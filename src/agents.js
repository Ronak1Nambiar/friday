// Agent adapters. Each one drives a headless CLI (or HTTP API) and turns its
// event stream into a small common vocabulary: text, tool, done, error.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

export const MODES = ['plan', 'edit', 'yolo'];

// RGB colors, shared by the TUI and the HUD.
export const AGENTS = {
  claude: {
    label: 'Claude Code',
    color: [217, 119, 87],
    bin: 'claude',
    args(prompt, session, mode) {
      const perm = { plan: 'plan', edit: 'acceptEdits', yolo: 'bypassPermissions' }[mode];
      const a = ['-p', prompt, '--output-format', 'stream-json', '--verbose',
        '--include-partial-messages', '--permission-mode', perm];
      if (session.id) a.push('--resume', session.id);
      return a;
    },
    // A process that stays up and reads one message per line (see liveTurn). Its
    // questions (AskUserQuestion) and permission requests come to FRIDAY as
    // control_request lines and wait for the user's answer (--permission-prompt-tool stdio;
    // without it, headless Claude denies them all).
    liveArgs(session, mode) {
      const perm = { plan: 'plan', edit: 'acceptEdits', yolo: 'bypassPermissions' }[mode];
      const a = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
        '--include-partial-messages', '--permission-mode', perm, '--permission-prompt-tool', 'stdio'];
      if (session.id) a.push('--resume', session.id);
      return a;
    },
    liveMessage: (prompt) => JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n',
    parse(ev, out, session) {
      if (ev.session_id) session.id = ev.session_id;
      if (ev.type === 'system' && ev.subtype === 'init' && ev.apiKeySource) {
        out.done({ billing: ev.apiKeySource === 'none' ? 'plan' : 'api' });
      } else if (ev.type === 'rate_limit_event') {
        // Subscription usage windows, 0..1. Only plan logins get these.
        const w = ev.rate_limit_info?.unifiedWindows || {};
        const limits = {};
        for (const k of ['five_hour', 'seven_day']) if (w[k]?.utilization != null) limits[k] = w[k].utilization;
        out.done({ billing: 'plan', limits });
      }
      if (ev.type === 'stream_event') {
        const e = ev.event;
        // Sub-agent streams carry a parent_tool_use_id; keep the main voice only.
        if (!ev.parent_tool_use_id && e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
          out.text(e.delta.text);
        }
      } else if (ev.type === 'assistant' && !ev.parent_tool_use_id) {
        for (const b of ev.message?.content || []) {
          if (b.type === 'tool_use') out.tool(b.name, b.input);
          // In plan mode the answer can arrive as the plan it proposes, not as text.
          if (b.type === 'tool_use' && b.name === 'ExitPlanMode' && typeof b.input?.plan === 'string') out.plan?.(b.input.plan);
        }
      } else if (ev.type === 'result') {
        if (ev.is_error) out.error(ev.result || ev.subtype || 'error');
        // Input as the model saw it: fresh + cache writes + cache reads.
        const u = ev.usage || {};
        const inTok = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].reduce((s, k) => s + (u[k] || 0), 0);
        out.done({ cost: ev.total_cost_usd, ...(ev.usage ? { inTokens: inTok, cachedIn: u.cache_read_input_tokens || 0, outTokens: u.output_tokens } : {}) });
        // `result` is Claude's last event; what follows is its SessionEnd hooks.
        if (!ev.parent_tool_use_id) out.end?.();
      }
    },
  },

  codex: {
    label: 'Codex',
    color: [16, 163, 127],
    bin: 'codex',
    promptLast: true,
    args(prompt, session, mode) {
      const a = ['exec'];
      if (session.id) a.push('resume', session.id);
      a.push('--json', '--skip-git-repo-check');
      if (mode === 'yolo') a.push('--dangerously-bypass-approvals-and-sandbox');
      else a.push('-c', `sandbox_mode="${mode === 'plan' ? 'read-only' : 'workspace-write'}"`);
      a.push(prompt);
      return a;
    },
    parse(ev, out, session) {
      if (ev.type === 'thread.started') session.id = ev.thread_id;
      const it = ev.item;
      if (ev.type === 'item.started' && it?.type === 'command_execution') {
        out.tool('Shell', { command: it.command });
      } else if (ev.type === 'item.completed' && it) {
        if (it.type === 'agent_message') out.text(it.text + '\n');
        else if (it.type === 'file_change') {
          for (const c of it.changes || []) out.tool(cap(c.kind || 'edit'), { path: c.path });
        } else if (it.type === 'mcp_tool_call') out.tool(`${it.server}.${it.tool}`, it.arguments);
        else if (it.type === 'web_search') out.tool('WebSearch', { query: it.query });
      } else if (ev.type === 'turn.failed') {
        out.error(ev.error?.message || 'turn failed');
      } else if (ev.type === 'error') {
        out.error(ev.message || 'error');
      } else if (ev.type === 'turn.completed') {
        // input_tokens already includes cached_input_tokens.
        out.done({ tokens: ev.usage?.output_tokens, inTokens: ev.usage?.input_tokens, cachedIn: ev.usage?.cached_input_tokens, outTokens: ev.usage?.output_tokens });
      }
    },
  },

  gemini: {
    label: 'Gemini',
    color: [71, 150, 227],
    bin: 'gemini',
    args(prompt, session, mode) {
      const approval = { plan: 'plan', edit: 'auto_edit', yolo: 'yolo' }[mode];
      const a = ['-p', prompt, '-o', 'stream-json', '--approval-mode', approval];
      if (session.id) a.push('--resume', 'latest');
      return a;
    },
    parse(ev, out, session) {
      if (ev.type === 'init') session.id = ev.session_id || 'latest';
      else if (ev.type === 'message' && ev.role === 'assistant') out.text(ev.content || '');
      else if (ev.type === 'tool_use') out.tool(ev.tool_name, ev.parameters);
      else if (ev.type === 'error') out.error(ev.message || 'error');
      else if (ev.type === 'result') {
        if (ev.status === 'error') out.error(ev.error?.message || 'error');
        out.done({});
      }
    },
  },

  opencode: {
    label: 'opencode',
    color: [245, 197, 66],
    bin: 'opencode',
    promptLast: true,
    args(prompt, session, mode) {
      const a = ['run', '--format', 'json'];
      if (mode === 'plan') a.push('--agent', 'plan');
      if (mode === 'yolo') a.push('--auto');
      if (session.id) a.push('--session', session.id);
      a.push(prompt);
      return a;
    },
    parse(ev, out, session) {
      if (ev.sessionID) session.id = ev.sessionID;
      const p = ev.part || {};
      if (ev.type === 'text') out.text((p.text || '') + '\n');
      else if (ev.type === 'tool_use') out.tool(p.tool, p.state?.input);
      else if (ev.type === 'step_finish') {
        out.done({ cost: p.cost || 0, tokens: p.tokens?.output, inTokens: p.tokens?.input, cachedIn: p.tokens?.cache?.read, outTokens: p.tokens?.output });
      }
      else if (ev.type === 'error') out.error(ev.error?.data?.message || ev.error?.name || 'error');
    },
  },

  ollama: {
    label: 'Ollama',
    color: [200, 200, 210],
    bin: 'ollama',
    http: true,
  },
};

function cap(s) { return s[0].toUpperCase() + s.slice(1); }
const fmtWait = (ms) => (ms >= 60000 ? `${Math.round(ms / 60000)}m` : `${Math.round(ms / 1000)}s`);

const PATHEXT = process.platform === 'win32'
  ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];

export function which(bin) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const ext of PATHEXT) {
      const p = path.join(dir, bin + ext);
      try { if (fs.statSync(p).isFile()) return p; } catch {
        // Windows app execution aliases (WindowsApps\wt.exe) cannot be stat'ed
        // (EACCES) but run fine; they show up as links.
        try { if (process.platform === 'win32' && fs.lstatSync(p).isSymbolicLink()) return p; } catch {}
      }
    }
  }
  return null;
}

// Pull file paths out of an arbitrary tool input, so the HUD can light them up.
const PATH_KEYS = /^(file_?path|filePath|path|notebook_path|filename)$/i;
export function touchedPaths(input, cwd) {
  const found = [];
  (function walk(v, key) {
    if (!v) return;
    if (typeof v === 'string') {
      if (key && PATH_KEYS.test(key)) found.push(v);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  })(input);
  return found.map((p) => {
    const abs = path.resolve(cwd, p);
    const rel = path.relative(cwd, abs);
    return rel.startsWith('..') ? abs : rel.split(path.sep).join('/');
  });
}

// One-line description of a tool call for the transcript.
export function describeTool(name, input, cwd) {
  if (!input) return name;
  const files = touchedPaths(input, cwd);
  if (files.length) return `${name} ${files.join(', ')}`;
  const s = input.command || input.query || input.pattern || input.url || input.description || input.prompt;
  if (typeof s === 'string') return `${name} ${s.replace(/\s+/g, ' ').slice(0, 90)}`;
  return name;
}

function winQuote(a) {
  return /[\s"&|<>^%]/.test(a) ? '"' + a.replace(/"/g, '""') + '"' : a;
}

// cmd.exe cannot pass an argument containing a newline, and prompts carry multi-line
// context, so on Windows run the real program without a shell. An npm .cmd shim
// names its target as "%dp0%\...\x.exe" or "%dp0%\...\x.js"; run that directly.
const winTargets = new Map();
export function winCommand(bin, args, shim = which(bin)) {
  if (!winTargets.has(shim)) {
    let target = null;
    if (shim && /\.exe$/i.test(shim)) target = { file: shim, pre: [] };
    else if (shim && /\.(cmd|bat)$/i.test(shim)) {
      try {
        const m = fs.readFileSync(shim, 'utf8').match(/"%~?dp0%?\\?([^"]+\.(exe|js|cjs|mjs))"/i);
        const p = m && path.join(path.dirname(shim), m[1]);
        if (p && fs.existsSync(p)) target = /\.exe$/i.test(p) ? { file: p, pre: [] } : { file: process.execPath, pre: [p] };
      } catch {}
    }
    winTargets.set(shim, target);
  }
  const t = winTargets.get(shim);
  return t ? { file: t.file, args: [...t.pre, ...args], shell: false }
    : { file: bin, args: args.map(winQuote), shell: true };
}

// Run one turn. Returns { done: Promise<{ok, ms, cost, tokens, text}>, abort() }.
// `on` receives text(chunk), tool(name, input), error(msg). `extraArgs` and `env`
// carry per-agent vault access; `system` is Ollama's system message.
// `ollamaOptions` / `keepAlive` go to Ollama as-is (e.g. a short num_predict for the router).
// `preArgs` go before the CLI's subcommand (Codex's top-level --search goes before `exec`).
// `live`: keep the agent's process running between turns (Claude only, see liveTurn).
// `timeoutMs`: past it the turn is stopped and reported as `timedOut` (an error, kept
// apart from `aborted`, which means someone stopped it).
export function runTurn(agentId, prompt, { cwd, mode = 'edit', session, on, ollamaModel, ollamaOptions, keepAlive, extraArgs = [], preArgs = [], env = {}, system, live = false, timeoutMs = 0 }) {
  const def = AGENTS[agentId];
  if (def.http) return runOllama(prompt, { session, on, model: ollamaModel, system, options: ollamaOptions, keepAlive });
  if (live && def.liveArgs && session) return liveTurn(agentId, prompt, { cwd, mode, session, on, extraArgs, env, timeoutMs });

  const started = Date.now();
  let text = '';
  let plan = '';
  let meta = {};
  const errors = [];
  const out = {
    text: (t) => { text += t; on.text?.(t); },
    tool: (n, i) => on.tool?.(n || 'tool', i || {}),
    error: (m) => { errors.push(m); on.error?.(m); },
    done: (m) => { meta = { ...meta, ...m }; on.meta?.(m); },
    plan: (p) => { plan = p; },
  };

  const args = [...preArgs, ...def.args(prompt, session, mode)];
  if (extraArgs.length) { if (def.promptLast) args.splice(args.length - 1, 0, ...extraArgs); else args.push(...extraArgs); }
  const cmd = process.platform === 'win32' ? winCommand(def.bin, args)
    : { file: which(def.bin) || def.bin, args, shell: false };
  const child = spawn(cmd.file, cmd.args, {
    cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: cmd.shell, env: { ...process.env, FORCE_COLOR: '0', ...env },
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 20000) stderr = stderr.slice(-10000); });
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    if (!line.trim()) return;
    let ev;
    try { ev = JSON.parse(line); } catch { out.text(line + '\n'); return; }
    try { def.parse(ev, out, session); } catch (e) { out.error(`parse: ${e.message}`); }
  });

  let aborted = false;
  let timedOut = false;
  let settled = false;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const timer = timeoutMs > 0 ? setTimeout(() => {
    if (settled || aborted) return;
    timedOut = true;
    out.error(`timed out after ${fmtWait(timeoutMs)}`);
    child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 1500).unref();
  }, timeoutMs) : null;
  timer?.unref?.();
  // The process may outlive the answer: Claude runs the user's SessionEnd hooks after
  // its final `result` event. `done` resolves on that event (out.end), so the answer
  // is not held back by the hooks; `exited` resolves when the process is gone.
  const exited = new Promise((resolve) => {
    child.on('error', (e) => {
      if (!settled) { settled = true; out.error(`${def.bin}: ${e.message}`); resolveDone(finish(1)); }
      resolve();
    });
    child.on('close', (code) => {
      if (!settled) { settled = true; resolveDone(finish(code)); }
      resolve();
    });
  });
  out.end = () => {
    if (settled || aborted) return;
    settled = true;
    resolveDone(finish(0));
  };
  track(session, exited);
  function finish(code) {
    if (timer) clearTimeout(timer);
    const ok = code === 0 && !aborted && !timedOut && !errors.length;
    const stderrTail = stderr.trim().split('\n').filter((l) => !/Reading additional input/.test(l)).slice(-4).join('\n');
    if (code !== 0 && !aborted && !errors.length) out.error(stderrTail || `${def.bin} exited with code ${code}`);
    if (!text.trim() && plan) text = plan;
    return { ok, aborted, timedOut, code, stderrTail, ms: Date.now() - started, text, errors, ...meta };
  }
  return {
    done,
    exited,
    // After the answer is in, the process is only finishing its hooks: leave it be.
    abort() {
      if (settled) return;
      aborted = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 1500).unref();
    },
  };
}

// ---- live processes ------------------------------------------------------------
// Starting `claude -p` costs a few seconds per turn before the model sees anything, so a
// session keeps one process up, fed one message per line, for as long as its
// folder, mode and flags stay the same. Anything else ends it (its SessionEnd hooks
// run) and the next process resumes the same session.
const liveProcs = new Set();
const liveOf = new WeakMap(); // session -> process
const liveSig = (cwd, mode, extraArgs, env) => JSON.stringify([cwd, mode, extraArgs, env]);

function spawnLive(agentId, { cwd, mode, session, extraArgs = [], env = {} }) {
  const def = AGENTS[agentId];
  const args = [...def.liveArgs(session, mode), ...extraArgs];
  const cmd = process.platform === 'win32' ? winCommand(def.bin, args)
    : { file: which(def.bin) || def.bin, args, shell: false };
  const child = spawn(cmd.file, cmd.args, {
    cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: cmd.shell, env: { ...process.env, FORCE_COLOR: '0', ...env },
  });
  const proc = { child, session, sig: liveSig(cwd, mode, extraArgs, env), cur: null, chain: Promise.resolve(), billing: null, stderr: '', alive: true };
  child.stdin.on('error', () => {});
  child.stderr.on('data', (d) => { proc.stderr = (proc.stderr + d).slice(-10000); });
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const t = proc.cur;
    if (!line.trim() || !t) return;
    let ev;
    try { ev = JSON.parse(line); } catch { t.out.text(line + '\n'); return; }
    if (ev.type === 'control_request') return answerControl(proc, t, ev);
    try { def.parse(ev, t.out, session); } catch (e) { t.out.error(`parse: ${e.message}`); }
  });
  proc.exited = new Promise((resolve) => {
    const gone = (code, err) => {
      if (proc.alive) {
        proc.alive = false;
        liveProcs.delete(proc);
        if (liveOf.get(session) === proc) liveOf.delete(session);
        proc.cur?.finish(code ?? 1, err);
      }
      resolve();
    };
    child.on('error', (e) => gone(1, `${def.bin}: ${e.message}`));
    child.on('close', (code) => gone(code));
  });
  liveProcs.add(proc);
  liveOf.set(session, proc);
  return proc;
}

// Claude asks before a tool runs (a question for the user, or a permission): the turn's
// `on.permission(request)` decides, and its answer goes back on stdin. Shapes: request { subtype: 'can_use_tool', tool_name, input, permission_suggestions };
// answer { behavior: 'allow', updatedInput } or { behavior: 'deny', message }.
function answerControl(proc, t, ev) {
  const reply = (response) => proc.child.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: ev.request_id, response } }) + '\n');
  if (ev.request?.subtype !== 'can_use_tool') {
    proc.child.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: ev.request_id, error: `FRIDAY does not handle ${ev.request?.subtype}` } }) + '\n');
    return;
  }
  const ask = t.on.permission;
  Promise.resolve(ask ? ask(ev.request) : { behavior: 'deny', message: 'Nobody can answer here; continue without it.' })
    .catch((e) => ({ behavior: 'deny', message: `FRIDAY could not ask: ${e.message}` }))
    .then((r) => { if (proc.alive) reply(r || { behavior: 'deny', message: 'Declined.' }); });
}

// Close a live process's input: it finishes, runs its hooks and exits. Resuming the
// session waits for that (sessionExited).
function endLive(proc) {
  if (liveOf.get(proc.session) === proc) liveOf.delete(proc.session);
  if (proc.ending) return;
  proc.ending = true;
  track(proc.session, proc.exited);
  try { proc.child.stdin.end(); } catch {}
  setTimeout(() => { if (proc.alive) proc.child.kill(); }, 30000).unref();
}

// Start a session's process before the first message, so that message does not wait
// for the CLI to boot. Same options as the turn that will use it, or it is wasted.
export function warmLive(agentId, { cwd, mode = 'edit', session, extraArgs = [], env = {} }) {
  if (!AGENTS[agentId]?.liveArgs || !session || !which(AGENTS[agentId].bin)) return false;
  const p = liveOf.get(session);
  if (p?.alive && p.sig === liveSig(cwd, mode, extraArgs, env)) return true;
  if (p?.cur) return false;
  if (p) endLive(p);
  sessionExited(session).then(() => { if (!liveOf.get(session)) spawnLive(agentId, { cwd, mode, session, extraArgs, env }); });
  return true;
}

// End every live process (or only those of `sessions`): on quit, /new, a resumed conversation.
export function closeLive(sessions = null) {
  for (const p of [...liveProcs]) if (!sessions || sessions.includes(p.session)) endLive(p);
}

function liveTurn(agentId, prompt, { cwd, mode, session, on, extraArgs = [], env = {}, timeoutMs = 0 }) {
  const def = AGENTS[agentId];
  const sig = liveSig(cwd, mode, extraArgs, env);
  const started = Date.now();
  let proc = null;
  let text = '';
  let plan = '';
  let meta = {};
  const errors = [];
  let aborted = false;
  let timedOut = false;
  let settled = false;
  let timer = null;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const t = {
    on,
    out: {
      plan: (p) => { plan = p; },
      text: (s) => { text += s; on.text?.(s); },
      tool: (n, i) => on.tool?.(n || 'tool', i || {}),
      error: (m) => { errors.push(m); on.error?.(m); },
      done: (m) => { meta = { ...meta, ...m }; if (m.billing && proc) proc.billing = m.billing; on.meta?.(m); },
      end: () => t.finish(0),
    },
    finish(code, err) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const stderrTail = (proc?.stderr || '').trim().split('\n').slice(-4).join('\n');
      if (err) t.out.error(err);
      else if (code !== 0 && !aborted && !errors.length) t.out.error(stderrTail || `${def.bin} exited with code ${code}`);
      if (proc?.cur === t) proc.cur = null;
      if (!text.trim() && plan) text = plan;
      resolveDone({ ok: code === 0 && !aborted && !timedOut && !errors.length, aborted, timedOut, code, stderrTail, ms: Date.now() - started, text, errors, ...(proc?.billing ? { billing: proc.billing } : {}), ...meta });
    },
  };
  (async () => {
    let p = liveOf.get(session);
    if (p) await p.chain;
    p = liveOf.get(session);
    if (p && (p.sig !== sig || !p.alive || p.ending)) { endLive(p); p = null; }
    await sessionExited(session);
    if (aborted) return t.finish(1);
    proc = p || spawnLive(agentId, { cwd, mode, session, extraArgs, env });
    proc.cur = t;
    proc.chain = done.then(() => {});
    proc.child.stdin.write(def.liveMessage(prompt));
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled || aborted || proc?.cur !== t) return;
        timedOut = true;
        t.out.error(`timed out after ${fmtWait(timeoutMs)}`);
        proc.child.kill('SIGTERM'); setTimeout(() => proc.alive && proc.child.kill('SIGKILL'), 1500).unref();
      }, timeoutMs);
      timer.unref?.();
    }
  })().catch((e) => t.finish(1, e.message));
  return {
    done,
    exited: done.then(() => {}),
    // Stop this turn: the process goes with it; the session resumes in a new one.
    abort() {
      if (settled) return;
      aborted = true;
      if (proc?.cur === t) { proc.child.kill('SIGTERM'); setTimeout(() => proc.alive && proc.child.kill('SIGKILL'), 1500).unref(); }
    },
  };
}

// Agent processes still finishing after their answer, per session and overall.
const exiting = new WeakMap();
const lingering = new Set();
function track(session, exited) {
  lingering.add(exited);
  if (session) exiting.set(session, exited);
  exited.then(() => {
    lingering.delete(exited);
    if (session && exiting.get(session) === exited) exiting.delete(session);
  });
}

// Wait for this session's previous process to exit before resuming it, so two
// processes never hold one session. Resolves at once when nothing is running.
export function sessionExited(session) {
  return exiting.get(session) || Promise.resolve();
}

// Wait (bounded) for every agent process still finishing its hooks. Returns how
// many were still running when called.
export async function settleAgents(timeoutMs = 10000) {
  const n = lingering.size;
  if (n) await Promise.race([Promise.all([...lingering]), new Promise((r) => setTimeout(r, timeoutMs).unref())]);
  return n;
}

// Ollama has no agent CLI with a JSON stream, so talk to its HTTP API and keep
// the chat history ourselves.
function runOllama(prompt, { session, on, model, system, options, keepAlive }) {
  const started = Date.now();
  const host = (process.env.OLLAMA_HOST || '127.0.0.1:11434').replace(/^https?:\/\//, '');
  const base = `http://${host}`;
  const ctrl = new AbortController();
  session.history ||= [];
  let text = '';
  let tokens;
  let inTokens;
  const done = (async () => {
    try {
      if (!model) {
        const tags = await (await fetch(`${base}/api/tags`, { signal: ctrl.signal })).json();
        model = tags.models?.[0]?.name;
        if (!model) throw new Error('no models pulled; run `ollama pull <model>`');
      }
      session.id = model;
      session.history.push({ role: 'user', content: prompt });
      const res = await fetch(`${base}/api/chat`, {
        method: 'POST', signal: ctrl.signal,
        body: JSON.stringify({
          model, messages: system ? [{ role: 'system', content: system }, ...session.history] : session.history, stream: true,
          ...(options ? { options } : {}), ...(keepAlive ? { keep_alive: keepAlive } : {}),
        }),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      const dec = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          const t = ev.message?.content || '';
          if (t) { text += t; on.text?.(t); }
          if (ev.done) { tokens = ev.eval_count; inTokens = ev.prompt_eval_count; }
        }
      }
      session.history.push({ role: 'assistant', content: text });
      return { ok: true, ms: Date.now() - started, text, model, tokens, inTokens, outTokens: tokens, billing: 'local' };
    } catch (e) {
      if (ctrl.signal.aborted) return { ok: false, aborted: true, ms: Date.now() - started, text };
      const last = session.history.at(-1);
      if (last?.role === 'user' && last.content === prompt) session.history.pop();
      const msg = /fetch failed|ECONNREFUSED/.test(e.message + (e.cause?.code || ''))
        ? 'Ollama is not running. Start it with `ollama serve`.' : e.message;
      on.error?.(msg);
      return { ok: false, ms: Date.now() - started, text, errors: [msg] };
    }
  })();
  return { done, exited: done.then(() => {}), abort() { ctrl.abort(); } };
}

// Gemini CLI needs a one-time interactive login (or an API key) before -p works.
export function geminiLoggedIn(env = process.env, home = os.homedir()) {
  if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY || env.GOOGLE_GENAI_USE_VERTEXAI) return true;
  return fs.existsSync(path.join(home, '.gemini', 'oauth_creds.json'));
}

// Is this model in memory right now? A model that has to load first takes seconds,
// so latency-critical callers skip it rather than wait.
export async function ollamaLoaded(model, timeoutMs = 300) {
  const host = (process.env.OLLAMA_HOST || '127.0.0.1:11434').replace(/^https?:\/\//, '');
  try {
    const res = await fetch(`http://${host}/api/ps`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const want = model.includes(':') ? model : `${model}:latest`;
    return ((await res.json()).models || []).some((m) => m.name === want || m.model === want);
  } catch { return false; }
}

export async function ollamaUp(timeoutMs = 800) {
  const host = (process.env.OLLAMA_HOST || '127.0.0.1:11434').replace(/^https?:\/\//, '');
  try {
    const res = await fetch(`http://${host}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch { return false; }
}

export function availableAgents() {
  return Object.keys(AGENTS).filter((id) => which(AGENTS[id].bin));
}
