import { settingsRpc } from "@getpaseo/plugin";
import type { PluginCommandCapabilities } from "@getpaseo/plugin/client";
import {
  SUPERVISOR_PROVIDER,
  isActiveSupervisorStatus,
  supervisionSettings,
  syncSupervisorRpc,
  type SupervisionSettings,
} from "../shared/supervision.js";

const settings = settingsRpc(supervisionSettings.id);
const listeners = new Set<(values: SupervisionSettings) => void>();

type RpcClient = Pick<PluginCommandCapabilities, "rpc">;

export async function readSettings(client: RpcClient): Promise<SupervisionSettings | null> {
  const result = await client.rpc(settings.read, {});
  if (result.status !== "ready") return null;
  const parsed = supervisionSettings.schema.safeParse(result.values);
  return parsed.success ? parsed.data : null;
}

export async function persistAndSync(
  client: RpcClient,
  values: SupervisionSettings,
): Promise<void> {
  const prepared = await client.rpc(syncSupervisorRpc, { intent: "prepare" });
  if (prepared.token === null) throw new Error("Unable to prepare Supervisor routing update");
  try {
    const current = await client.rpc(settings.read, {});
    if (current.status !== "ready") throw new Error("Supervision settings are unavailable");
    const saved = await client.rpc(settings.write, { revision: current.revision, values });
    if (saved.status !== "saved") throw new Error(saved.error);
    const result = await client.rpc(syncSupervisorRpc, {
      ...values, intent: "commit", token: prepared.token,
    });
    const expected = values.enabled ? "active" : "disabled";
    if (result.status !== expected) {
      throw new Error("The selected Supervisor thread is unavailable");
    }
    notifyRoutingChanged(values);
  } catch (error) {
    notifyRoutingChanged({ ...values, enabled: false });
    throw error;
  }
}

export async function synchronizePersistedSettings(client: RpcClient): Promise<{
  values: SupervisionSettings;
  status: "active" | "disabled" | "unavailable" | "superseded";
} | null> {
  const values = await readSettings(client);
  if (values === null) return null;
  const result = await client.rpc(syncSupervisorRpc, { ...values, intent: "bootstrap" });
  return { values, status: result.status };
}

export function isSelectableSupervisor(agent: { provider: string; status: string }): boolean {
  return agent.provider === SUPERVISOR_PROVIDER && isActiveSupervisorStatus(agent.status);
}

export function notifyRoutingChanged(values: SupervisionSettings): void {
  for (const listener of listeners) listener(values);
}

export function onRoutingChanged(listener: (values: SupervisionSettings) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
