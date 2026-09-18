# dsh-maintainer-doc-guard

A DeepSeek Harness (dsh) **bundle** that keeps long-term project memory *outside*
the context window — and keeps a long turn answerable to the request that
started it.

## Why

A small-parameter model that "thinks hard" builds a long context; the harness
compacts it; the compacted summary silently drops the project's conventions, its
plan, its stack decisions and its working state — and the model drifts.

The proven fix (measured on DeepSeek V4 Flash) is to externalise that memory into
**maintainer documents** and make the model **read them every turn**, so memory is
re-hydrated from files instead of recalled from a lossy summary:

```
plan.md   conventions.md   stack.md   state.md   maintainer/README.md
```

## What this plugin does

It has five parts.

**1. A standing reminder (a system-prompt section).** It registers one
**system-prompt section** (`maintainer-doc-guard`) that lists the maintainer
documents present in the workspace and instructs the model to read the relevant
one before every operation or thinking round.

Why a prompt *section* and not a pre-step *message*: a pre-step message is
persisted to the session log (that is how `instruction-hint` dedupes its hint), so
injecting one per step would flood the history. A section is re-evaluated on every
prompt assembly — every turn — and never accumulates. That is exactly the
"standing, per-turn instruction" this needs.

**2. A pre-write precedent gate (a `tools/pre-execute` guard).** The harness
already makes a model read a file before overwriting it
(`dsh-fs-observation-policy` → `FS_NOT_OBSERVED`). That covers the *file* it
replaces, but not the *contract* it must obey — so authoring a brand-new
infrastructure file (a plugin, a preset, a skill) from memory is how invented
APIs reach a running harness.

The gate closes that half. A `write`/`edit` whose target lives in a guarded
infrastructure area is **denied** until the session has read at least one
same-basename precedent that already works. The denial is model-visible and
lists concrete candidate files to read:

```
Blocked by maintainer-doc-guard: you are about to write "<target>", which lives
in a guarded infrastructure area, but this session has not read any working
"index.js" precedent that shows the real contract.

Read one of these first, then retry:

- /…/node_modules/@deepseek-ai/pkg-alpha/lib/index.js

Why: infrastructure written from memory is how invented APIs reach a running
harness. If the file already exists, read it; if you are creating it, read a
working sibling — the analogue you copy is what keeps the new file consistent
with the real API.
```

Design rules it follows:

- **Monotonic.** The listener delegates downstream first and only then applies its
  own deny, so it can never force an allow another guard refused.
- **Bounded.** After `gate.maxDeniesPerTarget` denials for one target it lets the
  call through and logs — a stubborn model cannot deadlock its own turn.
- **Never fatal.** Every path is wrapped; an internal failure degrades to "no
  decision" and warns. A guard bug must not break tool dispatch, exactly as a
  section bug must not break prompt assembly.
- **Per-session, in-memory.** Observed reads are keyed by the opaque
  `agent.session` identity and never persist, so a recovered session re-reads its
  precedent — the same semantics `dsh-fs-observation-policy` uses.
- **Coarse by design.** "Same basename" is a proxy for "a working analogue of
  this kind of file", not a proof. That keeps false denials rare, which is the
  right trade for a speed bump whose value is forcing one conscious look.

Candidates are found by walking up the directory chain and asking, at each level,
whether sibling packages carry the same relative path — for
`…/node_modules/<pkg>/lib/index.js` the first hit is
`…/node_modules/<other>/lib/index.js`, which is exactly the file a careful author
reads first.

**3. An intent gate (a second `tools/pre-execute` guard).** The precedent gate
polices *how* a change is written; it says nothing about whether the change was
worth making. The intent gate polices that, and it is the cheaper half: **a turn
that has not said what its step is for gets its first side-effecting call denied
once.** One round trip buys an explicit statement of purpose — and, when the
purpose cannot be stated, the honest answer is to stop and ask rather than to
run the command and find out.

Its design rules differ from the precedent gate's in one place: it is **turn-
scoped**, not target-scoped, because what it measures is a property of a turn's
reasoning, not of a file. It is also the only guard here that **stands down on a
missing sensor** — see the note on fail-open under
[The intent gate](#the-intent-gate).

**4. An objective anchor (a second system-prompt section).** Both gates above
police *how* a step is taken. Neither notices that the **objective was
replaced** — which is the actual mechanism behind "it burned a whole turn on
something nobody asked for". A long turn drifts because the model's own last
paragraph becomes its new premise: the user's instruction recedes into a
compacted history while a self-discovered lead takes its place, and every later
step is locally reasonable.

The anchor keeps the user's latest instruction quoted **verbatim** in the system
prompt, with an explicit precedence rule:

```
## Current objective — the user's latest instruction

> 修改一下估算的，这是任务1，任务2是……

This is the instruction the current work is answerable to. It is quoted from the
user's last message, so it outranks anything you inferred since.

Precedence when these disagree:
1. the user's latest instruction, quoted above
2. the plan you stated in your own previous turn
3. a lead, idea, or side-quest you found by yourself

Work the first item does not cover is your own excursion, not the task. Say so in
one line before you spend another step on it, and ask before it costs more than
that.
```

Two design choices worth naming:

- **It is a separate section at a late order (`anchor.order`, default `10150`),
  not text appended to the document reminder.** An unchanged prompt keeps prefix
  (KV) reuse, and a changed one loses it from the first changed token — and this
  is the one section that changes whenever the user speaks. Sitting after the Web
  surface (`10100`) and before the deployment persona suffix (`10200`) keeps the
  damage to the smallest tail in the assembly.
- **Only a message the user actually authored becomes the anchor.** The guard's
  own notices and the loop's runtime-context snapshot are `user/message` events
  too; `source.kind === 'user'` is the discriminator the loop itself uses, so the
  anchor can never end up quoting the guard back at itself.

The anchor renders to an empty string — and therefore disappears, costing no
tokens — until the session has seen a user message. Because the loop appends the
accepted user batch during the step that claimed it, the *next* assembly already
carries the new objective; the turn's own first step is the one place where the
user's message is still the last thing in the request, so there is nothing for an
anchor to disambiguate yet.

**5. A nudge stage (correct before you block).** An interception that only fires
after a whole turn has burned is a receipt, not a correction. So the intent
judgement is staged, and the cheap stage comes first:

| # | what happens | cost |
|---|---|---|
| 1st unexplained action | a reminder is **injected** (`agent.inject`) and the call **runs** | 0 round trips |
| 2nd | denied, with the request to say what the step is for | 1 round trip |
| 3rd | denied again, until `intent.maxBlocksPerTurn` is spent | 1 per denial |

The reminder reaches the model at its next step boundary, so the correction lands
inside the turn that needs it instead of in the next one. Two reminders exist:

- **the step-purpose nudge**, injected instead of the first denial;
- **the drift check**, injected once when a turn has run `nudge.afterSteps` steps
  without the user speaking again — the one drift signal that needs no semantic
  judgement about what the model is doing, because the step count is a fact and
  the fact is what "burned a turn on a side-quest" looks like from outside. It
  fires even for a turn that narrated itself perfectly, because a well-narrated
  turn can drift just as far.

The channel is deliberately `agent.inject` rather than the post-execute
`additionalContexts` field: `additionalContexts` exists only on the
POST-dispatch decision, while the pre-dispatch `PreToolDecision` is
allow/deny/ask and cannot carry context — so a reminder that must arrive *before*
an action has to travel through the agent. `steer` is the waking half of the same
pair and is not used, because a guard has no business starting a turn on an idle
driver. Delivery failure degrades to a plain allow and counts `nudgeFailed`; the
staged path can never turn into a blocking path by accident.

Set `nudge.grace: 0` to restore the pre-0.5 behaviour (deny the first offence),
`nudge.enabled: false` to drop the stage entirely, or `nudge.afterSteps: 0` to
keep the nudges but drop the drift check.

## Configuration

Row config (all optional):

| key | default | meaning |
|---|---|---|
| `enabled` | `true` | turn the section off without removing the row |
| `docs` | `["plan.md","conventions.md","stack.md","state.md","maintainer/README.md"]` | document names to probe |
| `onlyWhenPresent` | `false` | when `true`, stay silent unless at least one document exists |
| `includeSubagents` | `false` | also inject into subagents |
| `order` | `100` | section sort order (after the persona prefix at `0`) |
| `walkUp` | `6` | ancestor levels to walk looking for the project root |
| `projectMarkers` | `[".git"]` | root markers for the walk-up |
| `title` / `intro` | built-in | override the reminder's heading / body text |

Gate config lives under `gate:` and is also all optional:

| key | default | meaning |
|---|---|---|
| `gate.enabled` | `true` | mount the `tools/pre-execute` guard at all |
| `gate.dryRun` | `false` | observe only: count what it *would* deny, never block |
| `gate.tools` | `["write","edit"]` | tool names the gate examines |
| `gate.guardedGlobs` | `[".dsh/profiles/", ".dsh/skills/", ".dsh/.agent-presets/", "node_modules/@deepseek-ai/"]` | POSIX substrings of the resolved target path that make it guarded |
| `gate.exemptGlobs` | `[]` | POSIX substrings that exempt a target even if guarded |
| `gate.maxDeniesPerTarget` | `2` | denials for one target before the gate gives up and lets it through |
| `gate.maxCandidates` | `3` | precedents listed in one denial |
| `gate.scanLevels` | `4` | ancestor levels scanned for sibling precedents |
| `gate.entriesPerLevel` | `400` | directory entries examined per level (caps `node_modules` scans) |

Example — observe before enforcing:

```yaml
- id: maintainer-doc-guard
  config:
    gate:
      dryRun: true
```

The gate is **off for anything outside `guardedGlobs`**, so ordinary project files
(`plan.md`, source, notes, scratch scripts) are never touched by it.

Each document is probed in the session working directory first, then in the project
root, so a document kept at the repo root is found even from a nested cwd.

> Everything this plugin copies from outside itself — the quoted user
> instruction, document names, `title` / `intro` overrides — is defused for the
> harness's `{{variable}}` interpolation before it reaches the prompt (the
> two-character opener and closer are split apart), because rendering **throws**
> on an unregistered reference. A user who types `{{x}}` therefore cannot break
> prompt assembly for the rest of the session.

Anchor config lives under `anchor:` and is also all optional:

| key | default | meaning |
|---|---|---|
| `anchor.enabled` | `true` | render the standing objective section at all |
| `anchor.order` | `10150` | section sort order — late on purpose, so the section that changes on every user message invalidates as little prefix as possible |
| `anchor.maxChars` | `800` | clip the quoted instruction, marking the cut with `… (truncated)` |
| `anchor.title` / `anchor.intro` | built-in | override the heading / the framing sentence |
| `anchor.priorities` | the three-step rule | the precedence list, rendered as a numbered list after the quote |

Nudge config lives under `nudge:` and is also all optional:

| key | default | meaning |
|---|---|---|
| `nudge.enabled` | `true` | stage the intent judgement at all; `false` denies the first offence, as 0.4 did |
| `nudge.dryRun` | `false` | observe only: count what it *would* inject, inject nothing |
| `nudge.grace` | `1` | unexplained actions allowed through with a reminder before any denial |
| `nudge.maxPerTurn` | `3` | reminders per turn before it stops injecting (the deny budget is separate) |
| `nudge.afterSteps` | `12` | step count that triggers the once-per-turn drift check; `0` disables it |

## Settings page — the ten live knobs

Both gates' most-touched switches are also editable at runtime, in the
harness's own settings UI under **设置 → 插件 → 插件配置** ("Plugin
configuration"), with no restart:

| settings field | maps to | default |
|---|---|---|
| `gateEnabled` | `gate.enabled` | `true` |
| `gateDryRun` | `gate.dryRun` | `false` |
| `gateMaxDeniesPerTarget` | `gate.maxDeniesPerTarget` | `2` |
| `intentEnabled` | `intent.enabled` | `true` |
| `intentDryRun` | `intent.dryRun` | `false` |
| `intentMaxBlocksPerTurn` | `intent.maxBlocksPerTurn` | `1` |
| `intentMinChars` | `intent.minChars` | `24` |
| `anchorEnabled` | `anchor.enabled` | `true` |
| `nudgeGrace` | `nudge.grace` | `1` |
| `nudgeAfterSteps` | `nudge.afterSteps` | `12` |

The card lists the ten fields in guard order — precedent gate, intent gate,
objective anchor, then drift correction — each with its own label and hint, so it
is never ambiguous which guard a switch belongs to.

How it works, and what it deliberately does *not* do:

- The host half registers a settings namespace (`maintainer-doc-guard`) through
  `ctx.settings.installSection(...)` — guarded by `ctx.inject(['settings'], …)`,
  so a deployment without a settings provider simply keeps using the composition
  config instead. Nothing here is required for the gate to work.
- Values persist to the harness settings document (`$DSH_HOME/settings.yaml`),
  which is hot-reloaded; `installSection` falls back to the composition entry if
  the provider detaches, so the overlay can never go stale.
- The gate reads its config **per tool call**, never at mount time — that is what
  makes a flipped switch take effect immediately. Mounting the listener only when
  `gate.enabled` was `true` would have frozen the switch at load. The anchor
  re-reads its config per *assembly* for the same reason.
- Only these ten knobs are exposed. `gate.tools`, `gate.guardedGlobs`,
  `gate.exemptGlobs`, `gate.scanLevels`, `intent.tools`, `anchor.order`,
  `anchor.maxChars`, `anchor.priorities` and friends are *deployment decisions*,
  not preferences, and stay in the composition entry — as does everything about
  the reminder itself. `anchor.order` in particular is fixed at registration:
  changing it means editing the composition entry and restarting.
- The card is dispatched by the namespace key, so the section only renders it
  once the host has actually served the namespace. When no provider is mounted
  the card says so and stays read-only rather than pretending a write landed.

`gate.dryRun`, `intent.dryRun` and `nudge.dryRun` are all faithful simulations: a
would-be denial still spends one slot of its budget, so a day of observation
predicts exactly what enforcement would have done (including when it would have
given up).

`intentMinChars` is read **at judgement time**, not at recording time. A turn
records how many characters of explanation it has accumulated, and the threshold
is applied when a tool call is about to dispatch — so dragging the slider
re-tunes the *current* turn, not just the next one.

## The intent gate

The second gate answers a different question than the precedent gate. The
precedent gate asks *"did you read the precedent before writing here?"*; this one
asks *"did you say what this step is for before you ran it?"* It exists because
the expensive failure mode is not a bad write — it is **acting before checking
whether the action was worth taking at all**, which burns tokens on work nobody
asked for.

How it decides:

- The host subscribes to `session/event` (a non-vetoing observer seam) and
  records, per turn, how much assistant prose the turn has produced and how many
  steps it has taken.
- At `tools/pre-execute` — the only seam that can stop a call before dispatch —
  a call to one of `intent.tools` meets the staged judgement described in
  **5. A nudge stage** above: a reminder first, a denial only once the reminder
  has been ignored, and never more denials than `intent.maxBlocksPerTurn`.

```yaml
- id: maintainer-doc-guard
  config:
    intent:
      enabled: true
      dryRun: false
      tools: ["write", "edit", "bash", "pwsh"]
      maxBlocksPerTurn: 1
      minChars: 24
```

| key | default | meaning |
|---|---|---|
| `intent.enabled` | `true` | mount the intent gate at all |
| `intent.dryRun` | `false` | observe only: count what it *would* deny, never block |
| `intent.tools` | `["write","edit","bash","pwsh"]` | **side-effecting** tools only — gating cheap exploration buys nothing |
| `intent.maxBlocksPerTurn` | `1` | denials per turn before it gives up and lets the turn run |
| `intent.minChars` | `24` | characters of assistant prose that count as "said what this is for" |

The denial is a prompt, not a wall. It demands three things of the next attempt:
**what the step achieves**, **why it has to happen now**, and **what result is
expected** — and states plainly that if the value of the step cannot be stated,
the step should not run and the user should be asked what they actually want.
Its injected cousin says the same thing while the call is still allowed through,
so a model that takes the reminder never meets the wall at all.

Three safety properties are worth naming:

- **Fail-open on a missing channel.** If a tool call is already dispatching while
  the plugin has observed *zero* assistant messages this turn, the observation
  channel is not reaching it (a changed event shape, a re-ordered harness). It
  disarms itself for that turn and counts `intentDisarmed` — surfaced in the card
  as `⚠未观测到通道(已自停 N)` — rather than denying blind. A gate that blocks on
  a broken sensor is worse than no gate.
- **Independent budgets.** The intent gate runs *first*, but a denial downstream
  (the precedent gate, or the harness's own policy) does not spend the intent
  budget. One turn can therefore absorb one intent denial *and* one precedent
  denial without the second being swallowed. The nudge budget is a third,
  separate counter again.
- **Bounded.** `intent.maxBlocksPerTurn` (default `1`) is what keeps a stubborn
  model from deadlocking its own turn: once it is spent, the turn runs regardless
  and the give-up is counted as `intentGaveUp`. Raising it trades a longer stall
  for a firmer demand — `3` is a reasonable "insist" setting; there is no setting
  that blocks a turn indefinitely, by design.

The gate is off for any tool outside `intent.tools`, so `read`, `glob`, `grep`
and every read-only probe are never touched by it.

## UI — the right-sidebar tab

The bundle also ships a browser half (`./client.js`) that adds a **维护者文档**
tab to the right sidebar:

- a tab strip across the configured `docs` (default: the five above);
- one editor per document — the raw markdown in a text area, saved with a click;
- documents that do not exist yet are marked `·未建`, so the panel doubles as a
  checklist of what still needs writing;
- the header shows the working directory the panel resolved — the open session's
  cwd, with the host falling back to the cwd recorded at the last prompt assembly.

It is hand-written and build-free, and requires only the platform seed module
`react` — deliberately, so it cannot trip the `require(...) missed the module
table` failure that rc.*-era client bundles hit on 0.1.5.

Data plane (host routes, registered only when the host has a web server):

| method | path | payload |
|---|---|---|
| `GET` | `/dsh-maintainer-doc-guard/docs` | query `cwd=<abs path>` (optional). Also returns a `gate` object — see below — so you can confirm the guards are actually firing. |
| `PUT` | `/dsh-maintainer-doc-guard/docs` | body `{cwd, name, content}` |
| `GET` | `/dsh-maintainer-doc-guard/settings` | the settings card's read model: `served`, `namespace`, `value`, `overridden` (per-field presence in the user layer), `revision`, `fields`, plus the same `gate` counters |
| `PUT` | `/dsh-maintainer-doc-guard/settings` | body `{patch:{…}}` for edits, `{unset:["gateDryRun", …]}` to revert a field to the composition value. Unknown fields and wrong types are dropped; without a provider it answers **409** with the YAML fallback instead of pretending |

The `gate` object carries every guard's counters:

| counter | meaning |
|---|---|
| `seen` | tool calls the gate pipeline examined |
| `denied` | precedent denials issued |
| `gaveUp` | precedent gate exhausted `maxDeniesPerTarget` for a target |
| `wouldDeny` | `gate.dryRun` only: denials that *would* have happened |
| `reads` | reads recorded as precedents |
| `lastDenied` | `{tool, target}` of the most recent precedent denial |
| `intentBlocked` | intent denials issued |
| `intentWouldBlock` | `intent.dryRun` only: denials that *would* have happened |
| `intentGaveUp` | intent gate exhausted `maxBlocksPerTurn` for a turn |
| `intentDisarmed` | turns where the observation channel was missing and it stood down |
| `lastIntentBlocked` | `{tool, turn, step}` of the most recent intent denial |
| `nudged` | reminders actually delivered to the model |
| `nudgeWouldSend` | `nudge.dryRun` only: reminders that *would* have been delivered |
| `nudgeCapped` | turn hit `nudge.maxPerTurn`, so a reminder was withheld |
| `nudgeFailed` | delivery failed (no `agent.inject`) — the call went through, uncorrected |
| `lastNudge` | `{tool, tag}` of the most recent reminder; `tag` is `intent` or `drift` |

The three counters that matter when tuning are `nudged` (is the cheap stage
working?), `intentBlocked` (is the expensive stage still needed?), and
`nudgeFailed` (is the reminder channel actually wired in this deployment — a
non-zero value there means the staged path has silently degraded to "allow").

`name` must be one of the configured `docs`; writes are confined to `cwd`
(path traversal is rejected) and parent directories are created on demand.

Open the tab from the right sidebar's "new tab" menu. Restart dsh after changing
this plugin — bundles are not hot-loaded.

## Install

Requires dsh `0.1.5-rc.*` and Node >= 20. The plugin is **build-free**: `lib/` is
the shipped source, there is no compile step, and it depends on nothing but the
harness itself.

**1. Get the code anywhere on disk.**

```
git clone <this-repo-url> dsh-maintainer-doc-guard
```

**2. Declare it in the profile** — `$DSH_HOME/profiles/web/package.json`:

```jsonc
{
  "dependencies": {
    "dsh-maintainer-doc-guard": "link:/abs/path/to/dsh-maintainer-doc-guard"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // …the bundles already listed…
        "dsh-maintainer-doc-guard"
      ]
    }
  }
}
```

Both halves matter: `dependencies` makes it resolvable, and `dsh.profile.bundles`
is what actually loads it. A package that resolves but is not in the bundle list
mounts nothing.

Use `link:` with an **absolute path**, never `file:`. With `nodeLinker: hoisted`,
pnpm resolves a `file:` directory to a symlink *into* the source tree instead of a
self-contained package — that either breaks resolution or silently drops the
bundle from the graph.

**3. Install and restart.**

```
cd "$DSH_HOME/profiles/web" && pnpm install
```

Then restart dsh: **bundles are not hot-loaded.** A window close-reopen is often
*not* a restart either — if the shell log shows `adopted orphan service`, it
reused the old process and you are still on the old config. Kill the service PID
and start again.

**4. Verify.** `dsh web --dump-config` should list the `maintainer-doc-guard` row
exactly once, and **设置 → 插件 → 插件配置** should show the card with ten
knobs. If the card renders read-only and says no provider is mounted, the harness
has no settings service — every knob then falls back to this composition entry
and the plugin still works, just without live tuning.

To confirm the anchor half is live without waiting for a drift to happen: send a
message, then read `GET /dsh-maintainer-doc-guard/settings` and check that
`gate.nudged` moves when you next take an unexplained action. `gate.nudgeFailed`
staying at `0` is what tells you the reminder channel is genuinely wired in.

### Upgrading

`git pull` into the same directory and restart dsh. Nothing is written into your
profile beyond those two declarations, so there is no migration step.

### Uninstalling

Drop the `dsh.profile.bundles` entry (that is what unmounts it), then the
`dependencies` line, then `pnpm install`. The documents it manages —
`plan.md`, `conventions.md`, `stack.md`, `state.md`, `maintainer/README.md` — are
ordinary workspace files and are left untouched.

### Note on this repository

This plugin was developed against a specific deployment's `cordis.patch.yml`, so
the composition example above is the *generic* form. The guarded areas, the
document names and the tuning all live in that one row's `config:` block, which
ships in `cordis.patch.yml` here — read it before wiring the plugin into a
harness that guards different directories.
