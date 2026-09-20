import { describe, expect, it, vi } from "vitest";
import type { PluginCommandCapabilities } from "@getpaseo/plugin/client";
import { isSelectableSupervisor, onRoutingChanged, persistAndSync, synchronizePersistedSettings } from "../client/controller.js";
import { supervisionSettings } from "../shared/supervision.js";

const selected = {
  enabled: true,
  supervisorAgentId: "supervisor",
  supervisorTitle: "Supervisor",
  workspaceId: "workspace",
};

describe("client-side Supervisor routing", () => {
  it("defaults to disabled with no selected thread", () => {
    expect(supervisionSettings.schema.parse({})).toEqual({
      enabled: false, supervisorAgentId: null, supervisorTitle: null, workspaceId: null,
    });
  });

  it("only offers active codex-supervisor agents", () => {
    expect(isSelectableSupervisor({ provider: "codex-supervisor", status: "idle" })).toBe(true);
    expect(isSelectableSupervisor({ provider: "codex-supervisor", status: "closed" })).toBe(false);
    expect(isSelectableSupervisor({ provider: "codex-lead", status: "idle" })).toBe(false);
  });

  it("persists an explicit selection before synchronizing it as an update", async () => {
    const rpc = vi.fn(async (contract: { name: string }, input: unknown) => {
      if (contract.name.endsWith(".read")) return { status: "ready", revision: "one", values: {} };
      if (contract.name.endsWith(".write")) return { status: "saved", revision: "two", values: selected };
      if (contract.name === "supervision.supervisor.sync") {
        const intent = (input as { intent: string }).intent;
        return intent === "prepare"
          ? { status: "disabled", supervisorAgentId: null, token: "token-1" }
          : { status: "active", supervisorAgentId: "supervisor", token: null };
      }
      throw new Error(`Unexpected RPC: ${JSON.stringify(input)}`);
    });
    await persistAndSync({ rpc: rpc as unknown as PluginCommandCapabilities["rpc"] }, selected);
    expect(rpc.mock.calls.map(([contract]) => contract.name)).toEqual([
      "supervision.supervisor.sync",
      "settings.supervisor-routing.read",
      "settings.supervisor-routing.write",
      "supervision.supervisor.sync",
    ]);
    expect(rpc.mock.calls[0]?.[1]).toEqual({ intent: "prepare" });
    expect(rpc.mock.calls[3]?.[1]).toEqual({ ...selected, intent: "commit", token: "token-1" });
  });

  it("uses bootstrap intent when a client restores persisted settings", async () => {
    const rpc = vi.fn(async (contract: { name: string }, _input: unknown) => contract.name.endsWith(".read")
      ? { status: "ready", revision: "one", values: selected }
      : { status: "active", supervisorAgentId: "supervisor" });
    await synchronizePersistedSettings({ rpc: rpc as unknown as PluginCommandCapabilities["rpc"] });
    expect(rpc.mock.calls[1]?.[1]).toEqual({ ...selected, intent: "bootstrap" });
  });

  it("prepares by disabling runtime routing before a settings write and never commits a failed write", async () => {
    const changed = vi.fn();
    const off = onRoutingChanged(changed);
    const rpc = vi.fn(async (contract: { name: string }, input: unknown) => {
      if (contract.name === "supervision.supervisor.sync") {
        expect(input).toEqual({ intent: "prepare" });
        return { status: "disabled", supervisorAgentId: null, token: "token-1" };
      }
      if (contract.name.endsWith(".read")) return { status: "ready", revision: "one", values: selected };
      return { status: "conflict", error: "conflict" };
    });
    await expect(persistAndSync({
      rpc: rpc as unknown as PluginCommandCapabilities["rpc"],
    }, selected)).rejects.toThrow("conflict");
    expect(rpc.mock.calls.map(([contract]) => contract.name)).toEqual([
      "supervision.supervisor.sync",
      "settings.supervisor-routing.read",
      "settings.supervisor-routing.write",
    ]);
    expect(changed).toHaveBeenCalledWith({ ...selected, enabled: false });
    off();
  });

  it("treats a superseded unset commit as failure and reports runtime disabled", async () => {
    const unset = { enabled: false, supervisorAgentId: null, supervisorTitle: null, workspaceId: null };
    const changed = vi.fn();
    const off = onRoutingChanged(changed);
    const rpc = vi.fn(async (contract: { name: string }, input: unknown) => {
      if (contract.name.endsWith(".read")) return { status: "ready", revision: "one", values: selected };
      if (contract.name.endsWith(".write")) return { status: "saved", revision: "two", values: unset };
      return (input as { intent: string }).intent === "prepare"
        ? { status: "disabled", supervisorAgentId: null, token: "token-1" }
        : { status: "superseded", supervisorAgentId: null, token: null };
    });
    await expect(persistAndSync({
      rpc: rpc as unknown as PluginCommandCapabilities["rpc"],
    }, unset)).rejects.toThrow("unavailable");
    expect(changed).toHaveBeenCalledWith(unset);
    off();
  });
});
