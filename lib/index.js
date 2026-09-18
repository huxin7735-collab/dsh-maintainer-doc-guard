/**
 * maintainer-doc-guard — keep long-term project memory OUTSIDE the context
 * window, and keep infrastructure edits anchored to a real precedent.
 *
 * Problem: a small-parameter model (e.g. DeepSeek V4 Flash) that "thinks hard"
 * accumulates a long context, the harness compacts it, and the compacted
 * summary silently drops accumulated facts — the project's conventions, the
 * current plan, the stack decisions, the working state. The model then drifts.
 *
 * Answer, part 1 (a workflow proven on V4 Flash): the durable development
 * memory lives in external "maintainer documents" — plan.md / conventions.md /
 * stack.md / state.md / maintainer/README.md — and a standing instruction tells
 * the model to READ the relevant document before every operation or thinking
 * round, so it re-hydrates its memory from files each turn instead of recalling
 * a lossy summary.
 *
 * Part 2 (the pre-write precedent gate): the harness already forces a model to
 * read a file before overwriting it (`dsh-fs-observation-policy` →
 * `FS_NOT_OBSERVED`). That covers the FILE it replaces, but not the CONTRACT it
 * must obey — the failure mode is authoring a new infrastructure file (a
 * plugin, a preset, a skill) whose API was invented from memory. This plugin
 * adds the missing half as a real gate on the `tools/pre-execute` waterfall:
 * a `write`/`edit` whose target lives in a guarded infrastructure area is
 * denied until the session has read at least one same-basename precedent that
 * already works.
 *
 * Part 3 (the objective anchor): the two gates above police HOW a step is
 * taken; neither notices that the OBJECTIVE was replaced. A long turn drifts
 * because the model's own last paragraph becomes its new premise — the user's
 * instruction recedes into a compacted history while a self-discovered lead
 * takes its place. The fix is to keep the user's latest instruction quoted
 * verbatim in the system prompt as a standing "current objective" section,
 * with an explicit precedence rule (user's latest instruction > your own last
 * stated plan > a lead you found yourself). The section is re-rendered on
 * every assembly, so it is always the live anchor rather than a copy that has
 * to survive compaction.
 *
 * The anchor is a SEPARATE section rather than text appended to the document
 * reminder, and it sits at `anchor.order` (default 10150, i.e. after the Web
 * surface and before the deployment persona suffix) rather than at the front.
 * That placement is deliberate: an unchanged prompt keeps prefix reuse, and a
 * changed one loses it from the first changed token, so the one section that
 * changes whenever the user speaks is put as late as the assembly allows.
 *
 * Part 4 (nudge before deny): an interception that fires only AFTER a whole
 * turn has burned is a receipt, not a correction. The intent gate's judgement
 * is therefore staged: the first unexplained action only INJECTS a reminder
 * (`agent.inject`), which the model reads at its next step boundary while the
 * action is allowed to proceed; a second unexplained action is denied as
 * before. The same channel carries a drift reminder once a turn has run
 * `nudge.afterSteps` steps without the user speaking again. The staged shape
 * and the `{kind:'plugin'}` source stamp both follow the shipped
 * `dsh-repeat-tool-reminder` guard, which solves the same class of problem.
 *
 * Why the prompt section is a SYSTEM-PROMPT SECTION and not an `agent/pre-step`
 * message: a pre-step message is persisted to the session log (that is exactly
 * how `instruction-hint` dedupes its one-shot hint), so injecting one per step
 * would flood the history and the token budget. A prompt section is
 * re-evaluated on every `assemble()` — i.e. every turn — and never accumulates
 * in the history.
 *
 * `section.text` is resolved SYNCHRONOUSLY (`text(context)`), so the document
 * probe uses node:fs sync calls. The section renders to an empty string — and
 * therefore disappears — when the guard is disabled, when the agent is a
 * subagent (unless `includeSubagents`), or when `onlyWhenPresent` is set and no
 * maintainer document exists. A bug here must never break assembly: every path
 * is wrapped so a failure degrades to "no section".
 *
 * The gate follows the same discipline: it is wrapped end to end, it never
 * forces an allow another guard denied, it gives up after
 * `gate.maxDeniesPerTarget` denials for one target (so a stubborn model cannot
 * deadlock its own turn), and `gate.dryRun` turns it into an observer.
 *
 * The same plugin also ships a browser half (./client.js) that adds a
 * "maintainer documents" tab to the right-hand sidebar: a tab strip across the
 * configured documents, a viewer/editor per document, and a save button. The
 * two halves talk over the routes registered in `registerRoutes` below.
 *
 * @module dsh-maintainer-doc-guard
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-maintainer-doc-guard'

/** The one service this plugin needs: the prompt-section registry. */
export const inject = ['systemPrompt']

/** Files the convention centres on, probed in this order. */
export const DEFAULT_DOCS = [
  'plan.md',
  'conventions.md',
  'stack.md',
  'state.md',
  'maintainer/README.md',
]

/**
 * Infrastructure areas whose files carry a contract: authoring one from memory
 * is how invented APIs reach a running harness. Each entry is matched as a
 * POSIX substring of the resolved absolute target path.
 */
export const DEFAULT_GUARDED_GLOBS = [
  '.dsh/profiles/',
  '.dsh/skills/',
  '.dsh/.agent-presets/',
  'node_modules/@deepseek-ai/',
]

/** Tools whose call is examined by the precedent gate. */
export const DEFAULT_GATE_TOOLS = ['write', 'edit']

/**
 * Tools the intent gate treats as "acting on the world". The set is
 * deliberately the SIDE-EFFECTING calls only: a `write`/`edit`/`bash` that
 * starts from a wrong premise is what actually burns a turn, while gating
 * cheap exploration (`read`/`glob`/`grep`) would cost a round trip and buy
 * nothing. `pwsh` is listed because this deployment may expose the PowerShell
 * tool instead of bash; a name no tool registers simply never matches.
 */
export const DEFAULT_INTENT_TOOLS = ['write', 'edit', 'bash', 'pwsh']

/**
 * Working directory of the most recent prompt assembly. The UI routes fall back
 * to it when a request carries no explicit `cwd`: the section is re-evaluated on
 * every turn, so it stays in step with whichever session the user is in.
 */
let lastCwd = null

const DEFAULT_TITLE = '# Maintainer documents — read before every operation'

const DEFAULT_INTRO = [
  'This workspace keeps its durable development memory in the maintainer documents listed below.',
  'Before ANY operation or thinking round, first read the one(s) relevant to the current task.',
  'Re-read the file rather than trusting your recollection of earlier (possibly compacted) context:',
  'these documents are the source of truth for the plan, the conventions, the stack, and the current state.',
].join(' ')

const DEFAULT_ANCHOR_TITLE = '## Current objective — the user\'s latest instruction'

/**
 * The precedence rule the anchor states. It is the load-bearing half of the
 * section: quoting the objective is not enough, because the failure mode is a
 * model that still BELIEVES its own latest thread is the task. Naming the
 * order makes "I am doing X because it is interesting" legible as an
 * excursion instead of a continuation.
 */
export const DEFAULT_PRIORITIES = [
  'the user\'s latest instruction, quoted above',
  'the plan you stated in your own previous turn',
  'a lead, idea, or side-quest you found by yourself',
]

const DEFAULT_ANCHOR_INTRO = [
  'This is the instruction the current work is answerable to.',
  'It is quoted from the user\'s last message, so it outranks anything you inferred since.',
].join(' ')

/**
 * Where the anchor section sits in the assembled prompt. 10100 is the Web
 * surface and 10200 the deployment persona suffix (`SECTION_ORDERS` in
 * `@deepseek-ai/dsh-system-prompt`), so 10150 places the anchor last: an
 * unchanged prompt keeps prefix reuse and a changed one loses it from the
 * first changed token, and this is the one section that changes whenever the
 * user speaks.
 */
export const DEFAULT_ANCHOR_ORDER = 10150

/**
 * The `{kind:'plugin'}` source stamped on every message this plugin injects.
 * The label is load-bearing in two directions: an unlabeled context renders as
 * a user prompt in derived history (the shipped `dsh-repeat-tool-reminder`
 * documents the same constraint), and this plugin's own anchor recorder must
 * be able to tell the user's words apart from its own nudges.
 */
const PLUGIN_SOURCE = { kind: 'plugin', plugin: 'maintainer-doc-guard' }

/** Config for the standing maintainer-document reminder. */
export const Config = z.object({
  enabled: z.boolean().default(true),
  docs: z.array(z.string()).default(DEFAULT_DOCS),
  onlyWhenPresent: z.boolean().default(false),
  includeSubagents: z.boolean().default(false),
  order: z.number().default(100),
  walkUp: z.number().default(6),
  projectMarkers: z.array(z.string()).default(['.git']),
  title: z.string().default(DEFAULT_TITLE),
  intro: z.string().default(DEFAULT_INTRO),
  anchor: z.object({
    enabled: z.boolean().default(true),
    order: z.number().default(DEFAULT_ANCHOR_ORDER),
    maxChars: z.number().default(800),
    title: z.string().default(DEFAULT_ANCHOR_TITLE),
    intro: z.string().default(DEFAULT_ANCHOR_INTRO),
    priorities: z.array(z.string()).default(DEFAULT_PRIORITIES),
  }),
  gate: z.object({
    enabled: z.boolean().default(true),
    dryRun: z.boolean().default(false),
    tools: z.array(z.string()).default(DEFAULT_GATE_TOOLS),
    guardedGlobs: z.array(z.string()).default(DEFAULT_GUARDED_GLOBS),
    exemptGlobs: z.array(z.string()).default([]),
    maxDeniesPerTarget: z.number().default(2),
    maxCandidates: z.number().default(3),
    scanLevels: z.number().default(4),
    entriesPerLevel: z.number().default(400),
  }),
  intent: z.object({
    enabled: z.boolean().default(true),
    dryRun: z.boolean().default(false),
    tools: z.array(z.string()).default(DEFAULT_INTENT_TOOLS),
    maxBlocksPerTurn: z.number().default(1),
    minChars: z.number().default(24),
  }),
  nudge: z.object({
    enabled: z.boolean().default(true),
    dryRun: z.boolean().default(false),
    grace: z.number().default(1),
    maxPerTurn: z.number().default(3),
    afterSteps: z.number().default(12),
  }),
})

/**
 * Defuse `{{...}}` in any text this plugin copies from outside itself — a user
 * message, a document name, an operator-supplied title. Prompt rendering
 * interpolates strict `{{variable}}` references and THROWS on a malformed or
 * unregistered one, so a user who happens to type `{{x}}` would otherwise
 * break every later assembly, not just this section. Splitting the two-char
 * opener keeps the text literal and leaves single braces untouched.
 */
function sanitisePromptText(text) {
  if (typeof text !== 'string') return ''
  return text.split('{{').join('{ {').split('}}').join('} }')
}

/** Deep-freeze an object graph in place, leaving live AbortSignals mutable. */
function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || value instanceof AbortSignal) return value
  if (seen.has(value)) return value
  seen.add(value)
  Object.freeze(value)
  for (const key of Object.keys(value)) deepFreeze(value[key], seen)
  return value
}

/** Random v4 UUID from the platform CSPRNG. */
function randomUUID() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  const hex = Array.from(bytes, (byte, index) => {
    const shifted = index === 6 ? (byte & 15) | 64 : index === 8 ? (byte & 63) | 128 : byte
    return shifted.toString(16).padStart(2, '0')
  }).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Build one immutable user-role notice the model reads at its next step.
 * Inlined rather than imported from `@deepseek-ai/dsh-llm` so the guard keeps
 * its single runtime dependency (`@deepseek-ai/schemastery`); the shape and
 * the `{kind:'plugin'}` stamp are the shipped `dsh-repeat-tool-reminder`
 * guard's, which injects corrections the same way.
 */
function createNotice(text, summary) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: Object.assign({}, PLUGIN_SOURCE, { form: 'notice', summary }),
  })
}

/** POSIX-ise a platform path for display. */
function toPosix(path) {
  return path.split(sep).join('/')
}

/** First ancestor of `start` (inclusive) carrying a project marker, else `start`. */
function findProjectRoot(start, markers, maxUp) {
  let dir = start
  for (let i = 0; i <= maxUp; i += 1) {
    for (const marker of markers) {
      try {
        if (existsSync(join(dir, marker))) return dir
      } catch {
        // Unreadable marker — treat as absent and keep walking up.
      }
    }
    const parent = dirname(dir)
    if (parent.length === 0 || parent === dir) break
    dir = parent
  }
  return start
}

/** True when `path` exists and is a regular file. */
function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Resolve the maintainer documents that exist, as display paths relative to
 * `cwd`. Each document is probed in the working directory first, then in the
 * project root, so a document kept at the repo root is still found from a
 * nested session cwd.
 */
function collectFound(config, cwd) {
  const bases = [cwd]
  if (config.walkUp > 0) {
    const root = findProjectRoot(cwd, config.projectMarkers, config.walkUp)
    if (root !== cwd) bases.push(root)
  }
  const found = []
  const seen = new Set()
  for (const doc of config.docs) {
    for (const base of bases) {
      const absolute = isAbsolute(doc) ? doc : join(base, doc)
      if (!isFile(absolute)) continue
      const shown = isAbsolute(doc) ? toPosix(doc) : toPosix(relative(cwd, absolute))
      if (!seen.has(shown)) {
        seen.add(shown)
        found.push(shown)
      }
      break
    }
  }
  return found
}

/**
 * The session a section should render for, or null when this contribution must
 * stay silent: no agent, no session, or a subagent the deployment excluded.
 * Shared by both sections so they cannot disagree about who is being guarded.
 */
function sectionSession(config, context) {
  const agent = context === undefined || context === null ? undefined : context.agent
  if (agent === undefined || agent === null) return null
  const session = agent.session
  if (session === undefined || session === null) return null
  if (!config.includeSubagents && (session.header?.delegationDepth ?? 0) > 0) return null
  return session
}

/** Build the section text, or an empty string to stay silent. */
function renderSection(config, context) {
  const session = sectionSession(config, context)
  if (session === null) return ''

  const cwd = session.header?.cwd ?? process.cwd()
  lastCwd = cwd
  const found = collectFound(config, cwd)
  if (found.length === 0 && config.onlyWhenPresent) return ''

  const lines = [sanitisePromptText(config.title), '', sanitisePromptText(config.intro), '']
  if (found.length > 0) {
    for (const doc of found) lines.push(`- ${sanitisePromptText(doc)}`)
  } else {
    lines.push(`- (none found yet — expected one of: ${config.docs.map(sanitisePromptText).join(', ')})`)
  }
  return lines.join('\n')
}

/**
 * Build the objective-anchor section: the user's latest instruction, quoted
 * verbatim, followed by the precedence rule that says which of the three
 * competing "tasks" in a long turn actually wins.
 *
 * Renders empty — and therefore disappears entirely — when anchoring is off,
 * when the session has not seen a user message yet, or in an excluded
 * subagent. That is why "no anchor" costs no prompt tokens.
 *
 * The quote is set as a blockquote so its boundaries are unambiguous even when
 * the message itself contains headings or list markers that would otherwise
 * read as this plugin's own instructions.
 */
function renderAnchorSection(config, context) {
  const anchor = config.anchor
  if (!anchor.enabled) return ''
  const session = sectionSession(config, context)
  if (session === null) return ''
  const state = sessionState.get(session)
  const raw = state === undefined ? '' : state.anchor
  if (typeof raw !== 'string' || raw.length === 0) return ''

  const clipped = raw.length > anchor.maxChars ? `${raw.slice(0, anchor.maxChars)}… (truncated)` : raw
  const quoted = sanitisePromptText(clipped)
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')

  const lines = [sanitisePromptText(anchor.title), '', quoted, '', sanitisePromptText(anchor.intro)]
  if (anchor.priorities.length > 0) {
    lines.push('', 'Precedence when these disagree:')
    anchor.priorities.forEach((rule, index) => lines.push(`${index + 1}. ${sanitisePromptText(rule)}`))
    lines.push(
      '',
      'Work the first item does not cover is your own excursion, not the task. Say so in one line before you spend another step on it, and ask before it costs more than that.',
    )
  }
  return lines.join('\n')
}

/* ------------------------------------------------------------------ *
 * The pre-write precedent gate (`tools/pre-execute`).
 * ------------------------------------------------------------------ */

/**
 * Per-session observed state, keyed by the opaque `agent.session` identity —
 * the same weak-key discipline `dsh-fs-observation-policy` uses. Nothing here
 * persists across a restart, so a recovered session starts with no precedents
 * read and must read one again, which is the intended semantics.
 *
 * - `read` / `denies` — the precedent gate's ledger (see `evaluateGate`).
 * - `anchor` — the user's latest instruction, verbatim, as the standing
 *   objective (`noteUserMessage`). Empty until the session has seen one.
 */
const sessionState = new WeakMap()

/** The observed-state bucket for one session, or null when untrackable. */
function stateForSession(session) {
  if (session === undefined || session === null || typeof session !== 'object') return null
  let state = sessionState.get(session)
  if (state === undefined) {
    state = { read: new Set(), denies: new Map(), anchor: '' }
    sessionState.set(session, state)
  }
  return state
}

/** The observed-state bucket for one call's session, or null when untrackable. */
function stateFor(exec) {
  return stateForSession(exec === undefined || exec === null ? undefined : exec.agent?.session)
}

/** The file path a filesystem tool was called with, or null. */
function pathFromExec(exec) {
  const args = exec?.arguments ?? exec?.args
  if (args === undefined || args === null || typeof args !== 'object') return null
  const raw = args.file_path ?? args.filePath ?? args.path
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length === 0 ? null : trimmed
}

/** Resolve a call's file path against the calling session's workspace root. */
function resolveTarget(exec, raw) {
  if (isAbsolute(raw)) return resolve(raw)
  const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd()
  return resolve(cwd, raw)
}

/**
 * Working same-basename precedents for a target, found by walking up the
 * directory chain and asking, at each level, whether sibling packages carry the
 * same relative path. For `.../node_modules/<pkg>/lib/index.js` the first hit
 * is `.../node_modules/<other>/lib/index.js` — exactly the file a careful
 * author reads before writing a new plugin.
 */
function findPrecedents(absolute, gate) {
  const out = []
  const seen = new Set()
  let dir = dirname(absolute)
  for (let level = 0; level < gate.scanLevels; level += 1) {
    const parent = dirname(dir)
    if (parent.length === 0 || parent === dir) break
    const parts = relative(parent, absolute).split(sep)
    if (parts.length < 2) {
      dir = parent
      continue
    }
    const tail = parts.slice(1).join(sep)
    let entries = []
    try {
      entries = readdirSync(parent, { withFileTypes: true })
    } catch {
      entries = []
    }
    let scanned = 0
    for (const entry of entries) {
      if (scanned >= gate.entriesPerLevel) break
      scanned += 1
      if (typeof entry.isDirectory !== 'function' || !entry.isDirectory()) continue
      if (entry.name === parts[0]) continue
      const candidate = join(parent, entry.name, tail)
      if (seen.has(candidate)) continue
      seen.add(candidate)
      if (!isFile(candidate)) continue
      out.push(candidate)
      if (out.length >= gate.maxCandidates) return out
    }
    dir = parent
  }
  return out
}

/** The model-visible reason a guarded write was denied. */
function buildDenyReason(tool, shown, base, candidates) {
  const lines = [
    `Blocked by maintainer-doc-guard: you are about to ${tool} "${shown}", which lives in a guarded infrastructure area, but this session has not read any working "${base}" precedent that shows the real contract.`,
    '',
  ]
  if (candidates.length > 0) {
    lines.push('Read one of these first, then retry:', '')
    for (const candidate of candidates) lines.push(`- ${toPosix(candidate)}`)
  } else {
    lines.push(
      `No sibling precedent was found automatically. Read the closest working analogue of "${base}" in this workspace — a comparable bundle, plugin, or preset that already runs — then retry.`,
    )
  }
  lines.push(
    '',
    'Why: infrastructure written from memory is how invented APIs reach a running harness. If the file already exists, read it; if you are creating it, read a working sibling — the analogue you copy is what keeps the new file consistent with the real API.',
  )
  return lines.join('\n')
}

/**
 * Decide a `tools/pre-execute` call. Returns a `{ kind: 'deny', reason }` to
 * block, or null to let the call continue. Never throws: an internal failure
 * degrades to "no decision".
 */
function evaluateGate(gate, exec, stats) {
  if (!gate.enabled) return null
  if (exec === undefined || exec === null || typeof exec.name !== 'string') return null
  if (!gate.tools.includes(exec.name)) return null
  const raw = pathFromExec(exec)
  if (raw === null) return null

  const state = stateFor(exec)
  if (state === null) return null

  const absolute = resolveTarget(exec, raw)
  const shown = toPosix(absolute)
  if (gate.exemptGlobs.some((glob) => shown.includes(glob))) return null
  if (!gate.guardedGlobs.some((glob) => shown.includes(glob))) return null

  // The target itself was read, or a same-basename precedent was.
  if (state.read.has(absolute)) return null
  const base = basename(absolute)
  for (const observed of state.read) {
    if (basename(observed) === base) return null
  }

  const previous = state.denies.get(absolute) ?? 0
  state.denies.set(absolute, previous + 1)
  if (previous >= gate.maxDeniesPerTarget) {
    stats.gaveUp += 1
    return null
  }
  if (gate.dryRun) {
    stats.wouldDeny += 1
    return null
  }

  const candidates = findPrecedents(absolute, gate)
  stats.denied += 1
  stats.lastDenied = { path: shown, tool: exec.name, candidates: candidates.length }
  return { kind: 'deny', reason: buildDenyReason(exec.name, shown, base, candidates) }
}

/* ------------------------------------------------------------------ *
 * The intent gate — "say what this step is for, before you act on it".
 *
 * The precedent gate above stops a write that was never anchored to a real
 * precedent. It says nothing about the OTHER half of the same failure: acting
 * before deciding whether the action is worth taking. That is what this gate
 * covers, and it is deliberately turn-scoped rather than call-scoped:
 *
 *   A turn opens. The model streams its first assistant message. If that
 *   message carries a real explanation (prose of at least `minChars`), the
 *   turn is free — every later call in it passes untouched. If instead the
 *   turn opens straight into a side-effecting call, that call is denied once
 *   with a reason that asks for the missing line, and the model re-issues it
 *   after explaining itself.
 *
 * So the steady-state cost is ZERO round trips: a model that says what it is
 * doing is never interrupted, and only an unexplained action pays. The gate is
 * also self-disarming — see `evaluateIntent` for why a missing observation
 * channel must silence it rather than make it deny blind.
 * ------------------------------------------------------------------ */

/**
 * Per-session intent ledger, keyed by the same opaque `agent.session` identity
 * the precedent gate uses. One entry per TURN:
 *
 * - `textChars`     — how much real prose the model produced this turn. The
 *                     threshold is applied at JUDGEMENT time, not at recording
 *                     time, so raising `minChars` from the settings page
 *                     re-tunes the gate against the current turn instead of
 *                     only affecting the next one.
 * - `assistantSeen` — how many `assistant/message` events this turn delivered.
 *                     Zero, while a tool call is already being dispatched,
 *                     means the `session/event` channel is not reaching this
 *                     plugin: the gate cannot judge, so it disarms.
 * - `blocks`        — how many calls this gate already denied this turn, so a
 *                     stubborn model can never deadlock its own turn.
 */
const intentState = new WeakMap()

/** The intent ledger for one session, created on first use. */
function intentRecordFor(session) {
  if (session === undefined || session === null || typeof session !== 'object') return null
  let record = intentState.get(session)
  if (record === undefined) {
    record = { turn: null, step: null, textChars: 0, assistantSeen: 0, blocks: 0, disarmed: false, steps: 0, nudges: 0, deviations: 0, driftNudged: false }
    intentState.set(session, record)
  }
  return record
}

/** Open a fresh ledger for a new turn. */
function resetIntentTurn(session, turn, step) {
  const record = intentRecordFor(session)
  if (record === null) return
  record.turn = Number.isFinite(turn) ? turn : null
  record.step = Number.isFinite(step) ? step : null
  record.textChars = 0
  record.assistantSeen = 0
  record.blocks = 0
  record.disarmed = false
  record.steps = Number.isFinite(step) ? step : 0
  record.nudges = 0
  record.deviations = 0
  record.driftNudged = false
}

/**
 * Flatten a message's text blocks into trimmed prose. Shared by the anchor
 * recorder (a user message) and the intent ledger (an assistant message),
 * because both ask the same question of a message: what did it actually say.
 */
function textOfMessage(message) {
  const content = message === undefined || message === null ? undefined : message.content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      text += block.text
    }
  }
  return text.trim()
}

/**
 * Record the user's latest instruction as this session's standing objective.
 *
 * Only a message the USER authored counts. The guard's own nudges and the
 * loop's runtime-context snapshot are `user/message` events too, and adopting
 * one of those as the objective would make the anchor quote the guard back at
 * itself. `source.kind === 'user'` is the discriminator the loop itself uses
 * for the same purpose — the shipped `dsh-repeat-tool-reminder` guard resets
 * its repeat chain on exactly this test.
 *
 * Timing works out without any extra seam: the loop appends the accepted user
 * batch during the step that claimed it, so the very next assembly — the next
 * step of the same turn — already renders the new objective. The turn's first
 * step sees the previous anchor (or none), but that step is the one where the
 * user's message is literally the last thing in the request, so there is
 * nothing for an anchor to disambiguate yet.
 */
function noteUserMessage(session, event) {
  const state = stateForSession(session)
  if (state === null) return
  const message = event === undefined || event === null ? undefined : event.data
  const source = message === undefined || message === null ? undefined : message.source
  if (source === undefined || source === null || source.kind !== 'user') return
  const text = textOfMessage(message)
  if (text.length === 0) return
  state.anchor = text
}

/**
 * Record one `assistant/message`: accumulate its prose length. A turn change
 * re-opens the ledger here as well as on `turn/start`, so a missed boundary
 * event can never leak the previous turn's verdict into this one.
 */
function noteAssistantMessage(session, event) {
  const data = event === undefined || event === null ? undefined : event.data
  const record = intentRecordFor(session)
  if (record === null) return
  const turn = data === undefined || data === null ? undefined : data.turn
  if (Number.isFinite(turn) && record.turn !== turn) {
    resetIntentTurn(session, turn, data === undefined || data === null ? undefined : data.step)
  }
  record.assistantSeen += 1
  record.textChars += textOfMessage(data === undefined || data === null ? undefined : data.message).length
  // The step index is the drift clock: a turn that has reached `afterSteps`
  // without the user speaking again is running on its own momentum.
  const step = data === undefined || data === null ? undefined : data.step
  if (Number.isFinite(step)) record.steps = Math.max(record.steps, step)
}

/** The model-visible reason an unexplained action was denied. */
function buildIntentReason(tool) {
  return [
    `Blocked by maintainer-doc-guard: you are about to run "${tool}" without having said what this step is for.`,
    '',
    'Open the turn with one short line that answers all three:',
    '- what this step is meant to achieve,',
    '- why it has to happen now rather than later or never,',
    '- what result you expect, and how you will tell whether it worked.',
    '',
    'Then re-issue the call in the same message. If you cannot state the value of the step, do not run it — ask the user what they actually want instead. Actions taken before their purpose is clear are how a turn gets spent on work nobody asked for.',
  ].join('\n')
}

/**
 * The reminder injected INSTEAD of the first denial. It states the same
 * requirement as `buildIntentReason` — but as something to satisfy before the
 * next step rather than a wall the call already hit, because the call this
 * time is allowed to run.
 */
function buildNudgeText(tool) {
  return [
    `maintainer-doc-guard: you are about to run "${tool}" without having said what this step is for.`,
    '',
    'Nothing is blocked this time — the call runs. Before your next step, write one short line answering: what is this step meant to achieve, why now rather than later, and what result would tell you it worked.',
    '',
    'If you cannot answer, do not keep going: ask the user what they actually want. An action taken before its purpose is clear is how a turn gets spent on work nobody asked for.',
  ].join('\n')
}

/**
 * The reminder injected once a turn has run `afterSteps` steps on its own. It
 * names the specific hazard — a self-generated thread starting to FEEL like
 * the task — because that is the mechanism the objective anchor exists to
 * counter, and an abstract "stay focused" would not be actionable.
 */
function buildDriftText(steps) {
  return [
    `maintainer-doc-guard: this turn has taken ${steps} steps since the user last spoke — long enough for your own most recent thread to start feeling like the task.`,
    '',
    'Restate in one line which part of the user\'s request the current step serves. If the honest answer is "none", stop and ask the user instead of continuing; if you believe the plan has genuinely changed, say so explicitly and let the user agree before you build on it.',
  ].join('\n')
}

/**
 * The drift reminder, at most once per turn, and only for a turn that has run
 * long. This is the one drift signal that needs no semantic judgement about
 * what the model is doing: the step count is a fact, and the fact is what the
 * "burned a whole turn on a side-quest" failure looks like from outside.
 */
function evaluateDrift(nudge, record, stats) {
  if (!nudge.enabled || nudge.afterSteps <= 0) return null
  if (record.driftNudged) return null
  if (record.steps < nudge.afterSteps) return null
  if (record.nudges >= nudge.maxPerTurn) return null
  record.driftNudged = true
  if (nudge.dryRun) {
    stats.nudgeWouldSend += 1
    return null
  }
  return {
    kind: 'nudge',
    notice: createNotice(buildDriftText(record.steps), `drift check at step ${record.steps}`),
    tag: 'drift',
  }
}

/**
 * Deliver one nudge to the model. Returns whether it landed.
 *
 * The channel is `agent.inject`: it queues model-facing context for the next
 * pre-step WITHOUT waking the driver, which is exactly what a guard wants.
 * `additionalContexts` would be the natural alternative, but that field exists
 * only on the POST-dispatch decision — the pre-dispatch `PreToolDecision` is
 * allow/deny/ask and cannot carry context — so a reminder that has to reach
 * the model before an action must travel through the agent. `steer` is the
 * waking half of the same pair and is deliberately not used: it would start a
 * turn on an idle driver.
 */
function deliverNudge(agent, notice, stats) {
  if (agent === undefined || agent === null || typeof agent.inject !== 'function') {
    stats.nudgeFailed += 1
    return false
  }
  try {
    agent.inject(notice)
    return true
  } catch {
    stats.nudgeFailed += 1
    return false
  }
}

/**
 * Decide what an about-to-run tool call should be met with. Three outcomes:
 * `{kind:'nudge', notice, tag}` to inject a reminder and let the call through,
 * `{kind:'deny', reason}` to block it, or null to leave it alone. Never throws.
 *
 * Fail-open is the contract: every uncertain path lets the call through. The
 * `assistantSeen === 0` branch is the load-bearing one — a turn ALWAYS emits
 * `assistant/message` before its tool calls are dispatched (the agent loop
 * appends the message, then calls `executeToolCalls`), so a live tool call
 * with zero assistant messages means the observation channel is not wired to
 * this plugin. Denying on missing evidence would block every call; disarming
 * only costs the gate its own effect, which the counters expose.
 *
 * A `nudge` is not a weakened denial: the caller must deliver it through
 * `deliverNudge` and treat a delivery failure as a plain allow, so the staged
 * path can never turn into a blocking path by accident.
 */
function evaluateIntent(intent, nudge, exec, stats) {
  if (!intent.enabled) return null
  if (exec === undefined || exec === null || typeof exec.name !== 'string') return null
  if (!intent.tools.includes(exec.name)) return null

  const session = exec.agent === undefined || exec.agent === null ? undefined : exec.agent.session
  const record = intentRecordFor(session)
  if (record === null) return null

  // The turn already carries a real explanation: nothing to police. The
  // threshold is read live, so the settings page re-tunes this judgement
  // rather than only affecting the next turn. The drift check still applies —
  // a well-narrated turn can drift as far as a silent one.
  if (record.textChars >= intent.minChars) return evaluateDrift(nudge, record, stats)

  if (record.assistantSeen === 0) {
    if (!record.disarmed) {
      record.disarmed = true
      stats.intentDisarmed += 1
    }
    return evaluateDrift(nudge, record, stats)
  }

  // Staged judgement: the first `nudge.grace` unexplained actions produce a
  // reminder and are allowed to run; only what follows is denied. The ordering
  // is the whole point — a denial costs a round trip and a reminder does not,
  // so the cheap correction is spent first, and a model that takes it never
  // meets the wall. The nudge budget deliberately does NOT draw on
  // `maxBlocksPerTurn`: those denials stay available for a model that ignores
  // the reminder.
  if (nudge.enabled && nudge.grace > 0 && record.deviations < nudge.grace) {
    record.deviations += 1
    if (nudge.maxPerTurn > 0 && record.nudges >= nudge.maxPerTurn) {
      stats.nudgeCapped += 1
      return evaluateDrift(nudge, record, stats)
    }
    record.nudges += 1
    if (nudge.dryRun) {
      stats.nudgeWouldSend += 1
      return evaluateDrift(nudge, record, stats)
    }
    return {
      kind: 'nudge',
      notice: createNotice(buildNudgeText(exec.name), `step purpose: ${exec.name}`),
      tag: 'intent',
    }
  }

  if (record.blocks >= intent.maxBlocksPerTurn) {
    stats.intentGaveUp += 1
    return evaluateDrift(nudge, record, stats)
  }
  if (intent.dryRun) {
    stats.intentWouldBlock += 1
    return evaluateDrift(nudge, record, stats)
  }

  record.blocks += 1
  stats.intentBlocked += 1
  stats.lastIntentBlocked = { tool: exec.name, turn: record.turn, step: record.step }
  return { kind: 'deny', reason: buildIntentReason(exec.name) }
}

/**
 * Mount the observation seams on `session/event`, a plain observer event that
 * decides nothing and never throws, so a recording failure can only cost a
 * gate its evidence — which `evaluateIntent`'s channel self-check and
 * `renderAnchorSection`'s empty-string fallback already handle.
 *
 * Three event types are followed: a turn boundary reopens the intent ledger, a
 * user message becomes the objective anchor, and an assistant message feeds
 * the ledger its prose length and step index.
 */
function registerIntentTracking(ctx) {
  ctx.on('session/event', (session, event) => {
    try {
      const type = event === undefined || event === null ? undefined : event.type
      const data = event === undefined || event === null ? undefined : event.data
      if (type === 'turn/start') {
        resetIntentTurn(session, data === undefined || data === null ? undefined : data.turn, undefined)
        return
      }
      if (type === 'user/message') {
        noteUserMessage(session, event)
        return
      }
      if (type !== 'assistant/message') return
      noteAssistantMessage(session, event)
    } catch {
      // Observation must never interfere with the session log.
    }
  })
}

/** Record a successful `read` as an observed precedent for its session. */
function recordRead(exec, result, stats) {
  if (exec === undefined || exec === null || exec.name !== 'read') return
  if (result !== undefined && result !== null && result.isError === true) return
  const raw = pathFromExec(exec)
  if (raw === null) return
  const state = stateFor(exec)
  if (state === null) return
  const absolute = resolveTarget(exec, raw)
  if (!state.read.has(absolute)) {
    state.read.add(absolute)
    stats.reads += 1
  }
}

/**
 * Mount both gates on `tools/pre-execute`. The listener delegates downstream
 * FIRST and only then applies its own deny, so it can never force an allow
 * another guard refused — the monotonic-guard semantics the tool registry
 * documents.
 *
 * The listener is ALWAYS mounted and asks `gateOf()`/`intentOf()` for the
 * current configs on every call: mounting conditionally on `enabled` would
 * freeze that switch at load time, which defeats a settings page that can flip
 * it live.
 */
function registerGate(ctx, gateOf, intentOf, nudgeOf, stats) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    stats.seen += 1
    const downstream = await next()
    if (downstream !== undefined && downstream !== null && downstream.kind === 'deny') return downstream
    let decision = null
    try {
      // Read the LIVE configs: the settings page can disable or re-tune either
      // gate without a restart, so `enabled` is a per-call decision, not a
      // mount-time one.
      //
      // Intent is evaluated FIRST because "why is this step here" is logically
      // prior to "is this write anchored", and the two are independent: the
      // intent gate is keyed per turn, the precedent gate per target, so
      // neither spends the other's budget.
      decision = evaluateIntent(intentOf(), nudgeOf(), exec, stats)

      // A nudge is the whole correction: deliver it and let the call run. The
      // precedent gate still gets its say afterwards, because "this write was
      // never anchored to a real precedent" is a different and harder fault
      // than "this step was never explained" — a reminder to explain yourself
      // is not evidence that the contract was read.
      if (decision !== null && decision.kind === 'nudge') {
        if (deliverNudge(exec.agent, decision.notice, stats)) {
          stats.nudged += 1
          stats.lastNudge = { tool: exec.name, tag: decision.tag }
        }
        decision = null
      }

      if (decision === null) {
        const gate = gateOf()
        if (gate.enabled) decision = evaluateGate(gate, exec, stats)
      }
    } catch (error) {
      try {
        ctx.logger?.warn?.(`${name}: gate evaluation failed: ${String((error && error.message) || error)}`)
      } catch {
        // Logger unavailable — the swallow exists only so dispatch survives.
      }
      decision = null
    }
    return decision === null ? downstream : decision
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    try {
      recordRead(exec, result, stats)
    } catch {
      // Observation must never interfere with a tool result.
    }
    return next()
  })
}

/* ------------------------------------------------------------------ *
 * UI data plane — the sidebar panel's read/write routes.
 * ------------------------------------------------------------------ */

/**
 * Resolve every configured document inside `cwd` to an absolute path, whether or
 * not it exists yet (the editor offers to create the missing ones).
 */
function resolveDocs(config, cwd) {
  const out = []
  const seen = new Set()
  for (const doc of config.docs) {
    if (typeof doc !== 'string' || doc.length === 0) continue
    const absolute = isAbsolute(doc) ? doc : join(cwd, doc)
    if (seen.has(absolute)) continue
    seen.add(absolute)
    out.push({ name: doc, absolute, exists: isFile(absolute) })
  }
  return out
}

/** Reject a write whose resolved target escapes `root`. */
function inside(root, target) {
  const base = resolve(root)
  const abs = resolve(target)
  return abs === base || abs.startsWith(base + sep)
}

/** Collect and parse a JSON request body; `{}` on anything malformed. */
function readJsonBody(request) {
  return new Promise((done) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      try {
        done(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        done({})
      }
    })
    request.on('error', () => done({}))
  })
}

/** Send a JSON payload with no-store caching. */
function sendJson(response, status, payload, headOnly = false) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  response.end(headOnly ? undefined : body)
}

/**
 * Register the panel's data plane. Optional: when the host has no web server the
 * plugin still injects its prompt section, there is just no panel behind it.
 */
function registerRoutes(ctx, config, stats, settings) {
  ctx.inject(['webServer'], (routeCtx) => {
    routeCtx.effect(() => routeCtx.webServer.register({
      kind: 'exact',
      path: '/dsh-maintainer-doc-guard/docs',
      handler: async (request, response) => {
        const method = request.method ?? 'GET'

        if (method === 'GET' || method === 'HEAD') {
          let cwd = lastCwd
          try {
            const url = new URL(request.url ?? '/', 'http://127.0.0.1')
            const asked = url.searchParams.get('cwd')
            if (asked) cwd = asked
          } catch {
            // Malformed URL — keep the last known working directory.
          }
          if (!cwd) {
            sendJson(response, 400, { ok: false, error: 'no working directory known yet' }, method === 'HEAD')
            return
          }
          const docs = resolveDocs(config, cwd).map((doc) => ({
            name: doc.name,
            exists: doc.exists,
            content: doc.exists ? readFileSync(doc.absolute, 'utf8') : '',
          }))
          sendJson(
            response,
            200,
            { ok: true, cwd: toPosix(cwd), docs, gate: { ...stats } },
            method === 'HEAD',
          )
          return
        }

        if (method !== 'PUT' && method !== 'POST') {
          response.writeHead(405)
          response.end()
          return
        }

        const body = await readJsonBody(request)
        const cwd = typeof body.cwd === 'string' && body.cwd.length > 0 ? body.cwd : lastCwd
        const docName = typeof body.name === 'string' ? body.name : ''
        const content = typeof body.content === 'string' ? body.content : null

        if (!cwd) {
          sendJson(response, 400, { ok: false, error: 'no working directory known yet' })
          return
        }
        if (content === null) {
          sendJson(response, 400, { ok: false, error: 'content must be a string' })
          return
        }
        if (!config.docs.some((entry) => entry === docName)) {
          sendJson(response, 400, { ok: false, error: `"${docName}" is not one of the configured maintainer documents` })
          return
        }
        let isDir = false
        try {
          isDir = statSync(cwd).isDirectory()
        } catch {
          isDir = false
        }
        if (!isDir) {
          sendJson(response, 400, { ok: false, error: `working directory does not exist: ${cwd}` })
          return
        }
        const target = isAbsolute(docName) ? docName : join(cwd, docName)
        if (!inside(cwd, target)) {
          sendJson(response, 400, { ok: false, error: 'refusing to write outside the working directory' })
          return
        }
        try {
          mkdirSync(dirname(target), { recursive: true })
          writeFileSync(target, content, 'utf8')
          sendJson(response, 200, {
            ok: true,
            name: docName,
            bytes: Buffer.byteLength(content, 'utf8'),
          })
        } catch (error) {
          sendJson(response, 500, { ok: false, error: String((error && error.message) || error) })
        }
      },
    }), 'maintainer-doc-guard: docs route')

    // The Settings-page data plane. Registered unconditionally: when no settings
    // provider is mounted the panel gets `served: false` instead of a dead card.
    routeCtx.effect(() => routeCtx.webServer.register({
      kind: 'exact',
      path: '/dsh-maintainer-doc-guard/settings',
      handler: async (request, response) => {
        const method = request.method ?? 'GET'
        const headOnly = method === 'HEAD'

        if (method === 'GET' || headOnly) {
          sendJson(response, 200, gateSettingsView(settings, stats), headOnly)
          return
        }

        if (method !== 'PUT' && method !== 'POST') {
          response.writeHead(405)
          response.end()
          return
        }

        const service = settings.service()
        if (service === undefined || service === null) {
          sendJson(response, 409, {
            ok: false,
            error: 'no settings provider is mounted in this deployment — tune gate.* in profile cordis.patch.yml instead',
          })
          return
        }

        const body = await readJsonBody(request)
        const patch = body && typeof body.patch === 'object' && body.patch !== null ? body.patch : null
        const unset = Array.isArray(body && body.unset)
          ? body.unset.filter((key) => typeof key === 'string')
          : []

        try {
          if (patch !== null) {
            const clean = sanitiseGatePatch(patch)
            if (Object.keys(clean).length > 0) await service.update(settings.namespace, clean)
          }
          if (unset.length > 0) {
            await service.mutate(
              settings.namespace,
              unset.map((key) => ({ op: 'unset', path: [key] })),
            )
          }
        } catch (error) {
          sendJson(response, 400, { ok: false, error: String((error && error.message) || error) })
          return
        }

        sendJson(response, 200, gateSettingsView(settings, stats))
      },
    }), 'maintainer-doc-guard: settings route')
  })
}

/** Keep only known scalar fields of the right type; silently drop the rest. */
function sanitiseGatePatch(patch) {
  const clean = {}
  for (const field of GATE_SETTINGS_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(patch, field.key)) continue
    const value = patch[field.key]
    if (field.kind === 'boolean' && typeof value === 'boolean') clean[field.key] = value
    if (field.kind === 'number' && Number.isFinite(value)) clean[field.key] = value
  }
  return clean
}

/**
 * The Settings page's read model: effective value, per-field override markers
 * (presence in the user layer, so an override equal to the default still reads
 * as overridden), the write fence, and the live gate counters.
 */
function gateSettingsView(settings, stats) {
  const service = settings.service()
  let value = settings.base()
  let overridden = {}
  let revision
  if (service !== undefined && service !== null) {
    try {
      const descriptor = service.describe().find((entry) => entry.ns === settings.namespace)
      if (descriptor !== undefined) {
        if (descriptor.value !== null && typeof descriptor.value === 'object') value = descriptor.value
        const user = descriptor.user !== null && typeof descriptor.user === 'object' ? descriptor.user : {}
        overridden = Object.fromEntries(
          GATE_SETTINGS_FIELDS.map((field) => [field.key, Object.prototype.hasOwnProperty.call(user, field.key)]),
        )
        revision = descriptor.revision
      }
    } catch {
      // A describe failure only costs the panel its override markers.
    }
  }
  return {
    ok: true,
    namespace: settings.namespace,
    served: Boolean(service),
    revision,
    value,
    overridden,
    fields: GATE_SETTINGS_FIELDS,
    gate: { ...stats },
  }
}

/** Build the resolved gate config, tolerating a partial or missing section. */
function normaliseGate(raw) {
  const source = raw === undefined || raw === null ? {} : raw
  return {
    enabled: source.enabled !== false,
    dryRun: source.dryRun === true,
    tools: Array.isArray(source.tools) && source.tools.length > 0 ? source.tools : DEFAULT_GATE_TOOLS,
    guardedGlobs: Array.isArray(source.guardedGlobs) && source.guardedGlobs.length > 0
      ? source.guardedGlobs
      : DEFAULT_GUARDED_GLOBS,
    exemptGlobs: Array.isArray(source.exemptGlobs) ? source.exemptGlobs : [],
    maxDeniesPerTarget: Number.isFinite(source.maxDeniesPerTarget) ? source.maxDeniesPerTarget : 2,
    maxCandidates: Number.isFinite(source.maxCandidates) ? source.maxCandidates : 3,
    scanLevels: Number.isFinite(source.scanLevels) ? source.scanLevels : 4,
    entriesPerLevel: Number.isFinite(source.entriesPerLevel) ? source.entriesPerLevel : 400,
  }
}

/** Build the resolved intent-gate config, tolerating a partial or missing section. */
function normaliseIntent(raw) {
  const source = raw === undefined || raw === null ? {} : raw
  return {
    enabled: source.enabled !== false,
    dryRun: source.dryRun === true,
    tools: Array.isArray(source.tools) && source.tools.length > 0 ? source.tools : DEFAULT_INTENT_TOOLS,
    maxBlocksPerTurn: Number.isFinite(source.maxBlocksPerTurn) ? source.maxBlocksPerTurn : 1,
    minChars: Number.isFinite(source.minChars) ? source.minChars : 24,
  }
}

/** Build the resolved objective-anchor config, tolerating a partial or missing section. */
function normaliseAnchor(raw) {
  const source = raw === undefined || raw === null ? {} : raw
  return {
    enabled: source.enabled !== false,
    order: Number.isFinite(source.order) ? source.order : DEFAULT_ANCHOR_ORDER,
    maxChars: Number.isFinite(source.maxChars) ? source.maxChars : 800,
    title: typeof source.title === 'string' ? source.title : DEFAULT_ANCHOR_TITLE,
    intro: typeof source.intro === 'string' ? source.intro : DEFAULT_ANCHOR_INTRO,
    priorities: Array.isArray(source.priorities) ? source.priorities : DEFAULT_PRIORITIES,
  }
}

/** Build the resolved nudge config, tolerating a partial or missing section. */
function normaliseNudge(raw) {
  const source = raw === undefined || raw === null ? {} : raw
  return {
    enabled: source.enabled !== false,
    dryRun: source.dryRun === true,
    grace: Number.isFinite(source.grace) ? source.grace : 1,
    maxPerTurn: Number.isFinite(source.maxPerTurn) ? source.maxPerTurn : 3,
    afterSteps: Number.isFinite(source.afterSteps) ? source.afterSteps : 12,
  }
}

/* ------------------------------------------------------------------ *
 * User settings (optional) — the runtime knobs behind the Settings page.
 * ------------------------------------------------------------------ */

/**
 * Namespace this plugin owns in the harness user-settings document
 * (`$DSH_HOME/settings.yaml`). The `settings` service is OPTIONAL: when no
 * provider is mounted nothing here runs and the composition entry stays the
 * single source of truth.
 */
export const SETTINGS_NAMESPACE = 'maintainer-doc-guard'

/**
 * The settings-page surface. Deliberately FLAT and small: only the knobs a user
 * plausibly flips at runtime (a flat shape also keeps every field a scalar, so
 * the page's `set(field, value)` contract applies without path gymnastics).
 * The finer-grained switches — tool list, guarded globs, scan depth — stay in
 * the composition entry: those are deployment decisions, not preferences.
 */
export const GateSettings = z.object({
  gateEnabled: z.boolean().default(true),
  gateDryRun: z.boolean().default(false),
  gateMaxDeniesPerTarget: z.number().default(2),
  intentEnabled: z.boolean().default(true),
  intentDryRun: z.boolean().default(false),
  intentMaxBlocksPerTurn: z.number().default(1),
  intentMinChars: z.number().default(24),
  anchorEnabled: z.boolean().default(true),
  nudgeGrace: z.number().default(1),
  nudgeAfterSteps: z.number().default(12),
})

/** Project the nested gate config onto the flat settings section. */
function gateSettingsFrom(gate) {
  const source = gate === undefined || gate === null ? {} : gate
  return {
    gateEnabled: source.enabled !== false,
    gateDryRun: source.dryRun === true,
    gateMaxDeniesPerTarget: Number.isFinite(source.maxDeniesPerTarget) ? source.maxDeniesPerTarget : 2,
  }
}

/** Project the nested intent config onto the same flat settings section. */
function intentSettingsFrom(intent) {
  const source = intent === undefined || intent === null ? {} : intent
  return {
    intentEnabled: source.enabled !== false,
    intentDryRun: source.dryRun === true,
    intentMaxBlocksPerTurn: Number.isFinite(source.maxBlocksPerTurn) ? source.maxBlocksPerTurn : 1,
    intentMinChars: Number.isFinite(source.minChars) ? source.minChars : 24,
  }
}

/** Project the nested anchor config onto the same flat settings section. */
function anchorSettingsFrom(anchor) {
  const source = anchor === undefined || anchor === null ? {} : anchor
  return {
    anchorEnabled: source.enabled !== false,
  }
}

/** Project the nested nudge config onto the same flat settings section. */
function nudgeSettingsFrom(nudge) {
  const source = nudge === undefined || nudge === null ? {} : nudge
  return {
    nudgeGrace: Number.isFinite(source.grace) ? source.grace : 1,
    nudgeAfterSteps: Number.isFinite(source.afterSteps) ? source.afterSteps : 12,
  }
}

/**
 * The whole flat settings section: all four subsystems' knobs share ONE
 * namespace, so the Settings page shows a single card for this plugin. This is
 * also the composition fallback, i.e. what effective values look like before
 * any user override exists.
 */
export function settingsSectionOf(resolved) {
  return Object.assign(
    {},
    gateSettingsFrom(resolved.gate),
    intentSettingsFrom(resolved.intent),
    anchorSettingsFrom(resolved.anchor),
    nudgeSettingsFrom(resolved.nudge),
  )
}

/**
 * Overlay the flat settings section on the composition gate. Every field is
 * optional: a value the user never touched keeps the composition decision.
 */
function gateFromSettings(compositionGate, settingsValue) {
  const over = settingsValue === undefined || settingsValue === null ? {} : settingsValue
  return normaliseGate(Object.assign({}, compositionGate, {
    enabled: typeof over.gateEnabled === 'boolean' ? over.gateEnabled : compositionGate.enabled,
    dryRun: typeof over.gateDryRun === 'boolean' ? over.gateDryRun : compositionGate.dryRun,
    maxDeniesPerTarget: Number.isFinite(over.gateMaxDeniesPerTarget)
      ? over.gateMaxDeniesPerTarget
      : compositionGate.maxDeniesPerTarget,
  }))
}

/** Overlay the flat settings section on the composition intent config. */
function intentFromSettings(compositionIntent, settingsValue) {
  const over = settingsValue === undefined || settingsValue === null ? {} : settingsValue
  return normaliseIntent(Object.assign({}, compositionIntent, {
    enabled: typeof over.intentEnabled === 'boolean' ? over.intentEnabled : compositionIntent.enabled,
    dryRun: typeof over.intentDryRun === 'boolean' ? over.intentDryRun : compositionIntent.dryRun,
    maxBlocksPerTurn: Number.isFinite(over.intentMaxBlocksPerTurn)
      ? over.intentMaxBlocksPerTurn
      : compositionIntent.maxBlocksPerTurn,
    minChars: Number.isFinite(over.intentMinChars) ? over.intentMinChars : compositionIntent.minChars,
  }))
}

/** Overlay the flat settings section on the composition anchor config. */
function anchorFromSettings(compositionAnchor, settingsValue) {
  const over = settingsValue === undefined || settingsValue === null ? {} : settingsValue
  return normaliseAnchor(Object.assign({}, compositionAnchor, {
    enabled: typeof over.anchorEnabled === 'boolean' ? over.anchorEnabled : compositionAnchor.enabled,
  }))
}

/** Overlay the flat settings section on the composition nudge config. */
function nudgeFromSettings(compositionNudge, settingsValue) {
  const over = settingsValue === undefined || settingsValue === null ? {} : settingsValue
  return normaliseNudge(Object.assign({}, compositionNudge, {
    grace: Number.isFinite(over.nudgeGrace) ? over.nudgeGrace : compositionNudge.grace,
    afterSteps: Number.isFinite(over.nudgeAfterSteps) ? over.nudgeAfterSteps : compositionNudge.afterSteps,
  }))
}

/** Field descriptors the panel renders; label copy lives in the browser half. */
export const GATE_SETTINGS_FIELDS = [
  { key: 'gateEnabled', kind: 'boolean', default: true },
  { key: 'gateDryRun', kind: 'boolean', default: false },
  { key: 'gateMaxDeniesPerTarget', kind: 'number', default: 2, min: 0, max: 20 },
  { key: 'intentEnabled', kind: 'boolean', default: true },
  { key: 'intentDryRun', kind: 'boolean', default: false },
  { key: 'intentMaxBlocksPerTurn', kind: 'number', default: 1, min: 0, max: 10 },
  { key: 'intentMinChars', kind: 'number', default: 24, min: 0, max: 400 },
  { key: 'anchorEnabled', kind: 'boolean', default: true },
  { key: 'nudgeGrace', kind: 'number', default: 1, min: 0, max: 10 },
  { key: 'nudgeAfterSteps', kind: 'number', default: 12, min: 0, max: 200 },
]

/** Defensive normalisation so the plugin behaves with or without schema parsing. */
function normalise(raw) {
  const source = raw === undefined || raw === null ? {} : raw
  return {
    enabled: source.enabled !== false,
    docs: Array.isArray(source.docs) && source.docs.length > 0 ? source.docs : DEFAULT_DOCS,
    onlyWhenPresent: source.onlyWhenPresent === true,
    includeSubagents: source.includeSubagents === true,
    order: Number.isFinite(source.order) ? source.order : 100,
    walkUp: Number.isFinite(source.walkUp) ? source.walkUp : 6,
    projectMarkers: Array.isArray(source.projectMarkers) && source.projectMarkers.length > 0
      ? source.projectMarkers
      : ['.git'],
    title: typeof source.title === 'string' ? source.title : DEFAULT_TITLE,
    intro: typeof source.intro === 'string' ? source.intro : DEFAULT_INTRO,
    gate: normaliseGate(source.gate),
    intent: normaliseIntent(source.intent),
    anchor: normaliseAnchor(source.anchor),
    nudge: normaliseNudge(source.nudge),
  }
}

/** Register the standing reminder section and the pre-write precedent gate. */
export function apply(ctx, config) {
  const resolved = normalise(config)
  if (!resolved.enabled) return

  const stats = {
    seen: 0,
    denied: 0,
    gaveUp: 0,
    wouldDeny: 0,
    reads: 0,
    lastDenied: null,
    intentBlocked: 0,
    intentWouldBlock: 0,
    intentGaveUp: 0,
    intentDisarmed: 0,
    lastIntentBlocked: null,
    nudged: 0,
    nudgeWouldSend: 0,
    nudgeCapped: 0,
    nudgeFailed: 0,
    lastNudge: null,
  }

  /**
   * The live flat settings section. Starts as the composition projection and is
   * replaced by the provider's scope getter once the (optional) settings
   * service attaches; if that provider later detaches, `installSection` puts the
   * composition entry back, so this is never stale.
   */
  let settingsRead = () => settingsSectionOf(resolved)
  /** The settings service, once available; `undefined` means "composition only". */
  let settingsService = undefined
  /**
   * Gate config for THIS call: composition entry, overlaid by the user layer.
   * Never cached — that is what makes the settings page take effect live.
   */
  const gateOf = () => gateFromSettings(resolved.gate, settingsRead())
  /** Intent-gate config for THIS call, resolved the same live way. */
  const intentOf = () => intentFromSettings(resolved.intent, settingsRead())
  /** Nudge config for THIS call, resolved the same live way. */
  const nudgeOf = () => nudgeFromSettings(resolved.nudge, settingsRead())
  /** Anchor config for THIS assembly, resolved the same live way. */
  const anchorOf = () => anchorFromSettings(resolved.anchor, settingsRead())

  ctx.systemPrompt.section({
    name: 'maintainer-doc-guard',
    order: resolved.order,
    text(context) {
      try {
        return renderSection(resolved, context)
      } catch (error) {
        // A guard bug must never break prompt assembly: degrade to no section.
        try {
          ctx.logger?.warn?.(`${name}: section render failed: ${String((error && error.message) || error)}`)
        } catch {
          // Logger unavailable — the swallow exists only so assembly survives.
        }
        return ''
      }
    },
  })

  // The objective anchor is a SECOND section, not more text in the one above,
  // so it can carry its own (late) order and its own off switch. `order` is
  // fixed at registration — that is a deployment decision — while `enabled`
  // and the copy are re-read on every assembly, so the settings page can turn
  // the anchor off without a restart.
  ctx.systemPrompt.section({
    name: 'maintainer-doc-guard:anchor',
    order: resolved.anchor.order,
    text(context) {
      try {
        return renderAnchorSection(Object.assign({}, resolved, { anchor: anchorOf() }), context)
      } catch (error) {
        try {
          ctx.logger?.warn?.(`${name}: anchor section render failed: ${String((error && error.message) || error)}`)
        } catch {
          // Logger unavailable — the swallow exists only so assembly survives.
        }
        return ''
      }
    },
  })

  registerIntentTracking(ctx)
  registerGate(ctx, gateOf, intentOf, nudgeOf, stats)
  registerRoutes(ctx, resolved, stats, {
    namespace: SETTINGS_NAMESPACE,
    service: () => settingsService,
    read: () => settingsRead(),
    base: () => settingsSectionOf(resolved),
  })

  // Optional: expose the runtime knobs in 设置 → 插件 → 插件配置. The `inject`
  // callback simply never fires when no settings provider is mounted, which is
  // exactly the fallback we want (composition config keeps working).
  ctx.inject(['settings'], (settingsCtx) => {
    try {
      settingsService = settingsCtx.settings
      settingsCtx.settings.installSection(
        settingsCtx,
        SETTINGS_NAMESPACE,
        GateSettings,
        settingsSectionOf(resolved),
        {
          setSource: (read) => { settingsRead = read },
          onChange: () => {
            // Nothing to invalidate: `gateOf()` re-reads on every tool call.
            // Kept explicit so the wiring reads the same as the host contract.
          },
        },
      )
    } catch (error) {
      settingsService = undefined
      try {
        ctx.logger?.warn?.(`${name}: settings namespace not registered: ${String((error && error.message) || error)}`)
      } catch {
        // Logger unavailable — settings are optional, the gate still works.
      }
    }
  })
}
