import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const SUPERVISOR_PROVIDER = "codex-supervisor";

export const supervisionSettings = defineSettings({
  id: "supervisor-routing",
  scope: "host",
  version: 1,
  schema: z.object({
    enabled: z.boolean().default(false),
    supervisorAgentId: z.string().trim().min(1).nullable().default(null),
    supervisorTitle: z.string().trim().min(1).nullable().default(null),
    workspaceId: z.string().trim().min(1).nullable().default(null),
  }),
});

export type SupervisionSettings = z.output<typeof supervisionSettings.schema>;

export function isActiveSupervisorStatus(status: string): boolean {
  return status === "initializing" || status === "idle" || status === "running";
}

export const syncSupervisorRpc = defineRpc({
  name: "supervision.supervisor.sync",
  input: z.discriminatedUnion("intent", [
    z.object({ intent: z.literal("prepare") }),
    supervisionSettings.schema.extend({ intent: z.literal("bootstrap") }),
    supervisionSettings.schema.extend({ intent: z.literal("commit"), token: z.string().min(1) }),
  ]),
  output: z.object({
    status: z.enum(["active", "disabled", "unavailable", "superseded"]),
    supervisorAgentId: z.string().nullable(),
    token: z.string().nullable(),
  }),
});

export type SupervisorSyncInput = z.output<typeof syncSupervisorRpc.input>;
