import { jevResponseSchema, type JevResponse } from "./schema.js";
import type { JevQuestions } from "../evaluation/questions.js";

export const JEV_API_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
export const GATEWAY_API_ENDPOINT = "https://ai-gateway.vercel.sh/v4/ai/evaluation-model";
export const GATEWAY_MODEL = "typesafe-ai/jev";
export type JevTransport = "typesafe" | "gateway";

type FetchImplementation = typeof fetch;
type SleepImplementation = (milliseconds: number) => Promise<void>;

export type JevClientOptions = {
  apiKey: string;
  /** "typesafe" posts to api.typesafe.ai; "gateway" posts the same questions to Vercel AI Gateway. */
  transport?: JevTransport;
  fetchImplementation?: FetchImplementation;
  sleep?: SleepImplementation;
  timeoutMilliseconds?: number;
  maxRetries?: number;
};

export class JevApiError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "JevApiError";
    if (status !== undefined) this.status = status;
  }
}

export class JevClient {
  readonly #apiKey: string;
  readonly #transport: JevTransport;
  readonly #fetch: FetchImplementation;
  readonly #sleep: SleepImplementation;
  readonly #timeoutMilliseconds: number;
  readonly #maxRetries: number;

  constructor(options: JevClientOptions) {
    const apiKey = options.apiKey.trim();
    if (!apiKey) throw new JevApiError("JEV_API_KEY is not set. Export it before starting your coding agent.");

    this.#apiKey = apiKey;
    this.#transport = options.transport ?? "typesafe";
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#timeoutMilliseconds = options.timeoutMilliseconds ?? 30_000;
    this.#maxRetries = options.maxRetries ?? 2;
  }

  async evaluate(state: unknown, questions: JevQuestions): Promise<JevResponse> {
    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.#timeoutMilliseconds);

      try {
        const gateway = this.#transport === "gateway";
        const response = await this.#fetch(gateway ? GATEWAY_API_ENDPOINT : JEV_API_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.#apiKey}`,
            "Content-Type": "application/json",
            ...(gateway ? GATEWAY_HEADERS : {})
          },
          body: JSON.stringify(
            gateway ? { state, questions: toGatewayQuestions(questions) } : { state, model: JEV_MODEL, questions }
          ),
          signal: controller.signal
        });

        if (response.ok) {
          const body: unknown = await response.json();
          const rawResponse = gateway ? fromGatewayResponse(body, questions) : body;
          const parsed = jevResponseSchema.safeParse(rawResponse);
          if (!parsed.success) {
            throw new JevApiError("Jev returned a response that did not match its documented schema.");
          }
          return parsed.data;
        }

        if (isRetryable(response.status) && attempt < this.#maxRetries) {
          await this.#sleep(retryDelay(response.headers.get("retry-after"), attempt));
          continue;
        }

        throw await apiStatusError(response);
      } catch (error) {
        if (error instanceof JevApiError) throw error;
        if (isAbortError(error)) {
          throw new JevApiError(`Jev did not respond within ${this.#timeoutMilliseconds}ms.`);
        }
        throw new JevApiError("Could not reach the Jev API. Check network access and try again.");
      } finally {
        clearTimeout(timeout);
      }
    }

    throw new JevApiError("Jev request failed after retries.");
  }
}

// Same headers @ai-sdk/gateway sends for experimental_evaluate (the gateway's evaluation API is AI SDK-only).
const GATEWAY_HEADERS = {
  "ai-gateway-protocol-version": "0.0.1",
  "ai-gateway-auth-method": "api-key",
  "ai-evaluation-model-specification-version": "4",
  "ai-model-id": GATEWAY_MODEL
} as const;

/** The gateway speaks the AI SDK question shape: TypeSafe "noul" is "boolean" there; score/choice are identical. */
function toGatewayQuestions(questions: JevQuestions): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(questions).map(([id, question]) => [
      id,
      question.type === "noul" ? { ...question, type: "boolean" } : question
    ])
  );
}

/** Map a gateway evaluation response back to TypeSafe's documented shape so the rest of the pipeline is untouched. */
function fromGatewayResponse(body: unknown, questions: JevQuestions): unknown {
  if (!isRecord(body) || !isRecord(body.answers)) return body;
  const typesafe = isRecord(body.providerMetadata) ? body.providerMetadata.typesafe : undefined;
  const reportedConfidence = isRecord(typesafe) && isRecord(typesafe.confidence) ? typesafe.confidence : {};

  const answers = Object.fromEntries(
    Object.entries(body.answers).map(([id, answer]) => {
      if (!isRecord(answer)) return [id, answer];
      if (answer.type === "boolean") return [id, { type: "noul", noul: answer.probability }];

      const probabilities = isRecord(answer.probabilities) ? answer.probabilities : {};
      const reported = reportedConfidence[id];
      // ponytail: the gateway relays TypeSafe's confidence in providerMetadata; top probability is the fallback.
      const confidence = typeof reported === "number"
        ? reported
        : Math.max(0, ...Object.values(probabilities).filter((value): value is number => typeof value === "number"));

      if (answer.type === "score") {
        const question = questions[id];
        const legend = question?.type === "score"
          ? Object.fromEntries(question.criteria.map((label, index) => [String(index), label]))
          : {};
        return [id, { ...answer, legend, probabilities, confidence }];
      }
      return [id, { ...answer, probabilities, confidence }];
    })
  );

  const usage = isRecord(body.usage) ? body.usage : {};
  return {
    model: GATEWAY_MODEL,
    answers,
    usage: { input_tokens: usage.inputTokens ?? 0, output_tokens: usage.outputTokens ?? 0 }
  };
}

function isRetryable(status: number): boolean {
  return status === 429 || status === 529 || status >= 500;
}

async function apiStatusError(response: Response): Promise<JevApiError> {
  const status = response.status;
  const errorType = await readErrorType(response);

  if (status === 400 && errorType === "max_tokens_exceeded") {
    return new JevApiError(
      "Jev's input limit was exceeded. Send a smaller, focused code context or split the change across multiple review calls.",
      status
    );
  }
  if (status === 401) {
    return new JevApiError(
      "Jev rejected the API key (JEV_API_KEY or AI_GATEWAY_API_KEY). Check that it is current and available to the MCP process.",
      status
    );
  }
  if (status === 402) {
    return new JevApiError("Vercel AI Gateway credits or budget are exhausted for this key.", status);
  }
  if (status === 422) {
    return new JevApiError("Jev rejected the supplied evaluation context or questions.", status);
  }
  if (status === 429) {
    return new JevApiError("Jev rate-limited the request after retries. Try again shortly.", status);
  }
  if (status === 529) {
    return new JevApiError("Jev remained overloaded after retries. Try again shortly.", status);
  }
  return new JevApiError(`Jev API request failed with HTTP ${status}.`, status);
}

async function readErrorType(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    if (!isRecord(body) || !isRecord(body.detail)) return undefined;
    return typeof body.detail.error_type === "string" ? body.detail.error_type : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function retryDelay(retryAfter: string | null, attempt: number): number {
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 5_000);

    const retryDate = Date.parse(retryAfter);
    if (Number.isFinite(retryDate)) return Math.min(Math.max(retryDate - Date.now(), 0), 5_000);
  }
  return 250 * 2 ** attempt;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
