// Missions in the background: `friday mission "<goal>" --bg` starts a worker (FRIDAY
// itself, headless, its output in a log file) and gives the terminal back. The worker's
// questions ("Run this research? go / cancel") are written to a file and answered from
// the cockpit (/mission answer), from the phone (Telegram, src/telegram.js), or, with
// --yes, by the worker itself. One worker per mission: a lock with the worker's pid.
//
// Files, per run, in <config>/missions/runs/:
//   <run>.json    { id, goal, resume, yes, pid, missionId, status, started, updated, done }
//   <run>.log     everything the worker printed
//   <run>.ask     the question waiting for an answer (text)
//   <run>.answer  the answer (text), removed once read
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const runsDir = (configDir) => path.join(configDir, 'missions', 'runs');
const file = (dir, id, ext) => path.join(dir, `${id}.${ext}`);

export function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export function newRunId(now = new Date()) {
  return `run-${now.toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function writeRun(dir, run) {
  fs.mkdirSync(dir, { recursive: true });
  const next = { ...run, updated: Date.now() };
  fs.writeFileSync(`${file(dir, run.id, 'json')}.tmp`, JSON.stringify(next, null, 2));
  fs.renameSync(`${file(dir, run.id, 'json')}.tmp`, file(dir, run.id, 'json'));
  return next;
}

export function readRun(dir, id) {
  try { return JSON.parse(fs.readFileSync(file(dir, id, 'json'), 'utf8')); } catch { return null; }
}

// Every run, newest first, with `alive` (its worker is still running) and `asking`
// (the question it is waiting on, if any).
export function listRuns(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch {}
  return names.map((n) => readRun(dir, n.slice(0, -5))).filter(Boolean).map((r) => {
    let asking = null;
    try { asking = fs.readFileSync(file(dir, r.id, 'ask'), 'utf8'); } catch {}
    return { ...r, alive: !r.done && isAlive(r.pid), asking };
  }).sort((a, b) => (b.started || 0) - (a.started || 0));
}

// A run by number in listRuns (1 = newest) or by a piece of its id, goal or mission id.
export function findRun(dir, key) {
  const all = listRuns(dir);
  if (/^\d+$/.test(String(key))) return all[Number(key) - 1] || null;
  const k = String(key || '').toLowerCase();
  return all.find((r) => r.id.includes(k) || (r.missionId || '').includes(k) || (r.goal || '').toLowerCase().includes(k)) || null;
}

// The live worker already running this mission, if any (so it never runs twice).
export function workerFor(dir, missionId, { exceptRun = null } = {}) {
  if (!missionId) return null;
  return listRuns(dir).find((r) => r.alive && r.missionId === missionId && r.id !== exceptRun) || null;
}

// Claim a run for this process. Fails when another live process holds it.
export function acquire(dir, id, pid = process.pid) {
  const run = readRun(dir, id);
  if (!run) return { error: `no run ${id}` };
  if (run.pid && run.pid !== pid && !run.done && isAlive(run.pid)) return { error: `run ${id} is already running (pid ${run.pid})` };
  return { run: writeRun(dir, { ...run, pid }) };
}

// The worker asks: the question goes to <run>.ask; the answer is whatever lands in
// <run>.answer first, or whatever `also` (another channel, e.g. Telegram) resolves
// with. Both files are cleared once answered. `signal` stops the wait ('cancel').
export function askByFile(dir, id, question, { pollMs = 1000, also = null, signal = null } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  try { fs.unlinkSync(file(dir, id, 'answer')); } catch {}
  fs.writeFileSync(file(dir, id, 'ask'), question);
  return new Promise((resolve) => {
    let done = false;
    const finish = (answer, from) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      try { fs.unlinkSync(file(dir, id, 'ask')); } catch {}
      try { fs.unlinkSync(file(dir, id, 'answer')); } catch {}
      resolve({ answer: String(answer ?? 'cancel').trim(), from });
    };
    const timer = setInterval(() => {
      try { finish(fs.readFileSync(file(dir, id, 'answer'), 'utf8'), 'terminal'); } catch {}
    }, pollMs);
    also?.then?.((a) => { if (a != null) finish(a, 'phone'); }).catch(() => {});
    signal?.addEventListener?.('abort', () => finish('cancel', 'cancelled'));
  });
}

// The cockpit (or anything else) answers a waiting worker.
export function answerRun(dir, id, text) {
  if (!fs.existsSync(file(dir, id, 'ask'))) return false;
  fs.writeFileSync(file(dir, id, 'answer'), String(text));
  return true;
}

// --yes: the worker answers its own approval gates. A PR is never opened and failing
// fix rounds are never accepted on its own: those stay a person's call. Anything else
// (a budget limit, a question the mission did not expect) still goes to a person.
export function autoAnswer(question) {
  const q = String(question || '');
  if (/^Run this research\b/.test(q) || /^Build it\?/.test(q)) return 'go';
  if (/^Done\? ok\b/.test(q)) return 'ok';
  if (/^Open a pull request\b/.test(q)) return 'no';
  if (/^more \(more fix rounds\) \/ accept/.test(q)) return 'stop';
  return null;
}

export function logTail(dir, id, lines = 40) {
  try {
    const s = fs.readFileSync(file(dir, id, 'log'), 'utf8').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    return s.split('\n').slice(-lines).join('\n');
  } catch { return ''; }
}

// Start a worker for a new run: a detached `friday --mission-worker <run>` whose output
// goes to the run's log. Returns the run.
export function startWorker({ configDir, bin, goal = null, resume = null, yes = false, cwd = process.cwd(), env = process.env }) {
  const dir = runsDir(configDir);
  const id = newRunId();
  writeRun(dir, { id, goal, resume, yes, cwd, started: Date.now(), status: 'starting', pid: null, missionId: null, done: false });
  const log = fs.openSync(file(dir, id, 'log'), 'a');
  const child = spawn(process.execPath, [bin, cwd, '--child', '--no-hud', `--mission-worker=${id}`], {
    cwd, detached: true, stdio: ['ignore', log, log], windowsHide: true,
    env: { ...env, FRIDAY_NO_SUPERVISOR: '1', FRIDAY_SUPERVISED: '0', FORCE_COLOR: '0' },
  });
  child.unref();
  fs.closeSync(log);
  return writeRun(dir, { ...readRun(dir, id), pid: child.pid });
}
