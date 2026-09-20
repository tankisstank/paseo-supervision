# Repaired candidate handoff — 2026-09-20

Status: **DONE implementation; technical acceptance remains with Lead. Write ownership released at handoff.** No commit, publication, installation or live Supervisor/Jev call was made.

## Identity and base

Original base: new empty Git repository with an unborn HEAD (no base commit). Only the pre-existing `.git/` directory existed when work began. All deliverable files below are new; no unrelated files were modified.

Repair base: uncommitted source snapshot `4254056410a384330646add33b515094f6a928eae0a77f9ccbf1df0c059e8eb6`, rejected after independent review for end-arrival chronology and loss of delivered sends in failed/canceled Lead turns. The review handback was read before this repair. Both accepted findings are addressed below; product scope is unchanged.

Deterministic source snapshot SHA-256:

```text
2f0d462376afee79e94d5d112844eaf9ae5e4782bd0da97445f6ca4fb6b56dde
```

This identifies every deliverable below **except this verification report**, avoiding a self-referential hash. Reproduce from the repository root using Node 22:

```sh
node --input-type=module - <<'NODE'
import fs from 'node:fs';
import crypto from 'node:crypto';
const paths = [
  '.gitignore', '.npmrc', 'LICENSE', 'README.md', 'docs/INPUT_SHAPES.md',
  'index.server.ts', 'package-lock.json', 'package.json', 'paseo-plugin.json',
  'server/communication.ts', 'server/config.ts', 'server/jev.ts', 'server/observer.ts',
  'tests/communication.test.ts', 'tests/fixtures.ts', 'tests/jev.test.ts',
  'tests/observer.test.ts', 'tsconfig.json',
].sort();
const hash = crypto.createHash('sha256');
for (const path of paths) {
  hash.update(path); hash.update('\0');
  hash.update(fs.readFileSync(path)); hash.update('\0');
}
console.log(hash.digest('hex'));
NODE
```

## Exact repair paths

Only these existing files were changed in the bounded repair:

```text
README.md
docs/INPUT_SHAPES.md
docs/VERIFICATION.md
server/communication.ts
server/jev.ts
server/observer.ts
tests/communication.test.ts
tests/fixtures.ts
tests/jev.test.ts
tests/observer.test.ts
```

The complete candidate remains these uncommitted deliverables relative to the original empty base:

```text
.gitignore
.npmrc
LICENSE
README.md
docs/INPUT_SHAPES.md
docs/VERIFICATION.md
index.server.ts
package-lock.json
package.json
paseo-plugin.json
server/communication.ts
server/config.ts
server/jev.ts
server/observer.ts
tests/communication.test.ts
tests/fixtures.ts
tests/jev.test.ts
tests/observer.test.ts
tsconfig.json
```

Generated, ignored local installation/cache directories: `node_modules/` and `.npm-cache/`. These are not candidate source. No raw private evidence is included in the repository.

## Verification environment and results

Environment: macOS (`darwin`), arm64, Node `v22.22.3`, npm `10.9.8`. Installed exact package versions: `@getpaseo/client`, `@getpaseo/plugin`, `@getpaseo/protocol` all `0.8.0`; Zod `4.4.3`; TypeScript `5.9.3`; Vitest `4.1.6`; `@types/node` `22.19.15`.

Final repair checks, run from the repository root:

| Command | Actual result |
| --- | --- |
| `npm test` | Exit 0, 3 test files, **87 tests passed** (18 added to the original 69) |
| `npm run typecheck` | Exit 0, strict TypeScript, no diagnostics |
| `npm pack --dry-run --ignore-scripts --cache .npm-cache` | Exit 0; server-only entry/modules, license and documentation selected; no tarball written or package published |

Dependency files were not changed in the repair. Prior candidate checks retained as historical evidence, not claimed rerun: `npm ci --ignore-scripts --cache .npm-cache --no-audit --no-fund` exited 0 with 59 packages installed from the lockfile; `npm ls --depth=0` exited 0 with expected pinned dependencies. All repair test/typecheck runs passed.

An initial `npm install --ignore-scripts --cache .npm-cache --no-audit --no-fund` failed inside npm's automatic peer resolver (`Cannot read properties of null (reading 'edgesOut')`). The initial typecheck consequently failed with `tsc: command not found`. The server-only `.npmrc` now uses `legacy-peer-deps=true` to avoid installing React Native tooling, with the client SDK explicitly included for type resolution. A subsequent install and the clean `npm ci` above both passed. No failed check is being represented as a pass.

During original implementation, the installed Paseo mapper was invoked read-only using a sanitized genuine Meetless invocation structure. Its observed normalized recipient/prompt fields match the tested fixture. During repair, installed v0.8 lifecycle declarations and the source emitter were inspected read-only: starts expose nullable turn IDs, and all three terminal outcomes carry timelines. See [INPUT_SHAPES.md](INPUT_SHAPES.md) for the SDK source identity, exact shape and limits. The tests themselves do not depend on private files or another checkout.

## Accepted review findings and repair proof

1. **Causal chronology repaired.** `agent.turn_started` is now registered alongside `agent.turn_ended`. Matching non-null IDs record start capture order. Each case records handback capture order before queueing; only a strictly later matching Lead start permits messages into subsequent `roomMessages`. Overlap, missing/mismatched starts and null IDs retain confirmed messages separately in `uncertainRoomMessages`. A local gate forces unknown and prohibits both closure and alerts for those cases, even with a confident synthetic Jev verdict. Duplicate starts preserve the earliest observation. Both hooks and start state are cleaned up on stop.

   Regressions in `tests/observer.test.ts` cover overlapping turns under both handled/drift verdicts, absent/mismatched/null/other-actor starts, non-overlap closure and handling-drift alert, and different chronology for two handbacks around one Lead start with identical wall-clock times and before queue processing. The lifecycle registration test exercises the start/end callbacks. `tests/jev.test.ts` verifies that uncertain chronology blocks every drift dimension and closure even alongside valid subsequent messages.

2. **Failed/canceled deliveries retained.** Lead terminal outcome no longer gates extraction; each send must independently satisfy the existing successful-delivery checks. Peer handbacks still require completed turns. Recognized uncertain or malformed sends keep the evidence incomplete, while separately confirmed sends remain retained. Every captured Lead end arrival invalidates a stale in-flight judgment synchronously, independent of containing outcome or later recipient lookup.

   Regressions in `tests/communication.test.ts` cover confirmed plus malformed sends in failed/canceled turns. `tests/observer.test.ts` covers retained repairs and case closure from each outcome, mixed confirmed/uncertain sends with no alert, failed/canceled arrival during an in-flight drift evaluation, and unknown-start arrival invalidating a stale judgment while leaving the case open. All use mocks; no live messages were sent.

## What the checks establish

- Full latest Peer brief/final handback extraction; omission of reasoning, tools and older messages; complete Lead send extraction with recipient identity and successful output validation.
- Supervisor/non-room filtering; parent-Lead scope and explicit legacy allowlist behavior; invalid config fails before registration.
- Synchronous start/end hook capture, independent plugin lifetime signal, serialized model calls, fresh-evidence invalidation of stale judgments including failed/canceled Lead ends.
- Chronologically eligible cross-Peer disposition closes an origin case; room communication accumulates across sends; overlap/unknown starts cannot close or alert; replayed events/calls do not duplicate evidence/alerts.
- Typed HTTP contract with pinned model/official endpoint, local schema and probability validation, redirects rejected, transport/JSON/schema/low-confidence/ambiguous/error outcomes suppressed.
- Direct unobservable action/silence never becomes handling-only drift; one timer services only cases due for their single silence check.
- Evidence-bearing alert routed only to the configured Supervisor; failed/uncertain sends are not retried; stop removes hook/timers, aborts HTTP and detaches SDK waits.
- An integration-style test exercises the real entry and real evaluator with mocked lifecycle, HTTP and Paseo. No test makes a live network request or changes agents.

## Residual limits and downstream use

Usable downstream input: complete uncommitted server-only source, lockfile, sanitized fixtures, offline regression suite, install/config/privacy documentation and this deterministic candidate identity.

Unverified: real daemon loading, credential validity, official service response behavior under the configured account, real Supervisor delivery, model accuracy/calibration and resistance to adversarial message content. No artifact correctness or acceptance is claimed. Installation and live evaluation require a separate authorized operator decision.

Design limits retained: best-effort future hooks only; latest-user/final-assistant turn approximation without per-item turn IDs; observed start/end order assumes faithful lifecycle delivery and is not per-send timestamp reconstruction. Missing or overlapping starts conservatively make correlation unknown, even if a send actually followed a handback within an overlapping turn. Such uncertainty remains for the case lifetime and is not erased by later messages. Parent metadata does not authenticate message authors; only the inspected structured tool shapes are supported; incomplete communication stays unknown. Complete messages may contain sensitive data and require authorization before external transmission. Unknown outcomes are intentionally silent.

State is entirely in memory and grows for process lifetime; no restart recovery or persistent duplicate prevention. Restart loses pending obligations. An already issued SDK send cannot be canceled or retracted. The configured delay is not a deadline violation detector. All are documented limits, not passed acceptance claims.
