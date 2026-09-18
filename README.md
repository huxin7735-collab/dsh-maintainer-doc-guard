# dsh-maintainer-doc-guard

A DeepSeek Harness (dsh) **bundle** that keeps long-term project memory *outside*
the context window.

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

It has three parts.

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

> The section text is interpolated for `{{variable}}` references by the harness —
> avoid literal `{{` in `title` / `intro` overrides.

## Settings page — the seven live knobs

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

The card renders them as two labelled groups — ① 写前先例门禁 and ② 本轮意图门禁 —
so it is never ambiguous which gate a switch belongs to.

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
  `gate.enabled` was `true` would have frozen the switch at load.
- Only these seven knobs are exposed. `gate.tools`, `gate.guardedGlobs`,
  `gate.exemptGlobs`, `gate.scanLevels`, `intent.tools` and friends are
  *deployment decisions*, not preferences, and stay in the composition entry —
  as does everything about the reminder itself.
- The card is dispatched by the namespace key, so the section only renders it
  once the host has actually served the namespace. When no provider is mounted
  the card says so and stays read-only rather than pretending a write landed.

`gate.dryRun` and `intent.dryRun` are both faithful simulations: a would-be
denial still spends one slot of its budget, so a day of observation predicts
exactly what enforcement would have done (including when it would have given up).

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
  records, per turn, how much assistant prose the turn has produced.
- At `tools/pre-execute` — the only seam that can stop a call before dispatch —
  a call to one of `intent.tools` is denied **once per turn** when the turn has
  produced less than `intent.minChars` characters of explanation.

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
Budget `1` is what keeps this from deadlocking: the first unexplained action
pays a round trip, the second goes through regardless.

Two safety properties are worth naming:

- **Fail-open on a missing channel.** If a tool call is already dispatching while
  the plugin has observed *zero* assistant messages this turn, the observation
  channel is not reaching it (a changed event shape, a re-ordered harness). It
  disarms itself for that turn and counts `intentDisarmed` — surfaced in the card
  as `⚠未观测到通道(已自停 N)` — rather than denying blind. A gate that blocks on
  a broken sensor is worse than no gate.
- **Independent budgets.** The intent gate runs *first*, but a denial downstream
  (the precedent gate, or the harness's own policy) does not spend the intent
  budget. One turn can therefore absorb one intent denial *and* one precedent
  denial without the second being swallowed.

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

The `gate` object carries both guards' counters:

| counter | meaning |
|---|---|
| `seen` | tool calls the precedent gate examined |
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
exactly once, and **设置 → 插件 → 插件配置** should show the card with seven
knobs. If the card renders read-only and says no provider is mounted, the harness
has no settings service — every knob then falls back to this composition entry
and the plugin still works, just without live tuning.

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
