import type { PluginHookContext, PluginLifecycleEvents, PluginServerContext } from "@getpaseo/plugin/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import contribute from "../index.server.js";
import { Observer, register } from "../server/observer.js";
import type { Evaluate } from "../server/jev.js";
import { agent, assessment, config, disposition, leadTurn, mockContext, peerTurn, response, send, settle } from "./fixtures.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function emitLead(observer: Observer, event: PluginLifecycleEvents["agent.turn_ended"], context: PluginHookContext): void {
  observer.onStart({ agent: event.agent, turnId: event.turnId });
  observer.onTurn(event, context);
}

async function activateSupervisor(observer: Observer, context: PluginHookContext, id = "supervisor") {
  const prepared = await observer.syncSupervisor({ intent: "prepare" }, context.paseo);
  if (prepared.token === null) throw new Error("Missing sync token");
  return observer.syncSupervisor({
    intent: "commit", token: prepared.token, enabled: true, supervisorAgentId: id,
    supervisorTitle: "Supervisor", workspaceId: "workspace",
  }, context.paseo);
}

describe("serialized observer", () => {
  it("discovers multiple Lead-Peer rooms dynamically and never crosses their evidence", async () => {
    const evaluate = vi.fn<Evaluate>(async () => assessment());
    const observer = new Observer(config, evaluate);
    const { context } = mockContext();
    observer.onCreated(agent("lead", null, "codex-lead"));
    observer.onCreated(agent("lead-2", null, "codex-lead"));
    observer.onCreated(agent("peer-a", "lead"));
    observer.onCreated(agent("peer-2", "lead-2"));
    observer.onTurn(peerTurn(), context);
    observer.onTurn({ ...peerTurn("peer-turn-2", "peer-2"), agent: agent("peer-2", "lead-2") }, context);
    await vi.advanceTimersByTimeAsync(0);
    const lead = leadTurn();
    emitLead(observer, lead, context);
    await vi.advanceTimersByTimeAsync(0);
    expect(evaluate.mock.calls.map(([e]) => [e.leadId, e.roomMessages.length])).toEqual([
      ["lead", 0], ["lead-2", 0], ["lead", 1],
    ]);
    observer.stop();
  });

  it("drops a dynamically discovered room when its Lead is archived", async () => {
    const evaluate = vi.fn<Evaluate>(async () => assessment());
    const observer = new Observer(config, evaluate);
    const { context, refresh } = mockContext();
    const lead = agent("lead", null, "codex-lead");
    observer.onCreated(lead);
    observer.onCreated(agent());
    observer.onTurn(peerTurn(), context);
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).not.toHaveBeenCalledWith("lead");
    observer.onArchived(lead, context);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(evaluate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    observer.stop();
  });

  it("archive ordered behind a queued handback removes it before evaluation", async () => {
    const evaluate = vi.fn<Evaluate>(async () => assessment("pending", "drift"));
    const observer = new Observer(config, evaluate);
    const { context, sendPrompt } = mockContext();
    const peer = agent();
    observer.onCreated(agent("lead", null, "codex-lead"));
    observer.onTurn(peerTurn(), context);
    observer.onArchived(peer, context);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(evaluate).not.toHaveBeenCalled();
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    observer.stop();
  });

  it("archive invalidates an in-flight drift judgment and prevents later recreation", async () => {
    let resolve!: (value: ReturnType<typeof assessment>) => void;
    const evaluate = vi.fn<Evaluate>(() => new Promise((r) => { resolve = r; }));
    const observer = new Observer(config, evaluate);
    const { context, sendPrompt, refresh } = mockContext();
    const peer = agent();
    observer.onCreated(agent("lead", null, "codex-lead"));
    observer.onTurn(peerTurn(), context);
    await vi.advanceTimersByTimeAsync(0);
    observer.onArchived(peer, context);
    refresh.mockImplementation(async (id: string) => ({ agent: {
      id, archivedAt: id === "peer-a" ? "2026-09-20T00:00:00.000Z" : null,
      provider: id === "lead" ? "codex-lead" : "codex-peer",
      labels: { "paseo.parent-agent-id": "lead" },
    } }));
    observer.onTurn(peerTurn("after-archive"), context);
    resolve(assessment("pending", "drift"));
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(evaluate).toHaveBeenCalledOnce();
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    observer.stop();
  });

  it("verified post-archive activity restores the same Peer ID", async () => {
    const evaluate = vi.fn<Evaluate>(async () => assessment());
    const observer = new Observer(config, evaluate);
    const { context, refresh } = mockContext();
    const peer = agent();
    observer.onCreated(agent("lead", null, "codex-lead"));
    observer.onTurn(peerTurn(), context);
    await vi.advanceTimersByTimeAsync(0);
    observer.onArchived(peer, context);
    await vi.advanceTimersByTimeAsync(0);
    observer.onStart({ agent: peer, turnId: "restored-turn" });
    observer.onTurn(peerTurn("restored-turn"), context);
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledWith("peer-a");
    expect(evaluate).toHaveBeenCalledTimes(2);
    observer.stop();
  });

  it("verified activity restores a cascaded Lead-Peer pair with the same IDs", async () => {
    const evaluate = vi.fn<Evaluate>(async () => assessment());
    const observer = new Observer(config, evaluate);
    const { context, refresh } = mockContext();
    const lead = agent("lead", null, "codex-lead");
    const peer = agent();
    observer.onCreated(lead);
    observer.onCreated(peer);
    observer.onArchived(lead, context);
    observer.onArchived(peer, context);
    await vi.advanceTimersByTimeAsync(0);
    observer.onStart({ agent: peer, turnId: "restored-pair-turn" });
    observer.onTurn(peerTurn("restored-pair-turn"), context);
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledWith("peer-a");
    expect(refresh).toHaveBeenCalledWith("lead");
    expect(evaluate).toHaveBeenCalledOnce();
    observer.stop();
  });

  it("re-archive prevents an older Peer restoration refresh from clearing the new generation", async () => {
    let release!: (value: { agent: { id: string; provider: string; archivedAt: string | null; labels: { "paseo.parent-agent-id": string } } }) => void;
    const evaluate = vi.fn<Evaluate>(async () => assessment("pending", "drift"));
    const observer = new Observer(config, evaluate);
    const { context, refresh, sendPrompt } = mockContext();
    const peer = agent();
    observer.onCreated(agent("lead", null, "codex-lead"));
    observer.onArchived(peer, context);
    await vi.advanceTimersByTimeAsync(0);
    refresh.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    observer.onStart({ agent: peer, turnId: "restore-race" });
    observer.onTurn(peerTurn("restore-race"), context);
    await vi.advanceTimersByTimeAsync(0);
    observer.onArchived(peer, context);
    release({ agent: { id: "peer-a", provider: "codex-peer", archivedAt: null, labels: { "paseo.parent-agent-id": "lead" } } });
    await settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(evaluate).not.toHaveBeenCalled();
    expect(sendPrompt).not.toHaveBeenCalled();
    observer.stop();
  });

  it("re-archive prevents an older parent restoration refresh from clearing the new generation", async () => {
    let release!: (value: { agent: { id: string; provider: string; archivedAt: string | null; labels: { "paseo.parent-agent-id": string } } }) => void;
    const evaluate = vi.fn<Evaluate>(async () => assessment("pending", "drift"));
    const observer = new Observer(config, evaluate);
    const { context, refresh, sendPrompt } = mockContext();
    const lead = agent("lead", null, "codex-lead");
    observer.onCreated(lead);
    observer.onArchived(lead, context);
    await vi.advanceTimersByTimeAsync(0);
    refresh.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const peer = agent();
    observer.onStart({ agent: peer, turnId: "parent-restore-race" });
    observer.onTurn(peerTurn("parent-restore-race"), context);
    await vi.advanceTimersByTimeAsync(0);
    observer.onArchived(lead, context);
    release({ agent: { id: "lead", provider: "codex-lead", archivedAt: null, labels: { "paseo.parent-agent-id": "root" } } });
    await settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(evaluate).not.toHaveBeenCalled();
    expect(sendPrompt).not.toHaveBeenCalled();
    observer.stop();
  });

  it("self-healing parent refresh cannot admit the configured Supervisor as a Lead", async () => {
    const evaluate = vi.fn<Evaluate>(async () => assessment());
    const observer = new Observer(config, evaluate);
    const { context, refresh } = mockContext();
    refresh.mockResolvedValue({ agent: {
      id: "supervisor", provider: "codex-lead", archivedAt: null,
      labels: { "paseo.parent-agent-id": "root" },
    } });
    observer.onTurn({ ...peerTurn(), agent: agent("peer-a", "supervisor") }, context);
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledWith("supervisor");
    expect(evaluate).not.toHaveBeenCalled();
    observer.stop();
  });

  it("a non-overlapping matched Lead turn can support a handling-drift alert", async () => {
    const evaluate = vi.fn<Evaluate>(async () => assessment("drift"));
    const observer = new Observer(config, evaluate);
    const { context, sendPrompt } = mockContext();
    observer.onTurn(peerTurn(), context);
    await vi.advanceTimersByTimeAsync(0);
    expect(sendPrompt).not.toHaveBeenCalled();
    emitLead(observer, leadTurn(), context);
    await vi.advanceTimersByTimeAsync(0);
    expect(evaluate.mock.calls[1]?.[0].uncertainRoomMessages).toEqual([]);
    expect(evaluate.mock.calls[1]?.[0].roomMessages).toHaveLength(1);
    expect(sendPrompt).toHaveBeenCalledOnce();
    observer.stop();
  });
  it.each(["handled", "drift"] as const)("overlapping Lead communication cannot %s a case", async (verdict) => {
    const evaluate = vi.fn<Evaluate>(async () => assessment(verdict));
    const observer = new Observer(config, evaluate);
    const { context, sendPrompt } = mockContext();
    const lead = leadTurn();
    observer.onStart(lead);
    observer.onTurn(peerTurn(), context);
    // A repeated start must not re-date the same overlapping turn.
    observer.onStart(lead);
    observer.onTurn(lead, context);
    await vi.advanceTimersByTimeAsync(0);
    expect(evaluate.mock.calls[0]?.[0]).toMatchObject({
      roomMessages: [], uncertainRoomMessages: [{ recipient: "peer-b", prompt: disposition }],
    });
    expect(sendPrompt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(evaluate).toHaveBeenCalledTimes(2); // Case remains open, even for handled.
    expect(sendPrompt).not.toHaveBeenCalled();
    observer.stop();
  });

  it.each(["absent", "mismatched", "null", "other-actor"])("%s Lead start is unknown, never subsequent", async (kind) => {
    const evaluate = vi.fn<Evaluate>(async () => assessment("handled"));
    const observer = new Observer(config, evaluate);
    const { context, sendPrompt } = mockContext();
    observer.onTurn(peerTurn(), context);
    const lead = leadTurn();
    if (kind === "mismatched") observer.onStart({ ...lead, turnId: "different-turn" });
    if (kind === "null") { lead.turnId = null; observer.onStart(lead); }
    if (kind === "other-actor") observer.onStart({ ...lead, agent: agent("supervisor") });
    observer.onTurn(lead, context);
    await vi.advanceTimersByTimeAsync(0);
    expect(evaluate.mock.calls[0]?.[0].roomMessages).toEqual([]);
    expect(evaluate.mock.calls[0]?.[0].uncertainRoomMessages).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(sendPrompt).not.toHaveBeenCalled();
    observer.stop();
  });

  it("classifies chronology separately for each handback at capture time, not queue time", async () => {
    const evaluate = vi.fn<Evaluate>(async () => assessment("handled"));
    const observer = new Observer(config, evaluate);
    const { context, sendPrompt } = mockContext();
    // All events have the same fake wall clock and arrive before the queue runs.
    observer.onTurn(peerTurn(), context);
    const lead = leadTurn();
    observer.onStart(lead);
    observer.onTurn(peerTurn("peer-2", "peer-b"), context);
    observer.onTurn(lead, context);
    await vi.advanceTimersByTimeAsync(0);
    expect(evaluate.mock.calls[0]?.[0]).toMatchObject({ peerId: "peer-a", uncertainRoomMessages: [], roomMessages: [{ prompt: disposition }] });
    expect(evaluate.mock.calls[1]?.[0]).toMatchObject({ peerId: "peer-b", roomMessages: [], uncertainRoomMessages: [{ prompt: disposition }] });
    await vi.advanceTimersByTimeAsync(1000);
    expect(evaluate.mock.calls.map(([e]) => e.peerId)).toEqual(["peer-a", "peer-b", "peer-b"]);
    expect(sendPrompt).not.toHaveBeenCalled();
    observer.stop();
  });

  it.each(["failed", "canceled"] as const)("retains individually confirmed sends from a %s Lead turn", async (kind) => {
    const evaluate = vi.fn<Evaluate>(async () => assessment("handled"));
    const observer = new Observer(config, evaluate);
    const { context, sendPrompt } = mockContext();
    observer.onTurn(peerTurn(), context);
    const lead = leadTurn();
    lead.outcome = kind === "failed" ? { kind, error: { message: "PRIVATE FAILURE" } } : { kind, reason: "PRIVATE CANCELLATION" };
    emitLead(observer, lead, context);
    await vi.advanceTimersByTimeAsync(0);
    expect(evaluate.mock.calls[0]?.[0]).toMatchObject({ incompleteCommunication: false, uncertainRoomMessages: [], roomMessages: [{ prompt: disposition }] });
    expect(JSON.stringify(evaluate.mock.calls)).not.toContain("PRIVATE");
    await vi.advanceTimersByTimeAsync(1000);
    expect(evaluate).toHaveBeenCalledOnce(); // Confident repair closed the case.
    expect(sendPrompt).not.toHaveBeenCalled();
    observer.stop();
  });

  it.each(["failed", "canceled"] as const)("a %s Lead repair arrival invalidates an in-flight drift judgment", async (kind) => {
    let resolve!: (value: ReturnType<typeof assessment>) => void;
    const evaluate = vi.fn<Evaluate>().mockImplementationOnce(() => new Promise((r) => { resolve = r; }))
      .mockResolvedValue(assessment("handled"));
    const observer = new Observer(config, evaluate);
    const { context, sendPrompt } = mockContext();
    observer.onTurn(peerTurn(), context);
    await vi.advanceTimersByTimeAsync(0);
    const lead = leadTurn();
    lead.outcome = kind === "failed" ? { kind, error: { message: "failed later" } } : { kind, reason: "canceled later" };
    observer.onStart(lead);
    observer.onTurn(lead, context);
    expect(evaluate).toHaveBeenCalledOnce();
    resolve(assessment("pending", "drift"));
    await settle();
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(evaluate.mock.calls[1]?.[0].roomMessages).toHaveLength(1);
    expect(sendPrompt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(evaluate).toHaveBeenCalledTimes(2);
    observer.stop();
  });

  it.each(["failed", "canceled"] as const)("uncertain sends in a %s Lead turn retain confirmed deliveries but suppress decisions", async (kind) => {
    const evaluate = vi.fn<Evaluate>(async () => assessment("drift", "drift"));
    const observer = new Observer(config, evaluate);
    const { context, sendPrompt } = mockContext();
    observer.onTurn(peerTurn(), context);
    const uncertain = send("peer-b", "uncertain payload", "uncertain");
    uncertain.status = "running";
    const lead = leadTurn([send(), uncertain]);
    lead.outcome = kind === "failed" ? { kind, error: { message: "failure" } } : { kind, reason: "cancel" };
    emitLead(observer, lead, context);
    await vi.advanceTimersByTimeAsync(0);
    expect(evaluate.mock.calls[0]?.[0]).toMatchObject({ incompleteCommunication: true, roomMessages: [{ prompt: disposition }] });
    expect(evaluate.mock.calls[0]?.[0].roomMessages).toHaveLength(1);
    expect(sendPrompt).not.toHaveBeenCalled();
    observer.stop();
  });

  it("unknown-start arrival invalidates an in-flight judgment and cannot close the case", async () => {
    let resolve!: (value: ReturnType<typeof assessment>) => void;
    const evaluate = vi.fn<Evaluate>().mockImplementationOnce(() => new Promise((r) => { resolve = r; }))
      .mockResolvedValue(assessment("handled"));
    const observer = new Observer(config, evaluate);
    const { context, sendPrompt } = mockContext();
    observer.onTurn(peerTurn(), context);
    await vi.advanceTimersByTimeAsync(0);
    observer.onTurn(leadTurn(), context); // No matching observed start.
    resolve(assessment("pending", "drift"));
    await settle();
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(evaluate.mock.calls[1]?.[0].uncertainRoomMessages).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(evaluate).toHaveBeenCalledTimes(3);
    observer.stop();
  });

  it("synchronously captures and returns; ignores the hook's short-lived abort signal", async () => {
    const evaluate = vi.fn<Evaluate>(async () => assessment());
    const observer = new Observer(config, evaluate);
    const { context, hookAbort } = mockContext();
    const event = peerTurn();
    expect(observer.onTurn(event, context)).toBeUndefined();
    expect(evaluate).not.toHaveBeenCalled();
    const last = event.timeline[event.timeline.length - 1];
    if (last?.type === "assistant_message") last.text = "MUTATED AFTER CAPTURE";
    hookAbort.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls[0]?.[0].handback).not.toContain("MUTATED");
    expect(evaluate.mock.calls[0]?.[1].aborted).toBe(false);
    observer.stop();
  });

  it("cross-Peer handling closes the originating case without a direct reply", async () => {
    const evaluate = vi.fn<Evaluate>(async (e) => assessment(e.roomMessages.length ? "handled" : "pending"));
    const observer = new Observer(config, evaluate);
    const { context, sendPrompt } = mockContext();
    observer.onTurn(peerTurn(), context);
    await vi.advanceTimersByTimeAsync(0);
    emitLead(observer, leadTurn(), context);
    await vi.advanceTimersByTimeAsync(0);
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(evaluate.mock.calls[1]?.[0]).toMatchObject({ peerId: "peer-a", roomMessages: [{ recipient: "peer-b", prompt: disposition }] });
    expect(sendPrompt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    observer.stop();
  });

  it("accumulates every subsequent room communication for every open case", async () => {
    const evaluate = vi.fn<Evaluate>(async () => assessment());
    const observer = new Observer(config, evaluate);
    const { context } = mockContext();
    observer.onTurn(peerTurn(), context);
    observer.onTurn(peerTurn("peer-turn-2", "peer-b"), context);
    emitLead(observer, leadTurn([send("peer-b", "first", "1"), send("peer-a", "second", "2")]), context);
    await vi.advanceTimersByTimeAsync(0);
    emitLead(observer, leadTurn([send("peer-b", "third", "3")], "lead-turn-2"), context);
    await vi.advanceTimersByTimeAsync(0);
    expect(evaluate.mock.calls.slice(-2).map(([e]) => e.roomMessages.map((m) => m.prompt))).toEqual([
      ["first", "second", "third"], ["first", "second", "third"],
    ]);
    observer.stop();
  });

  it("excludes communications observed before the handback", async () => {
    const evaluate = vi.fn<Evaluate>(async () => assessment());
    const observer = new Observer(config, evaluate);
    const { context } = mockContext();
    emitLead(observer, leadTurn(), context);
    observer.onTurn(peerTurn(), context);
    await vi.advanceTimersByTimeAsync(0);
    expect(evaluate.mock.calls[0]?.[0].roomMessages).toEqual([]);
    observer.stop();
  });

  it("filters Supervisor/non-room actors and outgoing recipients before evaluation", async () => {
    const evaluate = vi.fn<Evaluate>(async () => assessment());
    const observer = new Observer(config, evaluate);
    const { context, refresh, sendPrompt } = mockContext();
    observer.onTurn({ ...peerTurn(), agent: agent("supervisor") }, context);
    observer.onTurn({ ...peerTurn(), agent: agent("foreign", null) }, context);
    await vi.advanceTimersByTimeAsync(0);
    expect(evaluate).not.toHaveBeenCalled();
    observer.onTurn(peerTurn(), context);
    emitLead(observer, leadTurn([
      send("supervisor", "PRIVATE SUPERVISOR", "s"), send("outsider", "PRIVATE OUTSIDER", "o"),
      send("unrelated-peer", "PRIVATE ROOM", "u"), send(),
    ]), context);
    await vi.advanceTimersByTimeAsync(0);
    const state = evaluate.mock.calls[0]?.[0];
    expect(state?.roomMessages).toHaveLength(1);
    expect(JSON.stringify(state)).not.toContain("PRIVATE");
    expect(refresh).not.toHaveBeenCalledWith("supervisor");
    expect(sendPrompt).not.toHaveBeenCalled();
    observer.stop();
  });

  it("unresolved recipient metadata stays unknown, even if Jev returns drift", async () => {
    const evaluate = vi.fn<Evaluate>(async () => assessment("drift", "drift"));
    const observer = new Observer(config, evaluate);
    const { context, refresh, sendPrompt } = mockContext();
    refresh.mockRejectedValue(new Error("unavailable"));
    observer.onTurn(peerTurn(), context);
    emitLead(observer, leadTurn(), context);
    await vi.advanceTimersByTimeAsync(0);
    expect(evaluate.mock.calls[0]?.[0].incompleteCommunication).toBe(true);
    expect(sendPrompt).not.toHaveBeenCalled();
    observer.stop();
  });

  it("only alerts the configured Supervisor, once, with full communication evidence", async () => {
    const evaluate = vi.fn<Evaluate>(async () => assessment("pending", "drift"));
    const observer = new Observer(config, evaluate);
    const { context, sendPrompt, ref } = mockContext();
    observer.onTurn(peerTurn(null), context);
    observer.onTurn(peerTurn(null), context);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    emitLead(observer, leadTurn(), context);
    await vi.advanceTimersByTimeAsync(0);
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(ref).toHaveBeenCalledWith("supervisor");
    const prompt = sendPrompt.mock.calls[0]?.[0];
    expect(prompt).toContain("Suspected communication protocol drift");
    expect(prompt).toContain("REOPEN_REQUEST");
    expect(prompt).not.toMatch(/PRIVATE|test-not-a-real-key|Old unrelated/);
    observer.stop();
  });

  it("stays silent until a client synchronizes a persisted Supervisor", async () => {
    const evaluate = vi.fn<Evaluate>(async () => assessment("pending", "drift"));
    const observer = new Observer({ ...config, supervisorId: null }, evaluate);
    const { context, sendPrompt, ref } = mockContext();
    observer.onTurn(peerTurn(), context);
    await vi.advanceTimersByTimeAsync(0);
    expect(sendPrompt).not.toHaveBeenCalled();
    await expect(activateSupervisor(observer, context)).resolves.toEqual({
      status: "active", supervisorAgentId: "supervisor", token: null,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(ref).toHaveBeenCalledWith("supervisor");
    expect(sendPrompt).toHaveBeenCalledOnce();
    observer.stop();
  });

  it("rejects a selected recipient that is not an active codex-supervisor", async () => {
    const observer = new Observer({ ...config, supervisorId: null }, async () => assessment("pending", "drift"));
    const { context, refresh, sendPrompt } = mockContext();
    refresh.mockResolvedValue({ agent: {
      id: "wrong", provider: "codex-lead", status: "idle", archivedAt: null,
      labels: { "paseo.parent-agent-id": "root" },
    } });
    await expect(activateSupervisor(observer, context, "wrong")).resolves.toEqual({
      status: "unavailable", supervisorAgentId: null, token: null,
    });
    observer.onTurn(peerTurn(), context);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sendPrompt).not.toHaveBeenCalled();
    observer.stop();
  });

  it("does not let a stale client bootstrap replace an active selection", async () => {
    const observer = new Observer({ ...config, supervisorId: null }, async () => assessment());
    const { context, refresh } = mockContext();
    await activateSupervisor(observer, context);
    const calls = refresh.mock.calls.length;
    await expect(observer.syncSupervisor({
      intent: "bootstrap", enabled: true, supervisorAgentId: "stale-supervisor",
      supervisorTitle: "Stale", workspaceId: "old-workspace",
    }, context.paseo)).resolves.toEqual({ status: "superseded", supervisorAgentId: "supervisor", token: null });
    expect(refresh).toHaveBeenCalledTimes(calls);
    observer.stop();
  });

  it("blocks stale bootstrap while a newer explicit update is validating", async () => {
    const observer = new Observer({ ...config, supervisorId: null }, async () => assessment());
    const { context, refresh } = mockContext();
    let release!: (value: { agent: {
      id: string; provider: string; status: "idle"; archivedAt: null;
      labels: { "paseo.parent-agent-id": string };
    } }) => void;
    refresh.mockImplementation((id) => id === "new-supervisor"
      ? new Promise((resolve) => { release = resolve; })
      : Promise.resolve({ agent: {
        id, provider: "codex-supervisor", status: "idle" as const, archivedAt: null,
        labels: { "paseo.parent-agent-id": "root" },
      } }));
    const prepared = await observer.syncSupervisor({ intent: "prepare" }, context.paseo);
    if (prepared.token === null) throw new Error("Missing token");
    const update = observer.syncSupervisor({
      intent: "commit", token: prepared.token, enabled: true,
      supervisorAgentId: "new-supervisor", supervisorTitle: "New", workspaceId: "workspace",
    }, context.paseo);
    await expect(observer.syncSupervisor({
      intent: "bootstrap", enabled: true, supervisorAgentId: "old-supervisor",
      supervisorTitle: "Old", workspaceId: "old-workspace",
    }, context.paseo)).resolves.toEqual({ status: "superseded", supervisorAgentId: null, token: null });
    expect(refresh).not.toHaveBeenCalledWith("old-supervisor");
    release({ agent: {
      id: "new-supervisor", provider: "codex-supervisor", status: "idle", archivedAt: null,
      labels: { "paseo.parent-agent-id": "root" },
    } });
    await expect(update).resolves.toEqual({
      status: "active", supervisorAgentId: "new-supervisor", token: null,
    });
    observer.stop();
  });

  it("a superseded explicit unset invalidates a concurrently activated route", async () => {
    const observer = new Observer({ ...config, supervisorId: null }, async () => assessment("pending", "drift"));
    const { context, sendPrompt } = mockContext();
    const first = await observer.syncSupervisor({ intent: "prepare" }, context.paseo);
    const second = await observer.syncSupervisor({ intent: "prepare" }, context.paseo);
    if (first.token === null || second.token === null) throw new Error("Missing token");
    await expect(observer.syncSupervisor({
      intent: "commit", token: second.token, enabled: true, supervisorAgentId: "supervisor",
      supervisorTitle: "Supervisor B", workspaceId: "workspace",
    }, context.paseo)).resolves.toEqual({
      status: "active", supervisorAgentId: "supervisor", token: null,
    });
    await expect(observer.syncSupervisor({
      intent: "commit", token: first.token, enabled: false, supervisorAgentId: null,
      supervisorTitle: null, workspaceId: null,
    }, context.paseo)).resolves.toEqual({
      status: "superseded", supervisorAgentId: null, token: null,
    });
    observer.onTurn(peerTurn(), context);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sendPrompt).not.toHaveBeenCalled();
    observer.stop();
  });

  it("a stale commit also cancels the current commit while its validation is in flight", async () => {
    const observer = new Observer({ ...config, supervisorId: null }, async () => assessment());
    const { context, refresh } = mockContext();
    let release!: (value: { agent: {
      id: string; provider: string; status: "idle"; archivedAt: null;
      labels: { "paseo.parent-agent-id": string };
    } }) => void;
    refresh.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const stale = await observer.syncSupervisor({ intent: "prepare" }, context.paseo);
    const current = await observer.syncSupervisor({ intent: "prepare" }, context.paseo);
    if (stale.token === null || current.token === null) throw new Error("Missing token");
    const committing = observer.syncSupervisor({
      intent: "commit", token: current.token, enabled: true, supervisorAgentId: "supervisor",
      supervisorTitle: "Current", workspaceId: "workspace",
    }, context.paseo);
    await expect(observer.syncSupervisor({
      intent: "commit", token: stale.token, enabled: false, supervisorAgentId: null,
      supervisorTitle: null, workspaceId: null,
    }, context.paseo)).resolves.toEqual({
      status: "superseded", supervisorAgentId: null, token: null,
    });
    release({ agent: {
      id: "supervisor", provider: "codex-supervisor", status: "idle", archivedAt: null,
      labels: { "paseo.parent-agent-id": "root" },
    } });
    await expect(committing).resolves.toEqual({
      status: "superseded", supervisorAgentId: null, token: null,
    });
    observer.stop();
  });

  it.each(["closed", "error"] as const)("rejects a %s codex-supervisor on the server", async (status) => {
    const observer = new Observer({ ...config, supervisorId: null }, async () => assessment());
    const { context, refresh } = mockContext();
    refresh.mockResolvedValue({ agent: {
      id: "supervisor", provider: "codex-supervisor", status, archivedAt: null,
      labels: { "paseo.parent-agent-id": "root" },
    } });
    await expect(activateSupervisor(observer, context)).resolves.toEqual({
      status: "unavailable", supervisorAgentId: null, token: null,
    });
    observer.stop();
  });

  it("disables the old route before persistence and leaves it disabled if no commit follows", async () => {
    const observer = new Observer(config, async () => assessment("pending", "drift"));
    const { context, sendPrompt } = mockContext();
    observer.onTurn(peerTurn(), context);
    await observer.syncSupervisor({ intent: "prepare" }, context.paseo);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sendPrompt).not.toHaveBeenCalled();
    observer.stop();
  });

  it("fails closed when the selected Supervisor becomes closed before delivery", async () => {
    const observer = new Observer(config, async () => assessment("pending", "drift"));
    const { context, refresh, sendPrompt } = mockContext();
    refresh.mockImplementation(async (id) => ({ agent: {
      id,
      provider: id === "supervisor" ? "codex-supervisor" : id === "lead" ? "codex-lead" : "codex-peer",
      status: id === "supervisor" ? "closed" as const : "idle" as const,
      archivedAt: null,
      labels: { "paseo.parent-agent-id": "lead" },
    } }));
    observer.onTurn(peerTurn(), context);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(refresh).toHaveBeenCalledWith("supervisor");
    expect(sendPrompt).not.toHaveBeenCalled();
    observer.stop();
  });

  it("unsets an archived selected Supervisor before queued work can alert", async () => {
    const observer = new Observer({ ...config, supervisorId: null }, async () => assessment("pending", "drift"));
    const { context, sendPrompt } = mockContext();
    await activateSupervisor(observer, context);
    observer.onTurn(peerTurn(), context);
    observer.onArchived(agent("supervisor", null, "codex-supervisor"), context);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sendPrompt).not.toHaveBeenCalled();
    observer.stop();
  });

  it("does not retry a failed/uncertain Supervisor send", async () => {
    const observer = new Observer(config, async () => assessment("pending", "drift"));
    const { context, sendPrompt } = mockContext();
    sendPrompt.mockRejectedValue(new Error("delivery unknown"));
    observer.onTurn(peerTurn(), context);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    observer.stop();
  });

  it("uses one timer and at most one silence reevaluation per case; silence never alerts", async () => {
    const evaluate = vi.fn<Evaluate>(async () => assessment("drift"));
    const observer = new Observer(config, evaluate);
    const { context, sendPrompt } = mockContext();
    observer.onTurn(peerTurn(), context);
    observer.onTurn(peerTurn("turn-2", "peer-b"), context);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(evaluate).toHaveBeenCalledTimes(4);
    expect(evaluate.mock.calls.slice(-2).every(([e]) => e.pendingDelayElapsed)).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(evaluate).toHaveBeenCalledTimes(4);
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    observer.stop();
  });

  it("deduplicates replayed sends when turn IDs change", async () => {
    const evaluate = vi.fn<Evaluate>(async () => assessment());
    const observer = new Observer(config, evaluate);
    const { context } = mockContext();
    observer.onTurn(peerTurn(), context);
    emitLead(observer, leadTurn(), context);
    emitLead(observer, leadTurn(undefined, "another-turn"), context);
    await vi.advanceTimersByTimeAsync(0);
    expect(evaluate.mock.calls[0]?.[0].roomMessages).toHaveLength(1);
    observer.stop();
  });

  it("a silence timer only reevaluates due cases, not younger ones", async () => {
    const evaluate = vi.fn<Evaluate>(async () => assessment());
    const observer = new Observer(config, evaluate);
    const { context } = mockContext();
    observer.onTurn(peerTurn(), context);
    await vi.advanceTimersByTimeAsync(500);
    observer.onTurn(peerTurn("turn-2", "peer-b"), context);
    await vi.advanceTimersByTimeAsync(500);
    expect(evaluate.mock.calls.map(([e]) => e.peerId)).toEqual(["peer-a", "peer-b", "peer-a"]);
    await vi.advanceTimersByTimeAsync(500);
    expect(evaluate.mock.calls.map(([e]) => e.peerId)).toEqual(["peer-a", "peer-b", "peer-a", "peer-b"]);
    expect(vi.getTimerCount()).toBe(0);
    observer.stop();
  });

  it("Lead turns without new room communication do not cause extra Jev requests", async () => {
    const evaluate = vi.fn<Evaluate>(async () => assessment());
    const observer = new Observer(config, evaluate);
    const { context } = mockContext();
    observer.onTurn(peerTurn(), context);
    await vi.advanceTimersByTimeAsync(0);
    emitLead(observer, leadTurn([], "no-communication"), context);
    await vi.advanceTimersByTimeAsync(0);
    emitLead(observer, leadTurn([send("outsider")], "non-room-communication"), context);
    await vi.advanceTimersByTimeAsync(0);
    expect(evaluate).toHaveBeenCalledTimes(1);
    observer.stop();
  });

  it("serializes requests and discards a stale drift judgment when newer handling arrives", async () => {
    let resolve!: (value: ReturnType<typeof assessment>) => void;
    const evaluate = vi.fn<Evaluate>().mockImplementationOnce(() => new Promise((r) => { resolve = r; }))
      .mockImplementation(async () => assessment("handled"));
    const observer = new Observer(config, evaluate);
    const { context, sendPrompt } = mockContext();
    observer.onTurn(peerTurn(), context);
    await vi.advanceTimersByTimeAsync(0);
    emitLead(observer, leadTurn(), context);
    expect(evaluate).toHaveBeenCalledTimes(1);
    resolve(assessment("pending", "drift"));
    await settle();
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(sendPrompt).not.toHaveBeenCalled();
    observer.stop();
  });

  it("unknown and thrown evaluations do not poison the queue", async () => {
    const evaluate = vi.fn<Evaluate>().mockRejectedValueOnce(new Error("private"))
      .mockResolvedValueOnce(null).mockResolvedValue(assessment("handled"));
    const observer = new Observer(config, evaluate);
    const { context, sendPrompt } = mockContext();
    observer.onTurn(peerTurn(), context);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    emitLead(observer, leadTurn(), context);
    await vi.advanceTimersByTimeAsync(0);
    expect(evaluate).toHaveBeenCalledTimes(3);
    expect(sendPrompt).not.toHaveBeenCalled();
    observer.stop();
  });

  it("stop aborts work, clears timers, drops queued jobs, and prevents later sends", async () => {
    let resolve!: (value: ReturnType<typeof assessment>) => void;
    const evaluate = vi.fn<Evaluate>(() => new Promise((r) => { resolve = r; }));
    const observer = new Observer(config, evaluate);
    const { context, sendPrompt } = mockContext();
    observer.onTurn(peerTurn(), context);
    await vi.advanceTimersByTimeAsync(0);
    emitLead(observer, leadTurn(), context);
    observer.stop();
    expect(evaluate.mock.calls[0]?.[1].aborted).toBe(true);
    resolve(assessment("pending", "drift"));
    await settle();
    observer.onTurn(peerTurn("after-stop"), context);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stop detaches from a stuck SDK refresh without leaking its wait timer", async () => {
    const evaluate = vi.fn<Evaluate>(async () => assessment());
    const observer = new Observer(config, evaluate);
    const { context, refresh } = mockContext();
    refresh.mockImplementation(() => new Promise(() => {}));
    observer.onTurn(peerTurn(), context);
    emitLead(observer, leadTurn(), context);
    await vi.advanceTimersByTimeAsync(0);
    observer.stop();
    await settle();
    expect(evaluate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("plugin lifecycle", () => {
  it("runs the real entry/evaluator with mocked lifecycle, HTTP and Paseo only", async () => {
    for (const name of ["PASEO_SUPERVISION_LEAD_PROVIDER", "PASEO_SUPERVISION_PEER_PROVIDER", "PASEO_SUPERVISION_PENDING_DELAY_MS", "PASEO_SUPERVISION_ALERT_CONFIDENCE", "JEV_MODEL", "JEV_ENDPOINT"]) vi.stubEnv(name, undefined);
    vi.stubEnv("JEV_API_KEY", "mock-only");
    const http = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(response(assessment("pending", "drift")))));
    vi.stubGlobal("fetch", http);
    let handler!: (event: PluginLifecycleEvents["agent.turn_ended"], context: PluginHookContext) => void;
    let sync!: (input: unknown, context: PluginHookContext) => Promise<unknown>;
    const off = vi.fn();
    const server = {
      registerSettings: vi.fn(),
      handle: vi.fn((_contract, callback) => { sync = callback; }),
      on: vi.fn((name, callback) => { if (name === "agent.turn_ended") handler = callback; return off; }),
    } as unknown as PluginServerContext;
    const { context, sendPrompt } = mockContext();
    const stop = contribute(server);
    const prepared = await sync({ intent: "prepare" }, context) as { token: string };
    await sync({ intent: "commit", token: prepared.token, enabled: true, supervisorAgentId: "supervisor", supervisorTitle: "Supervisor", workspaceId: "workspace" }, context);
    handler(peerTurn(), context);
    expect(http).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(http).toHaveBeenCalledOnce();
    expect(sendPrompt).toHaveBeenCalledOnce();
    expect(sendPrompt.mock.calls[0]?.[0]).not.toContain("mock-only");
    stop();
    expect(off).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("registers turn starts/ends and disposes both listeners and timer", async () => {
    let handler!: (event: PluginLifecycleEvents["agent.turn_ended"], context: PluginHookContext) => void;
    let startHandler!: (event: PluginLifecycleEvents["agent.turn_started"]) => void;
    const off = vi.fn();
    const on = vi.fn((name, callback) => {
      if (name === "agent.turn_started") startHandler = callback;
      if (name === "agent.turn_ended") handler = callback;
      return off;
    });
    const server = { on, handle: vi.fn() } as unknown as PluginServerContext;
    const evaluate = vi.fn<Evaluate>(async () => assessment());
    const stop = register(server, config, evaluate);
    expect(on).toHaveBeenCalledWith("agent.turn_ended", expect.any(Function));
    expect(on).toHaveBeenCalledWith("agent.turn_started", expect.any(Function));
    expect(on).toHaveBeenCalledWith("agent.created", expect.any(Function));
    expect(on).toHaveBeenCalledWith("agent.archived", expect.any(Function));
    expect(on).toHaveBeenCalledTimes(4);
    handler(peerTurn(), mockContext().context);
    startHandler(leadTurn());
    handler(leadTurn(), mockContext().context);
    await vi.advanceTimersByTimeAsync(0);
    expect(evaluate.mock.calls[0]?.[0].roomMessages).toHaveLength(1);
    expect(evaluate.mock.calls[0]?.[0].uncertainRoomMessages).toEqual([]);
    stop();
    expect(off).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("invalid startup config registers nothing and sends nothing", () => {
    vi.stubEnv("JEV_API_KEY", "");
    const on = vi.fn();
    const registerSettings = vi.fn();
    expect(() => contribute({ on, registerSettings } as unknown as PluginServerContext)).toThrow(/configuration/);
    expect(on).not.toHaveBeenCalled();
    expect(registerSettings).not.toHaveBeenCalled();
  });
});
