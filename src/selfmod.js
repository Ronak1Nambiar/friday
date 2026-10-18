// FRIDAY changing itself, only when the user asks. Two kinds:
// - settings: routing, strengths, standing instructions, colors, keys. Parsed
//   from the request, written to profile.json, live on the next message.
// - code: an agent edits FRIDAY's source in a git worktree on a new branch; the
//   tests must pass before the branch is fast-forwarded into the running checkout,
//   and FRIDAY then restarts into the same conversation. Failing tests change nothing.
// Every change is recorded in self-history.json so /undo-self can reverse it.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { cap, userName } from './user.js';

const AGENT = '(claude|codex|gemini|opencode|ollama)';

// Words for each routing category.
const CATEGORY_WORDS = [
  ['research', /\b(research|web|look ?ups?|search(es)?|fact.?check\w*)\b/],
  ['longContext', /\b(long|pdfs?|pages|whole repos?|long context|big files?|transcripts?)\b/],
  ['images', /\b(images?|screenshots?|pictures?|photos?)\b/],
  ['debug', /\b(debug\w*|bugs?|fix(es)?|failing tests?|errors?|crash\w*)\b/],
  ['review', /\b(reviews?|code reviews?|audits?)\b/],
  ['writing', /\b(writing|emails?|essays?|prose|docs|drafts?|posts?)\b/],
  ['vault', /\b(vault|notes|second brain|decisions?|priorities)\b/],
  ['simple', /\b(simple|quick|small|bulk|cheap|easy|trivial)\b/],
  ['code', /\b(code|coding|implementation|programming|features?|refactor\w*)\b/],
  ['chat', /\b(chat|general|everything else|other stuff|small talk)\b/],
];
const PRIVATE_WORDS = /\b(private|patient|health|medical|phi|mimic)\b/;
// Private words, or the name of a project the profile seals.
const privateTopic = (what, profile) => PRIVATE_WORDS.test(what)
  || (profile?.private?.sealed || []).some((n) => new RegExp(`\\b${String(n).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(what));

const COLORS = {
  red: [255, 95, 95], orange: [255, 150, 60], amber: [255, 176, 59], yellow: [245, 215, 70], green: [110, 231, 140],
  teal: [60, 200, 180], cyan: [95, 225, 255], blue: [80, 140, 255], purple: [170, 120, 255], violet: [170, 120, 255],
  magenta: [240, 90, 220], pink: [255, 130, 190], white: [235, 235, 240], grey: [150, 150, 160], gray: [150, 150, 160],
};

function categoryOf(what) {
  for (const [cat, re] of CATEGORY_WORDS) if (re.test(what)) return cat;
  return null;
}

const get = (obj, p) => p.reduce((o, k) => (o == null ? undefined : o[k]), obj);
function set(obj, p, v) {
  let o = obj;
  for (const k of p.slice(0, -1)) o = o[k] ??= {};
  if (v === undefined) delete o[p.at(-1)]; else o[p.at(-1)] = v;
}

// Returns { ops: [{path, value}], summary } or { refuse } or null (not a settings change).
export function parseSettingsChange(text, profile) {
  const t = text.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!]+$/, '');
  const ops = [];
  const lines = [];
  const strict = /\b(all|only|always|every|exclusively)\b/.test(t);

  // "route/send all research questions to gemini", "use gemini for research", "gemini should handle research"
  const m = new RegExp(`\\b(?:route|send|give|hand|direct|forward)\\s+(.+?)\\s+(?:over )?to\\s+${AGENT}\\b`).exec(t)
    || (() => { const x = new RegExp(`\\b(?:use|prefer|pick|choose)\\s+${AGENT}\\s+(?:for|on|with)\\s+(.+)$`).exec(t); return x && [x[0], x[2], x[1]]; })()
    || (() => { const x = new RegExp(`\\b${AGENT}\\s+(?:should\\s+)?(?:handles?|takes?|does|do|gets?)\\s+(.+)$`).exec(t); return x && [x[0], x[2], x[1]]; })();
  if (m) {
    const [, what, agent] = m;
    if (privateTopic(what, profile)) {
      if (agent !== 'ollama') return { refuse: 'Private and patient data stays on this machine (Ollama). Edit profile.json by hand if you really mean to change that.' };
      return { ops: [], summary: 'private data already goes to Ollama only' };
    }
    const cat = categoryOf(what);
    if (cat) {
      const cur = profile.categories[cat] || { agent: profile.default, fallback: [] };
      const fallback = strict ? [] : [cur.agent, ...(cur.fallback || [])].filter((a, i, arr) => a !== agent && arr.indexOf(a) === i);
      const next = { ...cur, agent, fallback, strict: strict || undefined };
      if (!strict) delete next.strict;
      ops.push({ path: ['categories', cat], value: next });
      const was = `${cur.agent}${cur.fallback?.length ? ` (fallback ${cur.fallback.join(', ')})` : ''}${cur.strict ? ' only' : ''}`;
      lines.push(`${cat}: ${was} -> ${agent}${strict ? ' only' : fallback.length ? ` (fallback ${fallback.join(', ')})` : ''}`);
      // Review / implement steps of the pipelines follow the same words.
      if (cat === 'review' || cat === 'code' || cat === 'debug') {
        const role = cat === 'review' ? 'review' : 'implement';
        for (const [name, steps] of Object.entries(profile.pipelines)) {
          const i = steps.findIndex((s) => s.role === role);
          if (i >= 0 && steps[i].agent !== agent) {
            ops.push({ path: ['pipelines', name, i], value: { ...steps[i], agent, fallback: [steps[i].agent, ...(steps[i].fallback || [])].filter((a) => a !== agent) } });
          }
        }
        lines.push(`pipelines: ${role} step -> ${agent}`);
      }
    }
  }

  // "claude reviews", "codex should do the reviews / implement"
  if (!ops.length) {
    const r = new RegExp(`\\b${AGENT}\\s+(?:should\\s+)?(reviews?|does the reviews?|checks? the work|implements?|does the (?:coding|implementation))\\b`).exec(t);
    if (r) {
      const role = /review|check/.test(r[2]) ? 'review' : 'implement';
      for (const [name, steps] of Object.entries(profile.pipelines)) {
        const i = steps.findIndex((s) => s.role === role);
        if (i >= 0) ops.push({ path: ['pipelines', name, i], value: { ...steps[i], agent: r[1], fallback: [steps[i].agent, ...(steps[i].fallback || [])].filter((a) => a !== r[1]) } });
      }
      lines.push(`pipelines: ${role} step -> ${r[1]}`);
    }
  }

  if (/\b(stop|turn off|disable|no more)\b.{0,12}\b(auto-?\s?)?routing\b|\bmanual routing\b/.test(t)) {
    ops.push({ path: ['routing'], value: 'manual' }); lines.push('routing: auto -> manual (messages go to the active agent)');
  } else if (/\b(turn on|enable|resume|back on)\b.{0,12}\b(auto-?\s?)?routing\b|\brouting back on\b/.test(t)) {
    ops.push({ path: ['routing'], value: 'auto' }); lines.push('routing: -> auto');
  }
  if (/\b(hide|don'?t show|do not show|stop showing)\b.{0,12}\broute\b/.test(t)) { ops.push({ path: ['showRoute'], value: false }); lines.push('route line: hidden'); }
  else if (/\bshow\b.{0,12}\broute\b/.test(t)) { ops.push({ path: ['showRoute'], value: true }); lines.push('route line: shown'); }

  const def = new RegExp(`\\bdefault (?:agent )?(?:is|to|should be|=)\\s+${AGENT}\\b|\\bmake ${AGENT} the default\\b`).exec(t);
  if (def) { const a = def[1] || def[2]; ops.push({ path: ['default'], value: a }); lines.push(`default agent: ${profile.default} -> ${a}`); }

  const col = new RegExp(`\\b${AGENT}(?:'s)?\\s+(?:colou?r\\s+)?(?:to\\s+|be\\s+|is\\s+)?(#[0-9a-f]{6}|${Object.keys(COLORS).join('|')})\\b`).exec(t.replace(/\b(make|set|change|paint|turn)\s+(the\s+)?/g, ''));
  if (col && /\bcolou?r|\bpaint|\bmake\b/.test(t)) {
    const v = col[2].startsWith('#') ? [1, 3, 5].map((i) => parseInt(col[2].slice(i, i + 2), 16)) : COLORS[col[2]];
    ops.push({ path: ['colors', col[1]], value: v }); lines.push(`${col[1]} color -> ${col[2]}`);
  }

  // "tell codex to always write tests", "codex should always run the tests"
  const ins = new RegExp(`\\b(?:tell|ask|instruct|remind)\\s+${AGENT}\\s+(?:to\\s+)?(.+)$|\\b${AGENT}\\s+should\\s+((?:always|never)\\s+.+)$`).exec(text.replace(/\s+/g, ' ').trim().replace(/[.!]+$/, '').toLowerCase());
  if (ins && !ops.length) {
    const agent = ins[1] || ins[3];
    const rule = (ins[2] || ins[4]).replace(/^(?:from now on,?\s*)/, '');
    const list = [...(profile.instructions?.[agent] || []), rule];
    ops.push({ path: ['instructions', agent], value: list }); lines.push(`${agent} standing instruction: "${rule}"`);
  }

  if (/\bkey\b|\bshortcut\b|\bbind\b/.test(t)) {
    const k = /\b(up|down|left|right|tab|ctrl\+\w|alt\+\w|f\d{1,2})\b.{0,30}\b(conversations?|history|picker|resume)\b|\b(conversations?|history|picker|resume)\b.{0,30}\b(up|down|left|right|tab|ctrl\+\w|alt\+\w|f\d{1,2})\b/.exec(t);
    if (k) { const key = k[1] || k[4]; ops.push({ path: ['keys', 'conversations'], value: key }); lines.push(`conversations key -> ${key}`); }
  }

  // A standing preference with no feature attached ("from now on be terse"): an instruction for every agent.
  if (!ops.length && /\b(from now on|going forward|always|never|by default|in future)\b/.test(t)
    && !/\b(panel|hud|command|button|screen|show|display|add|feature|support|draw|render|key)\b/.test(t)) {
    const rule = text.replace(/\s+/g, ' ').trim().replace(/^(from now on|going forward|in future),?\s*/i, '');
    ops.push({ path: ['instructions', 'all'], value: [...(profile.instructions?.all || []), rule] });
    lines.push(`standing instruction for every agent: "${rule}"`);
  }

  if (!ops.length) return null;
  return { ops, summary: lines.join('\n') };
}

export function applyOps(obj, ops) {
  const next = structuredClone(obj);
  for (const { path: p, value } of ops) set(next, p, structuredClone(value));
  return next;
}

// ---- history -------------------------------------------------------------------
export function createSelfHistory(configDir) {
  const file = path.join(configDir, 'self-history.json');
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; } };
  const write = (list) => { fs.mkdirSync(configDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(list, null, 2)); };
  return {
    file,
    list: read,
    push(entry) {
      const list = read();
      const e = { id: `${Date.now().toString(36)}-${list.length}`, t: Date.now(), ...entry };
      list.push(e); write(list);
      return e;
    },
    last() { return [...read()].reverse().find((e) => !e.undone) || null; },
    markUndone(id, extra = {}) { write(read().map((e) => (e.id === id ? { ...e, undone: Date.now(), ...extra } : e))); },
  };
}

// ---- settings ------------------------------------------------------------------
// profileStore: { get(), save(p) } (see liveProfile).
export function applySettingsChange({ profileStore, history, text, change }) {
  const before = profileStore.get();
  const { error, ...clean } = before;
  const after = applyOps(clean, change.ops);
  profileStore.save(after);
  return history.push({ type: 'settings', text, summary: change.summary, ops: change.ops,
    before: change.ops.map((o) => ({ path: o.path, value: get(clean, o.path) ?? null })) });
}

// ---- code ----------------------------------------------------------------------
function git(cwd, args, opts = {}) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, ...opts }).trim();
}
const errText = (e) => String(e.stderr || e.stdout || e.message).trim();

export function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 6).join('-') || 'change';
}

export function runTests(cwd, command = 'node --test', { timeoutMs = 300000 } = {}) {
  return new Promise((resolve) => {
    const sh = process.platform === 'win32' ? ['cmd', ['/c', command]] : ['sh', ['-c', command]];
    // NODE_TEST_CONTEXT would make a nested `node --test` report to its parent runner instead of failing.
    const { NODE_TEST_CONTEXT, ...env } = process.env;
    const child = spawn(sh[0], sh[1], { cwd, env: { ...env, FORCE_COLOR: '0', NO_COLOR: '1' } });
    let out = '';
    const add = (d) => { out += d; if (out.length > 400000) out = out.slice(-200000); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => { out += '\n[timed out]'; child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, out }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, code: -1, out: e.message }); });
  });
}

// The few lines that say why tests failed.
export function testFailureSummary(out) {
  const lines = out.split('\n');
  const keep = lines.filter((l) => /^not ok|^# (fail|pass|tests)|^ℹ (fail|pass|tests)|✖|AssertionError|Error:|expected|actual/i.test(l.trim()));
  return (keep.length ? keep : lines.slice(-12)).slice(0, 14).map((l) => l.trimEnd()).join('\n');
}

export function repoRoot(dir) {
  try { return git(dir, ['rev-parse', '--show-toplevel']); } catch { return null; }
}

// runAgent(cwd, prompt) -> Promise<{ ok, text }>. on.step(msg) reports progress.
// worktreeRoot must not be under a `.claude/` folder: Claude Code treats those paths
// as sensitive and a headless agent cannot edit there.
export async function codeChange({ repo, configDir, history, text, runAgent, testCommand = 'node --test', on = {}, worktreeRoot = path.join(configDir, 'self-worktrees') }) {
  const step = on.step || (() => {});
  if (!repo) return { ok: false, why: 'FRIDAY is not running from a git checkout, so it cannot change its own code safely.' };
  const dirty = git(repo, ['status', '--porcelain', '--untracked-files=no']);
  if (dirty) return { ok: false, why: `FRIDAY's checkout has uncommitted changes; commit them first:\n${dirty}` };

  const base = git(repo, ['rev-parse', 'HEAD']);
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  const slug = `${stamp}-${slugify(text)}`;
  const branch = `friday-self/${slug}`;
  const dir = path.join(worktreeRoot, slug);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(repo, ['worktree', 'add', '-q', '-b', branch, dir, base]);
  step(`branch ${branch} in ${dir}`);

  const cleanup = ({ dropBranch }) => {
    try { git(repo, ['worktree', 'remove', '--force', dir]); } catch { fs.rmSync(dir, { recursive: true, force: true }); try { git(repo, ['worktree', 'prune']); } catch {} }
    if (dropBranch) { try { git(repo, ['branch', '-D', branch]); } catch {} }
  };

  let agent;
  try { agent = await runAgent(dir, selfPrompt(text, testCommand)); } catch (e) { agent = { ok: false, text: e.message }; }
  git(dir, ['add', '-A']);
  const files = git(dir, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
  if (!files.length) {
    cleanup({ dropBranch: true });
    return { ok: false, why: agent?.ok === false ? `the agent failed: ${(agent.text || '').slice(-400)}` : 'the agent made no changes', agentText: agent?.text };
  }

  step(`tests: ${testCommand}`);
  const tests = await runTests(dir, testCommand);
  if (!tests.ok) {
    const failed = path.join(configDir, 'self-failed', `${slug}.patch`);
    fs.mkdirSync(path.dirname(failed), { recursive: true });
    fs.writeFileSync(failed, git(dir, ['diff', '--cached'], { maxBuffer: 64 << 20 }));
    cleanup({ dropBranch: true });
    return { ok: false, why: `tests failed, nothing changed:\n${testFailureSummary(tests.out)}`, patch: failed, files };
  }

  git(dir, ['-c', 'user.name=FRIDAY', '-c', 'user.email=friday@localhost', 'commit', '-q', '-m', `FRIDAY self-change: ${text.replace(/\s+/g, ' ').slice(0, 72)}`,
    '-m', `Requested in FRIDAY: "${text}"`]);
  const head = git(dir, ['rev-parse', 'HEAD']);
  try { git(repo, ['merge', '--ff-only', '-q', branch]); } catch (e) {
    cleanup({ dropBranch: false });
    return { ok: false, why: `tests passed but the change could not be applied (FRIDAY's branch moved): ${errText(e)}. It is kept on ${branch}.` };
  }
  const stat = git(repo, ['diff', '--shortstat', base, head]);
  cleanup({ dropBranch: false });
  const passed = /ℹ pass (\d+)/.exec(tests.out)?.[1] || /# pass (\d+)/.exec(tests.out)?.[1];
  const entry = history.push({ type: 'code', text, base, head, branch, files, stat, tests: passed ? `${passed} pass` : 'pass' });
  return { ok: true, entry, agentText: agent?.text };
}

function selfPrompt(text, testCommand) {
  return `You are changing FRIDAY's own source code (this folder is a git worktree of FRIDAY on its own branch).
${cap(userName())} asked FRIDAY: "${text}"

Make that change. Rules:
- Read docs/ARCHITECTURE.md (docs/GUIDE.md for detail) and the relevant files in src/ first. Match the existing style: plain Node 20+, ES modules, zero npm dependencies.
- Add or update tests in test/ for what you change.
- Run \`${testCommand}\` and keep going until it passes.
- Do not commit; FRIDAY commits, merges and reloads after its own test run.
- Do not touch the vault or anything outside this folder.
End with two or three lines saying what you changed.`;
}

// ---- undo ----------------------------------------------------------------------
export function undoSelf({ history, profileStore, repo }) {
  const e = history.last();
  if (!e) return { ok: false, why: 'no self-changes to undo' };
  if (e.type === 'settings') {
    const { error, ...cur } = profileStore.get();
    profileStore.save(applyOps(cur, e.before.map((b) => ({ path: b.path, value: b.value ?? undefined }))));
    history.markUndone(e.id);
    return { ok: true, entry: e, restart: false, summary: `reverted settings: ${e.summary.split('\n').join('; ')}` };
  }
  if (e.type === 'code') {
    if (!repo) return { ok: false, why: 'not a git checkout' };
    const dirty = git(repo, ['status', '--porcelain', '--untracked-files=no']);
    if (dirty) return { ok: false, why: `FRIDAY's checkout has uncommitted changes; commit them first:\n${dirty}` };
    try {
      git(repo, ['-c', 'user.name=FRIDAY', '-c', 'user.email=friday@localhost', 'revert', '--no-edit', `${e.base}..${e.head}`]);
    } catch (err) {
      try { git(repo, ['revert', '--abort']); } catch {}
      return { ok: false, why: `git revert failed: ${errText(err)}` };
    }
    history.markUndone(e.id, { revertedAt: git(repo, ['rev-parse', 'HEAD']) });
    return { ok: true, entry: e, restart: true, summary: `reverted ${e.files.length} file${e.files.length > 1 ? 's' : ''} from ${e.branch}` };
  }
  return { ok: false, why: `unknown change type ${e.type}` };
}
