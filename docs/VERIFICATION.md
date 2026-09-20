# UI-selected Supervisor candidate handoff — 2026-09-20

Status: **accepted for offline candidate status; not installed or live-accepted**.
This candidate extends the previously accepted dynamic-room implementation with
plugin-owned Supervisor selection and notification routing. It makes no Paseo
core changes.

## Identity and scope

Base: `f93c139070bcf322355930a82cb3f4236aed55de`.

Deterministic source snapshot SHA-256, excluding this self-referential report:

```text
04f8ac09c41a348a753a701f40a800591c90dc3bec301a2c92d2707ad1899b3a
```

The working tree contains both the accepted dynamic-room changes and this new
client/settings/RPC layer. It has not been committed or pushed.

## Decision and resulting contract

- `PASEO_SUPERVISION_SUPERVISOR_ID` is removed. Supplying it has no effect.
- A user opens an active `codex-supervisor` thread and runs **Set this thread as
  Supervisor** from Paseo's agent-context Command Center.
- Paseo host-scoped plugin settings persist enabled state, selected agent ID,
  display title and workspace ID. The selected workspace gets a plugin header
  bell menu for settings and disable; the settings screen supports enable,
  disable and unset.
- A typed client-to-server RPC synchronizes the persisted selection. The server
  refreshes the selected agent and accepts only an active exact
  `codex-supervisor` provider. It refreshes again immediately before alert
  delivery. Archive and invalid-provider states fail closed.
- Explicit updates first prepare a process-local token and disable the old
  runtime route, then persist settings, then commit that exact token. Any
  persistence/RPC interruption remains disabled. Once an explicit update begins,
  stale bootstraps are blocked for the rest of that server process. Any stale
  explicit commit invalidates the current generation and disables an already
  active or in-flight concurrent route; clients surface the conflict and require
  retry.
- Paseo 0.8 exposes no server-side read/watch API for plugin settings. After a
  daemon/plugin restart, routing remains disabled until a Paseo client loads
  this plugin and performs bootstrap synchronization. It then remains active
  when that client disconnects.
- The built-in **Workspace actions** menu is not modified. Paseo 0.8 provides no
  plugin contribution point for it; the supported UI is Command Center,
  settings and a workspace-header menu.

## Verification

Environment: macOS arm64, Node `v22.22.3`, npm `10.9.8`, Paseo SDK/protocol
packages `0.8.0`.

| Command/check | Observed result |
| --- | --- |
| `npm run typecheck` | Exit 0; strict client/server TypeScript, no diagnostics |
| `npm test` | Exit 0; 4 files, **113 tests passed** |
| Paseo source `compilePlugin({client, server})` | Exit 0; both client and server bundles produced |
| `npm pack --dry-run --ignore-scripts --cache .npm-cache` | Exit 0; 15 expected files selected; nothing published |
| `git diff --check` | Exit 0 |

New regressions cover disabled startup, token-bound explicit synchronization,
closed/error/provider validation, archive-before-alert suppression, stale
bootstrap during in-flight update, failed persistence after prepare, provider
role collisions, competing set/unset commits before and after activation,
settings defaults, selectable-agent rules and bootstrap intent.
The existing dynamic discovery, room isolation, archive and
restoration races, chronology gates, extraction, Jev validation and delivery
tests remain green.

The Paseo compiler check used the local Paseo 0.8 source checkout and compiled
both entries without installing, enabling or reloading the plugin. No live Jev
request or Supervisor prompt was sent.

An independent review rejected superseded snapshot `c52ee4b…`: a stale
bootstrap could supersede an in-flight update, closed/error Supervisors were
accepted server-side, explicit persistence could leave the old runtime route
active, provider configuration could collide with `codex-supervisor`, and tests
did not cover those boundaries. The replacement implements prepare/commit
tokens, disables before persistence, validates status at sync and delivery,
forbids provider collisions, and adds focused regressions. Acceptance of the
replacement snapshot is recorded only after a new exact-snapshot review.

A second independent review rejected superseded snapshot `17e23968…`: client A
could persist unset after client B activated a newer recipient, then have A's
stale commit rejected without disabling B. The repaired server treats any
wrong-token explicit commit as a fail-closed invalidation of both active and
in-flight routes. Both controller paths now require `disabled` for unset and
surface `superseded` as a conflict. Regressions cover both post-activation and
held-validation interleavings.

The same read-only reviewer then ACCEPTED exact replacement snapshot
`2a55fc8b328c289c7b1bcc7803ebd6053ef865ee423d51c5ec086a7eaf528429`.
It confirmed that a stale commit clears an already activated concurrent route,
invalidates a held current validation before activation, and is surfaced as a
client failure for both set and unset. It reran 113 tests, strict typecheck and
diff checking; the snapshot hash matched before and after review. Paseo compiler,
pack dry-run, live daemon and UI interaction were not independently rerun by the
reviewer; compiler and pack checks above are writer evidence.

Before commit, README received a documentation-only first-run runbook covering
load diagnostics, set/unset UI checks, restart bootstrap and the external-data/
cost boundary for an optional end-to-end alert test. No runtime, test, manifest
or dependency bytes changed after the accepted code snapshot. The resulting
source snapshot is `04f8ac09c41a348a753a701f40a800591c90dc3bec301a2c92d2707ad1899b3a`;
Lead reviewed and accepted the runbook delta.

## Remaining limits

- No live daemon loading, visual mobile/desktop interaction, save/reopen test,
  real Jev compatibility or end-to-end notification delivery has been verified.
- A client must load after each daemon/plugin restart before alert routing can
  resume. Until then, observation/evaluation may run but alert delivery is
  deliberately silent.
- Built-in settings persistence and runtime commit are not one atomic
  transaction. The prepare protocol guarantees the old route is already off,
  so interruption cannot continue delivery to the wrong recipient. It can leave
  runtime routing disabled until the user retries set/unset or restarts the
  daemon and a client bootstraps persisted settings.
- Pending cases, timers and deduplication remain process-local. Historical turns
  are not replayed, and the documented lifecycle ordering boundary still
  applies.

No install, enable, reload, commit, push, external service call or Paseo core
write was performed for this candidate.
