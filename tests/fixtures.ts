import type { AgentTimelineItem, ToolCallTimelineItem } from "@getpaseo/protocol/agent-types";
import type { PluginHookAgent, PluginHookContext } from "@getpaseo/plugin/server";
import { vi } from "vitest";
import { readConfig } from "../server/config.js";
import type { TurnEnded } from "../server/communication.js";
import type { Assessment, Evidence } from "../server/jev.js";

export const config = { ...readConfig({
  JEV_API_KEY: "test-not-a-real-key", PASEO_SUPERVISION_PENDING_DELAY_MS: "1000",
}), supervisorId: "supervisor" };
export const brief = "Review candidate abc123 read-only. Return findings with evidence and limits. Reopen if inputs are missing.";
export const handback = "REOPEN_REQUEST: candidate abc123 has no baseline. Cannot compare. Lead must provide the baseline. No write ownership retained.";
export const disposition = "Resolve the missing baseline for the originating review: use base def456 with candidate abc123. Peer B owns review, return findings when complete. Peer A's blocker is resolved.";

export function agent(id = "peer-a", parentAgentId: string | null = "lead", provider = "codex-peer"): PluginHookAgent {
  return { id, parentAgentId, provider, cwd: "/sanitized/project", workspaceId: "workspace", title: null };
}

// Sanitized from genuine Meetless mcp_tool_call_end invocation/result structure,
// projected through Paseo 0.8's MCP mapper. No original prompt, IDs or paths remain.
export function send(recipient = "peer-b", prompt = disposition, callId = "send-1"): ToolCallTimelineItem {
  return {
    type: "tool_call", callId, name: "paseo.send_agent_prompt", status: "completed", error: null,
    detail: {
      type: "unknown", input: { agentId: recipient, background: true, notifyOnFinish: true, prompt },
      output: { content: [], structuredContent: { success: true, status: "running", lastMessage: null, permission: null, guidance: "Sanitized guidance" } },
    },
  };
}

export function peerTurn(turnId: string | null = "peer-turn", id = "peer-a"): TurnEnded {
  return {
    agent: agent(id), turnId, outcome: { kind: "completed" }, timeline: [
      { type: "user_message", text: "Old unrelated brief" },
      { type: "assistant_message", text: "Old unrelated response" },
      { type: "user_message", text: brief, messageId: "latest-user" },
      { type: "reasoning", text: "PRIVATE REASONING MUST NEVER LEAVE" },
      { type: "assistant_message", text: "Intermediate commentary is not the handback" },
      { ...send("outsider", "PRIVATE TOOL INPUT"), name: "unrelated.tool" },
      { type: "assistant_message", text: handback },
    ],
  };
}

export function leadTurn(messages: AgentTimelineItem[] = [send()], turnId = "lead-turn"): TurnEnded {
  return {
    agent: agent("lead", null, "codex-lead"), turnId, outcome: { kind: "completed" },
    timeline: [send("peer-a", "OLD SEND", "old-call"), { type: "user_message", text: "Handle the review" }, ...messages],
  };
}

function choice<T extends string>(selected: T, options: readonly T[], confidence = 0.99) {
  return { type: "choice" as const, choice: selected, confidence,
    probabilities: Object.fromEntries(options.map((key) => [key, key === selected ? 0.98 : 0.02 / (options.length - 1)])) as Record<T, number> };
}
export function assessment(handling: Assessment["leadHandling"]["choice"] = "pending", briefChoice: Assessment["leadBrief"]["choice"] = "satisfied", peerChoice: Assessment["peerResponse"]["choice"] = "satisfied"): Assessment {
  return {
    leadBrief: choice(briefChoice, ["satisfied", "drift", "unknown"]),
    peerResponse: choice(peerChoice, ["satisfied", "drift", "unknown"]),
    leadHandling: choice(handling, ["handled", "pending", "drift", "unknown"]),
  };
}
export function response(answers = assessment()) {
  return { model: "jev-1.13.0", answers, usage: { input_tokens: 100, output_tokens: 20 } };
}
export function evidence(): Evidence {
  return { leadId: "lead", peerId: "peer-a", peerTurnId: "peer-turn", brief, handback, roomMessages: [], uncertainRoomMessages: [], pendingDelayElapsed: false, incompleteCommunication: false };
}
export function mockContext() {
  const sendPrompt = vi.fn(async (_text: string) => {});
  const refresh = vi.fn(async (id: string) => ({ agent: {
    id, provider: id === "supervisor" ? "codex-supervisor" : id.startsWith("lead") || id === "other-lead" ? "codex-lead" : id === "outsider" ? "other-provider" : "codex-peer",
    ...(id === "supervisor" ? {
      status: "idle" as "initializing" | "idle" | "running" | "error" | "closed",
    } : {}),
    archivedAt: null as string | null,
    labels: { "paseo.parent-agent-id": id === "peer-2" ? "lead-2" : id === "unrelated-peer" ? "other-lead" : "lead" },
  } }));
  const ref = vi.fn((id: string) => ({ send: sendPrompt, refresh: () => refresh(id) }));
  const hookAbort = new AbortController();
  const context = { paseo: { agents: { ref } }, signal: hookAbort.signal } as unknown as PluginHookContext;
  return { context, sendPrompt, refresh, ref, hookAbort };
}
export async function settle() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
