# Changelog

All notable changes to `dsh-maintainer-doc-guard` are recorded here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
