import { createHash } from "node:crypto";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { PluginHookAgent, PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { z } from "zod";
import type { Config } from "./config.js";

export type TurnEnded = PluginLifecycleEvents["agent.turn_ended"];
export type TurnStarted = PluginLifecycleEvents["agent.turn_started"];
export interface Outbound { callId: string; recipient: string; prompt: string }
export type Capture =
  | { kind: "peer"; id: string; peerId: string; turnId: string | null; brief: string; handback: string }
  | { kind: "lead"; id: string; turnId: string | null; messages: Outbound[]; incomplete: boolean };

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function isPeer(agent: Pick<PluginHookAgent, "id" | "parentAgentId" | "provider">, c: Config): boolean {
  if (agent.id === c.leadId || agent.id === c.supervisorId || agent.provider !== c.peerProvider) return false;
  return c.peerIds.length > 0 ? c.peerIds.includes(agent.id) : agent.parentAgentId === c.leadId;
}

const sendInput = z.object({ agentId: z.string().min(1), prompt: z.string().min(1) });
const names = new Set(["paseo.send_agent_prompt", "mcp__paseo__send_agent_prompt"]);

// v0.8 has no turn IDs on timeline items. Use its latest user-message boundary;
// never fall back to scanning older turns or to executing/parsing tool code.
export function latestTurn(timeline: readonly AgentTimelineItem[]): readonly AgentTimelineItem[] {
  const start = timeline.findLastIndex((item) => item.type === "user_message");
  return start < 0 ? [] : timeline.slice(start);
}

export function capture(event: TurnEnded, c: Config): Capture | null {
  if (event.agent.id === c.supervisorId) return null;
  if (event.agent.id !== c.leadId && !isPeer(event.agent, c)) return null;
  // A failed/canceled Lead turn can still contain successfully delivered sends.
  // Peer handbacks, unlike individual sends, require a completed turn.
  if (event.agent.id !== c.leadId && event.outcome.kind !== "completed") return null;
  const turn = latestTurn(event.timeline);
  const first = turn[0];
  if (first?.type !== "user_message") return null;
  if (event.agent.id !== c.leadId) {
    const final = turn.findLast((item) => item.type === "assistant_message");
    if (final?.type !== "assistant_message" || !first.text.trim() || !final.text.trim()) return null;
    return {
      kind: "peer", peerId: event.agent.id, turnId: event.turnId,
      id: fingerprint([event.agent.id, event.turnId, first.messageId, first.text, final.text]),
      brief: first.text, handback: final.text,
    };
  }
  const messages: Outbound[] = [];
  let incomplete = false;
  for (const item of turn) {
    if (item.type !== "tool_call" || !names.has(item.name)) continue;
    if (item.status !== "completed" || item.error !== null || item.detail.type !== "unknown") {
      incomplete = true;
      continue;
    }
    let input: unknown = item.detail.input;
    if (typeof input === "string") {
      try { input = JSON.parse(input); } catch { incomplete = true; continue; }
    }
    const parsed = sendInput.safeParse(input);
    if (!parsed.success) { incomplete = true; continue; }
    // Completion alone can still contain an MCP-level error. Do not transmit output.
    const output = z.object({
      isError: z.boolean().optional(),
      structuredContent: z.object({ success: z.literal(true) }),
    }).safeParse(item.detail.output);
    if (!output.success || output.data.isError === true) {
      incomplete = true;
      continue;
    }
    messages.push({ callId: item.callId, recipient: parsed.data.agentId, prompt: parsed.data.prompt });
  }
  return {
    kind: "lead", turnId: event.turnId,
    id: fingerprint([event.agent.id, event.turnId, first.messageId, messages, incomplete]),
    messages, incomplete,
  };
}
