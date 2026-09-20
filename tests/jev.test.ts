import { afterEach, describe, expect, it, vi } from "vitest";
import { createEvaluator, decision, parseAssessment, questions } from "../server/jev.js";
import { assessment, config, evidence, response } from "./fixtures.js";

afterEach(() => vi.useRealTimers());
describe("Jev HTTP and local validation", () => {
  it("sends typed questions and complete communication only to the fixed endpoint", async () => {
    const http = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(response())));
    expect(await createEvaluator(config, http)(evidence(), new AbortController().signal)).toEqual(assessment());
    const [url, options] = http.mock.calls[0]!;
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(options).toMatchObject({ method: "POST", redirect: "error" });
    expect(JSON.parse(String(options?.body))).toEqual({ model: "jev-1.13.0", state: evidence(), questions });
    expect(Object.values(questions).every((q) => q.type === "choice")).toBe(true);
  });
  it.each([401, 422, 429, 500, 529])("HTTP %i is unknown without retry", async (status) => {
    const http = vi.fn<typeof fetch>(async () => new Response('{"error":"max_tokens_exceeded"}', { status }));
    expect(await createEvaluator(config, http)(evidence(), new AbortController().signal)).toBeNull();
    expect(http).toHaveBeenCalledTimes(1);
  });
  it.each(["not JSON", '{"error":"max_tokens_exceeded"}', '{}'])("malformed/error response is unknown: %s", async (body) => {
    const http = vi.fn<typeof fetch>(async () => new Response(body));
    expect(await createEvaluator(config, http)(evidence(), new AbortController().signal)).toBeNull();
  });
  it("network failure is unknown", async () => {
    const http = vi.fn<typeof fetch>(async () => { throw new Error("sensitive response"); });
    expect(await createEvaluator(config, http)(evidence(), new AbortController().signal)).toBeNull();
  });
  it("aborts after 15 seconds and on plugin stop", async () => {
    vi.useFakeTimers();
    const http = vi.fn<typeof fetch>((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const run = createEvaluator(config, http)(evidence(), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await run).toBeNull();
    const stop = new AbortController();
    const second = createEvaluator(config, http)(evidence(), stop.signal);
    stop.abort();
    expect(await second).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not call HTTP with an already aborted signal", async () => {
    const http = vi.fn<typeof fetch>();
    const stopped = new AbortController();
    stopped.abort();
    expect(await createEvaluator(config, http)(evidence(), stopped.signal)).toBeNull();
    expect(http).not.toHaveBeenCalled();
  });
  it.each(["unknown-choice", "nan", "range", "sum", "tie", "wrong-max", "missing-option", "extra-option", "missing-answer", "extra-error"])("rejects invalid response: %s", (kind) => {
    const raw = JSON.parse(JSON.stringify(response())) as Record<string, any>;
    const a = raw.answers.leadBrief;
    if (kind === "unknown-choice") a.choice = "whatever";
    if (kind === "nan") a.confidence = NaN;
    if (kind === "range") a.confidence = 2;
    if (kind === "sum") a.probabilities.satisfied = 0.5;
    if (kind === "tie") a.probabilities = { satisfied: 0.5, drift: 0.5, unknown: 0 };
    if (kind === "wrong-max") a.choice = "drift";
    if (kind === "missing-option") delete a.probabilities.unknown;
    if (kind === "extra-option") a.probabilities.extra = 0;
    if (kind === "missing-answer") delete raw.answers.peerResponse;
    if (kind === "extra-error") raw.error = "max_tokens_exceeded";
    expect(parseAssessment(raw)).toBeNull();
  });
});

describe("conservative decisions", () => {
  it("uncertain chronology blocks closure and every drift dimension even alongside subsequent sends", () => {
    const message = { callId: "send", recipient: "peer-b", prompt: "Complete message", leadTurnId: "turn" };
    const e = { ...evidence(), roomMessages: [message], uncertainRoomMessages: [{ ...message, callId: "uncertain" }] };
    for (const a of [assessment("handled"), assessment("drift"), assessment("pending", "drift"), assessment("pending", "satisfied", "drift")]) {
      expect(decision(a, e, 0.9)).toBe("unknown");
    }
  });
  it("allows confident brief/handback drift at first handback", () => {
    expect(decision(assessment("pending", "drift"), evidence(), 0.9)).toBe("drift");
    expect(decision(assessment("pending", "satisfied", "drift"), evidence(), 0.9)).toBe("drift");
  });
  it("never diagnoses silence/direct unobservable action as handling drift", () => {
    expect(decision(assessment("drift"), { ...evidence(), pendingDelayElapsed: true }, 0.9)).toBe("unknown");
    expect(decision(assessment("handled"), evidence(), 0.9)).toBe("unknown");
  });
  it("blocks low confidence, ambiguity, incomplete communication and transport errors", () => {
    const a = assessment("pending", "drift"); a.peerResponse.confidence = 0.89;
    expect(decision(a, evidence(), 0.9)).toBe("unknown");
    expect(decision(assessment("unknown", "drift"), evidence(), 0.9)).toBe("unknown");
    expect(decision(assessment("pending", "drift"), { ...evidence(), incompleteCommunication: true }, 0.9)).toBe("unknown");
    expect(decision(null, evidence(), 0.9)).toBe("unknown");
  });
  it("allows cross-Peer closure and respects repairs to earlier gaps", () => {
    const e = { ...evidence(), roomMessages: [{ callId: "send", recipient: "peer-b", prompt: "Resolved", leadTurnId: "turn" }] };
    expect(decision(assessment("handled", "drift"), e, 0.9)).toBe("handled");
    expect(decision(assessment("drift"), e, 0.9)).toBe("drift");
  });
});
