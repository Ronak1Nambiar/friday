// /brain with nothing after it: pick the AI behind FRIDAY's brain in a terminal menu, the
// way Claude Code asks its questions. One row per AI (Local, OpenRouter, Claude, Codex,
// Gemini); the highlighted one shows its models underneath (→ into the list, ← back).
// Enter checks that AI is ready (installed, signed in, running, model downloaded) and
// fixes what is missing first: a browser sign-in, a CLI login, starting Ollama, a download.
// Typed forms still work: /brain cloud|local|auto, /brain model <id>.
import { spawn } from 'node:child_process';
import { which } from './agents.js';
import { AGENT_SETUP } from './signin.js';
import { CLOUD_MODELS, PROVIDERS, brainStatus, cliModels, loadKey, modelFor, resolveBrain } from './brain.js';

const ollamaBase = () => `http://${(process.env.OLLAMA_HOST || '127.0.0.1:11434').replace(/^https?:\/\//, '')}`;
export const BRAIN_ORDER = ['ollama', 'openrouter', 'claude', 'codex', 'gemini'];
const NAMES = { ollama: 'Local (Ollama)', openrouter: 'OpenRouter', claude: 'Claude', codex: 'Codex', gemini: 'Gemini' };
const ABOUT = {
  ollama: 'on this machine · private and free',
  openrouter: 'hundreds of models · fast',
  claude: 'your Claude account · slower, ~8 s a decision',
  codex: 'your ChatGPT account · slower, ~8 s a decision',
  gemini: 'your Google account · slower, ~8 s a decision',
};

// Models pulled into Ollama, or null when it is not running.
export async function localModels({ fetchImpl = globalThis.fetch } = {}) {
  try {
    const res = await fetchImpl(`${ollamaBase()}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    return ((await res.json()).models || []).map((m) => ({ id: m.name, size: m.size }));
  } catch { return null; }
}

// Does OpenRouter list this model (and can it call tools)? null when it cannot be checked.
export async function cloudModelInfo(id, { fetchImpl = globalThis.fetch } = {}) {
  try {
    const res = await fetchImpl(`${PROVIDERS.openrouter.baseUrl}/models`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const m = ((await res.json()).data || []).find((x) => x.id === id);
    return m ? { found: true, tools: (m.supported_parameters || []).includes('tools') } : { found: false };
  } catch { return null; }
}

const gb = (n) => (n ? `${(n / 1e9).toFixed(1)} GB` : '');

// The models listed under each AI.
function modelRows(p, { pulled, current, isNow }) {
  const mark = (id) => (isNow && id === current ? '  ✓ now' : '');
  let list;
  // Embedding models cannot chat: not offered.
  if (p === 'ollama') list = (pulled || []).filter((m) => !/embed/i.test(m.id)).map((m) => ({ id: m.id, description: gb(m.size) }));
  else if (p === 'openrouter') list = CLOUD_MODELS.map((m) => ({ id: m.id, description: m.note }));
  else list = cliModels(p).map((m) => ({ id: m.id, description: m.note }));
  if (current && !list.some((m) => m.id === current)) list.push({ id: current, description: 'your pick' });
  return [...list.map((m) => ({ label: `${m.id}${mark(m.id)}`, description: m.description, id: m.id })),
    { label: 'Other model…', description: p === 'ollama' ? 'type an Ollama model name' : p === 'openrouter' ? 'type any OpenRouter model id' : 'type a model name', input: true }];
}

// deps: { configDir, profile(), saveProfile(p), choose(spec), say(line), login() -> bool (OpenRouter),
//   runInteractive(bin, args) -> bool (a login, install or download that needs the terminal),
//   warm(brain), fetchImpl, state(provider) -> { installed } (tests) }
export async function brainMenu(deps) {
  const { configDir, choose, say } = deps;
  const prof = deps.profile();
  const brain = resolveBrain(prof, configDir);
  const pulled = await localModels({ fetchImpl: deps.fetchImpl });
  const installed = deps.state || ((p) => ({ installed: p === 'ollama' ? !!which('ollama') : p === 'openrouter' ? true : !!which(PROVIDERS[p].agent) }));
  const hint = (p) => {
    if (p === 'ollama') return !installed(p).installed ? 'not installed (ollama.com)' : pulled ? ABOUT[p] : `${ABOUT[p]} · starts when picked`;
    if (p === 'openrouter') return loadKey(configDir, 'openrouter') ? ABOUT[p] : `${ABOUT[p]} · signs in when picked`;
    return installed(p).installed ? ABOUT[p] : `${ABOUT[p]} · installs when picked`;
  };
  const options = BRAIN_ORDER.map((p) => ({
    label: `${NAMES[p]}${brain.provider === p ? '  ✓ now' : ''}`,
    description: hint(p), act: p,
    children: modelRows(p, { pulled, current: modelFor(prof, p), isNow: brain.provider === p }),
  }));
  const r = await choose({
    title: 'Brain',
    question: `Pick the AI behind FRIDAY: it decides where each message goes and plans missions.\nNow: ${brain.label}`,
    options, cancel: 'close', listWord: 'models', start: Math.max(0, BRAIN_ORDER.indexOf(brain.provider)),
  });
  if (!r) return null;
  const p = options[r.index].act;
  const picked = r.child != null ? options[r.index].children[r.child] : null;
  const model = (r.text || picked?.id || modelFor(prof, p)).trim();
  if (!(await ensureReady(p, model, deps))) return null;
  const b = deps.profile().brain || {};
  const patch = p === 'ollama' ? { localModel: model } : p === 'openrouter' ? { model } : { models: { ...(b.models || {}), [p]: model } };
  deps.saveProfile({ ...deps.profile(), brain: { ...b, provider: p, ...patch } });
  const nb = resolveBrain(deps.profile(), configDir);
  say(`  ✓ brain: ${nb.label}`);
  deps.warm?.(nb);
  return nb;
}

// Make the AI usable with this model, or say why not. true when ready.
export async function ensureReady(p, model, deps) {
  const { say, fetchImpl } = deps;
  const name = NAMES[p];
  if (p === 'openrouter') {
    if (model.includes('/') && !CLOUD_MODELS.some((m) => m.id === model)) {
      const info = await cloudModelInfo(model, { fetchImpl });
      if (info && !info.found) { say(`  ✗ OpenRouter has no model "${model}" · nothing changed`); return false; }
      if (info && !info.tools) { say(`  ✗ ${model} cannot call tools, which FRIDAY needs to hand work to agents · nothing changed`); return false; }
    }
    if (loadKey(deps.configDir, 'openrouter')) return true;
    say('  OpenRouter: opening the sign-in page in your browser…');
    return deps.login();
  }
  const check = () => brainStatus({ provider: p, model }, { fetchImpl, ...(deps.cli ? { cli: deps.cli } : {}) });
  let s = await check();
  if (p === 'ollama') {
    if (s.fix === 'start') {
      if (!which('ollama') && !deps.fetchImpl) { say('  ✗ Ollama is not installed: get it from ollama.com · nothing changed'); return false; }
      say('  Local: starting Ollama…');
      (deps.startOllama || startOllama)();
      for (let i = 0; i < 30 && (s = await check()).fix === 'start'; i++) await new Promise((res) => setTimeout(res, 500));
      if (s.fix === 'start') { say('  ✗ Ollama did not start · nothing changed'); return false; }
    }
    if (s.fix === 'pull') {
      say(`  Local: downloading ${model}…`);
      await deps.runInteractive('ollama', ['pull', model]);
      s = await check();
    }
    if (!s.ready) say(`  ✗ ${model}: ${s.reason} · nothing changed`);
    return s.ready;
  }
  const setup = AGENT_SETUP[PROVIDERS[p].agent];
  if (s.fix === 'install') {
    const ok = await choose(deps, `${name} is not installed on this machine.`, [`Install it now (${setup.install})`, 'Cancel']);
    if (!ok) return false;
    await deps.runInteractive(...setup.installCmd);
    s = await check();
    if (s.fix === 'install') { say(`  ✗ ${name} did not install · nothing changed`); return false; }
  }
  if (s.fix === 'login') {
    say(`  ${name}: ${setup.loginNote || 'signing in (a browser page may open)…'}`);
    await deps.runInteractive(...setup.login);
    s = await check();
  }
  if (!s.ready) say(`  ✗ ${name}: ${s.reason} · nothing changed`);
  return s.ready;
}

async function choose(deps, question, labels) {
  const r = await deps.choose({ title: 'Brain', question, options: labels.map((label) => ({ label })), cancel: 'cancel' });
  return r?.index === 0;
}

function startOllama() {
  try { spawn('ollama', ['serve'], { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref(); } catch {}
}
