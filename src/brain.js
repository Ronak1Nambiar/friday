// The brain: the model that decides what to do with each message (the orchestrator),
// plans missions and breaks routing ties. Cloud by default (OpenRouter: one sign-in,
// hundreds of models, billed to the user's own OpenRouter account), or local (Ollama)
// for people who want nothing to leave the machine.
//
// Every caller speaks Ollama's chat shape (messages, tools, tool_calls with object
// arguments, tool results as { role: 'tool', tool_name }); this module translates for
// OpenAI-compatible providers. Private and sealed messages never reach a cloud brain:
// the cockpit routes them to local agents before the brain is asked.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { ollamaUp, runTurn } from './agents.js';
import { cliState } from './signin.js';

export const PROVIDERS = {
  openrouter: {
    label: 'OpenRouter',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_API_KEY',
    keyUrl: 'https://openrouter.ai/keys',
    cloud: true,
  },
  ollama: { label: 'Ollama (local)', kind: 'ollama', cloud: false },
  // The user's own CLIs, signed in with their own accounts (plan or API billing, as for
  // any turn). Slower than an API (a process per decision) but nothing extra to pay for.
  claude: { label: 'Claude', kind: 'cli', agent: 'claude', modelArgs: (m) => ['--model', m], cloud: true },
  codex: { label: 'Codex', kind: 'cli', agent: 'codex', modelArgs: (m) => ['-m', m], cloud: true },
  gemini: { label: 'Gemini', kind: 'cli', agent: 'gemini', modelArgs: (m) => ['--model', m], cloud: true },
};

// Models offered per CLI (Claude takes aliases for its latest models; Codex's own list is
// read from its cache when there is one, see cliModels).
export const CLI_MODELS = {
  claude: [
    { id: 'haiku', note: 'fastest' },
    { id: 'sonnet', note: 'balanced' },
    { id: 'opus', note: 'smartest, slower' },
    { id: 'fable', note: 'frontier, slowest' },
  ],
  codex: [
    { id: 'gpt-6-luna', note: 'fast and affordable' },
    { id: 'gpt-6.1-sol', note: 'workhorse' },
    { id: 'gpt-6-astra', note: 'frontier' },
  ],
  gemini: [
    { id: 'gemini-3.8-flash', note: 'fast' },
    { id: 'gemini-4-argon', note: 'smartest' },
  ],
};

// Codex lists the models your account can use in ~/.codex/models_cache.json.
export function cliModels(provider, home = os.homedir()) {
  if (provider === 'codex') {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'models_cache.json'), 'utf8'));
      const list = (d.models || []).filter((m) => m.slug && m.visibility !== 'hide').map((m) => ({ id: m.slug, note: m.description || m.display_name || '' }));
      if (list.length) return list;
    } catch {}
  }
  return CLI_MODELS[provider] || [];
}

// Fast, cheap models that call tools well (OpenRouter;
// input/output USD per million tokens). The first is the default.
export const CLOUD_MODELS = [
  { id: 'anthropic/claude-haiku-5.5', note: 'fast, strong at tool calls · $0.10 / $0.50' },
  { id: 'openai/gpt-6-luna', note: 'fast · $0.10 / $0.50' },
  { id: 'deepseek/deepseek-v4.1-flash', note: 'cheapest · $0.04 / $0.45' },
  { id: 'google/gemini-3.8-flash', note: 'long context · $0.83 / $4.12' },
  { id: 'anthropic/claude-sonnet-5.5', note: 'smartest of these, slower · $2 / $10' },
];
export const DEFAULT_CLOUD_MODEL = CLOUD_MODELS[0].id;
export const DEFAULT_LOCAL_MODEL = 'qwen2.5:7b-instruct';

const ollamaBase = () => `http://${(process.env.OLLAMA_HOST || '127.0.0.1:11434').replace(/^https?:\/\//, '')}`;

// ---- keys -------------------------------------------------------------------------
// The environment wins; otherwise keys.json in FRIDAY's config folder, readable only by
// the user on Linux/macOS (on Windows the folder sits in the user's own profile).
const keysFile = (configDir) => path.join(configDir, 'keys.json');

export function loadKey(configDir, provider, env = process.env) {
  const spec = PROVIDERS[provider];
  if (spec?.keyEnv && env[spec.keyEnv]) return env[spec.keyEnv].trim();
  try { return String(JSON.parse(fs.readFileSync(keysFile(configDir), 'utf8'))[provider] || '').trim(); } catch { return ''; }
}

export function saveKey(configDir, provider, key) {
  fs.mkdirSync(configDir, { recursive: true });
  let all = {};
  try { all = JSON.parse(fs.readFileSync(keysFile(configDir), 'utf8')); } catch {}
  if (key) all[provider] = key.trim(); else delete all[provider];
  fs.writeFileSync(keysFile(configDir), JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(keysFile(configDir), 0o600); } catch {}
}

export const keyHint = (key) => (key ? `••••${key.slice(-4)}` : 'none');

// ---- which brain ----------------------------------------------------------------------
// profile.brain: { provider: 'auto' | 'openrouter' | 'ollama' | 'claude' | 'codex' | 'gemini',
// model (OpenRouter), localModel (Ollama), models: { claude, codex, gemini } }.
// auto = OpenRouter when a key is saved, else local.
export function resolveBrain(profile, configDir, env = process.env) {
  const b = profile?.brain || {};
  const localModel = b.localModel || profile?.orchestrator?.model || DEFAULT_LOCAL_MODEL;
  const key = loadKey(configDir, 'openrouter', env);
  const want = b.provider || 'auto';
  const provider = want === 'auto' ? (key ? 'openrouter' : 'ollama') : PROVIDERS[want] ? want : 'ollama';
  if (provider === 'ollama') return { provider, model: localModel, cloud: false, label: `local ${localModel}` };
  if (PROVIDERS[provider].kind === 'cli') {
    const model = b.models?.[provider] || CLI_MODELS[provider][0].id;
    return { provider, model, cloud: true, cli: true, label: `${PROVIDERS[provider].label} ${model}` };
  }
  return { provider, model: b.model || DEFAULT_CLOUD_MODEL, key, cloud: true, label: `${PROVIDERS[provider].label} ${b.model || DEFAULT_CLOUD_MODEL}` };
}

// The model a provider would use (its saved pick, or its default).
export function modelFor(profile, provider) {
  const b = profile?.brain || {};
  if (provider === 'ollama') return b.localModel || profile?.orchestrator?.model || DEFAULT_LOCAL_MODEL;
  if (provider === 'openrouter') return b.model || DEFAULT_CLOUD_MODEL;
  return b.models?.[provider] || CLI_MODELS[provider]?.[0]?.id;
}

// ---- Ollama shape <-> OpenAI shape ------------------------------------------------------
// Assistant tool calls get ids; each tool result is matched to the oldest unanswered call
// of the same name (Ollama results carry only the tool name).
export function toOpenAiMessages(messages) {
  const out = [];
  const open = [];
  let n = 0;
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const calls = m.tool_calls.map((c) => {
        const id = c.id || `call_${++n}`;
        const name = c.function?.name || '';
        open.push({ id, name });
        const args = c.function?.arguments;
        return { id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) } };
      });
      out.push({ role: 'assistant', content: m.content || null, tool_calls: calls });
    } else if (m.role === 'tool') {
      let id = m.tool_call_id;
      if (!id) {
        const i = open.findIndex((c) => c.name === m.tool_name);
        const hit = i >= 0 ? open.splice(i, 1)[0] : open.shift();
        id = hit?.id;
      }
      // A result with no call to answer would be rejected: keep it as plain context.
      out.push(id ? { role: 'tool', tool_call_id: id, content: String(m.content ?? '') } : { role: 'user', content: `[tool result] ${m.content ?? ''}` });
    } else {
      out.push({ role: m.role, content: String(m.content ?? '') });
    }
  }
  return out;
}

export function fromOpenAiMessage(m = {}) {
  const calls = (m.tool_calls || []).map((c) => {
    let args = c.function?.arguments ?? {};
    if (typeof args === 'string') { try { args = JSON.parse(args || '{}'); } catch { args = { task: args }; } }
    return { id: c.id, function: { name: c.function?.name || '', arguments: args } };
  });
  return { role: 'assistant', content: typeof m.content === 'string' ? m.content : '', ...(calls.length ? { tool_calls: calls } : {}) };
}

function cloudError(spec, status, body = '') {
  if (status === 401 || status === 403) return `${spec.label} rejected the key (run friday login)`;
  if (status === 402) return `${spec.label} account is out of credit (add credit at openrouter.ai/credits)`;
  if (status === 404) return `${spec.label} does not know that model (/brain model to pick another)`;
  if (status === 429) return `${spec.label} rate limit, try again shortly`;
  if (status >= 500) return `${spec.label} is having problems (${status})`;
  return `${spec.label} ${status}${body ? `: ${body.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`;
}

// ---- a CLI as the brain -------------------------------------------------------------------
// The CLIs have no tool-calling API for us, so the conversation becomes one prompt and the
// decision comes back as one JSON object: {"tool": ..., "args": {...}} or {"answer": ...}.
export function cliPrompt(messages, tools, format) {
  const parts = [];
  for (const m of messages) {
    if (m.role === 'system') parts.push(`[Instructions]\n${m.content}`);
    else if (m.role === 'user') parts.push(`[User]\n${m.content}`);
    else if (m.role === 'tool') parts.push(`[Result of ${m.tool_name || 'the tool'}]\n${m.content}`);
    else if (m.tool_calls?.length) parts.push(`[You called] ${m.tool_calls.map((c) => `${c.function?.name} ${JSON.stringify(c.function?.arguments ?? {})}`).join('; ')}`);
    else if (m.content) parts.push(`[You said]\n${m.content}`);
  }
  const only = 'Do not use any tools of your own, run commands or read files: you only decide.';
  if (tools?.length) {
    parts.push('[Tools you can call]\n' + tools.map((t) => `- ${t.function.name}(${Object.keys(t.function.parameters?.properties || {}).join(', ')}): ${t.function.description}`).join('\n'));
    parts.push(`${only} Reply with ONLY one JSON object, nothing before or after it:\n{"tool": "<tool name>", "args": {"task": "..."}} to call a tool, or {"answer": "<your reply to the user>"} to answer yourself.`);
  } else if (format) {
    parts.push(`${only} Reply with ONLY one JSON object that matches this JSON schema, nothing before or after it:\n${JSON.stringify(format)}`);
  } else parts.push(`${only} Reply with the answer only.`);
  return parts.join('\n\n');
}

// The first complete JSON object in a reply (models wrap it in prose or fences sometimes).
export function extractJson(text) {
  const s = String(text || '');
  for (let i = s.indexOf('{'); i >= 0; i = s.indexOf('{', i + 1)) {
    for (let j = s.lastIndexOf('}'); j > i; j = s.lastIndexOf('}', j - 1)) {
      try { return JSON.parse(s.slice(i, j + 1)); } catch {}
    }
  }
  return null;
}

export function fromCliText(text, { tools, format } = {}) {
  const obj = extractJson(text);
  if (tools?.length && obj?.tool) {
    const args = obj.args && typeof obj.args === 'object' ? obj.args : { task: String(obj.task ?? obj.args ?? '') };
    return { role: 'assistant', content: '', tool_calls: [{ function: { name: String(obj.tool), arguments: args } }] };
  }
  if (format) return { role: 'assistant', content: obj ? JSON.stringify(obj) : String(text || '').trim() };
  return { role: 'assistant', content: obj && typeof obj.answer === 'string' ? obj.answer : String(text || '').trim() };
}

async function runCli(provider, prompt, { model, timeoutMs }) {
  const run = runTurn(PROVIDERS[provider].agent, prompt, { cwd: os.tmpdir(), mode: 'plan', session: {}, on: {}, extraArgs: PROVIDERS[provider].modelArgs(model) });
  const timer = setTimeout(() => run.abort(), timeoutMs);
  const r = await run.done;
  clearTimeout(timer);
  return { ok: !!r.ok && !!r.text, text: r.text || '', error: (r.errors || []).join('; ').slice(0, 200) || (r.ok ? '' : 'timed out or failed') };
}

// ---- one call ------------------------------------------------------------------------------
// Never throws: { ok, message?, ms, reason?, usage? }. `format` is a JSON schema for a
// structured answer (Ollama's format / OpenAI's response_format).
export async function chat(brain, { messages, tools, format, temperature = 0, maxTokens, timeoutMs = 15000, keepAlive = '30m', ollamaOptions = {}, fetchImpl = globalThis.fetch, base, cliRun = runCli } = {}) {
  const t0 = Date.now();
  const ms = () => Date.now() - t0;
  const b = brain || { provider: 'ollama', model: DEFAULT_LOCAL_MODEL };
  try {
    if (PROVIDERS[b.provider]?.kind === 'cli') {
      // A CLI starts a process per decision: give it longer than an API call.
      const r = await cliRun(b.provider, cliPrompt(messages, tools, format), { model: b.model, timeoutMs: Math.max(timeoutMs, 60000) });
      if (!r.ok) return { ok: false, ms: ms(), reason: r.error || `${PROVIDERS[b.provider].label} did not answer` };
      return { ok: true, ms: ms(), message: fromCliText(r.text, { tools, format }) };
    }
    if (b.provider === 'ollama') {
      const res = await fetchImpl(`${base || ollamaBase()}/api/chat`, {
        method: 'POST', signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({ model: b.model, messages, ...(tools?.length ? { tools } : {}), ...(format ? { format } : {}), stream: false, keep_alive: keepAlive,
          options: { temperature, ...(maxTokens ? { num_predict: maxTokens } : {}), ...ollamaOptions } }),
      });
      if (!res.ok) return { ok: false, ms: ms(), reason: `ollama ${res.status}` };
      const j = await res.json();
      return { ok: true, ms: ms(), message: j.message || { role: 'assistant', content: '' } };
    }
    const spec = PROVIDERS[b.provider];
    if (!b.key) return { ok: false, ms: ms(), reason: `not signed in to ${spec.label} (run friday login)` };
    const body = {
      model: b.model, messages: toOpenAiMessages(messages), temperature,
      ...(tools?.length ? { tools } : {}),
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
      ...(format ? { response_format: { type: 'json_schema', json_schema: { name: 'answer', schema: format } } } : {}),
    };
    const send = (payload) => fetchImpl(`${base || spec.baseUrl}/chat/completions`, {
      method: 'POST', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${b.key}`, 'HTTP-Referer': 'https://github.com/Ronak1Nambiar/friday', 'X-Title': 'FRIDAY' },
      body: JSON.stringify(payload),
    });
    let res = await send(body);
    // A model without structured output: ask for plain JSON instead.
    if (res.status === 400 && format) res = await send({ ...body, response_format: { type: 'json_object' } });
    if (!res.ok) return { ok: false, ms: ms(), reason: cloudError(spec, res.status, await res.text().catch(() => '')) };
    const j = await res.json();
    if (j.error) return { ok: false, ms: ms(), reason: cloudError(spec, j.error.code || 500, j.error.message || '') };
    return { ok: true, ms: ms(), message: fromOpenAiMessage(j.choices?.[0]?.message), usage: j.usage };
  } catch (e) {
    const reason = e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timed out'
      : /fetch failed|ECONNREFUSED/.test(e.message + (e.cause?.code || '')) ? (b.provider === 'ollama' ? 'ollama not running' : 'no connection') : e.message;
    return { ok: false, ms: ms(), reason };
  }
}

// ---- health ----------------------------------------------------------------------------------
// Cloud: is the key accepted (and how much credit is left)? Local: is Ollama up, the model
// pulled and loaded? A CLI: installed and signed in?
// { ready, reason, fix? } with fix: 'install' | 'login' | 'start' | 'pull'.
export async function brainStatus(brain, { fetchImpl = globalThis.fetch, timeoutMs = 4000, cli = cliState } = {}) {
  if (PROVIDERS[brain.provider]?.kind === 'cli') {
    const s = cli(PROVIDERS[brain.provider].agent);
    if (!s.installed) return { ready: false, fix: 'install', reason: 'not installed' };
    if (s.signedIn === false) return { ready: false, fix: 'login', reason: 'not signed in' };
    return { ready: true, reason: 'signed in' };
  }
  if (brain.provider === 'ollama') {
    try {
      const tags = await fetchImpl(`${ollamaBase()}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!tags.ok) return { ready: false, fix: 'start', reason: 'Ollama not running' };
      const want = brain.model.includes(':') ? brain.model : `${brain.model}:latest`;
      const pulled = ((await tags.json()).models || []).some((m) => m.name === want);
      if (!pulled) return { ready: false, fix: 'pull', reason: `${brain.model} not downloaded yet` };
      const ps = await fetchImpl(`${ollamaBase()}/api/ps`, { signal: AbortSignal.timeout(timeoutMs) });
      const loaded = ps.ok && ((await ps.json()).models || []).some((m) => m.name === want || m.model === want);
      return { ready: true, loaded, reason: loaded ? 'loaded' : 'pulled, loads on first use' };
    } catch { return { ready: false, fix: 'start', reason: 'Ollama not running' }; }
  }
  if (!brain.key) return { ready: false, fix: 'login', reason: 'not signed in' };
  try {
    const res = await fetchImpl(`${PROVIDERS[brain.provider].baseUrl}/key`, { headers: { Authorization: `Bearer ${brain.key}` }, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 401 || res.status === 403) return { ready: false, fix: 'login', reason: 'key rejected' };
    if (!res.ok) return { ready: true, reason: `signed in · could not check credit (${res.status})` };
    const d = (await res.json()).data || {};
    const left = d.limit_remaining ?? (d.limit != null ? d.limit - (d.usage || 0) : null);
    return { ready: true, reason: `signed in${left != null ? ` · $${Number(left).toFixed(2)} left` : ''}`, usage: d.usage };
  } catch { return { ready: true, reason: 'signed in · offline?' }; }
}

// Load a local model ahead of its first use (an empty generate loads it).
export function warmBrain(brain, { keepAlive = '30m', fetchImpl = globalThis.fetch } = {}) {
  if (brain.provider !== 'ollama') return Promise.resolve(true);
  return fetchImpl(`${ollamaBase()}/api/generate`, { method: 'POST', body: JSON.stringify({ model: brain.model, keep_alive: keepAlive }) })
    .then((r) => r.ok).catch(() => false);
}

// ---- OpenRouter sign-in (OAuth PKCE, RFC 8252 loopback) ----------------------------------
// The browser signs in on openrouter.ai; a one-shot listener on localhost receives the code,
// which is exchanged for a key billed to the user's own OpenRouter account. Same flow as
// a desktop app. The state sits in the callback path, so a stray request can't finish it.
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const page = (msg) => `<!doctype html><meta charset="utf-8"><title>FRIDAY</title><body style="font:16px system-ui;background:#0b0f14;color:#cfe8ff;display:grid;place-items:center;height:90vh"><p>${msg}</p></body>`;

export async function signInOpenRouter({ open, fetchImpl = globalThis.fetch, timeoutMs = 300000, label = 'FRIDAY' } = {}) {
  const verifier = b64url(randomBytes(48));
  const state = b64url(randomBytes(24));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  let settle;
  const got = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== `/callback/${state}`) { res.writeHead(404); res.end(); return; }
    const code = url.searchParams.get('code');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (!code) { res.end(page('Sign-in was cancelled. You can close this tab.')); settle.reject(new Error('sign-in cancelled; nothing was connected')); return; }
    res.end(page('FRIDAY is connected to OpenRouter. You can close this tab.'));
    settle.resolve(code);
  });
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).on('error', reject));
  const port = server.address().port;
  const auth = new URL('https://openrouter.ai/auth');
  auth.searchParams.set('callback_url', `http://localhost:${port}/callback/${state}`);
  auth.searchParams.set('code_challenge', challenge);
  auth.searchParams.set('code_challenge_method', 'S256');
  auth.searchParams.set('key_label', label);
  const timer = setTimeout(() => settle.reject(new Error('sign-in took longer than five minutes; run friday login again')), timeoutMs);
  try {
    await open(auth.toString());
    const code = await got;
    const res = await fetchImpl('https://openrouter.ai/api/v1/auth/keys', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30000),
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || typeof data.key !== 'string' || !data.key.trim()) throw new Error(`OpenRouter did not finish the sign-in (${res.status}); nothing was connected`);
    return data.key.trim();
  } finally {
    clearTimeout(timer);
    // The browser keeps its connection open; close it too, or Node waits on it.
    server.close();
    server.closeAllConnections?.();
  }
}

// The sign-in page in the user's normal browser (a full tab: they may need to log in).
// Returns false when nothing could be launched; the caller prints the link instead.
export function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
    return true;
  } catch { return false; }
}
