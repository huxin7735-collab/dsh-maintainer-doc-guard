# Changelog

All notable changes to `dsh-maintainer-doc-guard` are recorded here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.5.2] — 2026-09-20

**Theme: each conversation (session) gets its own isolated, pre-populated
maintainer-document set; the side panel and its REST route are hardened so they
can no longer return an empty body.**

### Added — per-session documents
Documents are no longer shared across sessions in a workspace. The panel sends
the client `sessionId` and the server scopes the set to
`<workspace>/<docsDir>/<sanitized-sessionId>/` (default `<docsDir>` =
`.dsh-maintainer-doc-guard`). Every session opens with five blank, editable,
saveable documents, so reads are instant and two sessions in the same workspace
never collide on or mix the same file. `collectFound` no longer pre-creates a
workspace-level shared folder (that would be the shared set this change
removes). `docsDir` (config knob) and `sanitizeSession()` keep the folder name
safe (`..` and path separators are stripped).

### Changed — intent gate is now session-scoped, not re-armed every turn
The intent gate used to reset its "has the model said what this step is for"
ledger on every turn boundary, so a model doing correct work across many turns
was blocked at the open of each turn unless it re-typed ≥`minChars` of prose.
`textChars` now persists across turns and is reset **only when a new user
instruction arrives** (`noteUserMessage`) — the same event that re-anchors the
objective. A model states intent once, then works freely for the rest of the
session; a new user message re-arms the requirement because the task may have
changed. Per-turn deny/nudge budgets still reset, so a turn can never deadlock.

### Changed — drift reminder suppressed on well-narrated long turns
The drift reminder fired purely on step count (`afterSteps`), which nagged
normal long-but-productive tasks. It is now suppressed when the turn's
`textChars` already meets `minChars` — a turn the model is narrating well is, by
that same fact, not the "burned a whole turn on a side-quest" failure the
reminder targets.

### Added — destructive calls pulled into both gates
A new `isDestructiveTool()` matcher (whole-word `delete`/`remove`/`trash`/
`unlink`/`purge`/`wipe`, never the bare `rm`/`del` so names like `transform`
are safe) routes destructive tool calls through the same gates as writes:
- the **precedent gate** now requires a read precedent before a destructive call
  inside a guarded infrastructure area;
- the **intent gate** now requires stated intent before any destructive call
  (nudge-first), closing "deleted a file without saying what/why".

### Fixed — `maintainer/README.md` was never pre-created
`writeFileSync` does not create parent directories, so the nested `maintainer/`
subfolder failed with ENOENT and that one document was silently missing.
`ensureDocs` now `mkdirSync(dirname(target), {recursive:true})` before writing.

### Fixed — panel showed a cryptic "Unexpected end of JSON input"
Two independent defects caused an empty response body:
- the route's session-scoping variables (`lastSession`, `sanitizeSession`) were
  referenced but never declared, so a bare `GET` threw an uncaught
  `ReferenceError` and the harness returned an empty body;
- the browser `fetch` parsed the response as JSON without checking `response.ok`
  or guarding an empty body.

Both are now fixed: the variables are declared and `sanitizeSession` is defined;
the server's `GET /docs` handler is wrapped in a try/catch that always answers
with valid JSON (even on 500); and the client checks `response.ok`, reads the
body as text first, and throws a clear Chinese message instead of the opaque
one. If the panel still reports an empty body, the cause is a second/stale dsh
instance on the port — confirm only one dsh process is running.

### Note
- No new settings-page knob: the destructive and drift changes reuse existing
  thresholds (`minChars`, `afterSteps`) and the nudge-first staging.
- Where the documents are stored changed again (workspace-shared → per-session).
  Existing documents committed at the workspace root, or the old
  `.<docsDir>/` shared set, are not auto-migrated; move them into
  `.<docsDir>/<sessionId>/` (or set `docsDir` back to `.`) if you want to keep
  hand-authored ones.

---

## [0.5.1] — 2026-09-19

**Theme: the guard now behaves correctly *inside a delegated child*.**

0.5.0 shipped a single `includeSubagents` switch that gated both prompt sections at
once, and the objective anchor could never populate in a child at all. Reading the
subagent implementation showed why, and this release fixes the three gaps.

### Fixed — the anchor was always empty inside a child

The objective recorder only adopted a message when `source.kind === 'user'`, on the
assumption that a delegation is not stamped that way. It is: the harness delivers a
child's opening prompt through the ordinary user-message path, so a child's task
message is **indistinguishable from a human's by `source` alone**. The recorder now
discriminates positionally per lineage instead — a child adopts the **first** non-empty
user-role message once (its delegation) and keeps it; further messages from a real
sender do not silently replace the task it was handed. The top-level rule is unchanged:
the latest user message wins, and plugin/tool notices are still never adopted.

### Fixed — a child was shown the parent's objective under the parent's wording

Rendering "the user's latest instruction" inside a child inverts the precedence rule: the
child has no user instruction, and quoting the parent's objective invites it to chase the
original request instead of the task it was actually given. When the anchor is enabled for
children it now re-titles itself (`## Your delegated task — what you were sent here to do`)
and quotes the child's own delegation, under a precedence rule that names the delegated
task first. New `anchor.childTitle` / `anchor.childIntro` / `anchor.childPriorities`
override the wording.

### Changed — one coarse switch split into two independent policies

`includeSubagents` is replaced by two switches, because the two sections want opposite
answers inside a child — the documents are inherited and worth reading, the parent's
objective is not the child's task:

| contribution | knob | default | meaning |
|---|---|---|---|
| document reminder | `inSubagents` | off | `true` = also render in children and grandchildren |
| objective anchor | `anchor.inSubagents` | off | `true` = render the child's own delegation |

Only an explicit `true` opts in; the default, `false`, or a typo keeps a contribution at
the top level, so a mistake fails silent rather than leaking a parent's objective into a
child. A 0.5.0 composition that set `includeSubagents: true` keeps working — the old
spelling is still read as `inSubagents`.

### Changed — both subagent policies are composition-only

Neither is on the settings card. The card holds **exactly ten fields**, which is a hard
ceiling (an eleventh makes the whole card fail to mount), and delegation reach is a
per-deployment decision that belongs in `cordis.patch.yml`.

### Verified

Driven against the real module with a stub harness context: a depth matrix
(`undefined` / `0` / `1` / `2` × four switch combinations) and seven record-boundary cases
(latest-wins, plugin/tool notices ignored, delegation adopted once, `enabled: false`,
`{{ }}` sanitisation). Gates and the `session/event` observer were already
depth-independent and are unaffected by this change.

---

## [0.5.0] — 2026-09-18

**Theme: the guard now protects the *objective*, not only the *method*.**

The 0.4.0 gates policed *how* a step was taken (did you read a precedent first, did
you say what the step was for). Field use showed a failure mode they cannot cover:
a turn can pass every gate eight times and still end up doing something the user
never asked for, because the model quietly redefined its own task — treating a
lead it stumbled onto as if it were the assignment. This release adds a standing
statement of the objective, and softens the gates from "block" to "correct first".

### Added — objective anchor (new prompt section)

A second `systemPrompt.section`, registered at order `10150`, re-rendered on every
prompt assembly. It quotes the user's **latest instruction verbatim** in a
blockquote and states an explicit precedence rule:

> the user's latest instruction  &gt;  your own last stated plan  &gt;  a lead you found yourself

Design notes:

- **Only real user input is adopted.** The record is written from `session/event`
  `user/message` events, and only when `source.kind === 'user'`. Injected notices
  (`source.kind === 'plugin'`) are ignored, so the guard can never promote its own
  reminder into "the user's latest instruction".
- **Placed late** (order `10150`: after `WEB_SURFACE` at `10100`, before
  `DEPLOYMENT_PERSONA_SUFFIX` at `10200`). The anchor changes whenever the user
  speaks; keeping it near the tail confines KV-cache invalidation to the tail
  instead of losing prefix reuse from the first changed token.
- Renders an empty string — costing nothing — when the anchor is disabled, when no
  user message has been seen yet, or inside an excluded subagent.
- Tunable via `anchor.*`: `enabled`, `order`, `maxChars`, `title`, `intro`, `priorities`.

### Added — nudge stage: correct before you block

`tools/pre-execute` can only return `allow` / `deny` / `ask` — it cannot carry a
message. So "remind the model, then let it through" was previously impossible at
that seam. 0.5.0 delivers the reminder out-of-band with `agent.inject()`, which
queues a model-facing message for the next pre-step **without waking an idle
driver**, then allows the call:

- 1st deviation in a turn → inject the reminder, **allow** the call.
- Further deviations in the same turn → **deny** (the previous behaviour).
- Separately, a long turn (default `afterSteps: 12`) gets **one** drift reminder per
  turn, re-armed on `turn/start`.

This makes the gate **graded** — first offence informs, a repeat blocks — without
ever deadlocking a turn. Tunable via `nudge.*`: `enabled`, `dryRun`, `grace`,
`maxPerTurn`, `afterSteps`.

### Added — knobs and counters

- Settings page now exposes **ten** live knobs (was seven):
  `anchorEnabled`, `nudgeGrace`, `nudgeAfterSteps` are new.
- Counters added: `nudged`, `nudgeWouldSend`, `nudgeCapped`, `nudgeFailed`, `lastNudge`.

### Security — prompt-injection hardening

Prompt sections interpolate `{{variable}}` references at assembly time, and an
unregistered or malformed reference **throws**, which would break the entire prompt
assembly. Because the anchor quotes user-controlled text, any `{{` is now split to
`{ {` (and `}}` to `} }`) before it enters a section. The same sanitisation is
applied to the maintainer-document injection added in 0.4.0.

### Changed

- The intent gate's judgement is now **staged** rather than binary: unexplained action
  → reminder; repeated → deny. The character-count heuristic is now used only to
  decide "did the model explain itself at all"; drift in a long turn is detected
  mechanically by step count, which is reliable for Chinese paraphrases where
  keyword/overlap matching is not.

### Considered and rejected

- **Hard-stopping the turn on a third offence.** Rejected for three reasons:
  (1) `agent/pre-step` rejection *swallows the user's message* — `preStep()` calls
  `inbox.claim()`, which removes the message from the queue, and the reject path does
  not append it back to the session, so a hard stop silently loses user input;
  (2) sustained denies deadlock the turn, leaving the model unable to proceed at all;
  (3) cleaner alternatives already exist — raise `intent.maxBlocksPerTurn`, or use
  `dsh-plan-mode`, which is the harness's real blocking mechanism.
- **Upgrading the drift test to anchor-overlap matching.** Rejected as unreliable:
  Chinese paraphrase defeats character overlap, so drift is detected by step count.

### Verification

- 30/30 unit tests against the real plugin driven through a stub Cordis context:
  section registration and order; anchor rendering (empty before any user message,
  quotes the user, states the precedence rule, ignores plugin-authored messages,
  later message replaces earlier, blank message is a no-op); `{{` hardening on both
  sections; clipping by `maxChars` and the disable switch; the graded path (1st
  nudge + allow, 2nd deny, 3rd allow); a turn with a stated purpose passes; the
  drift check fires once per turn and re-arms on `turn/start`; graceful degradation
  to `allow` when the injection channel is missing; `nudge.enabled=false` and
  `grace=0` both fall back to deny-first; an injected notice never becomes the
  anchor; all ten settings knobs; and a 0.4.0-era config still receiving the new
  behaviours.
- `--dump-config` produces 725 lines with zero `did not activate` / `waiting for` /
  `Cannot find` entries.
- An isolated instance booted on a spare port: zero guard-error lines after the
  post-listen settling window, `/<plugin>/settings` returns 200 with ten knobs and
  the five new counters, port released on shutdown, no orphaned lock.

### Not verified

- Whether the harness delivers `tools/pre-execute` into a *real* agent turn in the
  live web profile was not re-proved in this release (same open item as 0.4.0). The
  structural evidence is unchanged. The failure mode is safe: if the event is never
  delivered, the gates simply never fire — nothing crashes and nothing is wrongly
  blocked. To confirm, restart, run a turn that creates an infrastructure file, then
  `GET /<plugin-id>/docs` and check `gate.seen > 0`. `gate.dryRun: true` dry-runs it.

---

## [0.4.0] — 2026-09-17

Initial release.

### Added

- A standing system-prompt section instructing the model to read the workspace
  maintainer documents (`plan.md` / `conventions.md` / `stack.md` / `state.md` /
  `maintainer/README.md`) before operating, so that small-model context compaction
  cannot erase long-term project memory.
- A `tools/pre-execute` **precedent gate**: denies a write/edit inside a guarded
  infrastructure area until a working same-basename precedent has been read.
- A `tools/pre-execute` **intent gate**: polices the turn's side-effecting calls when
  the model never said what the step was for.
- A right-sidebar tab to view and edit the maintainer documents, plus REST endpoints
  for document and settings access.
- Seven runtime knobs exposed in the harness settings page (设置 → 插件 → 插件配置).

[0.5.0]: https://gitee.com/xu230102/dsh-maintainer-doc-guard/compare/v0.4.0...v0.5.0
[0.4.0]: https://gitee.com/xu230102/dsh-maintainer-doc-guard/releases/tag/v0.4.0
