import { z } from "zod";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const id = z.string().trim().min(1).regex(/^[A-Za-z0-9_-]+$/);
const schema = z.object({
  leadId: id,
  supervisorId: id,
  apiKey: z.string().trim().min(1).regex(/^[\x21-\x7e]+$/),
  peerProvider: id.default("codex-peer"),
  peerIds: z.array(id).default([]),
  model: z.string().regex(/^jev-\d+\.\d+\.\d+$/).default("jev-1.13.0"),
  endpoint: z.literal(JEV_ENDPOINT).default(JEV_ENDPOINT),
  pendingDelayMs: z.coerce.number().int().min(1_000).max(86_400_000).default(60_000),
  alertConfidence: z.coerce.number().min(0.5).max(1).default(0.9),
}).superRefine((c, ctx) => {
  if (c.leadId === c.supervisorId || c.peerIds.includes(c.leadId) || c.peerIds.includes(c.supervisorId)) {
    ctx.addIssue({ code: "custom", path: ["peerIds"], message: "Roles must be distinct" });
  }
});
export type Config = z.infer<typeof schema>;

export function readConfig(env: NodeJS.ProcessEnv): Config {
  const result = schema.safeParse({
    leadId: env.PASEO_SUPERVISION_LEAD_ID,
    supervisorId: env.PASEO_SUPERVISION_SUPERVISOR_ID,
    apiKey: env.JEV_API_KEY,
    peerProvider: env.PASEO_SUPERVISION_PEER_PROVIDER,
    peerIds: env.PASEO_SUPERVISION_PEER_IDS?.split(","),
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
