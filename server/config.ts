import { z } from "zod";
import { SUPERVISOR_PROVIDER } from "../shared/supervision.js";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const id = z.string().trim().min(1).regex(/^[A-Za-z0-9_-]+$/);
const schema = z.object({
  // Runtime-owned. The client synchronizes this after reading persisted plugin
  // settings; it is deliberately never populated from daemon environment.
  supervisorId: id.nullable().default(null),
  apiKey: z.string().trim().min(1).regex(/^[\x21-\x7e]+$/),
  leadProvider: id.default("codex-lead"),
  peerProvider: id.default("codex-peer"),
  model: z.string().regex(/^jev-\d+\.\d+\.\d+$/).default("jev-1.13.0"),
  endpoint: z.literal(JEV_ENDPOINT).default(JEV_ENDPOINT),
  pendingDelayMs: z.coerce.number().int().min(1_000).max(86_400_000).default(60_000),
  alertConfidence: z.coerce.number().min(0.5).max(1).default(0.9),
}).superRefine((c, context) => {
  if (c.leadProvider === c.peerProvider) {
    context.addIssue({ code: "custom", path: ["peerProvider"], message: "Lead and Peer providers must be distinct" });
  }
  if (c.leadProvider === SUPERVISOR_PROVIDER || c.peerProvider === SUPERVISOR_PROVIDER) {
    context.addIssue({ code: "custom", path: ["leadProvider"], message: "Supervisor provider must remain distinct" });
  }
});
export type Config = z.infer<typeof schema>;

export function readConfig(env: NodeJS.ProcessEnv): Config {
  const result = schema.safeParse({
    supervisorId: null,
    apiKey: env.JEV_API_KEY,
    leadProvider: env.PASEO_SUPERVISION_LEAD_PROVIDER,
    peerProvider: env.PASEO_SUPERVISION_PEER_PROVIDER,
    endpoint: env.JEV_ENDPOINT,
    model: env.JEV_MODEL,
    pendingDelayMs: env.PASEO_SUPERVISION_PENDING_DELAY_MS,
    alertConfidence: env.PASEO_SUPERVISION_ALERT_CONFIDENCE,
  });
  if (!result.success) {
    // Never stringify Zod errors: values (including credentials) may be embedded.
    const fields = [...new Set(result.error.issues.map((issue) => issue.path[0]))];
    throw new Error(`Invalid paseo-supervision configuration: ${fields.join(", ")}. See README.`);
  }
  return result.data;
}
