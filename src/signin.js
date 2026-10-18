// Is an AI installed and signed in, and how to fix it when it is not. Shared by
// `friday setup`, the /brain menu and the brain itself (src/brain.js).
import { spawn, spawnSync } from 'node:child_process';
import { geminiLoggedIn, which, winCommand } from './agents.js';

// How to get and sign in to each agent. `status` returns true/false, or null when the
// CLI has no way to ask (then the first real turn tells).
export const AGENT_SETUP = {
  claude: {
    install: 'npm i -g @anthropic-ai/claude-code',
    installCmd: ['npm', ['i', '-g', '@anthropic-ai/claude-code']],
    login: ['claude', ['auth', 'login']],
    status: () => { const r = run('claude', ['auth', 'status']); try { return JSON.parse(r.out).loggedIn === true; } catch { return r.ok ? null : false; } },
  },
  codex: {
    install: 'npm i -g @openai/codex',
    installCmd: ['npm', ['i', '-g', '@openai/codex']],
    login: ['codex', ['login']],
    status: () => { const r = run('codex', ['login', 'status']); return r.ok && /logged in/i.test(r.out) && !/not logged in/i.test(r.out); },
  },
  gemini: {
    install: 'npm i -g @google/gemini-cli',
    installCmd: ['npm', ['i', '-g', '@google/gemini-cli']],
    login: ['gemini', []], // the first interactive start signs in; /quit leaves it
    loginNote: 'Gemini opens: sign in with Google, then type /quit to come back',
    status: () => geminiLoggedIn(),
  },
  opencode: {
    install: 'npm i -g opencode-ai',
    installCmd: ['npm', ['i', '-g', 'opencode-ai']],
    login: ['opencode', ['auth', 'login']],
    status: () => null, // its free model works without signing in
  },
  ollama: {
    install: 'https://ollama.com/download',
    login: null,
    status: null, // checked separately: is the service running
  },
};

export function run(bin, args, timeoutMs = 15000) {
  const c = process.platform === 'win32' ? winCommand(bin, args) : { file: bin, args, shell: false };
  const r = spawnSync(c.file, c.args, { shell: c.shell, encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}` };
}

// A login (or install) that needs the terminal: it shares this one until it exits.
export function runInteractive(bin, args) {
  const c = process.platform === 'win32' ? winCommand(bin, args) : { file: bin, args, shell: false };
  return new Promise((resolve) => {
    const child = spawn(c.file, c.args, { shell: c.shell, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

// { installed, signedIn } for a CLI agent; signedIn is null when it cannot be asked.
export function cliState(id) {
  const installed = !!which(id);
  return { installed, signedIn: installed ? AGENT_SETUP[id]?.status?.() ?? null : false };
}
