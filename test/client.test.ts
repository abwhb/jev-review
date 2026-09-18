import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GATEWAY_API_ENDPOINT, GATEWAY_MODEL, JevApiError, JevClient, JEV_API_ENDPOINT, JEV_MODEL } from "../src/jev/client.js";

const validResponse = {
  model: JEV_MODEL,
  answers: {},
  usage: { input_tokens: 10, output_tokens: 2 }
};

describe("Jev client", () => {
  it("sends the key only in the direct Jev authorization header", async () => {
    let observedUrl = "";
    let observedAuthorization = "";
    let observedBody: Record<string, unknown> = {};
    const fakeFetch: typeof fetch = async (input, init) => {
      observedUrl = String(input);
      observedAuthorization = new Headers(init?.headers).get("authorization") ?? "";
      observedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify(validResponse), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const client = new JevClient({ apiKey: "test-secret", fetchImplementation: fakeFetch });
    await client.evaluate({ diff: "+ change" }, {});

    assert.equal(observedUrl, JEV_API_ENDPOINT);
    assert.equal(observedAuthorization, "Bearer test-secret");
    assert.equal(observedBody.model, JEV_MODEL);
    assert.deepEqual(observedBody.state, { diff: "+ change" });
  });

  it("retries documented transient failures with bounded backoff", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const fakeFetch: typeof fetch = async () => {
      attempts += 1;
      if (attempts === 1) return new Response("overloaded", { status: 529 });
      return new Response(JSON.stringify(validResponse), { status: 200 });
    };

    const client = new JevClient({
      apiKey: "test-secret",
      fetchImplementation: fakeFetch,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      }
    });
    await client.evaluate("state", {});

    assert.equal(attempts, 2);
    assert.deepEqual(delays, [250]);
  });

  it("routes through Vercel AI Gateway and maps the response back to Jev's shape", async () => {
    let observedUrl = "";
    let observedHeaders = new Headers();
    let observedBody: Record<string, unknown> = {};
    const fakeFetch: typeof fetch = async (input, init) => {
      observedUrl = String(input);
      observedHeaders = new Headers(init?.headers);
      observedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          answers: {
            ok: { type: "boolean", probability: 0.9 },
            quality: { type: "score", score: 1.5, probabilities: { "0": 0.1, "1": 0.3, "2": 0.6 } },
            weakness: { type: "choice", choice: "none", probabilities: { none: 0.7, naming: 0.3 } }
          },
          usage: { inputTokens: 40, outputTokens: 3 },
          providerMetadata: { typesafe: { confidence: { quality: 0.42 } } }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };

    const client = new JevClient({ apiKey: "gw-secret", transport: "gateway", fetchImplementation: fakeFetch });
    const result = await client.evaluate("state", {
      ok: { type: "noul", instructions: "ok?", criteria: { true: "yes", false: "no" } },
      quality: { type: "score", instructions: "rate", criteria: ["low", "mid", "high"] },
      weakness: { type: "choice", instructions: "pick", criteria: { none: "none", naming: "naming" } }
    });

    assert.equal(observedUrl, GATEWAY_API_ENDPOINT);
    assert.equal(observedHeaders.get("authorization"), "Bearer gw-secret");
    assert.equal(observedHeaders.get("ai-model-id"), GATEWAY_MODEL);
    assert.equal(observedHeaders.get("ai-evaluation-model-specification-version"), "4");
    assert.equal((observedBody.questions as Record<string, { type: string }>).ok?.type, "boolean");
    assert.equal("model" in observedBody, false);

    assert.equal(result.model, GATEWAY_MODEL);
    assert.deepEqual(result.answers.ok, { type: "noul", noul: 0.9 });
    const quality = result.answers.quality;
    assert.equal(quality?.type, "score");
    if (quality?.type === "score") {
      assert.equal(quality.confidence, 0.42);
      assert.deepEqual(quality.legend, { "0": "low", "1": "mid", "2": "high" });
    }
    const weakness = result.answers.weakness;
    assert.equal(weakness?.type, "choice");
    if (weakness?.type === "choice") assert.equal(weakness.confidence, 0.7);
    assert.deepEqual(result.usage, { input_tokens: 40, output_tokens: 3 });
  });

  it("never starts without an API key", () => {
    assert.throws(() => new JevClient({ apiKey: " " }), JevApiError);
  });

  it("explains Jev's upstream token-limit response", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ detail: { error_type: "max_tokens_exceeded" } }), {
        status: 400,
        headers: { "content-type": "application/json" }
      });
    const client = new JevClient({ apiKey: "test-secret", fetchImplementation: fakeFetch });

    await assert.rejects(
      client.evaluate({ diff: "+ oversized change" }, {}),
      (error: unknown) =>
        error instanceof JevApiError &&
        error.status === 400 &&
        error.message.includes("split the change across multiple review calls")
    );
  });
});
