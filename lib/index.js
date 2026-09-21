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
 * probe uses node:fs sync calls. Each of the two sections carries its OWN
 * subagent policy, because they want opposite answers inside a delegated child:
 * the document reminder points at files the child inherits with its parent's
 * `cwd` (worth reading, opt in via `inSubagents`), while the objective anchor
 * would quote the PARENT's instruction, which is not the child's task (opt in
 * via `anchor.inSubagents`, which then quotes the child's own delegation under
 * child-specific wording). A section renders to an empty string — and therefore
 * disappears, costing no tokens — when it is disabled or where its policy
 * excludes it. A bug here must never break assembly: every path is wrapped so a
 * failure degrades to "no section".
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
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-maintainer-doc-guard'

/**
 * The one service this plugin CANNOT work without: the prompt-section registry,
 * which both sections are registered on.
 *
 * Everything else is an OPTIONAL dependency and deliberately NOT listed here.
 * In cordis, a name in `inject` is a hard gate — the whole plugin waits for it
 * and never applies if the deployment lacks it. That would be catastrophic for
 * extras like "open the folder": losing the opener must not cost the user the
 * gates and the reminder as well. Those services are reached through
 * `ctx.inject([...], cb)` (see `registerRoutes` / the judge), which activates
 * only when present.
 */
export const inject = ['systemPrompt']

/** Files the convention centres on, probed in this order. */
export const DEFAULT_DOCS = [
  'plan.md',
  'conventions.md',
  'stack.md',
  'state.md',
  'maintainer/README.md',
  // The experience book — the one document the MODEL owns and appends to. It is
  // listed alongside the operator's documents but deliberately kept OUT of
  // `DEFAULT_INJECT_DOCS`: it is delivered ON DEMAND, when a line's `触发` field
  // matches the live call (see `evaluateLedgerNotice`). A lesson injected every
  // step is a lesson the model merely has to remember — and remembering across a
  // compacted context is exactly what failed; matching the call replaces it.
  'lessons.md',
]

/** Folder (relative to each workspace) where the maintainer documents live. */
export const DEFAULT_DOCS_DIR = '.dsh-maintainer-doc-guard'

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
 * Whether a tool name denotes a destructive operation (delete / remove / trash /
 * unlink / purge / wipe). Destructive calls are pulled into the same gates as
 * writes — deleting infrastructure, or deleting without having stated intent, is
 * exactly the "acted before thinking" failure the gates exist to catch.
 * Matched on whole destructive words (never the bare substrings "rm" or "del")
 * so names like "transform" or "model" are never mistaken for destructive.
 */
const DESTRUCTIVE_WORDS = /\b(delete|remove|trash|unlink|purge|wipe)\b/i
function isDestructiveTool(name) {
  if (typeof name !== 'string' || name.length === 0) return false
  return DESTRUCTIVE_WORDS.test(name)
}

/**
 * Working directory of the most recent prompt assembly. The UI routes fall back
 * to it when a request carries no explicit `cwd`: the section is re-evaluated on
 * every turn, so it stays in step with whichever session the user is in.
 */
let lastCwd = null
let lastSession = null

/**
 * The sidebar's "strict on-topic mode" toggle. This is a PROCESS-level runtime
 * switch, not a per-session setting: the user flips it from the panel when they
 * want every answer to lead with the question and stop when it drifts, and
 * flips it back when a wider excursion is welcome. It only changes the anchor
 * section's wording — the plugin never inspects the output, so this is a
 * prompt-level contract, not a gate.
 */
let strictOnTopic = false

/**
 * The advisory notices, each switchable from the sidebar switch group.
 * Process-level and all-ON by default, exactly like `strictOnTopic`: the
 * plugin's own behaviour IS the default, and a switch exists so a noisy session
 * can be quieted without editing source or restarting.
 *
 * Deliberately NOT settings-card fields: that card has a hard ten-field ceiling
 * (an 11th field stops the whole card mounting), so anything added after it must
 * live somewhere else — this is that somewhere.
 */
const NOTICE_SWITCH_KEYS = ['ledger', 'content', 'verify', 'induce']
const NOTICE_SWITCH_LABELS = {
  ledger: '经验本命中提醒',
  content: '删数字落点核对',
  verify: '验证读数提醒',
  induce: '经验本自动归纳',
}
export let noticeSwitches = { ledger: true, content: true, verify: true, induce: true }

/** The body appended to the anchor when strict mode is ON. */
const STRICT_TAIL = [
  '',
  '## Answer contract — STRICT ON-TOPIC MODE is enabled',
  '',
  '1. Lead with the answer. Your reply must open with the part that directly answers the instruction quoted above. Do not open with a reflection, a recap of your process, or a status report.',
  '2. Answer before you反思. Any reflection, self-correction, or "what went wrong" content goes AFTER the answer, and must be clearly marked as an addendum.',
  '3. Stop at the edge. If the current step no longer serves the quoted instruction, stop and say so in one line instead of continuing. Do not spend the turn on a self-generated sub-goal.',
  '4. An excursion is allowed only if you first say, in one line, which part of the instruction it serves. If the honest answer is "none", do not take it — ask the user first.',
].join('\n')

/** The body appended to the anchor when strict mode is OFF (default). */
const RELAXED_TAIL = [
  '',
  '## Answer contract — excursions allowed, but must be declared',
  '',
  '1. Lead with the answer. Open with the part that directly answers the instruction quoted above.',
  '2. Excursions come first from you; the marker is only an explanation. A related finding is welcome when it is genuinely worth the reader\'s time — it goes AFTER the answer, and you may mark it in one word ("延伸：" / "Beyond your question:") so the reader knows why it is there. That marker is a courtesy, not a quota: nothing here asks you to produce an extension, and an answer with nothing extra needs no remark at all.',
  '3. Declare, do not smuggle. A step that does not serve the instruction must be named as such in one line before you take it. It may still be worth taking; it may not be taken silently.',
  '4. Reflection is an addendum, never the reply. If you want to review what went wrong, put it after the answer, not in place of it.',
].join('\n')

const DEFAULT_TITLE = '# Maintainer documents — read before every operation'

/**
 * The documents whose CONTENT is injected on every assembly by default: the
 * plan (the technical route this work answers to), the conventions (the hard
 * rules), and the experience book (the lessons the model wrote for itself after
 * getting something wrong). Names are matched against the tail of every
 * discovered document path, so the same set works for the top level and for a
 * per-session folder.
 */
export const DEFAULT_INJECT_DOCS = ['plan.md', 'conventions.md']

const DEFAULT_INJECT_TITLE = '## Mandatory requirements — injected in full, not just listed'

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
 * The wording an anchor uses when the session is a delegated child. A child's
 * standing objective is the task it was handed, NOT the top-level user's
 * instruction: quoting the parent's words inside a child would invite it to
 * treat the original request as its own assignment and drift off the delegated
 * scope, which is the one thing a child must not do.
 */
const DEFAULT_CHILD_ANCHOR_TITLE = '## Your delegated task — what you were sent here to do'
const DEFAULT_CHILD_ANCHOR_INTRO = [
  'This is the task you were delegated. It is quoted from the message that started your session.',
  'It outranks anything you inferred since, and it does not widen by being interesting.',
].join(' ')
const DEFAULT_CHILD_PRIORITIES = [
  'the delegated task, quoted above',
  'the plan you stated in your own previous turn',
  'a lead, idea, or side-quest you found by yourself',
]

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
  docsDir: z.string().default(DEFAULT_DOCS_DIR),
  onlyWhenPresent: z.boolean().default(false),
  /**
   * Whether the documents reach delegated children.
   *
   * `false` (DEFAULT) = top level only. `true`, or the spelling `'children'`,
   * = also inside delegated children (`true` additionally covers grandchildren,
   * which a parent-relative rule would not).
   *
   * A child inherits its parent's `cwd`, so the documents it would read are the
   * same real files — which is why this is the one contribution a deployment may
   * reasonably want to extend. The default deliberately excludes children
   * anyway: a child has its own delegated task, and a default must never widen a
   * contribution's reach.
   *
   * The spelling `'children'` used to mean the OPPOSITE of what it says: the
   * schema accepted it, every comparison ignored it, and it was the default — so
   * an operator who wrote it explicitly silently got top-level only. It is a real
   * opt-in now, because a value whose name lies is worse than no value at all.
   */
  inSubagents: z.union([z.boolean(), z.const('children')]).default(false),
  /**
   * NOTE — the 0.5.0 spelling `includeSubagents` is deliberately NOT declared
   * here. schemastery has no `.optional()`, and a union whose second arm is
   * `undefined` is dropped by `Schema.resolve` exactly like an absent key, so
   * the alias cannot be expressed in the schema at all. It does not need to be:
   * `z.object` runs non-strict, and its object handler merges unrecognised
   * input keys through untouched (verified against schemastery's `index.cjs`).
   * `normalise` therefore still sees `includeSubagents: true` on the raw config
   * and folds it into `inSubagents` — see the `inSubagents` line there.
   */
  order: z.number().default(100),
  walkUp: z.number().default(6),
  projectMarkers: z.array(z.string()).default(['.git']),
  title: z.string().default(DEFAULT_TITLE),
  intro: z.string().default(DEFAULT_INTRO),
  /**
   * The mandatory half of the document channel: the CONTENT of the operator's
   * standing requirements, injected on every assembly instead of merely listed.
   *
   * A list of filenames is an invitation a model can decline; a rule it must obey
   * has to be in front of it. That is why the default set is the plan and the
   * conventions — the technical route and the hard rules — and why `enabled`
   * defaults to TRUE: the feature exists to be on, and an operator who wants the
   * content out turns it off rather than on.
   *
   * Rendered in this SECTION rather than as an injected message, because
   * requirements change rarely: a stable prefix stays in the provider's cache,
   * while an appended message is re-read on every step. Editing a document costs
   * exactly one cache miss — the moment the operator wanted noticed anyway.
   *
   * Children are excluded by `inSubagents` exactly like the rest of the section,
   * so nothing here leaks a parent's requirements into a delegated child.
   */
  injectDocs: z.object({
    enabled: z.boolean().default(true),
    docs: z.array(z.string()).default(DEFAULT_INJECT_DOCS),
    title: z.string().default(DEFAULT_INJECT_TITLE),
    maxCharsPerDoc: z.number().default(2000),
    maxCharsTotal: z.number().default(6000),
  }),
  anchor: z.object({
    enabled: z.boolean().default(true),
    /**
     * Whether the anchor reaches delegated children. `false` (DEFAULT) = top
     * level only. `true` or `'children'` renders it in children too, where it
     * quotes the child's DELEGATION (or the last message a real sender pushed
     * into the child) under wording that says "your delegated task" rather than
     * "the user's latest instruction" — a child must not read the parent's
     * objective as its own. Any unrecognised value is treated as silence.
     */
    inSubagents: z.union([z.boolean(), z.const('children')]).default(false),
    /**
     * Where the anchor reaches the model.
     *
     * 'section' = rendered into the system prompt, re-asserted at a fixed
     * position on every step. 'message' (default) = appended as a tail inbox
     * message and the section renders empty instead.
     *
     * The measured reason for the default: a section change invalidates the
     * prompt PREFIX, and the entire conversation follows the prompt, so
     * adopting a new objective on the turn's second step re-prefilled
     * everything after it — 10-19万 tokens per turn in one measured session,
     * with every single turn's second step missing its cache. An appended
     * message carries the same text at the same moment and invalidates nothing.
     * Set 'section' to get the old always-visible placement back.
     */
    delivery: z.union([z.const('section'), z.const('message')]).default('message'),
    order: z.number().default(DEFAULT_ANCHOR_ORDER),
    maxChars: z.number().default(800),
    title: z.string().default(DEFAULT_ANCHOR_TITLE),
    intro: z.string().default(DEFAULT_ANCHOR_INTRO),
    priorities: z.array(z.string()).default(DEFAULT_PRIORITIES),
    childTitle: z.string().default(DEFAULT_CHILD_ANCHOR_TITLE),
    childIntro: z.string().default(DEFAULT_CHILD_ANCHOR_INTRO),
    childPriorities: z.array(z.string()).default(DEFAULT_CHILD_PRIORITIES),
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
  /**
   * The document reminder's verifier (see `evaluateDocsNotice`). Deliberately
   * NOT one of `GATE_SETTINGS_FIELDS`: that card has a hard ceiling of ten
   * knobs, so an eleventh would stop the whole card from mounting. This is a
   * per-deployment call that belongs in `cordis.patch.yml`.
   */
  docsNotice: z.object({
    enabled: z.boolean().default(true),
    dryRun: z.boolean().default(false),
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
/**
 * Documents that exist for the HUMAN — the panel tab, the file manager, this
 * description — and never for the prompt.
 *
 * A README spends prompt tokens on prose the model did not write and cannot act
 * on, and in the panel's default 0-byte stub it was worse than useless: the
 * reminder listed a path that taught the model nothing. The operator asked for
 * the split explicitly: the README documents the plugin to a person, the
 * remaining documents carry the standing instructions to the model.
 */
const HUMAN_ONLY_DOCS = ['maintainer/README.md']

function isHumanOnlyDoc(doc) {
  return typeof doc === 'string' && HUMAN_ONLY_DOCS.includes(doc.replace(/\\/g, '/'))
}

function collectFound(config, cwd, session) {
  // No ensureDocs() here: with per-session documents the workspace-level folder
  // must not be auto-created, or every session would collide on one shared set.
  // Each session's blank set is generated by the panel's GET instead.
  const bases = [cwd]
  if (config.walkUp > 0) {
    const root = findProjectRoot(cwd, config.projectMarkers, config.walkUp)
    if (root !== cwd) bases.push(root)
  }
  // The session's OWN document set is probed first and wins over the
  // workspace-level one. The panel writes each session's documents under
  // `<docsDir>/<sessionKey>/` (see `resolveDocs`), so a reminder that scanned
  // only the workspace root would point the model at an empty workspace-level
  // stub while the session's real instructions sat unread in its own folder.
  const own = sessionDocsDir(config, cwd, session)
  const found = []
  const seen = new Set()
  // Only NON-EMPTY files are offered. A 0-byte stub carries nothing to read, so
  // listing it spends prompt budget on a path that teaches the model nothing
  // and dilutes the signal of the documents that do have content.
  const offer = (candidate) => {
    let size = -1
    try {
      const stat = statSync(candidate)
      size = stat.isFile() ? stat.size : -1
    } catch {
      // Vanished between probe and stat — not a document, exactly like missing.
    }
    if (size <= 0) return false
    const shown = isAbsolute(candidate) ? toPosix(candidate) : toPosix(relative(cwd, candidate))
    if (seen.has(shown)) return true
    seen.add(shown)
    found.push(shown)
    return true
  }
  for (const doc of config.docs) {
    if (typeof doc !== 'string' || doc.length === 0) continue
    if (isHumanOnlyDoc(doc)) continue
    if (isAbsolute(doc)) {
      // Deployment-pointed shared files ignore every base.
      offer(doc)
      continue
    }
    if (own !== null && offer(join(own.dir, doc))) continue
    for (const base of bases) {
      if (offer(join(base, config.docsDir, doc))) break
    }
  }
  return found
}

/**
 * The session a section should render for, or null when this contribution must
 * stay silent: no agent, no session, or a subagent the deployment excluded.
 * Shared by both sections so they cannot disagree about who is being guarded.
 */
function sessionDepth(session) {
  const depth = session?.header?.delegationDepth
  return Number.isFinite(depth) && depth > 0 ? depth : 0
}

/**
 * Whether this session is a delegated child. `origin` is the coarse
 * classification the subagent service stamps at creation; `delegationDepth` is
 * the durable monotone floor. Either one being positive is enough, because a
 * resumed child arrives with fresh options and a header written by an older
 * format.
 */
function isChildSession(session) {
  if (session === undefined || session === null) return false
  return session.header?.origin === 'subagent' || sessionDepth(session) > 0
}

/**
 * Whether a subagent policy opts a contribution into delegated children.
 * `true` renders it everywhere, grandchildren included; the spelling
 * `'children'` is exactly the same opt-in for a deployment that prefers to say
 * it in words. Everything else — `false`, an absent value, a typo — stays
 * silent inside a child, which is the safe reading: a default must never widen
 * a contribution's reach, and a child already has its own delegated task.
 */
function subagentOptIn(policy) {
  return policy === true || policy === 'children'
}

/**
 * The session a contribution should render for, or null when it must stay
 * silent. Each contribution carries its OWN subagent policy: the document
 * reminder and the objective anchor are separately switchable, because they
 * want opposite answers in a delegated child (the documents are inherited and
 * worth reading; the parent's objective is NOT the child's task).
 */
function sectionSession(config, context, contribution) {
  const agent = context === undefined || context === null ? undefined : context.agent
  if (agent === undefined || agent === null) return null
  const session = agent.session
  if (session === undefined || session === null) return null
  const policy = contribution === 'anchor' ? config.anchor?.inSubagents : config.inSubagents
  if (subagentOptIn(policy)) return session
  // Top-level only — read defensively, a typo stays silent.
  if (isChildSession(session)) return null
  return session
}

/** Build the section text, or an empty string to stay silent. */
function renderSection(config, context) {
  const session = sectionSession(config, context, 'docs')
  if (session === null) return ''

  const cwd = session.header?.cwd ?? process.cwd()
  lastCwd = cwd
  const found = collectFound(config, cwd, session)
  if (found.length === 0 && config.onlyWhenPresent) return ''

  // R4 — the section reports what it actually rendered. Best-effort and
  // documented as such: telemetry failing must read as "values unchanged", not
  // as "the section disappeared", and this function must always return a string.
  try {
    lastSectionRender = { docsListed: found.length, at: Date.now() }
  } catch {
    // Telemetry only.
  }

  const lines = [sanitisePromptText(config.title), '', sanitisePromptText(config.intro), '']
  if (found.length > 0) {
    for (const doc of found) lines.push(`- ${sanitisePromptText(doc)}`)
  } else {
    lines.push(`- (none found yet — expected one of: ${config.docs.map((d) => sanitisePromptText(join(config.docsDir, d))).join(', ')})`)
  }
  // Listing is not reading: the requirements themselves go in, in full.
  const injected = injectDocsText(config, cwd, found)
  if (injected.length > 0) lines.push('', injected)
  return lines.join('\n')
}

/**
 * The mandatory half of the document channel: the CONTENT of the operator's
 * standing requirements, injected on every assembly instead of merely listed.
 *
 * A list of filenames is an invitation a model can decline; a rule it must obey
 * has to be in front of it. The default set is the plan and the conventions —
 * the technical route and the hard rules.
 *
 * Rendered inside this SECTION rather than as an injected message, because
 * requirements change rarely: a stable prefix stays in the provider's cache,
 * while an appended message would be re-read on every step. Editing a document
 * costs exactly one cache miss — the moment the operator wanted noticed anyway.
 *
 * A document is matched by the tail of its path, so `plan.md` picks up the
 * per-session copy as well as a workspace-level one, and the content is capped
 * per document and in total so one runaway file cannot consume the prompt.
 */
function injectDocsText(config, cwd, found) {
  const cfg = config.injectDocs ?? {}
  if (cfg.enabled === false) return ''
  const wanted = Array.isArray(cfg.docs) && cfg.docs.length > 0 ? cfg.docs : DEFAULT_INJECT_DOCS
  const perDoc = Number.isFinite(cfg.maxCharsPerDoc) ? Math.max(0, cfg.maxCharsPerDoc) : 2000
  const total = Number.isFinite(cfg.maxCharsTotal) ? Math.max(0, cfg.maxCharsTotal) : 6000
  const picked = []
  for (const doc of found) {
    const normalised = toPosix(doc)
    if (!wanted.some((name) => normalised === toPosix(name) || normalised.endsWith(`/${toPosix(name)}`))) continue
    const absolute = isAbsolute(doc) ? resolve(doc) : resolve(cwd, doc)
    let text
    try {
      text = readFileSync(absolute, 'utf8')
    } catch {
      // Unreadable or vanished — the listing above still stands.
      continue
    }
    if (typeof text !== 'string' || text.trim().length === 0) continue
    picked.push({ doc, text })
  }
  if (picked.length === 0) return ''
  const out = [sanitisePromptText(cfg.title ?? DEFAULT_INJECT_TITLE)]
  let budget = total
  for (const item of picked) {
    if (budget <= 0) break
    const slice = item.text.slice(0, Math.min(perDoc, budget))
    if (slice.length === 0) continue
    budget -= slice.length
    out.push('', `--- ${item.doc}${item.text.length > slice.length ? ' (truncated — open the file for the rest)' : ''} ---`, '', slice.trim())
  }
  return out.length > 1 ? out.join('\n') : ''
}

/**
 * Build the anchor section: the session's standing objective, quoted verbatim,
 * followed by the precedence rule that says which of the competing "tasks" in a
 * long turn actually wins.
 *
 * The objective is the user's latest instruction at the top level, and the
 * delegated task inside a child session — the same slot, read from a different
 * message (see `noteUserMessage`), with wording that matches who is reading it.
 *
 * Renders empty — and therefore disappears entirely — when anchoring is off,
 * when the session has not seen the relevant message yet, or where the
 * contribution's subagent policy excludes it. That is why "no anchor" costs no
 * prompt tokens.
 *
 * The quote is set as a blockquote so its boundaries are unambiguous even when
 * the message itself contains headings or list markers that would otherwise
 * read as this plugin's own instructions.
 */
function renderAnchorSection(config, context, delivering) {
  const anchor = config.anchor
  if (!anchor.enabled) return ''
  // In message delivery the anchor leaves the system prompt entirely and goes
  // out through `deliverAnchor` instead. The same renderer produces that
  // message — passing `delivering` reuses the identical text (titles,
  // priorities, strict/relaxed tail) rather than growing a second copy of it.
  if (!delivering && anchor.delivery === 'message') return ''
  const session = sectionSession(config, context, 'anchor')
  if (session === null) return ''
  const state = sessionState.get(session)
  const raw = state === undefined ? '' : state.anchor
  if (typeof raw !== 'string' || raw.length === 0) return ''

  const child = isChildSession(session)
  const title = child ? anchor.childTitle : anchor.title
  const intro = child ? anchor.childIntro : anchor.intro
  const priorities = child ? anchor.childPriorities : anchor.priorities

  const clipped = raw.length > anchor.maxChars ? `${raw.slice(0, anchor.maxChars)}… (truncated)` : raw
  const quoted = sanitisePromptText(clipped)
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')

  const lines = [sanitisePromptText(title), '', quoted, '', sanitisePromptText(intro)]
  if (priorities.length > 0) {
    lines.push('', 'Precedence when these disagree:')
    priorities.forEach((rule, index) => lines.push(`${index + 1}. ${sanitisePromptText(rule)}`))
    lines.push(
      '',
      'Work the first item does not cover is your own excursion, not the task. Say so in one line before you spend another step on it, and ask before it costs more than that.',
    )
  }
  // The answer contract is the panel-toggleable half of the anchor. Strict mode
  // is for when the user wants the reply to lead with the question and stop at
  // the drift boundary; relaxed mode keeps excursions allowed but requires them
  // to be declared rather than smuggled in place of the answer.
  lines.push(sanitisePromptText(strictOnTopic ? STRICT_TAIL : RELAXED_TAIL))
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
    state = { read: new Set(), denies: new Map(), anchor: '', taskSeen: false, lastAnswer: '', docsNoticeFor: '' }
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
  // A shell denial judged from text alone has to SAY it was judged from text,
  // or the blocked reader cannot tell a real hazard from a misread. The first
  // version of this gate named only the path, and a command that merely READ
  // that path while writing elsewhere looked like an unexplained accusation.
  if (SHELL_TOOL_NAMES.has(String(tool).toLowerCase())) {
    lines.push(
      '',
      'This was judged from the shell command text, not from the tool name: a write — a redirect into a path, or a write-class cmdlet — and that guarded path appear in the SAME statement.',
      'A command that only READS a guarded path (Select-String, Get-Content, git diff) and writes somewhere else is not blocked.',
      '',
    )
  }
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
/**
 * R1 — the shell half of the precedent gate's surface.
 *
 * The gate matched TOOL NAMES only (`write`/`edit`), so every scripted write
 * walked past it: `Set-Content <guarded path>`, `Copy-Item … <guarded path>`, and
 * anything a shell does to a plugin were invisible. This finds the guarded path a
 * shell command names so the same rules below can judge it.
 *
 * Detection is deliberately conservative: a write-class verb or a redirection
 * INTO a path must also appear. Matching on the path alone would deny
 * `Select-String <guarded path>` — the very command a careful author uses to READ
 * the file the gate wants read first. Known limit, documented rather than hidden:
 * a shell command that writes a guarded path from inside a script it invokes
 * (`node apply.mjs`) names no guarded path in its own text and stays invisible.
 */
const SHELL_TOOL_NAMES = new Set(['pwsh', 'powershell', 'bash', 'sh', 'zsh', 'cmd'])
const SHELL_WRITE_SIGNAL = /\b(?:Set-Content|Add-Content|Clear-Content|Out-File|Tee-Object|Set-Item|New-Item|Copy-Item|Move-Item|Rename-Item|Remove-Item|cp|mv|rm|tee|truncate|patch)\b|>{1,2}\s*['"]?(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|\/|~[\\/])/

/**
 * A read-class command word, as a COMMAND (followed by whitespace, so the prose
 * word `type:` never matches). R5: the document reminder used to count only the
 * `read` tool, so `pwsh Select-String plan.md` — how a careful author actually
 * reads a file here — left the document "unread" and the reminder fired at the
 * very step that had just read it.
 */
const SHELL_READ_VERB = /\b(?:Get-Content|gc|Select-String|sls|Import-Csv|cat|type|head|tail|less|more|ReadAllText|ReadAllLines)\s/i

/**
 * A path-looking token inside one shell statement.
 *
 * Absolute forms (`D:\x`, `./x`, `../x`, `/x`) plus — a gap found by the R5
 * test — a BARE relative name with an extension (`plan.md`, `lib/index.js` was
 * already covered by the leading `/`… no: `lib/index.js` is bare too, and the
 * old pattern missed it whenever the name carried no drive letter or leading
 * dot). Commas are excluded so PowerShell's `-LiteralPath a.md,b.md` array form
 * yields two tokens, and so a guarded relative write is no longer invisible.
 */
const SHELL_PATH_TOKEN = /[A-Za-z]:[\\/][^\s'";|)>,]*|\.{1,2}[\\/][^\s'";|)>,]*|\/[^\s'";|)>,]*|[^\s'";|)>,]+\.[A-Za-z0-9]{1,6}/g

/**
 * The path tokens a shell command READS: a read verb and a path in the SAME
 * statement (split on `;`/newline), which is the clause discipline the write
 * gate already uses. `echo plan.md` and the prose word `type:` must not count.
 *
 * Exported for the regression test, because the risky half is this parser — the
 * verb set, the clause split and the prose false-positive — not the bookkeeping.
 */
export function shellReadPaths(command) {
  if (typeof command !== 'string' || command.length === 0) return []
  const out = []
  for (const clause of command.split(/[;\n]+/)) {
    if (!SHELL_READ_VERB.test(clause)) continue
    const tokens = clause.match(SHELL_PATH_TOKEN) ?? []
    for (const token of tokens) out.push(toPosix(token).replace(/[)"']+$/, ''))
  }
  return out
}

/** The command text of a shell call, or null. */
function commandOf(exec) {
  const args = exec?.arguments ?? exec?.args
  if (args === undefined || args === null || typeof args !== 'object') return null
  const raw = args.command ?? args.cmd ?? args.script
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

/**
 * The first guarded path a write-class shell command actually WRITES, or null.
 *
 * The signals are matched per STATEMENT, not across the whole command: a guarded
 * path must appear in the same `;`/newline-separated clause as a write. Matching
 * "any guarded path anywhere" against "any write anywhere" fired on this plugin's
 * own maintenance script — a command that read a guarded file with `Select-String`
 * and then wrote a report under a workspace path — because the two signals merely
 * co-existed. Requiring them in one clause keeps `Select-String` (how a careful
 * author reads the very file the gate wants read first) out of the gate.
 *
 * Known limit, documented rather than hidden: a clause that writes through a
 * variable built in an earlier clause (`$f = '<guarded>'; Set-Content $f x`) still
 * names no guarded path where the write happens, and stays invisible.
 */
function guardedShellTarget(exec, gate) {
  if (!SHELL_TOOL_NAMES.has(String(exec.name).toLowerCase())) return null
  const command = commandOf(exec)
  if (command === null) return null
  if (!SHELL_WRITE_SIGNAL.test(command)) return null
  for (const clause of command.split(/[;\n]+/)) {
    if (!SHELL_WRITE_SIGNAL.test(clause)) continue
    const tokens = clause.match(SHELL_PATH_TOKEN) ?? []
    for (const token of tokens) {
      const shown = toPosix(token).replace(/[)"']+$/, '')
      if (gate.exemptGlobs.some((glob) => shown.includes(glob))) continue
      if (!gate.guardedGlobs.some((glob) => shown.includes(glob))) continue
      return shown
    }
  }
  return null
}

function evaluateGate(gate, exec, stats) {
  if (!gate.enabled) return null
  if (exec === undefined || exec === null || typeof exec.name !== 'string') return null
  // R1: a shell command that WRITES into a guarded path is the same failure the
  // tool-name check was written for, so it is judged by the same rules below.
  const shellTarget = guardedShellTarget(exec, gate)
  if (shellTarget === null && !gate.tools.includes(exec.name) && !isDestructiveTool(exec.name)) return null
  const raw = shellTarget ?? pathFromExec(exec)
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
 * The document reminder's verifier — "these documents exist" is not the
 * same claim as "you have read them".
 * ------------------------------------------------------------------ */

/**
 * Decide whether an about-to-run call should be met with a one-off reminder
 * that this session still has maintainer documents with content it never
 * opened.
 *
 * Why this exists: the prompt section lists the documents at every step, but
 * nothing ever checked that any of them was opened. The observed failure is
 * exactly that — a document carrying the operator's instructions was listed on
 * every assembly and never read, so the reminder had no verifier at all.
 *
 * The evidence is the SAME ledger the precedent gate uses (`state.read`, fed
 * by `recordRead` on every successful `read`), so no second observation
 * channel is introduced and one real read satisfies both.
 *
 * Re-arming is by CONTENT, not by turn: the fingerprint of the non-empty
 * documents (path + size + mtime) is recorded once the reminder is delivered,
 * so a session is reminded once per version of the documents — and again
 * whenever the operator edits one. That is what makes "the user wrote new
 * instructions mid-session" reach a model that never re-opens the file.
 *
 * Always advisory, never a denial: a reminder costs one injected line while a
 * deny costs a round trip, so this spends only the cheap correction. The
 * caller records `print` on successful delivery, so a failed nudge is retried
 * on the next call rather than silently spent.
 */
/* ------------------------------------------------------------------ *
 * The lessons ledger — the one document the model writes for itself.
 *
 * It is deliberately NOT injected on every step. A lesson earns prompt tokens
 * only at the moment the same situation comes back, so the ledger is matched
 * against the call in front of us: each line's `触发` field names a tool plus a
 * path/command fragment — the same two things the gates already judge — and
 * only the hitting lines are delivered. Reuse across conversations comes from
 * the file living at the WORKSPACE level, not from re-stating it every turn.
 * ------------------------------------------------------------------ */

/** The trigger field of one ledger line, e.g. `触发：edit + lib/index.js`. */
const LEDGER_TRIGGER = /触发[：:]\s*([^｜|]+)/

/** Words that name a TOOL rather than a path or command fragment. */
const LEDGER_TOOLISH = new Set([
  ...SHELL_TOOL_NAMES,
  'read', 'write', 'edit', 'glob', 'grep', 'ls', 'todo_write',
  'doc_read', 'doc_write', 'subagent', 'subagent_fork', 'workflow', 'ralph',
])

/** True when a trigger fragment looks like a path (has a separator, dot, star). */
function isPathish(fragment) {
  return /[\\/.*]/.test(fragment)
}

/**
 * Parse the ledger into entries: one per `- …` line that carries a trigger.
 * Exported because the matching rules are the risky half and are unit-tested.
 */
export function parseLedger(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  const out = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith('- ')) continue
    const match = line.match(LEDGER_TRIGGER)
    if (match === null) continue
    const trigger = match[1].trim()
    const parts = trigger.split(/[+＋、,，]/).map((part) => part.trim()).filter((part) => part.length > 0)
    if (parts.length === 0) continue
    out.push({ line, trigger, parts })
  }
  return out
}

/** `a*b*c` matches when every `*`-separated piece appears; else a substring. */
function fragmentMatches(fragment, haystack) {
  const pieces = toPosix(fragment).split('*').map((piece) => piece.trim()).filter((piece) => piece.length > 0)
  if (pieces.length === 0) return false
  return pieces.every((piece) => haystack.includes(piece.toLowerCase()))
}

/**
 * Does one ledger entry describe the call in front of us?
 *
 * A named tool must match, and at least one non-tool fragment must be found in
 * the call's path or command text. Both halves come from observed strings, so
 * the judgement is "same tool, same place" — never a guess about intent.
 */
export function ledgerHits(entry, tool, target, command) {
  if (entry === undefined || entry === null) return false
  const name = String(tool ?? '').toLowerCase()
  const tools = entry.parts.map((part) => part.toLowerCase()).filter((part) => LEDGER_TOOLISH.has(part))
  if (tools.length > 0 && !tools.includes(name)) return false
  const fragments = entry.parts.filter((part) => !LEDGER_TOOLISH.has(part.toLowerCase()))
  if (fragments.length === 0) return tools.length > 0
  const haystack = `${target ?? ''} ${command ?? ''}`.toLowerCase()
  return fragments.some((fragment) => fragmentMatches(fragment, haystack))
}

/** The ledger file path for this session, or null when it cannot be located. */
function ledgerPathOf(config, cwd, session) {
  for (const shown of collectFound(config, cwd, session)) {
    if (toPosix(shown).endsWith('lessons.md')) {
      return isAbsolute(shown) ? resolve(shown) : resolve(cwd, shown)
    }
  }
  return null
}

/** The ledger lines that match this call, delivered as one reminder. */
export function evaluateLedgerNotice(config, exec, stats) {
  if (noticeSwitches.ledger !== true) return null
  if (exec === undefined || exec === null || typeof exec.name !== 'string') return null
  const session = exec.agent === undefined || exec.agent === null ? undefined : exec.agent.session
  if (session === undefined || session === null) return null
  // Same reach as the document reminder: a delegated child stays silent unless
  // the deployment opted the maintainer documents into children.
  if (isChildSession(session) && !subagentOptIn(config.inSubagents)) return null
  const cwd = session.header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) return null
  const state = stateFor(exec)
  if (state === null) return null
  const ledger = ledgerPathOf(config, cwd, session)
  if (ledger === null) return null
  let text
  try {
    text = readFileSync(ledger, 'utf8')
  } catch {
    return null
  }
  const hits = []
  const fired = state.ledgerFired ?? (state.ledgerFired = new Set())
  for (const entry of parseLedger(text)) {
    if (fired.has(entry.line)) continue
    if (!ledgerHits(entry, exec.name, pathFromExec(exec) ?? '', commandOf(exec) ?? '')) continue
    hits.push(entry.line)
  }
  if (hits.length === 0) return null
  return {
    kind: 'nudge',
    tag: 'ledger',
    lines: hits,
    notice: createNotice(
      buildLedgerNoticeText(hits, exec.name),
      `lessons ledger: ${hits.length} match(es) for ${exec.name}`,
    ),
  }
}

/** The injected text for a ledger hit. */
function buildLedgerNoticeText(lines, tool) {
  const out = [
    'maintainer-doc-guard: 这一步的经验本里记过（命中，只在相同情形下才出现）。',
    '',
    `本次调用：${tool}`,
    '',
  ]
  for (const line of lines) out.push(line)
  out.push(
    '',
    '先看“正确”那一栏再动手；如果你这次的做法确实不同，忽略它继续。',
  )
  return out.join('\n')
}

/** How many separate number runs a string carries (`12.5` counts once). */
function countDigitRuns(text) {
  const runs = String(text ?? '').match(/\d+(?:[.,]\d+)*/g)
  return runs === null ? 0 : runs.length
}

/**
 * The content-aware reminder (report item F4).
 *
 * The observed failure was deleting the sentences that carried the numbers —
 * not editing the numbers. A net DECREASE in number runs is the objective trace
 * of that shape, so it is the judgement: `12 -> 13` (equal counts) stays silent,
 * and nothing here claims to know what the edit meant.
 */
export function evaluateContentNotice(exec, stats) {
  if (noticeSwitches.content !== true) return null
  if (exec === undefined || exec === null) return null
  if (String(exec.name ?? '').toLowerCase() !== 'edit') return null
  const args = exec.arguments ?? exec.args
  if (args === undefined || args === null || typeof args !== 'object') return null
  const before = typeof args.old_string === 'string' ? args.old_string : null
  const after = typeof args.new_string === 'string' ? args.new_string : null
  if (before === null || after === null) return null
  const from = countDigitRuns(before)
  const to = countDigitRuns(after)
  if (from <= to) return null
  const state = stateFor(exec)
  if (state === null) return null
  const target = pathFromExec(exec) ?? ''
  const key = `${target}|${from}>${to}`
  const seen = state.contentNotice ?? (state.contentNotice = new Set())
  if (seen.has(key)) return null
  return {
    kind: 'nudge',
    tag: 'content',
    key,
    notice: createNotice(
      buildContentNoticeText(from, to),
      `content: number runs ${from} -> ${to}`,
    ),
  }
}

/** The injected text for a net-reduction edit. */
function buildContentNoticeText(from, to) {
  return [
    'maintainer-doc-guard: 这一步让数字**净减少**了（原文 ' + from + ' 处数字，新文 ' + to + ' 处）。',
    '',
    '如果你正在删承载数字或结论的文字，先做落点核对：这些数字/结论在别处是否另有落点？',
    '删题注、删重复项一律适用（工作区铁律 3）。',
    '',
    '如果只是原地修正数值（例如 12 → 13），忽略本条继续。',
  ].join('\n')
}

/** File kinds whose change implies "there is something to verify". */
const VERIFY_EXTS = /\.(?:mjs|cjs|js|jsx|ts|tsx|ps1|sh|bash|bat|cmd|py|json|yml|yaml|toml)$/i

/**
 * The completion-standard reminder (optimisation item: "did you verify?").
 *
 * Fired ONCE per changed artifact, at the next call after the change, because
 * the alternative — a rule that only exists as prose — is the one this session
 * actually violated. It never blocks: the model is told what the completion
 * standard is, in the same channel as every other correction here.
 */
export function evaluateVerifyNotice(exec, stats) {
  if (noticeSwitches.verify !== true) return null
  const state = stateFor(exec)
  if (state === null) return null
  const pending = state.verifyPending
  if (pending === undefined || pending === null) return null
  return {
    kind: 'nudge',
    tag: 'verify',
    artifact: pending.artifact,
    notice: createNotice(buildVerifyNoticeText(pending.artifact), `verify: ${pending.artifact}`),
  }
}

/** The injected text of the verification reminder. */
function buildVerifyNoticeText(artifact) {
  return [
    `maintainer-doc-guard: 你刚改过 ${artifact}，本轮还没有给出验证读数。`,
    '',
    '完成标准是“验证方式 + 实际读数”：跑哪条命令、期望什么、实际是什么（工作区铁律 7）。',
    '未验证不要写成“已完成 / 已修复”。',
  ].join('\n')
}

/** R2 of the ledger: auto-induction caps. */
const LEDGER_INDUCE_MAX = 3

/** A stable key for "the same target" across two calls. */
function targetKeyOf(exec) {
  const path = pathFromExec(exec)
  if (path !== null) {
    const absolute = resolveTarget(exec, path)
    return toPosix(absolute)
  }
  return null
}

/** The human-readable text of a failed call's error, or ''. */
function errorTextOf(result) {
  if (result === undefined || result === null) return ''
  for (const direct of [result.error, result.message, result.errorText, result.output]) {
    if (typeof direct === 'string' && direct.trim().length > 0) return direct.trim()
  }
  const content = result.content
  if (Array.isArray(content)) {
    const parts = content
      .map((item) => (item !== null && typeof item === 'object' && typeof item.text === 'string' ? item.text : ''))
      .filter((text) => text.length > 0)
    if (parts.length > 0) return parts.join(' ').trim()
  }
  return ''
}

/** Which argument keys the successful retry changed, for the "正确" column. */
function argDiffSummary(failedArgs, currentArgs) {
  const a = failedArgs !== null && typeof failedArgs === 'object' ? failedArgs : {}
  const b = currentArgs !== null && typeof currentArgs === 'object' ? currentArgs : {}
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  const changed = []
  for (const key of keys) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) changed.push(key)
  }
  return changed.slice(0, 4).join(', ')
}

/**
 * Auto-induction (user request: "自动归纳错误，记录正确路径").
 *
 * Only OBSERVED facts go in: the failure's own error text, the fact that the
 * next call on the same target succeeded, and which argument keys changed. No
 * inference about why the model was wrong, and shell calls are excluded because
 * "the same target" is not well defined for a command string.
 */
export function noteLedgerOutcome(exec, result, config, stats) {
  if (noticeSwitches.induce !== true) return
  if (exec === undefined || exec === null || typeof exec.name !== 'string') return
  const target = targetKeyOf(exec)
  if (target === null) return
  const state = stateFor(exec)
  if (state === null) return
  const failed = result !== undefined && result !== null && result.isError === true
  if (failed) {
    const message = errorTextOf(result)
    if (message.length === 0) return
    state.lastFailure = {
      tool: exec.name,
      target,
      message,
      args: exec.arguments ?? exec.args ?? null,
      at: Date.now(),
    }
    return
  }
  const last = state.lastFailure
  if (last === undefined || last === null) return
  if (last.tool !== exec.name || last.target !== target) return
  state.lastFailure = null
  if ((state.inducedCount ?? 0) >= LEDGER_INDUCE_MAX) return
  const session = exec.agent === undefined || exec.agent === null ? undefined : exec.agent.session
  const cwd = session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) return
  const ledger = ledgerPathOf(config, cwd, session)
  if (ledger === null) return
  const why = last.message.replace(/\s+/g, ' ').slice(0, 160)
  const changed = argDiffSummary(last.args, exec.arguments ?? exec.args ?? null)
  const fix = changed.length > 0 ? `随后对同一目标调用成功，改动了 ${changed} 的取值` : '随后对同一目标的调用成功'
  const date = new Date().toISOString().slice(0, 10)
  const line = `- 错误：${last.tool} 对 ${target} 的调用失败 ｜ 为什么错：${why} ｜ 正确：${fix} ｜ 触发：${last.tool} + ${target} ｜ ${date}`
  const seen = state.induced ?? (state.induced = new Set())
  if (seen.has(line)) return
  try {
    appendFileSync(ledger, `\n${line}\n`, 'utf8')
  } catch {
    return
  }
  seen.add(line)
  state.inducedCount = (state.inducedCount ?? 0) + 1
  stats.ledgerInduced += 1
  stats.lastLedgerInduced = { tool: last.tool, target }
}

/** Arm the verification reminder after a successful change to a code artifact. */
export function armVerifyNotice(exec, result) {
  if (exec === undefined || exec === null) return
  if (result !== undefined && result !== null && result.isError === true) return
  const name = String(exec.name ?? '').toLowerCase()
  if (name !== 'write' && name !== 'edit') return
  const path = pathFromExec(exec)
  if (path === null || !VERIFY_EXTS.test(path)) return
  const state = stateFor(exec)
  if (state === null) return
  state.verifyPending = { artifact: toPosix(path), at: Date.now() }
}

function evaluateDocsNotice(config, exec, stats) {
  const docsCfg = config.docsNotice ?? {}
  if (docsCfg.enabled === false) return null
  if (exec === undefined || exec === null || typeof exec.name !== 'string') return null
  const session = exec.agent === undefined || exec.agent === null ? undefined : exec.agent.session
  if (session === undefined || session === null) return null
  // Same reach as the section: a delegated child stays silent unless the
  // deployment explicitly opted the documents into children.
  if (isChildSession(session) && !subagentOptIn(config.inSubagents)) return null
  const cwd = session.header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) return null
  const state = stateFor(exec)
  if (state === null) return null

  const unread = []
  const stamps = []
  // The same probe order the section uses, so the notice can never point at a
  // document the prompt does not list.
  for (const shown of collectFound(config, cwd, session)) {
    // Normalised exactly as `resolveTarget` does, or a read that satisfied the
    // precedent gate would not be seen here.
    const absolute = isAbsolute(shown) ? resolve(shown) : resolve(cwd, shown)
    let stamp
    try {
      const stat = statSync(absolute)
      stamp = `${stat.size}:${Math.trunc(stat.mtimeMs)}`
    } catch {
      // Vanished between the probe and this stat — nothing to point at.
      continue
    }
    stamps.push(`${shown}@${stamp}`)
    if (!state.read.has(absolute)) unread.push(shown)
  }
  if (unread.length === 0 || stamps.length === 0) return null
  const print = stamps.join('|')
  // R6 — the closure. One reminder per document version was an ask a model can
  // simply not answer: the observed failure is a session reminded three times that
  // still never opened the file. So a version gets two reminders — the first is the
  // listing, the second embeds the documents themselves and is the last. Both are
  // injected messages, so neither touches the prompt prefix (cache-neutral).
  const seen = state.docsNoticeSeen ?? (state.docsNoticeSeen = new Map())
  const sent = seen.get(print) ?? 0
  if (sent >= DOCS_NOTICE_MAX_SENDS) return null
  if (docsCfg.dryRun === true) {
    stats.docsNoticeWouldSend += 1
    return null
  }
  const withContent = sent >= 1
  const excerpts = withContent ? readDocExcerpts(unread, cwd) : []
  return {
    kind: 'nudge',
    tag: 'docs',
    count: unread.length,
    print,
    withContent,
    notice: createNotice(
      buildDocsNoticeText(unread, excerpts),
      withContent ? 'maintainer documents: unread (content included)' : 'maintainer documents: unread',
    ),
  }
}

/** R6: reminders per document version, and how much the second one may carry. */
const DOCS_NOTICE_MAX_SENDS = 2
const DOC_EXCERPT_EACH = 1600
const DOC_EXCERPT_TOTAL = 4000

/** The actual text of the unread documents, bounded, for the second reminder. */
function readDocExcerpts(unread, cwd) {
  const out = []
  let budget = DOC_EXCERPT_TOTAL
  for (const shown of unread) {
    if (budget <= 0) break
    const absolute = isAbsolute(shown) ? resolve(shown) : resolve(cwd, shown)
    try {
      const text = readFileSync(absolute, 'utf8')
      const slice = text.slice(0, Math.min(DOC_EXCERPT_EACH, budget))
      if (slice.length === 0) continue
      out.push({ doc: shown, text: slice, truncated: text.length > slice.length })
      budget -= slice.length
    } catch {
      // Unreadable or vanished between the stat and this read — the listing above
      // still stands, and the next call re-probes.
    }
  }
  return out
}

/** Build the injected text for the unread-document reminder. */
function buildDocsNoticeText(unread, excerpts = []) {
  const lines = [
    'maintainer-doc-guard: this session has maintainer documents with content that you have not read yet.',
    '',
  ]
  for (const doc of unread) lines.push(`- ${doc}`)
  lines.push(
    '',
    'The prompt lists them at every step; listing is not reading. Open them before continuing — they are this workspace\'s standing instructions from the operator, and they outrank anything you inferred since.',
  )
  if (excerpts.length > 0) {
    lines.push(
      '',
      'This is the second reminder, so the content is included rather than asked for a third time. These are the operator\'s standing instructions for this workspace.',
    )
    for (const item of excerpts) {
      lines.push('', `--- ${item.doc}${item.truncated ? ' (truncated — open the file for the rest)' : ''} ---`, '', item.text.trim())
    }
  }
  return lines.join('\n')
}

/* ------------------------------------------------------------------ *
 * The intent gate — "say what this step is for, before you act on it".
 *
 * The precedent gate above stops a write that was never anchored to a real
 * precedent. It says nothing about the OTHER half of the same failure: acting
 * before deciding whether the action is worth taking. That is what this gate
 * covers. The stated intent is SESSION-scoped, not call-scoped and not
 * re-armed every turn:
 *
 *   A user instruction arrives. The model states what its step is for (prose
 *   of at least `minChars`). From then on — for the rest of the session, across
 *   as many turns as the work takes — every side-effecting call passes
 *   untouched. Only a NEW user instruction re-arms the requirement (see
 *   `noteUserMessage`), because the task may have changed. If the very first
 *   side-effecting call of a session fires before any explanation, it is denied
 *   once with a reason that asks for the missing line, and the model re-issues
 *   it after explaining itself.
 *
 * So the steady-state cost is ZERO round trips: a model that says what it is
 * doing is never interrupted, and only an unexplained action pays. The gate is
 * also self-disarming — see `evaluateIntent` for why a missing observation
 * channel must silence it rather than make it deny blind.
 * ------------------------------------------------------------------ */

/**
 * Per-session intent ledger, keyed by the same opaque `agent.session` identity
 * the precedent gate uses. One entry per SESSION (not per turn — `textChars`
 * persists across turns until a new user instruction resets it):
 *
 * - `textChars`     — how much real prose the model produced since the last
 *                     user instruction. The threshold is applied at JUDGEMENT
 *                     time, not at recording time, so raising `minChars` from
 *                     the settings page re-tunes the gate against the current
 *                     session instead of only affecting the next turn.
 * - `assistantSeen` — how many `assistant/message` events the current turn has
 *                     delivered. Zero, while a tool call is already being
 *                     dispatched, means the `session/event` channel is not
 *                     reaching this plugin: the gate cannot judge, so it
 *                     disarms.
 * - `blocks`        — how many calls this gate already denied this turn, so a
 *                     stubborn model can never deadlock its own turn.
 */
const intentState = new WeakMap()

/** The intent ledger for one session, created on first use. */
function intentRecordFor(session) {
  if (session === undefined || session === null || typeof session !== 'object') return null
  let record = intentState.get(session)
  if (record === undefined) {
    record = { turn: null, step: null, textChars: 0, narration: '', assistantSeen: 0, blocks: 0, disarmed: false, steps: 0, nudges: 0, deviations: 0, driftNudged: false }
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
  // `textChars` is intentionally NOT reset here. A stated intent persists across
  // turns until a new user instruction re-anchors the session (see
  // `noteUserMessage`): the model states what a step is for once, then works
  // freely across the following turns instead of being nagged to re-explain at
  // the open of every turn. Only the per-turn budgets below reset, so a turn
  // can never be blocked to death.
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
 * Record the standing objective for this session, choosing what counts as "the
 * thing this session is answerable to" by WHO is reading it.
 *
 * At the top level that is the user's latest instruction, and the discriminator
 * is `source.kind === 'user'`. The guard's own nudges and the loop's
 * runtime-context snapshot are `user/message` events too, and adopting one of
 * those would make the anchor quote the guard back at itself. This is the same
 * test the shipped `dsh-repeat-tool-reminder` uses to reset its repeat chain.
 *
 * Inside a delegated child it is the DELEGATION, and `source.kind` cannot tell
 * it apart: the subagent service hands the child its prompt as a user-authored
 * message (`source: { kind: 'user' }`), so a child's own first message is
 * indistinguishable from a human's by source alone. The lineage is what
 * actually differs, so the rule is positional there — adopt the first
 * non-empty user-role message of the session, once, and let a later real send
 * (an operator or the parent continuing the child) replace it. Adopting the
 * parent's objective instead would be worse than adopting nothing: it invites
 * the child to treat the original request as its own assignment and widen its
 * scope, which is precisely what a delegated agent must not do.
 *
 * Timing works out without any extra seam: the loop appends the accepted user
 * batch during the step that claimed it, so the very next assembly — the next
 * step of the same turn — already renders the new objective. The turn's first
 * step sees the previous anchor (or none), but that step is the one where the
 * message is literally the last thing in the request, so there is nothing for
 * an anchor to disambiguate yet.
 */
function noteUserMessage(session, event) {
  const state = stateForSession(session)
  if (state === null) return
  const message = event === undefined || event === null ? undefined : event.data
  const source = message === undefined || message === null ? undefined : message.source
  if (source === undefined || source === null || source.kind !== 'user') return
  const text = textOfMessage(message)
  if (text.length === 0) return
  if (isChildSession(session) && state.taskSeen) return
  state.taskSeen = true
  state.anchor = text
  // A new user instruction re-anchors the objective, so the model must
  // re-state intent for the new task rather than coasting on an earlier one.
  const record = intentRecordFor(session)
  if (record !== null) {
    record.textChars = 0
    record.narration = ''
    record.disarmed = false
  }
}

/**
 * Record one `assistant/message`: accumulate its prose length. A turn change
 * re-opens the ledger here as well as on `turn/start`, so a missed boundary
 * event can never leak the previous turn's verdict into this one.
 */
function noteAssistantMessage(session, event) {
  const data = event === undefined || event === null ? undefined : event.data
  // Keep the latest assistant prose per session: the strict on-topic judge
  // reads it at the stop boundary, where the turn's final answer is what the
  // judge must rule on.
  const state = stateForSession(session)
  if (state !== null) {
    const text = assistantText(data === undefined || data === null ? undefined : data.message)
    if (text.length > 0) state.lastAnswer = text
  }
  const record = intentRecordFor(session)
  if (record === null) return
  const turn = data === undefined || data === null ? undefined : data.turn
  if (Number.isFinite(turn) && record.turn !== turn) {
    resetIntentTurn(session, turn, data === undefined || data === null ? undefined : data.step)
  }
  record.assistantSeen += 1
  const prose = textOfMessage(data === undefined || data === null ? undefined : data.message)
  record.textChars += prose.length
  // R2: keep the prose itself, not only its length. A length threshold alone
  // cleared the gate for every verbose turn. Bounded to the most recent window,
  // so the buffer can neither grow without limit nor go stale.
  if (prose.length > 0) {
    record.narration = `${record.narration}${prose}\n`
    if (record.narration.length > NARRATION_CAP) record.narration = record.narration.slice(-NARRATION_CAP)
  }
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
function evaluateDrift(nudge, record, stats, intentMinChars) {
  // R3: four silent exits, each counted, so the panel can answer "was the drift
  // check suppressed, and by which condition" instead of leaving a reader to
  // guess between "never rendered" and "rendered, no effect".
  if (!nudge.enabled || nudge.afterSteps <= 0) {
    stats.driftSkipDisabled += 1
    return null
  }
  if (record.driftNudged) {
    stats.driftSkipDone += 1
    return null
  }
  if (record.steps < nudge.afterSteps) {
    stats.driftSkipEarly += 1
    return null
  }
  if (record.nudges >= nudge.maxPerTurn) {
    stats.driftSkipBudget += 1
    return null
  }
  // A turn the model is narrating well — it has already stated what its steps
  // are for — is, by that same fact, the kind of long productive task the drift
  // reminder exists to avoid misfiring on. Suppress the nudge there so a normal
  // long task is never nagged just for taking many steps.
  // Report item A2: this line used to short-circuit the drift check whenever
  // the turn's prose cleared the intent threshold — so the turns with the most
  // narration could never be checked for drift, which is exactly backwards. A
  // long, fluent turn that quietly swapped its target is the failure this check
  // exists for. The drift clock is now the step count alone.
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
 * Send the objective anchor as a tail message instead of a prompt section.
 *
 * Called from the tool-call path, which is the first place an agent handle is
 * available — the same place the document reminder is delivered. The anchor
 * text is its own version key, so one objective is announced exactly once and a
 * new user message announces again; that also means a delivery that fails is
 * retried on the next call rather than being lost.
 */
function deliverAnchor(exec, anchor, stats) {
  if (anchor === undefined || anchor === null) return false
  if (anchor.delivery !== 'message' || anchor.enabled === false) return false
  const agent = exec === undefined || exec === null ? undefined : exec.agent
  if (agent === undefined || agent === null) return false
  const session = agent.session
  if (session === undefined || session === null) return false
  const text = renderAnchorSection({ anchor }, { agent }, true)
  if (text.length === 0) return false
  const state = stateForSession(session)
  if (state === null) return false
  if (state.anchorSent === text) return false
  if (!deliverNudge(agent, createNotice(text, 'current objective (tail delivery)'), stats)) return false
  state.anchorSent = text
  stats.anchorSent = (stats.anchorSent || 0) + 1
  stats.lastAnchor = text.slice(0, 160)
  return true
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
/**
 * R2 — the relational half of the intent judgement.
 *
 * A turn that says a LOT is not a turn that said what THIS call is for. With only
 * the length threshold, `minChars: 24` is cleared by any narration at all, so the
 * gate passed every step of a verbose agent and never fired in a whole session.
 * The question asked here is narrower and answerable: does the narration name the
 * tool being called, or a file stem that appears in its arguments? A token must be
 * at least `INTENT_TOKEN_MIN` characters, so a stray fragment cannot satisfy it.
 *
 * This is a STRICTER reading than before, which is why the staged path matters:
 * the first unexplained action still gets the reminder (`nudge.grace`) instead of
 * a denial, so a model that takes the hint never meets the wall.
 */
const NARRATION_CAP = 4000
const INTENT_TOKEN_MIN = 4

/** File-ish stems named anywhere in a call's arguments. */
function callTokens(exec) {
  const args = exec?.arguments ?? exec?.args
  const out = []
  if (args === undefined || args === null || typeof args !== 'object') return out
  for (const value of Object.values(args)) {
    if (typeof value !== 'string') continue
    const matches = value.match(/[^\s'";|()<>]+/g) ?? []
    for (const token of matches) {
      if (!/[./\\]/.test(token)) continue
      const base = token.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
      const stem = base.replace(/\.[A-Za-z0-9]{1,6}$/, '')
      if (stem.length >= INTENT_TOKEN_MIN) out.push(stem)
    }
  }
  return out
}

/** Whether this turn's narration names the tool or a file the call touches. */
function narrationExplainsCall(record, exec) {
  const narration = typeof record.narration === 'string' ? record.narration.toLowerCase() : ''
  if (narration.length === 0) return false
  const name = String(exec.name).toLowerCase()
  if (name.length >= INTENT_TOKEN_MIN && narration.includes(name)) return true
  for (const token of callTokens(exec)) {
    if (narration.includes(token.toLowerCase())) return true
  }
  return false
}

function evaluateIntent(intent, nudge, exec, stats) {
  if (!intent.enabled) return null
  if (exec === undefined || exec === null || typeof exec.name !== 'string') return null
  if (!intent.tools.includes(exec.name) && !isDestructiveTool(exec.name)) return null

  const session = exec.agent === undefined || exec.agent === null ? undefined : exec.agent.session
  const record = intentRecordFor(session)
  if (record === null) return null

  // R2: an explanation counts only when it is ABOUT this call. `minChars` stays
  // the floor it always was (read live, so the settings page still re-tunes it),
  // but length alone no longer clears the gate: the narration must also name the
  // tool or a file the call touches. The drift check still applies either way — a
  // well-narrated turn can drift as far as a silent one.
  if (record.textChars >= intent.minChars && narrationExplainsCall(record, exec)) {
    return evaluateDrift(nudge, record, stats, intent.minChars)
  }

  if (record.assistantSeen === 0) {
    if (!record.disarmed) {
      record.disarmed = true
      stats.intentDisarmed += 1
    }
    return evaluateDrift(nudge, record, stats, intent.minChars)
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
      return evaluateDrift(nudge, record, stats, intent.minChars)
    }
    record.nudges += 1
    if (nudge.dryRun) {
      stats.nudgeWouldSend += 1
      return evaluateDrift(nudge, record, stats, intent.minChars)
    }
    return {
      kind: 'nudge',
      notice: createNotice(buildNudgeText(exec.name), `step purpose: ${exec.name}`),
      tag: 'intent',
    }
  }

  if (record.blocks >= intent.maxBlocksPerTurn) {
    stats.intentGaveUp += 1
    return evaluateDrift(nudge, record, stats, intent.minChars)
  }
  if (intent.dryRun) {
    stats.intentWouldBlock += 1
    return evaluateDrift(nudge, record, stats, intent.minChars)
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
  if (exec === undefined || exec === null) return
  if (result !== undefined && result !== null && result.isError === true) return
  const name = String(exec.name ?? '').toLowerCase()
  if (name !== 'read' && !SHELL_TOOL_NAMES.has(name)) return
  const state = stateFor(exec)
  if (state === null) return
  if (SHELL_TOOL_NAMES.has(name)) {
    // R5 — the shell half of "what counts as reading". Only paths that actually
    // exist are recorded, so a typo cannot silently exempt a guarded write from
    // the precedent gate later on.
    for (const token of shellReadPaths(commandOf(exec))) {
      const absolute = resolveTarget(exec, token)
      if (!isFile(absolute)) continue
      if (!state.read.has(absolute)) {
        state.read.add(absolute)
        stats.reads += 1
      }
    }
    return
  }
  const raw = pathFromExec(exec)
  if (raw === null) return
  const absolute = resolveTarget(exec, raw)
  if (!state.read.has(absolute)) {
    state.read.add(absolute)
    stats.reads += 1
  }
}

/* ------------------------------------------------------------------ *
 * Fork inheritance, orphan cleanup, and "open the folder".
 * ------------------------------------------------------------------ */

/** A session id safe to use as one path segment, or null. */
function sessionKeyOf(session) {
  if (session === undefined || session === null) return null
  const id = session.id
  return sanitizeSession(typeof id === 'string' ? id : String(id))
}

/** The per-session document folder for one session, or null when untrackable. */
function sessionDocsDir(config, cwd, session) {
  if (typeof cwd !== 'string' || cwd.length === 0) return null
  const key = sessionKeyOf(session)
  if (key === null) return null
  return { key, dir: join(cwd, config.docsDir, key) }
}

/**
 * Copy a forked child the parent's document set into the CHILD'S OWN folder.
 *
 * A fork gets a fresh session id, so with per-session documents it would
 * otherwise start blank — which reads as "the branch forgot the project". The
 * inheritance is a copy, not a shared pointer: the child's later edits must
 * never reach back into the parent, and the parent's must not leak forward.
 *
 * Only files that do not already exist in the child are written, so a replayed
 * `session/created` can never overwrite work the child has already saved.
 */
function inheritDocsOnFork(config, session, stats) {
  const header = session === undefined || session === null ? undefined : session.header
  if (header === undefined || header === null) return
  const parentId = header.parentSession
  if (parentId === undefined || parentId === null) return
  const cwd = header.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) return
  const child = sessionDocsDir(config, cwd, session)
  const parentKey = sanitizeSession(typeof parentId === 'string' ? parentId : String(parentId))
  if (child === null || parentKey === null) return
  // A child that is not itself seeded was not created by a fork boundary we
  // should inherit across; leave it alone.
  if (header.isSeeded !== true) return
  if (child.key === parentKey) return
  const parentDir = join(cwd, config.docsDir, parentKey)
  let copied = 0
  for (const doc of config.docs) {
    if (typeof doc !== 'string' || doc.length === 0) continue
    // Absolute entries are deployment-pointed shared files; never copy them.
    if (isAbsolute(doc)) continue
    const from = join(parentDir, doc)
    const to = join(child.dir, doc)
    try {
      if (!isFile(from)) continue
      if (isFile(to)) continue
      mkdirSync(dirname(to), { recursive: true })
      writeFileSync(to, readFileSync(from, 'utf8'), 'utf8')
      copied += 1
    } catch {
      // One uncopyable file must not abort the rest of the set.
    }
  }
  if (copied > 0) stats.forkInherited += 1
}

/**
 * List the session sub-folders under one workspace's docs dir, newest first,
 * with the id each folder name decodes to. Used by both the folder listing and
 * the orphan sweep.
 */
function listSessionFolders(config, cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return []
  const base = join(cwd, config.docsDir)
  let entries
  try {
    entries = readdirSync(base, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const full = join(base, entry.name)
    try {
      out.push({ key: entry.name, dir: full, mtime: statSync(full).mtimeMs })
    } catch {
      // Vanished between readdir and stat — skip.
    }
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}

/**
 * Delete the document folders of sessions that no longer exist. There is no
 * host `session/delete` event (and no host delete API at all), so cleanup is a
 * sweep driven by the caller, not a reaction: we ask the session registry which
 * ids are live and remove only the folders whose id is absent from it.
 *
 * Safety is structural rather than probabilistic — the sweep is confined to
 * direct children of `<cwd>/<docsDir>/`, each candidate must be one recorded
 * folder name, and a sweep that cannot enumerate live sessions removes NOTHING.
 */
async function sweepOrphans(ctx, config, cwd, stats) {
  const live = await liveSessionIds(ctx, cwd)
  if (live === null) {
    return { removed: [], skipped: 'could not enumerate live sessions' }
  }
  const removed = []
  for (const folder of listSessionFolders(config, cwd)) {
    if (folder.key.startsWith('.')) continue
    if (!isSessionFolder(config, folder.dir)) continue
    if (live.has(folder.key)) continue
    try {
      rmSync(folder.dir, { recursive: true, force: true })
      removed.push(folder.key)
    } catch {
      // A folder we cannot remove is skipped, never escalated into a broader rm.
    }
  }
  if (removed.length > 0) stats.orphansRemoved += removed.length
  return { removed, skipped: null }
}

/**
 * Read one optional service off a context, or null. Never throws: a deployment
 * that does not mount the service is a normal case, not an error.
 */
function serviceOf(ctx, key) {
  try {
    const value = ctx === undefined || ctx === null || ctx.get === undefined ? undefined : ctx.get(key)
    return value === undefined || value === null ? null : value
  } catch {
    return null
  }
}

/**
 * An `AbortSignal` to hand to host APIs that require one.
 *
 * Several host methods (`openWorkspacePath` most notably) call
 * `signal.throwIfAborted()` on an UNGUARDED parameter, so passing `undefined`
 * throws a TypeError rather than doing anything useful. But for a folder-open we
 * NEVER want the operation to be cancelled: it is a fire-and-forget desktop
 * action, and inheriting the caller/request signal would risk leaking an
 * already-aborted signal in (which makes the host reject with
 * "This operation was aborted") for zero benefit. So this always returns a fresh,
 * never-aborting controller signal — satisfying the required parameter without
 * ever aborting the native open.
 */
function signalOf() {
  try {
    return new AbortController().signal
  } catch {
    return undefined
  }
}

/**
 * The set of session ids the host still has stored, as sanitized keys, or null
 * when the store is unavailable. `sessionPersistence.list()` is the right
 * source — it enumerates what durably exists, which is exactly what "orphaned
 * folder" is measured against. `null` is the safe answer: the sweep must remove
 * nothing when it cannot prove a folder is orphaned.
 */
async function liveSessionIds(ctx, cwd) {
  const store = serviceOf(ctx, 'sessionPersistence')
  if (store === null || typeof store.list !== 'function') return null
  try {
    const list = await store.list()
    if (!Array.isArray(list)) return null
    const ids = new Set()
    for (const item of list) {
      if (item === undefined || item === null) continue
      const header = item.header !== undefined && item.header !== null ? item.header : item
      const raw = header.id
      const cwdOf = header.cwd
      // Only compare within the same workspace: a folder under THIS cwd can
      // only belong to a session whose cwd matches it. A stored session with no
      // recorded cwd is treated as belonging here (canonical store semantics).
      if (typeof cwdOf === 'string' && cwdOf.length > 0 && resolve(cwdOf) !== resolve(cwd)) continue
      const key = sanitizeSession(typeof raw === 'string' ? raw : String(raw))
      if (key !== null) ids.add(key)
    }
    return ids
  } catch {
    return null
  }
}

/**
 * Whether a folder under the docs dir is actually a per-session document set.
 * The docs dir holds session folders, but `maintainer/` (the nested home of
 * `maintainer/README.md`) sits right beside them — so shape alone is not
 * enough. A real session folder contains at least one configured document that
 * is NOT itself inside a nested subfolder of the docs dir.
 */
function isSessionFolder(config, dir) {
  for (const doc of config.docs) {
    if (typeof doc !== 'string' || doc.length === 0) continue
    if (isAbsolute(doc)) continue
    // Only top-level documents count: `maintainer/README.md` lives in the
    // `maintainer/` folder, so that folder would otherwise qualify on its own.
    if (doc.includes('/') || doc.includes('\\')) continue
    if (isFile(join(dir, doc))) return true
  }
  return false
}

/* ------------------------------------------------------------------ *
 * The on-topic judge (`agent/turn-stopping`) — the STRICT hard stop.
 * ------------------------------------------------------------------ */

/**
 * The judge's one-shot prompt. It is deliberately tiny and answer-only: the
 * judge must not become a second task, and a one-word verdict keeps the token
 * cost of an enforced turn bounded.
 */
const JUDGE_SYSTEM = [
  'You are a strict relevance judge. You receive (1) the user\'s latest instruction and (2) the agent\'s final answer for one turn.',
  'Decide ONE thing: does the answer actually address the instruction?',
  'An answer that only reports process, reflects on failures, inventories side-quests, or describes work done WITHOUT answering the instruction is OFF-TOPIC, even if every step was related.',
  'A correct answer may also contain extra material; extra material alone does not make it off-topic.',
  'Reply with exactly one line: "ONTOPIC" or "OFFTOPIC: <reason in at most 20 words>". Nothing else.',
].join('\n')

/** Parse the judge's one-line verdict. Unknown shapes count as ONTOPIC (fail-open). */
function parseVerdict(text) {
  const raw = typeof text === 'string' ? text.trim() : ''
  if (raw.length === 0) return { off: false, reason: '' }
  if (/^ONTOPIC\b/i.test(raw)) return { off: false, reason: '' }
  const m = raw.match(/^OFFTOPIC\s*:?\s*(.*)$/i)
  if (m) return { off: true, reason: (m[1] || '').trim() }
  // Fail-open: an unparseable verdict must never trap a finished answer.
  return { off: false, reason: '' }
}

/** Concatenate the assistant's own text from one `assistant/message` payload. */
function assistantText(message) {
  if (message === undefined || message === null) return ''
  const content = message.content
  if (!Array.isArray(content)) return ''
  const out = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      out.push(block.text)
    }
  }
  return out.join('\n').trim()
}

/**
 * Ask the session's own model whether `answer` addresses `instruction`.
 * Resolves to null whenever the check cannot be made (no llm service, no
 * provider/model, empty inputs, provider failure) — every one of those is a
 * reason to let the answer through, never to trap it.
 */
async function judgeOnTopic(llm, provider, model, instruction, answer, signal) {
  if (llm === undefined || llm === null) return null
  if (typeof provider !== 'string' || provider.length === 0) return null
  if (typeof model !== 'string' || model.length === 0) return null
  if (typeof instruction !== 'string' || instruction.length === 0) return null
  if (typeof answer !== 'string' || answer.length === 0) return null
  // A very long answer is fine to judge from its head: the opening is where
  // "did it lead with the answer" is decided, and the goal here is a cheap,
  // bounded check rather than a faithful full transcript.
  const clipped = answer.length > 4000 ? `${answer.slice(0, 4000)}\n…(truncated)` : answer
  const userText = `USER INSTRUCTION:\n${instruction}\n\nAGENT ANSWER:\n${clipped}`
  try {
    let text = ''
    const stream = llm.stream({
      provider,
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
      system: JUDGE_SYSTEM,
      maxTokens: 60,
      temperature: 0,
      signal,
    })
    for await (const chunk of stream) {
      // Adapters emit text deltas; collecting both common shapes keeps this
      // independent of which provider is configured.
      if (chunk === undefined || chunk === null) continue
      if (typeof chunk.text === 'string') text += chunk.text
      else if (chunk.delta !== undefined && typeof chunk.delta.text === 'string') text += chunk.delta.text
    }
    return parseVerdict(text)
  } catch (error) {
    try {
      // Degrade to "let it through": a judge outage is not the user's problem.
      void error
    } catch {
      // ignore
    }
    return null
  }
}

/**
 * Mount the strict on-topic judge. It runs at the turn's stop boundary — the
 * ONLY place an answer can still be caught, because a finished answer is not
 * revocable once the turn closes. When the judge calls the answer off-topic,
 * the plugin steers a correction into the agent: the loop sees a non-empty
 * inbox and does NOT close the turn, so the model must answer the instruction
 * before it can stop.
 *
 * Always mounted; `enabled` is read live so the panel's strict switch takes
 * effect without a restart. Off unless the user turned it on.
 */
function registerOnTopicJudge(ctx, stats) {
  // Resolve `llm` through a child context that declares it in `inject`. The
  // plugin root only declares `systemPrompt` (a hard requirement), so a bare
  // `ctx.get('llm')` off it would answer `undefined` forever — the judge would
  // silently report "failed" on every strict turn. This callback fires as soon
  // as the deployment mounts `llm`; when it never mounts, `judgeCtx` stays
  // undefined and the judge fails open exactly as designed.
  let judgeCtx
  ctx.inject(['llm'], (injected) => {
    judgeCtx = injected
  })

  ctx.on('agent/turn-stopping', async (payload) => {
    if (!strictOnTopic) return
    try {
      const agent = payload === undefined || payload === null ? undefined : payload.agent
      if (agent === undefined || agent === null) return
      const session = agent.session
      const state = session === undefined || session === null ? undefined : sessionState.get(session)
      const instruction = state === undefined ? '' : state.anchor
      const answer = state === undefined ? '' : state.lastAnswer
      if (typeof instruction !== 'string' || instruction.length === 0) return
      if (typeof answer !== 'string' || answer.length === 0) return
      const options = agent.options === undefined || agent.options === null ? {} : agent.options
      const llm = serviceOf(judgeCtx, 'llm')
      const verdict = await judgeOnTopic(llm, options.provider, options.model, instruction, answer, payload === undefined ? undefined : payload.signal)
      if (verdict === null) {
        stats.judgeFailed += 1
        return
      }
      if (!verdict.off) {
        stats.judgeOnTopic += 1
        return
      }
      stats.judgeOffTopic += 1
      const reason = verdict.reason.length > 0 ? verdict.reason : 'the answer does not address the instruction'
      const notice = [
        'maintainer-doc-guard: this answer was judged OFF-TOPIC and the turn was not allowed to close.',
        `Judge's reason: ${reason}`,
        '',
        'Answer the instruction above directly, in your reply, before doing anything else.',
        'Your previous message was not an answer — restate it as an answer to the instruction.',
      ].join('\n')
      if (typeof agent.steer === 'function') {
        agent.steer({ role: 'user', content: [{ type: 'text', text: notice }], source: PLUGIN_SOURCE })
        stats.judgeSteered += 1
      }
    } catch {
      // A judge bug must never wedge the turn — fail open by saying nothing.
    }
  })
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
function registerGate(ctx, gateOf, intentOf, nudgeOf, docsOf, anchorCfgOf, stats) {
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

      // The objective anchor, appended rather than rendered into the prompt.
      // Same text, same moment as the old section, no prefix invalidation.
      deliverAnchor(exec, anchorCfgOf(), stats)

      if (decision === null) {
        const gate = gateOf()
        if (gate.enabled) decision = evaluateGate(gate, exec, stats)

        // The document reminder's missing verifier. The section says WHICH
        // documents exist; nothing checked whether they were ever opened, and
        // the observed failure is exactly that. Advisory by construction:
        // delivery is recorded only on SUCCESS, so a failed nudge is retried at
        // the next call instead of being silently spent.
        if (decision === null) {
          const docsDecision = evaluateDocsNotice(docsOf(), exec, stats)
          if (docsDecision !== null && deliverNudge(exec.agent, docsDecision.notice, stats)) {
            const docsState = stateFor(exec)
            if (docsState !== null) {
              docsState.docsNoticeFor = docsDecision.print
              // R6: count deliveries per document version. The second one carries
              // the content; the version then goes quiet for good.
              const seen = docsState.docsNoticeSeen ?? (docsState.docsNoticeSeen = new Map())
              seen.set(docsDecision.print, (seen.get(docsDecision.print) ?? 0) + 1)
            }
            stats.nudged += 1
            stats.docsNoticeSent += 1
            stats.lastNudge = { tool: exec.name, tag: docsDecision.tag }
            stats.lastDocsNotice = { tool: exec.name, count: docsDecision.count, withContent: docsDecision.withContent === true }
          }
        }

        // The lessons ledger, on demand: only the lines whose `触发` field names
        // this tool and this path/command are delivered — never the whole file.
        if (decision === null) {
          const ledgerDecision = evaluateLedgerNotice(docsOf(), exec, stats)
          if (ledgerDecision !== null && deliverNudge(exec.agent, ledgerDecision.notice, stats)) {
            const ledgerState = stateFor(exec)
            if (ledgerState !== null) {
              const fired = ledgerState.ledgerFired ?? (ledgerState.ledgerFired = new Set())
              for (const line of ledgerDecision.lines) fired.add(line)
            }
            stats.nudged += 1
            stats.ledgerNoticeSent += 1
            stats.lastLedgerNotice = { tool: exec.name, count: ledgerDecision.lines.length }
          }
        }

        // F4: deleting the sentences that CARRIED the numbers is the observed
        // failure; a net reduction in number runs is its objective trace.
        if (decision === null) {
          const contentDecision = evaluateContentNotice(exec, stats)
          if (contentDecision !== null && deliverNudge(exec.agent, contentDecision.notice, stats)) {
            const contentState = stateFor(exec)
            if (contentState !== null) {
              const seen = contentState.contentNotice ?? (contentState.contentNotice = new Set())
              seen.add(contentDecision.key)
            }
            stats.nudged += 1
            stats.contentNoticeSent += 1
          }
        }

        // The completion standard, stated once per changed artifact.
        if (decision === null) {
          const verifyDecision = evaluateVerifyNotice(exec, stats)
          if (verifyDecision !== null && deliverNudge(exec.agent, verifyDecision.notice, stats)) {
            const verifyState = stateFor(exec)
            if (verifyState !== null) verifyState.verifyPending = null
            stats.nudged += 1
            stats.verifyNoticeSent += 1
            stats.lastVerifyNotice = { tool: exec.name, artifact: verifyDecision.artifact }
          }
        }
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
    try {
      noteLedgerOutcome(exec, result, docsOf(), stats)
    } catch {
      // Auto-induction is best-effort: a failed append must not fail the call.
    }
    try {
      armVerifyNotice(exec, result)
    } catch {
      // Same rule: observation only, never a change to the call's outcome.
    }
    try {
      if (lastSectionRender !== null) {
        stats.sectionRenderSeen += 1
        stats.lastSectionDocs = lastSectionRender.docsListed
      }
    } catch {
      // Telemetry only.
    }
    return next()
  })
}

/* ------------------------------------------------------------------ *
 * UI data plane — the sidebar panel's read/write routes.
 * ------------------------------------------------------------------ */

/**
 * The seed written into the plugin's OWN `maintainer/README.md` when a document
 * set is created, or when that file exists but is still empty.
 *
 * Deliberately short. This text is prompt-visible — the reminder section lists
 * every NON-EMPTY document — so it has to earn its tokens with orientation
 * rather than documentation. `plan.md` is still created EMPTY — a seeded plan
 * would put the plugin's words into the operator's plan. `conventions.md` is the
 * one exception (see CONVENTIONS_SEED).
 */
const README_SEED = [
  '# 维护者文档（使用说明）',
  '',
  '本目录存放本工作区的长期记忆：每个会话一套，上下文被压缩也不会丢。',
  '本文件也会出现在系统提示的文档列表里，但**正文不会注入**。',
  '',
  '## 每份文档干什么',
  '',
  '- **plan.md** —— 这个会话要做什么：目标与验收标准。',
  '- **conventions.md** —— 必须遵守的硬规则（铁律）。',
  '- **stack.md** —— 技术栈与路径约定：用什么工具、东西放哪。',
  '- **state.md** —— 进度：做到哪、下一步、未决问题。',
  '- **lessons.md** —— 错误路线账本：踩过的坑与正确做法；只在遇到相同问题时才注入。',
  '- **maintainer/README.md** —— 本文件：给人看的说明。',
  '',
  '每轮提示里会**直接带上** plan.md 与 conventions.md 的正文（有字数上限）；其余文档只列文件名。',
  '',
  '## 这版会做什么',
  '',
  '- 每轮把 plan.md 与 conventions.md 的**正文**带进提示，长任务也不容易忘。',
  '- 把用户最近一条**真实指令**追加在工具调用前，明确优先级。',
  '- 改基础设施区之前，要求先读过同类已有实现（先例门禁）。',
  '- 没说明这一步要干什么就要动手时，先提醒、再拦截（意图门禁）。',
  '- lessons.md 里哪条教训和**本次调用**是同类问题，就只把那条贴出来一次（不整本常驻）。',
  '- 同一目标"失败后重试成功"时，自动把这条教训记进 lessons.md（每会话最多 3 条）。',
  '- 一次编辑让**数字净减少**时，提醒先核对那些数字/结论在别处是否另有落点。',
  '- 写过代码类文件后，下一次调用提醒一次"验证方式 + 实际读数"。',
  '',
  '## 每个按钮干什么（侧边栏「维护者文档」）',
  '',
  '- **文档页签**（plan.md / conventions.md / …）—— 切换编辑哪一份；带「·未建」的表示还没这个文件，首次保存时创建。',
  '- **重载** —— 丢掉未保存的改动，从磁盘重读。',
  '- **保存 / 已保存** —— 把编辑框写回磁盘；没有改动时不可点。',
  '- **严格扣题 · 开/关** —— 开启后回答先直接回扣提问、离题即停；关闭允许延伸，延伸要标在回答之后。',
  '- **提醒开关**（经验本命中 / 删数字落点核对 / 验证读数 / 经验本自动归纳）—— 分别开关这四类提醒，默认全开。',
  '- **打开文件夹** —— 在文件管理器里打开本会话的文档目录。',
  '- **清理孤儿文档** —— 删除已不存在会话遗留的文档文件夹；先列清单再确认。',
  '- 底部的**统计行** —— 各类提醒与拦截的次数。',
  '',
  '> 侧边栏的开关都是**进程级**：重启后回到默认。要长期生效的选项写进 profile 的 cordis.patch.yml——',
  '> 设置页那张卡片是十个开关的硬上限，加不进第 11 个。',
].join('\n')

/**
 * The seed written into `conventions.md` when a document set is created, or when
 * that file exists but is still empty.
 *
 * The operator asked for this explicitly: the iron rules are identical in every
 * session, so re-pasting them by hand is a manual step that silently gets
 * skipped — and a rule that is not written is a rule with zero coverage. This is
 * the only operator document the plugin seeds, because it is the only one whose
 * content is not per-session invention.
 *
 * Keep it SHORT: this text is force-injected into every assembly.
 */
const CONVENTIONS_SEED = [
  '# 铁律（conventions.md）',
  '',
  '本文件由插件在会话创建时预置，可自由改写；它会被**强制注入正文**，务必保持短。',
  '',
  '1. 不能说谎，一切依据事实来：每个结论都要能指到证据（文件+行号 / 命令+实际输出）。',
  '2. 先列技术路线、规划任务，再执行；执行中偏离路线要显式说明并等用户同意。',
  '3. 【证据守恒】删除任何文字前，先判定它承载的数字/结论在别处是否另有落点，并输出核对结果。删题注、删重复项一律适用。',
  '4. 【不静默覆盖】最近的用户指令不得静默覆盖 plan.md 的范围；两者冲突时先提出再动手。',
  '5. 【动作型完成标准】每遍改写脚本必须输出"落点核对"清单；没有清单不算完成。',
  '6. 【经验本】走错并纠正后，立刻在 lessons.md 追加一行：错误｜为什么错｜正确做法｜触发（工具+路径/命令片段）。',
  '7. 未验证不许写成"已完成/已修复"；写"验证方式 + 实际读数"。',
].join('\n')

/**
 * Heads of README seeds shipped by earlier versions. `ensureDocs` replaces the
 * plugin's own README when — and only when — the file on disk still starts with
 * one of these, so a README the operator rewrote is never clobbered while a
 * stale instruction sheet actually gets updated.
 */
const STALE_README_HEADS = ['# 维护者文档（dsh-maintainer-doc-guard 插件）']

/**
 * The seed for one configured document, or null when it is the operator's own.
 *
 * `lessons.md` is deliberately NOT seeded: a session-level file shadows the
 * workspace-level one in `collectFound`, so seeding it would hide the shared,
 * accumulated ledger behind an empty template.
 */
function seedFor(doc) {
  const name = basename(doc)
  if (name === 'README.md') return README_SEED
  if (name === 'conventions.md') return CONVENTIONS_SEED
  return null
}

/**
 * Ensure the maintainer-document folder exists in `cwd` and that every
 * configured document has a file on disk, so the side panel always has
 * something to open. Cheap and idempotent: it only stats/mkdirs and writes only
 * when the file is missing, or when the plugin's own README is still empty.
 */
export function ensureDocs(config, cwd, sessionKey) {
  const base = join(cwd, config.docsDir)
  const dir = sessionKey ? join(base, sessionKey) : base
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    return
  }
  for (const doc of config.docs) {
    if (typeof doc !== 'string' || doc.length === 0) continue
    const target = isAbsolute(doc) ? doc : join(dir, doc)
    try {
      const seed = seedFor(doc)
      let size = -1
      try {
        const stat = statSync(target)
        size = stat.isFile() ? stat.size : -1
      } catch {
        // Missing — created below.
      }
      // The README is the plugin's own text, and its instructions go stale when
      // the plugin changes. Upgrade it in place only when the file still starts
      // with a known older seed — never a README the operator rewrote.
      let stale = false
      if (size > 0 && seed !== null && basename(doc) === 'README.md') {
        try {
          stale = STALE_README_HEADS.some((head) => readFileSync(target, 'utf8').startsWith(head))
        } catch {
          // Unreadable → leave the file alone.
        }
      }
      // `size < 0` is a missing file. A 0-byte README is one this plugin owns
      // but never got to describe, so it is filled in rather than left as a stub
      // that the reminder section hides and the panel opens empty.
      if (size < 0 || (seed !== null && size === 0) || stale) {
        // writeFileSync does not create parent directories, so the nested
        // `maintainer/README.md` would otherwise fail with ENOENT and stay
        // silently missing.
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, seed ?? '', 'utf8')
      }
    } catch {
      // One unwritable file must not abort the whole ensure pass.
    }
  }
}

/**
 * Resolve every configured document inside `cwd` to an absolute path, whether or
 * not it exists yet (the editor offers to create the missing ones).
 */
function resolveDocs(config, cwd, sessionKey) {
  const base = join(cwd, config.docsDir)
  const dir = sessionKey ? join(base, sessionKey) : base
  const out = []
  const seen = new Set()
  for (const doc of config.docs) {
    if (typeof doc !== 'string' || doc.length === 0) continue
    const absolute = isAbsolute(doc) ? doc : join(dir, doc)
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
 * Turn an opaque client-supplied session id into a safe folder name. The id is
 * used verbatim as a path segment under `<docsDir>`, so it must never contain a
 * separator or `..`; anything outside `[A-Za-z0-9._-]` is collapsed to `_` and
 * the result is length-capped. Returns `null` for empty/garbage input so the
 * caller falls back to the workspace-level folder.
 */
function sanitizeSession(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128)
  if (cleaned.length === 0 || cleaned === '.' || cleaned === '..') return null
  return cleaned
}

/**
 * Register the panel's data plane. Optional: when the host has no web server the
 * plugin still injects its prompt section, there is just no panel behind it.
 */
function registerRoutes(ctx, config, stats, settings) {
  // `webServer` is the only hard requirement. The three services after it are
  // OPTIONAL and listed here for one reason only: in cordis, `ctx.get(key)`
  // resolves a service only through the context that declared it in `inject`.
  // Without them in this list `serviceOf(routeCtx, 'sessionController')` and
  // friends always answer `null`, which is exactly the 501 / "no working
  // directory" pair the panel was reporting. Listing them here is safe — the
  // callback fires as soon as `webServer` exists, and cordis supplies `undefined`
  // for the ones the deployment does not mount (a normal case, not an error).
  ctx.inject(['webServer', 'sessionController', 'sessionPersistence', 'llm'], (routeCtx) => {
    routeCtx.effect(() => routeCtx.webServer.register({
      kind: 'exact',
      path: '/dsh-maintainer-doc-guard/docs',
      handler: async (request, response) => {
        const method = request.method ?? 'GET'

        if (method === 'GET' || method === 'HEAD') {
          let cwd = lastCwd
          let sessionKey = lastSession
          try {
            const url = new URL(request.url ?? '/', 'http://127.0.0.1')
            const asked = url.searchParams.get('cwd')
            if (asked) cwd = asked
            const askedSession = sanitizeSession(url.searchParams.get('session'))
            if (askedSession) sessionKey = askedSession
          } catch {
            // Malformed URL — keep the last known working directory / session.
          }
          if (sessionKey) lastSession = sessionKey
          if (!cwd) {
            sendJson(response, 400, { ok: false, error: 'no working directory known yet' }, method === 'HEAD')
            return
          }
          try {
            ensureDocs(config, cwd, sessionKey)
            const docs = resolveDocs(config, cwd, sessionKey).map((doc) => ({
              name: doc.name,
              exists: doc.exists,
              content: doc.exists ? readFileSync(doc.absolute, 'utf8') : '',
            }))
            sendJson(
              response,
              200,
              { ok: true, cwd: toPosix(cwd), session: sessionKey, docs, gate: { ...stats } },
              method === 'HEAD',
            )
          } catch (error) {
            // Never answer the panel with an empty body — the browser surfaces
            // that as a cryptic "Unexpected end of JSON input".
            sendJson(
              response,
              500,
              { ok: false, error: `docs listing failed: ${String((error && error.message) || error)}` },
              method === 'HEAD',
            )
          }
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
        // The client sends the session id in the PUT body; the server has no
        // session context of its own, so per-session isolation on write must be
        // driven by this value. Without it `join(cwd, config.docsDir, sessionKey,
        // docName)` references an undefined `sessionKey` and the whole save 500s
        // — that is the "保存按钮没有用" symptom.
        // `|| ''` keeps `join` legal when no session is known: it falls back to
        // the workspace-level folder, exactly like the GET branch's `base`.
        const sessionKey = sanitizeSession(typeof body.session === 'string' ? body.session : lastSession) || ''
        if (sessionKey) lastSession = sessionKey

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
        const target = isAbsolute(docName) ? docName : join(cwd, config.docsDir, sessionKey, docName)
        if (!inside(join(cwd, config.docsDir, sessionKey), target)) {
          sendJson(response, 400, { ok: false, error: 'refusing to write outside the maintainer document folder' })
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

    // The on-topic mode toggle. A tiny GET/PUT pair for the sidebar switch:
    // GET reports the current mode, PUT flips it. Process-level state, so it
    // survives across sessions until the next restart — which is the intended
    // scope for "I want strict answering for a while".
    routeCtx.effect(() => routeCtx.webServer.register({
      kind: 'exact',
      path: '/dsh-maintainer-doc-guard/mode',
      handler: async (request, response) => {
        const method = request.method ?? 'GET'
        const headOnly = method === 'HEAD'

        if (method === 'GET' || headOnly) {
          sendJson(response, 200, { ok: true, strictOnTopic }, headOnly)
          return
        }
        if (method !== 'PUT' && method !== 'POST') {
          response.writeHead(405)
          response.end()
          return
        }
        try {
          const body = await readJsonBody(request)
          if (typeof body.strictOnTopic === 'boolean') strictOnTopic = body.strictOnTopic
          sendJson(response, 200, { ok: true, strictOnTopic })
        } catch (error) {
          sendJson(response, 400, { ok: false, error: String((error && error.message) || error) })
        }
      },
    }), 'maintainer-doc-guard: mode route')

    // The advisory-notice switches, as the sidebar's switch group. Same GET/PUT
    // shape and the same process-level scope as the mode route above: these are
    // "quiet it down for this run" controls, not deployment options.
    routeCtx.effect(() => routeCtx.webServer.register({
      kind: 'exact',
      path: '/dsh-maintainer-doc-guard/notices',
      handler: async (request, response) => {
        const method = request.method ?? 'GET'
        const headOnly = method === 'HEAD'

        if (method === 'GET' || headOnly) {
          sendJson(response, 200, { ok: true, switches: { ...noticeSwitches }, labels: NOTICE_SWITCH_LABELS, keys: NOTICE_SWITCH_KEYS }, headOnly)
          return
        }
        if (method !== 'PUT' && method !== 'POST') {
          response.writeHead(405)
          response.end()
          return
        }
        try {
          const body = await readJsonBody(request)
          const patch = body.switches ?? body
          for (const key of NOTICE_SWITCH_KEYS) {
            if (typeof patch[key] === 'boolean') noticeSwitches[key] = patch[key]
          }
          sendJson(response, 200, { ok: true, switches: { ...noticeSwitches } })
        } catch (error) {
          sendJson(response, 400, { ok: false, error: String((error && error.message) || error) })
        }
      },
    }), 'maintainer-doc-guard: notices route')

    // Orphan sweep: `GET` previews what would be removed, `POST` removes it.
    // The host has no session-delete event, so this is caller-driven cleanup,
    // and the GET-first shape lets the panel show the list before anything goes.
    routeCtx.effect(() => routeCtx.webServer.register({
      kind: 'exact',
      path: '/dsh-maintainer-doc-guard/orphans',
      handler: async (request, response) => {
        const method = request.method ?? 'GET'
        // The preview carries `cwd` in the query string; the sweep carries it in
        // the body. Reading only one of the two is what made the POST answer
        // "no working directory known yet" right after a successful preview.
        let cwd = lastCwd
        try {
          const url = new URL(request.url ?? '/', 'http://127.0.0.1')
          const asked = url.searchParams.get('cwd')
          if (asked !== null && asked.length > 0) cwd = asked
        } catch {
          // Malformed URL — keep the last known working directory.
        }
        let body = null
        if (method === 'POST' || method === 'PUT') {
          try {
            body = await readJsonBody(request)
          } catch {
            body = null
          }
          if (body !== null && typeof body.cwd === 'string' && body.cwd.length > 0) cwd = body.cwd
        }
        if (typeof cwd !== 'string' || cwd.length === 0) {
          sendJson(response, 400, { ok: false, error: 'no working directory known yet' })
          return
        }
        const folders = listSessionFolders(config, cwd).filter(
          (f) => !f.key.startsWith('.') && isSessionFolder(config, f.dir),
        )
        const live = await liveSessionIds(routeCtx, cwd)
        if (live === null) {
          sendJson(response, 200, {
            ok: true,
            cwd: toPosix(cwd),
            sweepable: false,
            reason: 'the session store is unavailable, so no folder can be proven orphaned',
            candidates: [],
            total: folders.length,
          })
          return
        }
        const candidates = folders.filter((f) => !live.has(f.key)).map((f) => f.key)
        if (method === 'GET' || method === 'HEAD') {
          sendJson(response, 200, {
            ok: true,
            cwd: toPosix(cwd),
            sweepable: true,
            candidates,
            total: folders.length,
          }, method === 'HEAD')
          return
        }
        if (method !== 'POST' && method !== 'PUT') {
          response.writeHead(405)
          response.end()
          return
        }
        const result = await sweepOrphans(routeCtx, config, cwd, stats)
        sendJson(response, 200, { ok: true, cwd: toPosix(cwd), removed: result.removed, skipped: result.skipped })
      },
    }), 'maintainer-doc-guard: orphans route')

    // "Open the folder" in the OS file manager. Uses the host's own
    // workspace-path opener (`reveal`), which on Windows resolves to
    // `explorer.exe /select,` — the plugin never spawns a GUI process itself.
    routeCtx.effect(() => routeCtx.webServer.register({
      kind: 'exact',
      path: '/dsh-maintainer-doc-guard/reveal',
      handler: async (request, response) => {
        if (request.method !== 'POST' && request.method !== 'PUT') {
          response.writeHead(405)
          response.end()
          return
        }
        const body = await readJsonBody(request)
        const cwd = typeof body.cwd === 'string' && body.cwd.length > 0 ? body.cwd : lastCwd
        if (typeof cwd !== 'string' || cwd.length === 0) {
          sendJson(response, 400, { ok: false, error: 'no working directory known yet' })
          return
        }
        const key = sanitizeSession(typeof body.session === 'string' ? body.session : lastSession)
        const target = key === null ? join(cwd, config.docsDir) : join(cwd, config.docsDir, key)
        // The opener lives on `sessionController` (dsh-api-session-controller),
        // NOT on `sessions` (a SessionStore, which has no such method) — using
        // the wrong service is why this answered 501.
        const controller = serviceOf(routeCtx, 'sessionController')
        if (controller === null || typeof controller.openWorkspacePath !== 'function') {
          sendJson(response, 501, { ok: false, error: 'the host has no workspace-path opener in this deployment', path: toPosix(target) })
          return
        }
        // Tell the truth about availability BEFORE calling: a headless/remote
        // deployment reaches this point with an opener method present but no
        // native file manager behind it, and the call would only fail later.
        // `canOpenWorkspacePath()` is the host's own probe for exactly this.
        if (typeof controller.canOpenWorkspacePath === 'function') {
          let canOpen = false
          try {
            canOpen = controller.canOpenWorkspacePath() === true
          } catch {
            canOpen = false
          }
          if (!canOpen) {
            sendJson(response, 501, {
              ok: false,
              error: 'this host cannot open a native file manager (no desktop file-manager available in this deployment)',
              path: toPosix(target),
            })
            return
          }
        }
        try {
          // The target is always a FOLDER (the docs directory). On Windows the
          // host's plain-open branch runs `powershell Invoke-Item <folder>`,
          // which opens it in Explorer; the `reveal` branch instead runs
          // `explorer.exe /select,<path>` — a flag whose job is highlighting a
          // FILE inside its parent. Passed a folder it neither throws nor opens a
          // window, so it would report success without doing anything visible.
          // Plain open is therefore the correct and sufficient choice here.
          //
          // ⚠ `openWorkspacePath(request, signal)` calls `signal.throwIfAborted()`
          // unguarded, so a signal that ever aborts throws. Folder opening is a
          // fire-and-forget desktop action and must never be cancelled, hence the
          // fresh never-aborting signal.
          await controller.openWorkspacePath({ path: target }, signalOf())
          sendJson(response, 200, { ok: true, path: toPosix(target) })
          return
        } catch (error) {
          sendJson(response, 500, {
            ok: false,
            error: `could not open the folder: ${String((error && error.message) || error || 'unknown')}`,
            path: toPosix(target),
          })
        }
      },
    }), 'maintainer-doc-guard: reveal route')

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
    switches: { ...noticeSwitches },
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
    inSubagents: subagentOptIn(source.inSubagents),
    // Whitelisted like every other anchor key: only the literal 'section' keeps
    // the prompt placement. An unknown value is rejected LOUDLY by the schema
    // above at composition time — verified: Config({anchor:{delivery:'bogus'}})
    // throws — so this line is only the quieter second line of defence for a raw
    // value that reaches normalise without passing through the schema.
    delivery: source.delivery === 'section' ? 'section' : 'message',
    childTitle: typeof source.childTitle === 'string' ? source.childTitle : DEFAULT_CHILD_ANCHOR_TITLE,
    childIntro: typeof source.childIntro === 'string' ? source.childIntro : DEFAULT_CHILD_ANCHOR_INTRO,
    childPriorities: Array.isArray(source.childPriorities) ? source.childPriorities : DEFAULT_CHILD_PRIORITIES,
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
    // `inSubagents` has no settings field on purpose — see `GATE_SETTINGS_FIELDS`.
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
  // `inSubagents` is deliberately NOT a settings knob: the card holds exactly
  // ten fields and this is a per-deployment call, so it is read from the
  // composition (`cordis.patch.yml`) and passed through untouched here.
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

/**
 * Field descriptors the panel renders; label copy lives in the browser half.
 *
 * Ten fields, which is a hard ceiling: the settings provider accepts a shared
 * single-namespace card of at most ten knobs, so an eleventh would make the
 * whole card fail to mount. The two subagent policies (`inSubagents` for the
 * document reminder, `anchor.inSubagents` for the anchor) are therefore NOT
 * settings knobs — both are per-deployment calls that belong in
 * `cordis.patch.yml`, where they cost nothing. Keeping them out is also the
 * honest split: a delegation-reach decision should be made once when the
 * deployment is composed, not flipped mid-session in a panel.
 */
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

/** Defensive normalisation for the document-reminder verifier. */
function normaliseDocsNotice(raw) {
  const source = raw === undefined || raw === null ? {} : raw
  return {
    enabled: source.enabled !== false,
    dryRun: source.dryRun === true,
  }
}

/** Defensive normalisation so the plugin behaves with or without schema parsing. */
function normalise(raw) {
  const source = raw === undefined || raw === null ? {} : raw
  return {
    enabled: source.enabled !== false,
    docs: Array.isArray(source.docs) && source.docs.length > 0 ? source.docs : DEFAULT_DOCS,
    // `docsDir` is the workspace-relative folder the per-session document sets
    // live under (`<docsDir>/<sessionId>/`). It is mandatory for every path
    // join below; without it `join(cwd, config.docsDir)` throws "path must be of
    // type string. Received undefined" and the GET /docs handler answers 500.
    docsDir: typeof source.docsDir === 'string' && source.docsDir.length > 0 ? source.docsDir : DEFAULT_DOCS_DIR,
    onlyWhenPresent: source.onlyWhenPresent === true,
    // `true` opts a deployment into children; everything else stays top-level
    // only. A 0.5.0 config that set `includeSubagents: true` still opts in.
    inSubagents: subagentOptIn(source.inSubagents) || source.includeSubagents === true,
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
    docsNotice: normaliseDocsNotice(source.docsNotice),
    injectDocs: normaliseInjectDocs(source.injectDocs),
  }
}

/** The mandatory-injection block: on by default, capped, whitelisted. */
function normaliseInjectDocs(raw) {
  const source = raw === undefined || raw === null ? {} : raw
  return {
    enabled: source.enabled !== false,
    docs: Array.isArray(source.docs) && source.docs.length > 0 ? source.docs : DEFAULT_INJECT_DOCS,
    title: typeof source.title === 'string' ? source.title : DEFAULT_INJECT_TITLE,
    maxCharsPerDoc: Number.isFinite(source.maxCharsPerDoc) ? Math.max(0, source.maxCharsPerDoc) : 2000,
    maxCharsTotal: Number.isFinite(source.maxCharsTotal) ? Math.max(0, source.maxCharsTotal) : 6000,
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
    // The document reminder's verifier (see `evaluateDocsNotice`): a document
    // listed at every step while `docsNoticeSent` stays 0 is exactly the
    // failure this counter exists to expose.
    docsNoticeSent: 0,
    docsNoticeWouldSend: 0,
    lastDocsNotice: null,
    // The ledger's on-demand hits, its auto-induction, the content check and the
    // completion standard — each with its own counter so "inert" and "working"
    // can be told apart without reading the source.
    ledgerNoticeSent: 0,
    ledgerInduced: 0,
    lastLedgerNotice: null,
    lastLedgerInduced: null,
    contentNoticeSent: 0,
    verifyNoticeSent: 0,
    lastVerifyNotice: null,
    // R3: one counter per silent exit of the drift check, so a suppressed check
    // names its own condition instead of leaving a reader to guess.
    driftSkipDisabled: 0,
    driftSkipDone: 0,
    driftSkipEarly: 0,
    driftSkipBudget: 0,
    // R4: the document section's own telemetry (see `renderSection`), reported
    // into stats by the next tool call — without it, "0 notices" cannot be told
    // apart from "the section never rendered".
    sectionRenderSeen: 0,
    lastSectionDocs: 0,
    // The strict on-topic judge (agent/turn-stopping). Zero until strict mode
    // is switched on; `judgeFailed` counts checks that could not be made
    // (fail-open) and is the first number to look at if enforcement seems inert.
    judgeOnTopic: 0,
    judgeOffTopic: 0,
    judgeSteered: 0,
    judgeFailed: 0,
    lastJudge: null,
    // Fork inheritance + orphan cleanup.
    forkInherited: 0,
    orphansRemoved: 0,
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
 * R4: the last document-section render, mirrored into `stats` by the next tool
 * call. A module-level slot because the renderer has no hook and no stats
 * parameter — it is called by the prompt provider, not by a tool event.
 */
let lastSectionRender = null
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
  registerGate(ctx, gateOf, intentOf, nudgeOf, () => resolved, () => anchorOf(), stats)
  registerOnTopicJudge(ctx, stats)
  // Fork inheritance rides `session/created`: a fork is not an event of its own,
  // it is a create whose header carries `parentSession`.
  ctx.on('session/created', (session) => {
    try {
      inheritDocsOnFork(resolved, session, stats)
    } catch {
      // Inheritance must never break session creation.
    }
  })
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
