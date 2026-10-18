#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR, RESTART_CODE, startCockpit } from '../src/cockpit.js';
import { runTermHud } from '../src/term-hud.js';
import { runSetup, runTelegramSetup, setupDone } from '../src/setup.js';
import { openBrowser, saveKey, signInOpenRouter } from '../src/brain.js';
import { answerRun, findRun, listRuns, logTail, runsDir, startWorker } from '../src/missionrun.js';

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  console.log(`friday [folder] [--no-hud] [--resume=<id>]
friday setup
friday login
friday hud [N | --port N]
friday mission "<goal>" [--bg] [--yes]
friday mission resume [n] [--bg] [--yes]
friday missions | friday mission log [n] | friday mission answer <n> <reply>
friday telegram

  One cockpit for Claude Code, Codex, Gemini, opencode and Ollama.
  Type /help inside for commands.

  --no-hud        never open the HUD automatically
  --resume=<id>   pick up a saved conversation
  setup           check your agents and sign in to them, choose the brain (cloud or local)
  login           sign in to OpenRouter (the cloud brain) in your browser
  hud             run the project HUD in this terminal, linked to a running cockpit
  mission         lead a mission (research, brief, build, verify); --bg runs it in the
                  background and gives the terminal back; --yes approves its plan and
                  build by itself (budget limits, PRs and accepting failures still ask)
  missions        background missions: running, waiting for an answer, done
  telegram        connect a Telegram bot: missions ask you on your phone`);
  process.exit(0);
}

// A first start on a new machine (no config yet): set up before the cockpit opens.
const fresh = !fs.existsSync(path.join(CONFIG_DIR, 'config.json')) && !fs.existsSync(path.join(CONFIG_DIR, 'profile.json'));
if (args[0] !== 'setup' && args[0] !== 'telegram' && fresh && !setupDone(CONFIG_DIR) && process.stdin.isTTY && !args.includes('--child') && args[0] !== 'hud' && args[0] !== 'login') {
  await runSetup({ configDir: CONFIG_DIR });
}

// `friday mission ...` / `friday missions`: the words after "mission", minus flags.
const words = args.slice(1).filter((a) => !a.startsWith('-'));
const runs = runsDir(CONFIG_DIR);
const self = fileURLToPath(import.meta.url);
const missionCmd = () => (words[0] === 'resume' ? `/mission resume ${words.slice(1).join(' ')}`.trim() : `/mission ${words.join(' ')}`);
const showRuns = () => {
  const all = listRuns(runs).slice(0, 10);
  if (!all.length) return console.log('  no background missions');
  all.forEach((r, i) => console.log(`  ${i + 1}. ${(r.goal || `resume ${r.resume}`).replace(/\s+/g, ' ').slice(0, 60)} · ${r.alive ? (r.asking ? `waiting: ${r.asking.slice(0, 80)}` : 'running') : r.done ? r.status : 'stopped'}`));
};

// setup and login end by letting Node exit on its own: process.exit() while a socket is
// still closing aborts Node on Windows (libuv "UV_HANDLE_CLOSING" assertion).
if (args[0] === 'setup') {
  await runSetup({ configDir: CONFIG_DIR });
} else if (args[0] === 'login') {
  console.log('  opening OpenRouter in your browser · sign in and approve FRIDAY (5 minutes)');
  try {
    const key = await signInOpenRouter({ open: async (url) => { if (!openBrowser(url)) console.log(`  open this link: ${url}`); } });
    saveKey(CONFIG_DIR, 'openrouter', key);
    console.log('  ✓ signed in to OpenRouter · FRIDAY now thinks in the cloud (/brain to change)');
  } catch (e) { console.error(`  ✗ ${e.message}`); process.exitCode = 1; }
} else if (args[0] === 'telegram') {
  await runTelegramSetup({ configDir: CONFIG_DIR });
} else if (args[0] === 'missions') {
  showRuns();
} else if (args[0] === 'mission' && words[0] === 'log') {
  const r = findRun(runs, words[1] || '1');
  console.log(r ? logTail(runs, r.id, 60) : '  no background missions');
} else if (args[0] === 'mission' && words[0] === 'answer') {
  const r = findRun(runs, words[1] || '');
  const text = words.slice(2).join(' ');
  if (!r || !text) { console.error('  usage: friday mission answer <n> <go|cancel|what to change>'); process.exitCode = 1; }
  else console.log(answerRun(runs, r.id, text) ? `  ✓ answered: ${text}` : `  ${r.id} is not waiting for an answer`);
} else if (args[0] === 'mission' && !words.length) {
  console.error('  usage: friday mission "<goal>" [--bg] [--yes]  ·  friday mission resume [n]');
  process.exitCode = 1;
} else if (args[0] === 'mission' && args.includes('--bg')) {
  const resume = words[0] === 'resume' ? (words.slice(1).join(' ') || '1') : null;
  const run = startWorker({ configDir: CONFIG_DIR, bin: self, goal: resume ? null : words.join(' '), resume, yes: args.includes('--yes'), cwd: process.cwd() });
  console.log(`  ◈ mission running in the background (${run.id})
    friday missions               where it is
    friday mission log            its output
    friday mission answer 1 go    answer it when it asks (or from Telegram, if set up)`);
} else if (args[0] === 'hud') {
  const i = args.indexOf('--port');
  let port = i >= 0 ? +args[i + 1] : +(args.slice(1).find((a) => /^\d+$/.test(a)) || 0);
  if (!port) {
    try { port = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'hud.json'), 'utf8')).port; } catch { port = 7777; }
  }
  runTermHud({ port });
} else if (!args.includes('--child') && process.env.FRIDAY_NO_SUPERVISOR !== '1') {
  // Supervisor: runs the cockpit as a child so a self-change can restart it with
  // fresh code (exit code RESTART_CODE) and the same conversation. It shares the
  // terminal; Ctrl+C is the cockpit's to handle.
  process.on('SIGINT', () => {});
  const run = (extra) => {
    const child = spawn(process.execPath, [self, ...extra, '--child'], {
      stdio: 'inherit', env: { ...process.env, FRIDAY_SUPERVISED: '1' },
    });
    child.on('exit', (code, signal) => {
      if (code === RESTART_CODE) return run([...args.filter((a) => !a.startsWith('--resume')), '--restarted']);
      process.exit(code ?? (signal ? 1 : 0));
    });
  };
  run(args);
} else {
  // `friday mission "<goal>"` in the foreground: the cockpit opens and starts it.
  const mission = args[0] === 'mission';
  const dir = mission ? null : args.find((a) => !a.startsWith('-'));
  const cwd = dir ? path.resolve(dir) : process.cwd();
  if (!fs.existsSync(cwd)) { console.error(`no such folder: ${cwd}`); process.exit(1); }
  const resumeId = args.find((a) => a.startsWith('--resume='))?.slice(9) || null;
  const worker = args.find((a) => a.startsWith('--mission-worker='))?.slice(17) || null;
  const restarted = args.includes('--restarted');
  const c = await startCockpit({ cwd, noHud: args.includes('--no-hud') || !!worker, resumeId, restarted, worker });
  // After a self-change restart the mission is already under way: /mission resume.
  if (mission && !restarted) c.handle(missionCmd());
}
