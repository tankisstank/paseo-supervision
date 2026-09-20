import { describe, expect, it } from "vitest";
import { capture, isLead, isPeer } from "../server/communication.js";
import { readConfig } from "../server/config.js";
import { agent, brief, config, handback, leadTurn, peerTurn, send } from "./fixtures.js";

describe("configuration and room boundary", () => {
  it("requires configuration without leaking credentials", () => {
    expect(() => readConfig({ JEV_API_KEY: "PRIVATE VALUE" })).toThrow(/Invalid paseo-supervision/);
    try { readConfig({ JEV_API_KEY: "PRIVATE VALUE" }); } catch (error) { expect(String(error)).not.toContain("PRIVATE VALUE"); }
  });
  it("never reads the Supervisor recipient from daemon environment", () => {
    expect(readConfig({
      JEV_API_KEY: "test",
      PASEO_SUPERVISION_SUPERVISOR_ID: "hardcoded-supervisor",
    }).supervisorId).toBeNull();
  });
  it.each([
    { JEV_ENDPOINT: "https://attacker.invalid" }, { JEV_MODEL: "jev-latest" },
    { PASEO_SUPERVISION_PENDING_DELAY_MS: "NaN" }, { PASEO_SUPERVISION_PENDING_DELAY_MS: "0" },
    { PASEO_SUPERVISION_ALERT_CONFIDENCE: "1.1" }, { PASEO_SUPERVISION_ALERT_CONFIDENCE: "" },
    { PASEO_SUPERVISION_LEAD_PROVIDER: "codex-peer" },
    { PASEO_SUPERVISION_LEAD_PROVIDER: "codex-supervisor" },
    { PASEO_SUPERVISION_PEER_PROVIDER: "codex-supervisor" },
  ])("rejects invalid settings %j", (overrides) => {
    expect(() => readConfig({ PASEO_SUPERVISION_SUPERVISOR_ID: "supervisor", JEV_API_KEY: "test", ...overrides })).toThrow();
  });
  it("discovers role and parent identity, never cwd/workspace or an ID allowlist", () => {
    expect(isLead(agent("lead", null, "codex-lead"), config)).toBe(true);
    expect(isPeer(agent(), "lead", config)).toBe(true);
    expect(isPeer(agent("peer-a", "other-lead"), "lead", config)).toBe(false);
    expect(isPeer(agent("peer-a", null), "lead", config)).toBe(false);
    expect(isPeer(agent("peer-a", "lead", "other-provider"), "lead", config)).toBe(false);
    expect(isPeer(agent("supervisor"), "lead", config)).toBe(false);
  });
});

describe("communication extraction", () => {
  it.each(["failed", "canceled"] as const)("keeps successful sends and flags malformed sends in a %s Lead turn", (kind) => {
    const broken = send("peer-a", "malformed", "broken");
    if (broken.detail.type === "unknown") broken.detail.input = "bad JSON";
    const event = leadTurn([send(), broken]);
    event.outcome = kind === "failed" ? { kind, error: { message: "failure" } } : { kind, reason: "cancel" };
    expect(capture(event, config)).toMatchObject({ messages: [{ recipient: "peer-b" }], incomplete: true });
    const result = capture(event, config);
    expect(result?.kind === "lead" && result.messages.length).toBe(1);
  });
  it("retains the complete latest brief and final handback, not reasoning, tools or history", () => {
    const result = capture(peerTurn(), config);
    expect(result).toMatchObject({ kind: "peer", brief, handback });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|Old unrelated|Intermediate/);
  });
  it("extracts complete payloads and recipients from the latest Lead window", () => {
    const text = "\nFull message\nwith every line intact.\n";
    expect(capture(leadTurn([send("peer-b", text)]), config)).toMatchObject({
      kind: "lead", incomplete: false, messages: [{ recipient: "peer-b", prompt: text }],
    });
    expect(JSON.stringify(capture(leadTurn(), config))).not.toContain("OLD SEND");
  });
  it("supports the observed legacy envelope name and JSON input", () => {
    const item = send();
    item.name = "mcp__paseo__send_agent_prompt";
    if (item.detail.type === "unknown") item.detail.input = JSON.stringify(item.detail.input);
    expect(capture(leadTurn([item]), config)).toMatchObject({ messages: [{ recipient: "peer-b" }], incomplete: false });
  });
  it("ignores non-room actors and non-completed outcomes", () => {
    for (const a of [agent("supervisor"), agent("other", null), agent("other", "lead", "jev")]) {
      expect(capture({ ...peerTurn(), agent: a }, config)).toBeNull();
    }
    expect(capture({ ...peerTurn(), outcome: { kind: "failed", error: { message: "private" } } }, config)).toBeNull();
    expect(capture({ ...peerTurn(), outcome: { kind: "canceled", reason: "private" } }, config)).toBeNull();
  });
  it("does not infer missing boundaries or missing handbacks", () => {
    expect(capture({ ...peerTurn(), timeline: [{ type: "assistant_message", text: "orphan" }] }, config)).toBeNull();
    expect(capture({ ...peerTurn(), timeline: [{ type: "user_message", text: brief }] }, config)).toBeNull();
  });
  it.each(["malformed", "missing", "failed", "mcp-error", "success-false", "unknown-output"])("fails closed for %s sends", (kind) => {
    const item = send();
    if (item.detail.type !== "unknown") throw new Error("fixture");
    if (kind === "malformed") item.detail.input = "{bad JSON";
    if (kind === "missing") item.detail.input = { prompt: "no recipient" };
    if (kind === "failed") { item.status = "failed"; item.error = { message: "failed" }; }
    if (kind === "mcp-error") item.detail.output = { isError: true, structuredContent: { success: true } };
    if (kind === "success-false") item.detail.output = { structuredContent: { success: false } };
    if (kind === "unknown-output") item.detail.output = {};
    expect(capture(leadTurn([item]), config)).toMatchObject({ messages: [], incomplete: true });
  });
  it("never parses executable wrappers or matches arbitrary tool-name substrings", () => {
    const item = send(); item.name = "functions.exec";
    expect(capture(leadTurn([item]), config)).toMatchObject({ messages: [] });
  });
});
