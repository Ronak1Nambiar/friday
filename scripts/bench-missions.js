#!/usr/bin/env node
// Mission benchmark: does a FRIDAY mission beat one Claude Code turn on the same goal?
// Each task in bench/missions/<id>/ has a goal and a hidden acceptance check the agents
// never see. Every task runs two ways, each in a fresh folder:
//   claude  one `claude -p` turn with the goal (edit mode; plan mode + web for research)
//   friday  `friday mission "<goal>" --bg --yes`, pinned to the folder
// and the acceptance check decides. Results go to docs/BENCHMARKS.md and docs/bench/.
//
//   node scripts/bench-missions.js --check            check the checks: each fails on the
//                                                     starting code, passes on a reference
//   node scripts/bench-missions.js [--task <id>] [--only claude|friday]
//
// It spends real plan usage (several agent turns per FRIDAY mission). Never part of npm test.
// FRIDAY runs with its own config folder (a copy of your profile and keys, no vault, no
// Telegram), so nothing lands in your vault and nothing pings your phone.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TASKS = path.join(ROOT, 'bench', 'missions');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

export function loadTasks(only = null) {
  return fs.readdirSync(TASKS).filter((d) => fs.existsSync(path.join(TASKS, d, 'task.json')))
    .map((d) => ({ ...JSON.parse(fs.readFileSync(path.join(TASKS, d, 'task.json'), 'utf8')), dir: path.join(TASKS, d) }))
    .filter((t) => !only || t.id === only);
}

function copyDir(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// A fresh folder with the task's starting code, as a git repo with one commit.
export function prepare(task, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  copyDir(path.join(task.dir, 'seed'), dir);
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=bench', '-c', 'user.email=bench@localhost', 'commit', '-q', '--allow-empty', '-m', 'start');
  return dir;
}

export function accept(task, cwd, answerFile = null) {
  const r = spawnSync(process.execPath, [path.join(task.dir, 'accept.mjs'), ...(answerFile ? [answerFile] : [])], { cwd, encoding: 'utf8', timeout: 300000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').pop() || '';
  return { pass: r.status === 0, out };
}

// --check: every acceptance check must fail on the starting code and pass on the reference.
export function checkTasks(tasks, tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-bench-check-'))) {
  const problems = [];
  for (const t of tasks) {
    if (t.kind === 'research') {
      const good = accept(t, tmp, path.join(t.dir, 'reference.md'));
      const weak = accept(t, tmp, path.join(t.dir, 'weak.md'));
      if (!good.pass) problems.push(`${t.id}: the reference answer fails (${good.out})`);
      if (weak.pass) problems.push(`${t.id}: a weak answer passes (${weak.out})`);
      continue;
    }
    const dir = prepare(t, path.join(tmp, t.id));
    const before = accept(t, dir);
    if (before.pass) problems.push(`${t.id}: passes on the starting code`);
    copyDir(path.join(t.dir, 'reference'), dir);
    const after = accept(t, dir);
    if (!after.pass) problems.push(`${t.id}: the reference fails (${after.out})`);
  }
  return problems;
}

const fmtTime = (ms) => (ms == null ? '-' : ms >= 60000 ? `${(ms / 60000).toFixed(1)} min` : `${Math.round(ms / 1000)} s`);
const pct = (x) => (typeof x === 'number' ? `${Math.round(x * 100)}%` : 'n/a');
const usd = (x) => (typeof x === 'number' && x > 0 ? `$${x.toFixed(2)}` : '-');

export function benchMarkdown(results, { date }) {
  const rows = results.map((r) => `| ${r.task} | ${r.approach} | ${r.pass ? 'pass' : 'fail'} | ${fmtTime(r.ms)} | ${r.fixRounds ?? '-'} | ${pct(r.fiveHourAfter)} | ${usd(r.cost)} | ${(r.note || r.acceptOut || '').replace(/\|/g, '/').slice(0, 120)} |`);
  const score = (a) => { const x = results.filter((r) => r.approach === a); return `${x.filter((r) => r.pass).length}/${x.length}`; };
  return [
    '# Mission benchmark', '',
    `*Run ${date} with \`node scripts/bench-missions.js\`. Raw data: \`docs/bench/\`.*`, '',
    `**FRIDAY mission: ${score('friday')} tasks pass. One Claude Code turn: ${score('claude')}.**`, '',
    'Each task has a goal and a hidden acceptance check that neither approach sees (`bench/missions/<task>/`). Both start from the same fresh folder.', '',
    '| Task | Approach | Acceptance | Time | Fix rounds | Claude 5-hour use after | API cost | Notes |',
    '|---|---|---|---|---|---|---|---|',
    ...rows, '',
    '## Read this before quoting it', '',
    '- One run per task. Agents are not deterministic; a single run shows a direction, not a rate.',
    '- "Claude 5-hour use after" is the plan-limit reading at the end of each run, in run order (Claude alone, then FRIDAY, per task). The difference between consecutive readings is roughly what a run used; a window reset in between makes it meaningless.',
    '- Both approaches run Claude in edit mode, which cannot run shell commands headless; FRIDAY runs the tests itself between rounds, Claude alone cannot.',
    '- The research checklist is crude (does the answer cover what was asked), not a judgement of quality.',
    '',
  ].join('\n');
}

async function main() {
  const tasks = loadTasks(opt('--task'));
  if (!tasks.length) { console.error('no such task'); process.exit(1); }
  if (args.includes('--check')) {
    const problems = checkTasks(tasks);
    for (const p of problems) console.log(`  ✗ ${p}`);
    console.log(problems.length ? `${problems.length} problem(s)` : `  ✓ ${tasks.length} task checks are sound`);
    process.exit(problems.length ? 1 : 0);
  }

  const { CONFIG_DIR } = await import('../src/cockpit.js');
  const { runTurn } = await import('../src/agents.js');
  const { readRun, runsDir, startWorker, answerRun } = await import('../src/missionrun.js');
  const only = opt('--only');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `friday-bench-${stamp}-`));
  const cfg = path.join(root, 'config');
  fs.mkdirSync(cfg, { recursive: true });
  for (const f of ['profile.json', 'keys.json', 'setup.json']) if (fs.existsSync(path.join(CONFIG_DIR, f))) fs.copyFileSync(path.join(CONFIG_DIR, f), path.join(cfg, f));
  fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({ roots: [path.join(root, 'work')], missionStore: path.join(root, 'missions-out'), autoHud: false }, null, 2));
  console.log(`bench folder: ${root}`);

  const results = [];
  for (const t of tasks) {
    const research = t.kind === 'research';
    if (only !== 'friday') {
      console.log(`\n▸ ${t.id} · claude alone`);
      const dir = prepare(t, path.join(root, 'work', `${t.id}-claude`));
      const r = await runTurn('claude', t.goal, {
        cwd: dir, mode: research ? 'plan' : 'edit', session: {}, on: {}, timeoutMs: 45 * 60000,
        extraArgs: research ? ['--allowedTools', 'WebSearch', 'WebFetch'] : [],
      }).done;
      const answer = path.join(root, `${t.id}-claude.md`);
      fs.writeFileSync(answer, r.text || '');
      const a = accept(t, dir, research ? answer : null);
      results.push({ task: t.id, approach: 'claude', pass: a.pass, acceptOut: a.out, ms: r.ms, fiveHourAfter: r.limits?.five_hour ?? null, cost: r.billing === 'api' ? r.cost : null, note: r.ok ? '' : `turn failed: ${(r.errors || []).join('; ').slice(0, 100)}` });
      console.log(`  ${a.out}`);
    }
    if (only !== 'claude') {
      console.log(`\n▸ ${t.id} · friday mission`);
      const dir = prepare(t, path.join(root, 'work', `${t.id}-friday`));
      const t0 = Date.now();
      const run = startWorker({ configDir: cfg, bin: path.join(ROOT, 'bin', 'friday.js'), goal: t.goal, yes: true, cwd: dir, env: { ...process.env, FRIDAY_CONFIG: cfg, FRIDAY_MISSION_DIR: dir } });
      let rec = run;
      let note = '';
      let askedSince = null;
      // Wait for the worker. A question --yes does not answer (a budget limit) is answered
      // "pause" after 2 minutes, so the run ends instead of hanging.
      while (Date.now() - t0 < 120 * 60000) {
        await new Promise((r) => setTimeout(r, 5000));
        rec = readRun(runsDir(cfg), run.id) || rec;
        if (rec.done) break;
        const asking = fs.existsSync(path.join(runsDir(cfg), `${run.id}.ask`));
        if (!asking) { askedSince = null; continue; }
        askedSince ||= Date.now();
        if (Date.now() - askedSince > 120000) { note = `stalled on: ${fs.readFileSync(path.join(runsDir(cfg), `${run.id}.ask`), 'utf8').slice(0, 80)}`; answerRun(runsDir(cfg), run.id, 'pause'); askedSince = null; }
      }
      if (!rec.done) { note ||= 'timed out after 120 min'; try { process.kill(rec.pid); } catch {} }
      let m = null;
      try { m = JSON.parse(fs.readFileSync(path.join(cfg, 'missions', `${rec.missionId}.json`), 'utf8')); } catch {}
      const answer = path.join(root, `${t.id}-friday.md`);
      fs.writeFileSync(answer, m?.build?.brief || '');
      const a = accept(t, dir, research ? answer : null);
      const costOf = (u) => Object.values(u || {}).reduce((s, x) => s + (x?.cost || 0), 0);
      results.push({
        task: t.id, approach: 'friday', pass: a.pass, acceptOut: a.out, ms: Date.now() - t0, status: m?.status || rec.status,
        fixRounds: m ? (m.rounds || []).filter((r) => r.fixer).length : null,
        fiveHourAfter: m?.usage?.after?.claude?.five_hour ?? null,
        cost: m ? costOf(m.usage?.after) - costOf(m.usage?.before) : null,
        note: note || (m?.status && !/^built and verified|^researched/.test(m.status) ? m.status : ''),
      });
      console.log(`  ${a.out} · ${m?.status || rec.status}`);
    }
  }
  const date = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(path.join(ROOT, 'docs', 'bench'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'docs', 'bench', `results-${stamp}.json`), JSON.stringify({ date, results }, null, 2));
  fs.writeFileSync(path.join(ROOT, 'docs', 'BENCHMARKS.md'), benchMarkdown(results, { date }));
  console.log(`\n${benchMarkdown(results, { date }).split('\n').slice(4, 5).join('')}\nwritten: docs/BENCHMARKS.md`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
