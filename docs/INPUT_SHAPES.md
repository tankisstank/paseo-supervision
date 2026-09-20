# Input-shape evidence

Read-only inspection on 2026-09-20 used the installed Paseo source/SDK reporting `0.8.0`, source checkout HEAD `b8e24677e12b226c7c38c1c3a40649daa9f1152f`. No Paseo files, agents, daemon settings or installed plugins were changed. Public npm SDK and protocol packages are pinned to `0.8.0` in this repository's lockfile.

Inspected source paths, relative to the Paseo checkout:

- `packages/plugin/src/server/lifecycle.ts`: `agent.created` and `agent.archived` expose the role provider and nullable parent ID; `agent.turn_started` contains `agent` and nullable `turnId`; `agent.turn_ended` also contains outcome and full readonly timeline. Callback returns `void | Promise<void>` and receives `{ paseo, signal }`. These signatures were rechecked against installed `@getpaseo/plugin@0.8.0` declarations during the dynamic-discovery repair.
- `packages/server/src/server/plugins/lifecycle/index.ts`, `publishAgentStream`: emits start hooks from `turn_started`; completed, failed and canceled terminal events all emit end hooks with the timeline and `event.turnId ?? null`. A terminal failure does not say whether an individual earlier tool send succeeded.
- `packages/protocol/src/agent-types.ts`: message text is stored in `user_message.text` / `assistant_message.text`. Tool calls have `callId`, `name`, `status`, `error`, `detail`; unknown detail preserves `input` and `output`. Timeline items do not expose turn IDs.
- `packages/server/src/server/agent/tools/paseo-tools.ts`: `send_agent_prompt` uses `agentId` and `prompt`; successful output has `structuredContent.success === true`.
- `packages/server/src/server/agent/providers/codex/tool-call-mapper.ts`: `mapMcpToolCallItem` builds `server.tool` names and passes structured arguments through. `mapCodexToolCallFromThreadItem` provides the normalized timeline shape.
- `packages/server/src/server/agent/providers/codex/tool-call-detail-parser.ts`: unrecognized tool details preserve full input/output under `type: "unknown"`.
- `packages/client/src/index.ts`: `agents.ref(id).refresh()` returns an agent snapshot; `send(text)` returns `Promise<void>` without an abort-signal option.
- `packages/protocol/src/agent-labels.ts`: parent membership label is `paseo.parent-agent-id`.
- `packages/plugin/src/client/contracts.ts` and `buttons.ts`: client plugins can add settings screens, agent-context Command Center actions and workspace header menus. Paseo 0.8 does not expose an extension point for the built-in workspace-actions menu.
- `packages/plugin/src/settings.ts` and `packages/server/src/server/plugins/settings/index.ts`: host-scoped plugin settings persist atomically and are available through typed settings RPCs. `PluginServerContext.registerSettings()` does not return a server-side reader or change subscription, so the plugin client is the documented bootstrap bridge into the observer's typed synchronization RPC.

A genuine local Meetless Lead session record contained `event_msg` / `mcp_tool_call_end` with `invocation.server = "paseo"`, `invocation.tool = "send_agent_prompt"` and **structured object** arguments. The observed argument keys/types were `agentId: string`, `background: boolean`, `notifyOnFinish: boolean`, `prompt: string`. Result `Ok` contained `content` and `structuredContent`; the latter contained `success`, `status`, `lastMessage`, `permission`, `guidance`.

The installed mapper was invoked read-only with the observed invocation structure, replacing identities and complete message contents with synthetic values before printing anything. Its actual result was:

```json
{
  "type": "tool_call",
  "callId": "sanitized-call",
  "name": "paseo.send_agent_prompt",
  "status": "completed",
  "error": null,
  "detail": {
    "type": "unknown",
    "input": {
      "agentId": "peer-b",
      "background": true,
      "notifyOnFinish": true,
      "prompt": "Complete sanitized communication."
    },
    "output": {
      "content": [],
      "structuredContent": {
        "success": true,
        "status": "running",
        "lastMessage": null,
        "permission": null,
        "guidance": "Sanitized guidance"
      }
    }
  }
}
```

`tests/fixtures.ts` uses this normalized structure with wholly synthetic protocol messages. No private transcript, native session identifiers, credentials, personal paths or original project content is copied into the fixtures. The legacy envelope alias and JSON-string input are defensive compatibility cases, not additional genuine sessions claimed as evidence.

Conclusion: the inspected v0.8 structured send shape supports recipient/full-prompt extraction without parsing executable wrappers or selecting semantic excerpts. This evidence does **not** prove every provider exposes the same shape or that a latest-user window always equals a complete turn. Those limits remain explicit in README; no live daemon history RPC or Jev request was used.

Dynamic topology boundary: the plugin observes every `agent.created` event, identifies Leads and Peers by their configured provider names, and accepts a Peer only under its daemon-owned `paseo.parent-agent-id` relationship. Every `agent.archived` increments that ID's archive generation, removes room state and invalidates queued or in-flight work. Since creation events are not replayed when a plugin reloads, a later Peer turn can self-heal discovery only after a read-only refresh verifies that its parent is active and uses the Lead provider. Paseo 0.8 may restore the same archived ID without emitting `agent.created`; a later turn clears the archive generation only after a new post-archive start is observed, `refresh()` reports `archivedAt === null` for the actor and any tombstoned parent, and the generation remains unchanged across the asynchronous refresh. `cwd` and workspace identity are deliberately not topology signals.

Repair boundary: match observed Lead start/end hooks by non-null turn ID and compare start capture order with each Peer handback's capture order. Only strictly later starts permit subsequent handling. Overlap or unavailable matching starts preserve full confirmed prompts as chronology-uncertain evidence and locally prohibit closure/alert. Failed/canceled Lead turns use the same per-send confirmation checks as completed turns; uncertain recognized sends still mark the case incomplete. No live service or daemon mutation was needed to validate these lifecycle contracts.
