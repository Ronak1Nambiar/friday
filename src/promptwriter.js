// The prompt-writer: before a message goes to a cloud agent, a small local Ollama
// model rewrites the user's words into a compact prompt shaped for that agent. Only
// the message is rewritten; FRIDAY's context blocks (Now block, vault notes,
// standing instructions, vault rules) are added after it unchanged. A rewrite is
// used only if it is shorter and keeps every key term; otherwise the original goes.
// The log holds counts, never text.
import fs from 'node:fs';
import path from 'node:path';
import { isPrivate } from './router.js';

// Token counts we cannot get from a tokenizer are estimated as chars/4. Every
// number derived from this is labelled "est" in the log and the benchmark.
export const estimateTokens = (s) => Math.ceil((s || '').length / 4);
const words = (s) => (s.trim().match(/\S+/g) || []).length;

// Whether this message, to this agent, should be rewritten at all.
// `pinned`: the user chose the agent (@agent or /use); `kind`: relay, classifier,
// command and the like are never rewritten.
export function shouldRewrite(text, { agent, pw, pinned = false, kind = 'message' } = {}) {
  if (!pw?.enabled) return { ok: false, reason: 'disabled' };
  if (pinned) return { ok: false, reason: 'pinned agent' };
  if (kind !== 'message') return { ok: false, reason: kind };
  if ((pw.skipAgents || []).includes(agent)) return { ok: false, reason: `${agent} is skipped` };
  if (!pw.styles?.[agent]) return { ok: false, reason: `no style for ${agent}` };
  if (words(text) < (pw.minWords ?? 25)) return { ok: false, reason: 'short' };
  return { ok: true };
}

// ---- requirement preservation ---------------------------------------------
const NEG = /\b(must not|mustn'?t|never|do not|don'?t|does not|doesn'?t|cannot|can'?t|no longer|without|avoid)\b/i;
const CONSTRAINT = /\b(must not|mustn'?t|must|never|do not|don'?t|only|without|always|avoid|no)\b\s+([^.;,\n!?]+)/gi;
// Things a rewrite may not add: an action the user did not ask for ("tell me the root
// cause" must not become "fix it"), or a placeholder the model made up.
const ACTIONS = ['fix', 'change', 'edit', 'modify', 'implement', 'refactor', 'delete', 'remove', 'rename', 'commit', 'push', 'merge', 'deploy', 'install', 'run', 'write', 'create', 'add', 'update', 'rewrite', 'replace', 'migrate'];
const PLACEHOLDER = /\[(?:specific|insert|your|add|tbd|todo|date|name|x{2,})[^\]]*\]|<(?:insert|your|tbd)[^>]*>/i;
const NEG_NEAR = /\b(must not|mustn'?t|never|do not|don'?t|not|no|cannot|can'?t|without|avoid)\b/i;
const FORCE = {
  only: /\b(only|exclusively|just|solely)\b/i,
  always: /\b(always|every|each)\b/i,
  must: /\b(must|required?|need to|needs to|has to|have to)\b/i,
};
const STOP =new Set(['the', 'a', 'an', 'to', 'be', 'it', 'any', 'this', 'that', 'them', 'they', 'is', 'are', 'of', 'in', 'on', 'for', 'and', 'or', 'with', 'from', 'into', 'your', 'you', 'its', 'ever', 'just', 'use', 'have', 'has']);

// Terms a faithful rewrite must keep. Each is { kind, value } and is matched
// case-insensitively; constraints are matched by their key words, since a
// rewrite may turn "don't" into "do not".
export function extractTerms(text, { projects = [] } = {}) {
  const terms = [];
  const seen = new Set();
  const add = (kind, value, extra) => {
    const v = value.trim().replace(/[)\].,:;!?'"]+$/, '');
    if (!v || seen.has(kind + v.toLowerCase())) return;
    seen.add(kind + v.toLowerCase());
    terms.push({ kind, value: v, ...extra });
  };
  for (const m of text.matchAll(/\bhttps?:\/\/[^\s<>"'`)]+/g)) add('url', m[0]);
  const noUrls = text.replace(/\bhttps?:\/\/[^\s<>"'`)]+/g, ' ');
  for (const m of noUrls.matchAll(/`([^`\n]+)`/g)) add('code', m[1]);
  for (const m of noUrls.matchAll(/["“]([^"”\n]{1,80})["”]/g)) add('quote', m[1]);
  // Paths and file names (with an optional :line): src/router.js:121, README.md, a\b.ts
  for (const m of noUrls.matchAll(/(?:[\w@.-]+[\/\\])*[\w-]{2,}\.[a-z][a-z0-9]{0,5}(?::\d+)?\b/gi)) add('path', m[0]);
  for (const m of noUrls.matchAll(/(?:~|\.{1,2})?(?:[\/\\][\w.-]+){2,}/g)) add('path', m[0]);
  // Identifiers: camelCase, snake_case, CONSTANT_CASE / acronyms with digits, --flags, #123
  for (const m of noUrls.matchAll(/\b[a-z]+[A-Z][\w]*\b/g)) add('ident', m[0]);
  for (const m of noUrls.matchAll(/\b[A-Za-z0-9]+_[A-Za-z0-9_]+\b/g)) add('ident', m[0]);
  for (const m of noUrls.matchAll(/\b[A-Z][A-Z0-9]{2,}(?:[-_][A-Z0-9]+)*\b/g)) add('ident', m[0]);
  for (const m of noUrls.matchAll(/(?<![\w-])--[a-z][\w-]*/g)) add('ident', m[0]);
  for (const m of noUrls.matchAll(/#\d+\b/g)) add('ident', m[0]);
  // Numbers (versions, counts, percentages), not ones inside identifiers already kept.
  for (const m of noUrls.matchAll(/(?<![\w.#])v?\d+(?:\.\d+)*%?(?![\w.])/g)) add('number', m[0]);
  for (const p of projects) {
    if (p && new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)) add('project', p);
  }
  for (const m of text.matchAll(CONSTRAINT)) {
    // "a user who has never seen it" describes, it does not instruct.
    if (/\b(has|have|had|was|were|who|which|i've|we've|they've|you've)\s+$/i.test(text.slice(Math.max(0, m.index - 12), m.index))) continue;
    const key = m[2].toLowerCase().match(/[a-z0-9][\w-]*/g)?.filter((w) => w.length > 2 && !STOP.has(w)).slice(0, 2) || [];
    const kw = m[1].toLowerCase();
    if (key.length) add('constraint', `${kw} ${key.join(' ')}`, { kw, keys: key });
  }
  return terms;
}

function hasTerm(curated, t) {
  const low = curated.toLowerCase();
  if (t.kind === 'constraint') {
    // "never push main": the key words must survive, and a word of the same force
    // must sit just before the first one (same clause), so "never push to main"
    // cannot quietly become "push to main".
    const { kw, keys } = t;
    if (!keys.every((w) => low.includes(w))) return false;
    const force = NEG.test(kw) || kw === 'no' ? NEG_NEAR : FORCE[kw] || new RegExp(`\\b${kw}\\b`, 'i');
    for (const m of low.matchAll(new RegExp(`\\b${keys[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'))) {
      const before = low.slice(Math.max(0, m.index - 45), m.index).split(/[;\n]|\.\s|(?:^|\s)-\s/).pop();
      if (force.test(before)) return true;
    }
    return false;
  }
  if (t.kind === 'path') return low.includes(t.value.toLowerCase()) || low.includes(t.value.toLowerCase().replace(/\\/g, '/'));
  if (t.kind === 'number') return new RegExp(`(?<![\\d.])${t.value.replace(/[.%]/g, '\\$&')}(?![\\d])`, 'i').test(curated);
  return low.includes(t.value.toLowerCase());
}

// Action verbs in the rewrite (any form: fix/fixes/fixed/fixing) with no form in the original.
export function addedActions(original, curated) {
  const forms = (v) => new RegExp(`\\b${v}(?:e|es|ed|s|d|ing|ning|ion|ions|er|ten)?\\b`, 'i');
  const stem = (v) => (/e$/.test(v) ? v.slice(0, -1) : v);
  return ACTIONS.filter((v) => forms(stem(v)).test(curated) && !forms(stem(v)).test(original));
}

const DEFAULT_REFUSALS =["^i'?m sorry", '^i (cannot|can\'?t|am unable|won\'?t)', '^as an ai', '^sorry,', "^i'?m not able"];

// Is the rewrite safe to send in place of the original? Returns { ok, reason, missing }.
export function checkCurated(original, curated, { projects = [], profile, refusals = DEFAULT_REFUSALS } = {}) {
  const c = (curated || '').trim();
  if (!c) return { ok: false, reason: 'empty rewrite' };
  if (refusals.some((r) => new RegExp(r, 'i').test(c))) return { ok: false, reason: 'model refused' };
  if (estimateTokens(c) >= estimateTokens(original)) return { ok: false, reason: 'not shorter' };
  if (profile && isPrivate(original, { profile }) && !isPrivate(c, { profile })) return { ok: false, reason: 'dropped private-data terms' };
  if (PLACEHOLDER.test(c) && !PLACEHOLDER.test(original)) return { ok: false, reason: 'added a placeholder' };
  const added = addedActions(original, c);
  if (added.length) return { ok: false, reason: `added action "${added[0]}"` };
  const missing = extractTerms(original, { projects }).filter((t) => !hasTerm(c, t));
  if (missing.length) return { ok: false, reason: `missing ${missing.slice(0, 3).map((t) => `${t.kind} "${t.value}"`).join(', ')}${missing.length > 3 ? ` +${missing.length - 3}` : ''}`, missing };
  return { ok: true };
}

// ---- the model call ---------------------------------------------------------
export function writerPrompt(agent, label, style, origWords, pw) {
  const budget = Math.max(style.maxWords || 100, Math.round(origWords * (pw.keepRatio ?? 0.5)));
  return [
    `You rewrite a user's request into a compact prompt for ${label}, an AI agent. ${style.notes ? `About it: ${style.notes}.` : ''}`,
    'Output only the rewritten prompt: no preface, no quotes, no code fences, no commentary.',
    'Keep exactly as written: every file name, path, identifier, command, flag, number, version, URL, quoted string and project name.',
    'Keep every constraint (must, never, do not, only, always, without) and its meaning.',
    'Do not answer or do the task. Do not add requirements, steps, deadlines, placeholders or guesses. Remove filler, politeness, repetition and backstory that does not change the task.',
    'Keep the kind of request: a question stays a question, a request to explain or diagnose stays that and must not become a request to change, fix or run anything.',
    `Format: ${style.format}. At most ${budget} words.`,
  ].join('\n');
}

// Models sometimes wrap the answer anyway; take it off.
export function cleanRewrite(s) {
  let t = (s || '').trim();
  t = t.replace(/^(here(?:'s| is) (?:the |a )?(?:rewritten|compact|curated|revised)[^\n:]*:?\s*\n)/i, '');
  t = t.replace(/^(rewritten prompt|prompt):\s*/i, '');
  const fence = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(t);
  if (fence) t = fence[1];
  if (/^"[\s\S]*"$/.test(t) && !t.slice(1, -1).includes('"')) t = t.slice(1, -1);
  return t.trim();
}

const ollamaBase = () => `http://${(process.env.OLLAMA_HOST || '127.0.0.1:11434').replace(/^https?:\/\//, '')}`;

// One rewrite. Never throws: { ok, text?, ms, inTok?, outTok?, reason? }.
// inTok/outTok are the writer model's own prompt_eval_count/eval_count.
export async function rewrite(text, { agent, label = agent, pw, fetchImpl = globalThis.fetch, base = ollamaBase() } = {}) {
  const t0 = Date.now();
  const style = pw.styles[agent];
  try {
    const res = await fetchImpl(`${base}/api/chat`, {
      method: 'POST',
      signal: AbortSignal.timeout(pw.timeoutMs ?? 8000),
      body: JSON.stringify({
        model: pw.model, stream: false, keep_alive: pw.keepAlive ?? '15m',
        options: { temperature: pw.temperature ?? 0.1, num_predict: pw.maxOutputTokens ?? 1024 },
        messages: [{ role: 'system', content: writerPrompt(agent, label, style, words(text), pw) }, { role: 'user', content: text }],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, ms: Date.now() - t0, reason: /not found/i.test(body) ? `model ${pw.model} not pulled` : `ollama ${res.status}` };
    }
    const j = await res.json();
    return { ok: true, text: cleanRewrite(j.message?.content), ms: Date.now() - t0, inTok: j.prompt_eval_count, outTok: j.eval_count };
  } catch (e) {
    const why = e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timed out'
      : /fetch failed|ECONNREFUSED/.test(e.message + (e.cause?.code || '')) ? 'ollama not running' : e.message;
    return { ok: false, ms: Date.now() - t0, reason: why };
  }
}

// Decide, rewrite, check. Always returns something sendable:
// { text, rewritten, reason?, fallback, stats } where `text` is what goes to the agent.
export async function curate(text, { agent, label, pw, pinned, kind, projects, profile, fetchImpl, base } = {}) {
  const should = shouldRewrite(text, { agent, pw, pinned, kind });
  const stats = { origTok: estimateTokens(text), tokSource: 'est' };
  if (!should.ok) return { text, rewritten: false, fallback: false, reason: should.reason, stats };
  const r = await rewrite(text, { agent, label, pw, fetchImpl, base });
  stats.rewriteMs = r.ms;
  stats.writerInTok = r.inTok;
  stats.writerOutTok = r.outTok;
  if (!r.ok) return { text, rewritten: false, fallback: true, reason: r.reason, stats };
  const chk = checkCurated(text, r.text, { projects, profile, refusals: pw.refusals });
  if (!chk.ok) return { text, rewritten: false, fallback: true, reason: chk.reason, attempted: r.text, stats };
  stats.curTok = estimateTokens(r.text);
  return { text: r.text, rewritten: true, fallback: false, stats };
}

// ---- health -------------------------------------------------------------------
export async function writerStatus(pw, { fetchImpl = globalThis.fetch, base = ollamaBase() } = {}) {
  try {
    const res = await fetchImpl(`${base}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return { up: false, pulled: false };
    const names = ((await res.json()).models || []).map((m) => m.name);
    const want = pw.model.includes(':') ? pw.model : `${pw.model}:latest`;
    return { up: true, pulled: names.includes(want) };
  } catch { return { up: false, pulled: false }; }
}

// Load the model into memory ahead of the first rewrite (an empty generate loads it).
export function warmWriter(pw, { fetchImpl = globalThis.fetch, base = ollamaBase() } = {}) {
  return fetchImpl(`${base}/api/generate`, { method: 'POST', body: JSON.stringify({ model: pw.model, keep_alive: pw.keepAlive ?? '15m' }) })
    .then((r) => r.ok).catch(() => false);
}

// ---- measurement: counts only, never text -------------------------------------
const LOG = 'promptwriter.jsonl';
const ALLOWED = ['agent', 'category', 'kind', 'rewritten', 'fallback', 'reason', 'origTok', 'curTok', 'tokSource', 'rewriteMs',
  'writerInTok', 'writerOutTok', 'respInTok', 'respCachedIn', 'respOutTok', 'respMs', 'billing', 'ok'];

export function logEntry(configDir, entry) {
  const clean = { t: Date.now() };
  for (const k of ALLOWED) if (entry[k] !== undefined) clean[k] = entry[k];
  // Reasons can quote a missing term from the message; keep only the kind of failure.
  if (typeof clean.reason === 'string') clean.reason = clean.reason.replace(/\s*".*$/s, '').replace(/^missing\s+(\w+).*/, 'missing $1');
  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.appendFileSync(path.join(configDir, LOG), JSON.stringify(clean) + '\n');
  } catch {}
  return clean;
}

export function readLog(configDir) {
  try {
    return fs.readFileSync(path.join(configDir, LOG), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// For /usage: how often it rewrote, how much it saved (est.), what it cost in time.
export function summarizeLog(entries) {
  const tried = entries.filter((e) => e.rewritten || e.fallback);
  const done = entries.filter((e) => e.rewritten);
  const saved = done.map((e) => 1 - e.curTok / e.origTok).filter(Number.isFinite);
  const ms = tried.map((e) => e.rewriteMs).filter(Number.isFinite);
  const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  const reasons = {};
  for (const e of entries.filter((x) => x.fallback)) reasons[e.reason] = (reasons[e.reason] || 0) + 1;
  return {
    turns: entries.length, tried: tried.length, rewritten: done.length, fallbacks: tried.length - done.length,
    avgSaved: avg(saved), tokSaved: done.reduce((s, e) => s + (e.origTok - e.curTok), 0), avgMs: avg(ms), reasons,
    since: entries[0]?.t || null,
  };
}
