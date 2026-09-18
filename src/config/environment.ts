import { JevApiError } from "../jev/client.js";

export type JevTransport = "typesafe" | "gateway";
export type JevCredentials = { apiKey: string; transport: JevTransport };

/** JEV_API_KEY (TypeSafe direct) wins; otherwise AI_GATEWAY_API_KEY routes through Vercel AI Gateway. */
export function getJevCredentials(environment: NodeJS.ProcessEnv = process.env): JevCredentials {
  const direct = environment.JEV_API_KEY?.trim();
  if (direct) return { apiKey: direct, transport: "typesafe" };
  const gateway = environment.AI_GATEWAY_API_KEY?.trim();
  if (gateway) return { apiKey: gateway, transport: "gateway" };
  throw new JevApiError(
    "Set JEV_API_KEY (TypeSafe) or AI_GATEWAY_API_KEY (Vercel AI Gateway) before starting your coding agent."
  );
}

export function getJevApiKey(environment: NodeJS.ProcessEnv = process.env): string {
  return getJevCredentials(environment).apiKey;
}
