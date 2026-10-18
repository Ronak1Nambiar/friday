// The routing profile: each agent's strengths and which agent handles which kind
// of task, as editable data in ~/.config/friday/profile.json. FRIDAY re-reads it
// whenever the file changes, so edits (by hand, by a self-change, or learned from
// @agent overrides) take effect on the next message.
import fs from 'node:fs';
import path from 'node:path';

// Strengths, from each CLI's help and docs:
// - Claude Code 2.1: multi-file edits, plan mode, skills/hooks; loads the user's vault
//   rules from ~/.claude/CLAUDE.md. No Claude Design (Artifact tool) when headless.
// - Codex 0.160: `codex exec` in a workspace-write sandbox; `codex exec review` is a
//   built-in reviewer, so it suits independent review of another agent's diff.
// - Gemini CLI: ~1M-token context, built-in Google Search grounding, reads images
//   and PDFs. Needs a one-time interactive login.
// - opencode 1.19: runs a free hosted model here (cost 0), fine for cheap or bulk work.
// - Ollama: local HTTP API, no tools; the only place private data may go.

export const DEFAULT_PROFILE = {
  version: 3,
  // Whose FRIDAY this is: the name agents hear ("<name>'s request"). Asked in `friday setup`.
  user: { name: '' },
  routing: 'auto', // auto | manual (manual = always the active agent, like v0.2)
  showRoute: true,
  showAbilities: true, // "What FRIDAY can do" at startup (src/abilities.js); /abilities shows it anytime
  default: 'claude',
  agents: {
    claude: { strengths: ['multi-file coding', 'architecture', 'writing', 'vault edits', 'planning'], cloud: true },
    codex: { strengths: ['implementation and debugging in a sandbox', 'running tests', 'independent code review (codex exec review)'], cloud: true },
    gemini: { strengths: ['very long context (~1M tokens: whole repos, long PDFs)', 'web-grounded research (Google Search)', 'images'], cloud: true },
    opencode: { strengths: ['free model', 'cheap bulk or simple tasks'], cloud: true },
    ollama: { strengths: ['private or offline work', 'patient/health data (never leaves the machine)'], cloud: false },
    design: { strengths: ['UI redesigns', 'new screens', 'landing pages', 'visual mockups', 'themes'], via: 'claude', cloud: true },
  },
  // Which agent takes each kind of task; `fallback` is tried in order when the
  // first choice is not installed or not logged in.
  categories: {
    code: { agent: 'claude', fallback: ['codex', 'opencode'] },
    debug: { agent: 'codex', fallback: ['claude'] },
    review: { agent: 'codex', fallback: ['claude'] },
    research: { agent: 'gemini', fallback: ['claude'] },
    longContext: { agent: 'gemini', fallback: ['claude'] },
    images: { agent: 'gemini', fallback: ['claude'] },
    writing: { agent: 'claude', fallback: ['opencode'] },
    vault: { agent: 'claude', fallback: ['codex'] },
    simple: { agent: 'opencode', fallback: ['claude'] },
    chat: { agent: 'claude', fallback: ['opencode', 'codex'] },
  },
  pipelines: {
    // "fix X and have someone check it": one implements, another reviews.
    implementReview: [{ role: 'implement', agent: 'codex', fallback: ['claude'] }, { role: 'review', agent: 'claude', fallback: ['codex'] }],
    // "plan and build X": plan, implement, review.
    planImplementReview: [
      { role: 'plan', agent: 'claude', fallback: ['codex'] },
      { role: 'implement', agent: 'codex', fallback: ['claude'] },
      { role: 'review', agent: 'claude', fallback: ['codex'] },
    ],
  },
  private: {
    agent: 'ollama',
    // A message matching any of these never goes to a cloud agent (health data words).
    patterns: ['\\bmimic(-?i{2,3}|-?iv)?\\b', '\\bphysionet\\b', '\\bpatients?\\b', '\\bphi\\b', '\\bhipaa\\b',
      '\\bclinical notes?\\b', '\\bdischarge summar', '\\bmedical records?\\b', '\\bmrns?\\b', '\\behr\\b',
      '\\bhealth records?\\b', '\\bde-?identified\\b'],
    // Sealed projects (by name): any mention, focus, or work inside their folder stays
    // on this machine (Ollama only), with no @agent! override. Add your own.
    sealed: [],
    // Projects whose data is private: mentioning one with a data word routes locally.
    projects: [],
    dataWords: ['data', 'dataset', 'notes', 'records', 'charts', 'cohort', 'labs', 'vitals'],
  },
  // Small-model tie-break when the rules are unsure. Local first; opencode's free
  // model next. Messages that look private never reach this step.
  // The model must be small: it runs before the answer starts. qwen2.5:7b-instruct
  // fits 8 GB VRAM and answers in well under a second warm (a large model makes
  // every unsure message wait out the timeout). Not pulled: Ollama is skipped.
  classifier: { agents: ['ollama', 'opencode'], timeoutMs: 6000, ollamaModel: 'qwen2.5:7b-instruct', keepAlive: '30m' },
  learning: { minOverrides: 3, share: 0.6, window: 8 },
  // Extra standing instructions per agent, added by "from now on tell codex to ...".
  instructions: {},
  // Claude Design targets; found automatically from .design-sync/ folders too.
  designSystems: {},
  self: { agent: 'claude', testCommand: 'node --test' },
  // The brain (src/brain.js): the model behind the orchestrator, mission planning and
  // routing ties. auto = OpenRouter once signed in (friday login), else local Ollama.
  // model: the OpenRouter model; localModel: the Ollama one (default: orchestrator.model).
  brain: { provider: 'auto' },
  // Local orchestrator (src/orchestrator.js): a local model decides each message and
  // calls the cloud agents as tools. ~0.8 s per decision on qwen2.5:7b-instruct here.
  // Private, sealed, council, design, self-change and "have someone check" pipelines
  // keep their rules; @agent and /use skip it. Unloaded model: the rules route.
  orchestrator: {
    enabled: true,
    model: 'qwen2.5:7b-instruct',
    maxSteps: 4,
    timeoutMs: 15000,
    keepAlive: '30m',
    agents: ['claude', 'codex', 'gemini', 'opencode'],
    resultChars: 1500,
    history: 3, // exchanges remembered for follow-ups ("have codex check that")
    // After an agent answers, ask the local model again (another ~1 s before the prompt
    // comes back) only when the message wants more than one step: a review, a check,
    // "then ...". true: always ask (it may add a closing line).
    alwaysFollowUp: false,
  },
  // Missions (src/mission.js). fixRounds: build fixes before FRIDAY asks the user.
  // pauseAt: ask before a job once an agent passes this share of its 5-hour plan
  // limit. maxCost: ask once API-billed agents pass this many dollars in one mission
  // (null: never). maxParallel: build parts run at once, each in its own worktree.
  // Per-job time limits: past them a job fails with "timed out" (and research retries on
  // another agent) instead of holding the mission forever.
  // overflow: what happens when an agent is past pauseAt of its plan limit. "ask" (the
  // user decides) or "auto" (the job moves to the ready agent with the most room).
  mission: { fixRounds: 3, pauseAt: 0.85, maxCost: null, maxParallel: 3, researchTimeoutMs: 1200000, buildTimeoutMs: 2700000, overflow: 'ask' },
  // Local prompt-writer (src/promptwriter.js): a small Ollama model rewrites the
  // user's message into a compact prompt per agent. Off until the benchmark says
  // it pays. Model tag checked on ollama.com/library/qwen2.5 (4.7 GB, fits 8 GB VRAM).
  // A message is never rewritten for skipAgents, under minWords, or when pinned.
  // Budget per rewrite: max(style.maxWords, keepRatio x original words).
  promptWriter: {
    enabled: false,
    model: 'qwen2.5:7b-instruct',
    minWords: 25,
    timeoutMs: 8000,
    keepAlive: '15m',
    keepRatio: 0.5,
    temperature: 0.1,
    maxOutputTokens: 1024,
    skipAgents: ['ollama'],
    // Styles follow `agents.*.strengths` above.
    styles: {
      claude: { format: 'the goal in one line, then short bullets: constraints, files, done when', maxWords: 120,
        notes: 'Claude Code; strong at multi-file edits, architecture and planning; already has the vault rules' },
      codex: { format: 'one imperative task line, the exact files, then the test command to run', maxWords: 90,
        notes: 'Codex CLI in a sandbox; implements, debugs, runs tests, reviews diffs' },
      gemini: { format: 'the question, its scope, and what to search or read', maxWords: 120,
        notes: 'Gemini CLI; very long context and Google Search grounding' },
      opencode: { format: 'one short imperative paragraph', maxWords: 60,
        notes: 'opencode on a free model; keep it simple and literal' },
    },
  },
  learned: [],
};

export const profilePath = (configDir) => path.join(configDir, 'profile.json');

function merge(base, over) {
  if (Array.isArray(base) || Array.isArray(over) || typeof base !== 'object' || typeof over !== 'object' || !base || !over) {
    return over === undefined ? base : over;
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = merge(base[k], v);
  return out;
}

// Loads the profile, writing the defaults the first time so there is a file to edit.
export function loadProfile(configDir) {
  const file = profilePath(configDir);
  let user = null;
  try { user = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch (e) {
    if (e.code === 'ENOENT') {
      try { fs.mkdirSync(configDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(DEFAULT_PROFILE, null, 2) + '\n'); } catch {}
    } else return { ...structuredClone(DEFAULT_PROFILE), error: `profile.json: ${e.message}` };
  }
  if (user && migrate(user)) {
    try { fs.writeFileSync(file, JSON.stringify(user, null, 2) + '\n'); } catch {}
  }
  return merge(structuredClone(DEFAULT_PROFILE), user || {});
}

// Profiles written by an older FRIDAY carry that version's defaults verbatim.
// Drop old defaults the user never changed, so the new ones apply. Returns true if changed.
export function migrate(user) {
  const v = user.version || 1;
  if (v >= DEFAULT_PROFILE.version) return false;
  if (v < 2 && user.classifier?.timeoutMs === 25000) delete user.classifier.timeoutMs;
  // Version 3 ships with nothing sealed. Lists a profile already holds (FRIDAY writes the
  // whole profile on first run) are the user's and are never touched.
  user.version = DEFAULT_PROFILE.version;
  return true;
}

export function saveProfile(configDir, profile) {
  const file = profilePath(configDir);
  const { error, ...clean } = profile;
  fs.mkdirSync(configDir, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// A profile that reloads itself when the file changes (by mtime, checked on use).
export function liveProfile(configDir, { onReload } = {}) {
  const file = profilePath(configDir);
  let cur = loadProfile(configDir);
  let mtime = stat(file);
  return {
    get() {
      const m = stat(file);
      if (m !== mtime) {
        mtime = m;
        cur = loadProfile(configDir);
        onReload?.(cur);
      }
      return cur;
    },
    save(p) { saveProfile(configDir, p); cur = loadProfile(configDir); mtime = stat(file); },
    file,
  };
}

function stat(f) { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }

// ---- learning from @agent overrides ------------------------------------------
// Each override is one JSON line: which category the router saw, who it picked,
// and who the user picked instead. Message text is not stored.
export function recordOverride(configDir, entry) {
  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.appendFileSync(path.join(configDir, 'overrides.jsonl'), JSON.stringify({ t: Date.now(), ...entry }) + '\n');
  } catch {}
}

export function readOverrides(configDir) {
  try {
    return fs.readFileSync(path.join(configDir, 'overrides.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// If the user keeps sending one kind of task to the same other agent, make that the
// route. Returns { category, from, to, count, of } or null.
export function learn(profile, overrides, category) {
  const { minOverrides, share, window } = profile.learning;
  const cat = profile.categories[category];
  if (!cat) return null;
  const recent = overrides.filter((o) => o.category === category).slice(-window);
  const counts = {};
  for (const o of recent) counts[o.chosen] = (counts[o.chosen] || 0) + 1;
  const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || [];
  if (!best || best === cat.agent || n < minOverrides || n / recent.length < share) return null;
  // Only learn from overrides made after the last change to this category.
  const since = [...profile.learned].reverse().find((l) => l.category === category)?.t || 0;
  if (recent.filter((o) => o.t > since && o.chosen === best).length < minOverrides) return null;
  return { category, from: cat.agent, to: best, count: n, of: recent.length };
}
