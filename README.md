# paseo-supervision

A public, Apache-2.0 Paseo 0.8 plugin that dynamically observes communication between discovered Leads and their Peers. Jev assesses Lead briefs, Peer handbacks and subsequent Lead handling. Only sufficiently confident suspected protocol drift produces a prompt to the Supervisor thread selected in the plugin UI.

This is communication supervision, **not artifact review or acceptance**. A Peer identifies where an obligation originated; Lead communication to any Peer in the room can handle it. No direct reply to the originating Peer is not drift. Ambiguous cross-Peer handling is unknown.

## Install and configure

Requires Paseo 0.8.x and Node 22+. The manifest declares `^0.8.0`; SDK/protocol development dependencies are pinned to `0.8.0`. The plugin has a client settings screen and Command Center actions, but no dashboard, agent tool or MCP server.

Clone/download this source to a directory on the daemon machine, then validate it:

```sh
cd /absolute/path/to/paseo-supervision
npm ci --ignore-scripts
npm test
npm run typecheck
```

Paseo supplies host runtime modules; the checked-in client dependencies exist for strict local typechecking. The entries require no build step.

Set these variables in the **Paseo daemon process environment**, not merely the shell used to run the plugin CLI. A service/desktop launcher may need its own environment configuration and restart. This plugin does not load `.env` files or change daemon configuration.

| Variable | Requirement/default |
| --- | --- |
| `JEV_API_KEY` | Required Jev bearer credential; keep out of source control |
| `PASEO_SUPERVISION_LEAD_PROVIDER` | `codex-lead` |
| `PASEO_SUPERVISION_PEER_PROVIDER` | `codex-peer` |
| `JEV_ENDPOINT` | Optional; only `https://api.typesafe.ai/v1/systemone` is accepted |
| `JEV_MODEL` | `jev-1.13.0`; only version-pinned `jev-N.N.N` names accepted, not moving aliases |
| `PASEO_SUPERVISION_PENDING_DELAY_MS` | `60000`; integer from 1000 through 86400000 |
| `PASEO_SUPERVISION_ALERT_CONFIDENCE` | `0.9`; number from 0.5 through 1 |

Lead and Peer IDs are never configured. The plugin discovers role agents from `agent.created`, removes their active state on every `agent.archived`, and uses `parentAgentId === leadId` (the `paseo.parent-agent-id` label) as the authoritative room relationship. Turn events self-heal discovery after plugin reload, but a previously unseen Peer is accepted only after its parent refreshes as an active Lead provider. Paseo can restore an archived ID without another creation event; the first later turn is accepted only after a new post-archive turn start is observed and `refresh()` verifies that the actor and any tombstoned parent are active again. Archive generations prevent an older refresh result from clearing a newer re-archive. Same workspace, working directory or provider alone is **not** room membership. Peers without a parent and descendants of Peers are not included.

After installation, open the intended `codex-supervisor` thread and run **Set this thread as Supervisor** from the Command Center. Paseo stores the selected thread in host-scoped plugin settings. A bell button then appears in that workspace header; its menu opens settings or disables notifications. The Supervision settings screen can also enable, disable or unset the route. Only an active agent whose exact provider is `codex-supervisor` is accepted. Archiving the selected thread disables runtime routing; the plugin never silently falls back to another thread.

Paseo 0.8 does not expose persisted plugin settings directly to a server contribution. To remain plugin-only, the client reads the setting and synchronizes it through a typed plugin RPC whenever the client plugin loads or the selection changes. After a daemon/plugin restart, supervision is intentionally silent until any Paseo client loads the plugin. The synchronized route remains active if that client later disconnects. This is a known availability limitation, not a core modification.

An explicit set/unset is fail-closed across the client/settings boundary: the client first obtains a process-local update token while the server disables the old route, then writes settings, then commits that exact token. Stale bootstraps cannot replace an in-progress update. Any stale or superseded explicit commit invalidates the current generation and disables runtime routing, including when another client already activated a recipient. If the client stops, loses a concurrency race, or persistence/RPC fails between steps, routing remains disabled rather than diverging from persisted settings. The user must retry an explicit set/unset, or restart the daemon and let a client bootstrap the persisted setting.

After reviewing the external-data and cost implications below, an operator can install/enable the plugin:

```sh
paseo plugin add /absolute/path/to/paseo-supervision
# After source edits:
paseo plugin reload paseo-supervision
# To stop observing:
paseo plugin disable paseo-supervision
```

These commands are instructions, **not actions performed during development**. Adding the plugin immediately enables observation and may make Jev requests; Supervisor prompts remain disabled until a client synchronizes an enabled selection. Invalid/missing daemon configuration throws a field-name-only error before settings, RPC or hook registration; no requests or sends occur. Invalid credentials, unknown model names at the service, and unavailable agents are runtime unknowns, not locally verifiable configuration failures. After environment changes, restart the daemon with the new environment; plugin reload alone cannot update its inherited environment.

## First run and validation

Use these checks in order so loading/UI failures do not get confused with Jev or notification-delivery behavior.

1. Start or restart the Paseo daemon with `JEV_API_KEY` and any optional variables above in the daemon's environment, then install the plugin.
2. Confirm Paseo sees it and inspect startup diagnostics:

   ```sh
   paseo plugin ls paseo-supervision
   paseo plugin logs paseo-supervision
   ```

   Resolve any configuration or compilation error before continuing. Do not expect an alert recipient yet.
3. Open an active thread whose provider is exactly `codex-supervisor`. In Paseo's Command Center, run **Set this thread as Supervisor**. The command rejects Lead, Peer, closed and errored threads.
4. Confirm a bell appears in that thread's workspace header. Open **Supervision** in plugin settings and verify the selected title/agent ID and enabled state. This proves client settings persistence and the client-to-server synchronization path without deliberately creating protocol drift.
5. Exercise **Disable notifications** from the bell menu or **Unset** from settings. The bell should disappear in the current client. Select the thread again before any end-to-end delivery test.
6. For restart persistence, restart/reload the daemon, then open a Paseo client. Routing intentionally remains silent until that client loads the plugin; the persisted selection should then restore the workspace bell. If an update was interrupted or lost a concurrency race, explicitly select the Supervisor again.

An end-to-end alert test is optional and has external-data/cost effects: in an authorized disposable Lead/Peer room, create a genuine communication-protocol drift case and wait through the configured pending delay. Confirm that only the selected Supervisor thread receives the structured review prompt. This sends captured communication to Jev, is model-dependent, and is not deterministic; no alert is **not** proof of healthy supervision. Use plugin logs and the offline tests to distinguish loading/configuration failures from a silent unknown assessment.

To stop the live check, disable the plugin:

```sh
paseo plugin disable paseo-supervision
```

## Architecture and decisions

Client set/unset → prepare token and disable old route → persist host setting → token-bound commit → active `codex-supervisor` validation → runtime recipient. Client startup uses a guarded bootstrap path. Separately, `agent.created` / `agent.archived` maintain dynamic room membership and archive generations. `agent.turn_started` + `agent.turn_ended` → synchronous chronology/communication capture scoped by discovered Lead → serialized background queue → active-state verification after restoration → typed Jev questions → local validation → optional Supervisor prompt.

Hooks are best-effort and have a 30-second host deadline. Callbacks return `void` immediately after capture/enqueue: no HTTP/SDK work is awaited there. A separate plugin-lifetime abort signal governs background work, not the hook's expiring signal. New end-event evidence, including failed/canceled Lead turns and chronology-uncertain sends, invalidates an in-flight judgment before it can alert.

For a completed Peer turn, capture the full latest `user_message` as the brief and the full last `assistant_message` after it as the handback. Do not transmit intervening commentary, reasoning, other tool calls, or earlier history. Missing message boundaries or handbacks produce no case.

For every ended Lead turn—completed, failed or canceled—inspect outbound `paseo.send_agent_prompt` tool calls after its latest user message. The supported normalized v0.8 shape is `tool_call.detail.type === "unknown"`, with `{ agentId, prompt }` in `detail.input` and a successful MCP `detail.output.structuredContent.success`. The legacy `mcp__paseo__send_agent_prompt` name and JSON-string inputs are also accepted. Individual send success is independent of the containing turn outcome: a delivered repair is retained even if the turn later fails or is canceled. Failed, running, malformed or unconfirmed individual sends mark evidence incomplete; they are not treated as delivered communication. Executable wrappers, shell commands, arbitrary tool-name matches and final Lead prose are never parsed as sends.

Each recipient is checked through read-only SDK `refresh()` against the sending Lead's parent relationship. Complete prompts to that Lead's room Peers are retained for its open cases, regardless of the originating Peer, and never cross into another Lead's cases. A prompt enters `roomMessages` as subsequent handling **only if the matching non-null Lead turn ID has an observed start strictly after that case's captured Peer handback**. A monotonic callback-order counter, not wall-clock timestamps or queue processing time, establishes this ordering. Duplicate starts keep the earliest observation. Different open cases can therefore classify the same turn differently.

Overlapping turns and absent, mismatched or null-ID starts put confirmed deliveries in `uncertainRoomMessages`, not subsequent `roomMessages`. Jev is told that their chronology is unknown, and a local gate blocks both closure and alerts for any case retaining such evidence, regardless of Jev's confidence or choice. These cases remain unknown for their lifetime; later evidence does not erase prior uncertainty. A recipient lookup failure or malformed recognized send likewise marks evidence incomplete, while retaining any separately confirmed sends. Tool outputs, failure reasons, unrelated recipients and refresh metadata are not transmitted to Jev.

At first handback and subsequent relevant events, Jev receives three independent typed Choice questions: `leadBrief`, `peerResponse`, and `leadHandling`. The rubric checks applicable communication obligations rather than rigid prose templates: bounded delegation, usable handbacks, evidence/limits/ownership, and explicit handling of decisions, dependencies and blockers. It never asks Jev to certify an artifact. Questions treat message bodies as untrusted evidence.

One room-level timer gives each unresolved case at most one additional evaluation after its configured delay. The delay is a check opportunity, **not proof that silence is drift**. Unobservable direct Lead action remains pending/unknown. No further timer polling occurs for that case, though later communications can trigger evaluation.

Responses must include all three answers, valid choices, finite confidence/probabilities in `[0,1]`, a distribution summing approximately to 1, a unique highest-probability selected choice, model and token usage. Unknown choices, tied probabilities, any answer below the configured confidence, incomplete communication, HTTP errors, malformed JSON/schema, timeout, and `max_tokens_exceeded` all mean unknown/no alert. No automatic HTTP retries. Requests use the official fixed endpoint, pinned model and a 15-second abort timeout; redirects are rejected.

A confident `handled` disposition with observable room communication closes the case, including communication repairs to earlier gaps. Otherwise, a confidently identified brief/handback gap or an observable handling violation can alert. A handling-only drift result with no room messages is locally suppressed even if Jev claims certainty. An alert includes the case fingerprint, all three assessments and the full captured communication evidence; it explicitly requests review, not acceptance. Immediately before delivery, the selected recipient is refreshed and must still be active with provider `codex-supervisor`; otherwise routing is disabled and nothing is sent. Delivery uses `context.paseo.agents.ref(supervisorId).send(prompt)`.

Case/event/call fingerprints suppress duplicates **only within the current process**. The alert fingerprint is marked before sending; failed or timed-out sends have uncertain delivery and are not retried. Stop unregisters both hooks, aborts HTTP work, clears the timer and retained starts, drops queued work and releases retained state. SDK `refresh/send` waits are bounded to 15 seconds and detached on stop; the SDK offers no cancellation of an already issued send, so it cannot be retracted.

## Privacy, trust and limits

- Jev receives complete brief/handback/room-prompt bodies plus agent IDs, turn IDs, call IDs and case timing/visibility flags. The Supervisor receives the same communication evidence on an alert. Complete messages may themselves contain sensitive data. Only enable this with authorization to send that data to TypeSafe and the Supervisor.
- No semantic excerpts, redaction inside messages, raw full-session transmission, tool output or reasoning transmission. The plugin does not log credentials, project messages, HTTP bodies or raw exceptions; it creates no data files. Paseo and the services involved may independently retain prompts/requests under their own policies. This is not a secrecy boundary against the daemon host, and prompt-injection robustness is not established by these tests.
- The Supervisor selection is persisted by Paseo plugin settings, but runtime routing must be re-synchronized by a loaded client after restart. There is no database, pending-case restart recovery, task graph, artifact read, dashboard, core change, agent creation or tool registration. Unresolved cases, evidence and fingerprint sets remain in memory; restart loses them and may produce repeat alerts when evidence is observed again.
- Only future observed hooks are processed. Turn-event self-healing recovers role membership after reload but not historical communication. Missed turns, failed/canceled Peer turns, pre-install history, unsupported tool shapes, parentless Peers and communication outside Paseo are blind spots. Failed/canceled Lead turns are inspected for individually confirmed sends. Empty or unextractable Peer exchanges are skipped rather than called drift.
- v0.8 timeline items have no per-item turn IDs or final-message channel. Latest-user-message and final-assistant-message boundaries follow the supplied MVP contract. Multiple injected user messages within a turn, history compaction/replacement and commentary-only endings can be ambiguous. Lifecycle start/end ordering is a conservative correlation bound, not per-send execution-time reconstruction. A send in a turn overlapping the handback stays unknown even if it actually occurred afterward. Missing starts, including plugin startup mid-turn, cannot support subsequent handling. Ordering assumes faithful lifecycle delivery; no recovery of missed or reordered events is attempted.
- Parent membership associates the Peer with its Lead; the timeline user message does not authenticate its sender. The MVP assumes that the latest user message is the brief for that completed Peer turn. Manually created parentless agents are intentionally outside dynamic room discovery.
- Unknown is intentionally silent, so absence of alerts is not proof of protocol health. Confidence is Jev's model output, not measured detector accuracy. The offline tests prove extraction, routing and safety gates, not semantic accuracy, real-service compatibility, real daemon loading or end-to-end delivery.

## Development and evidence

`npm test` runs only mocked lifecycle/Paseo/Jev tests with synthetic message text in fixtures based on inspected genuine Meetless tool-record structure. No live network is used by tests. `npm run typecheck` checks both client and server entries with matching v0.8 SDK types. The [verification record](docs/VERIFICATION.md) identifies the candidate and observed checks; [input-shape evidence](docs/INPUT_SHAPES.md) records the read-only SDK investigation.

References: [Paseo plugin reference](https://paseo.sh/docs/plugins/reference), [TypeSafe HTTP API](https://docs.typesafe.ai/api), [TypeSafe Choice response semantics](https://docs.typesafe.ai/primitives/choice). These inform the integration; no live Jev call or plugin installation was performed for this candidate.

Licensed under [Apache-2.0](LICENSE).
