#!/usr/bin/env node
// Pull the prompt-writer's model and check it: Ollama up, model present, and one
// timed rewrite (cold, then warm). `--check` skips the pull.
//   node scripts/setup-promptwriter.js [--check]
import { spawnSync } from 'node:child_process';
import { which } from '../src/agents.js';
import { CONFIG_DIR } from '../src/cockpit.js';
import { loadProfile } from '../src/profile.js';
import { curate, writerStatus } from '../src/promptwriter.js';

const pw = { ...loadProfile(CONFIG_DIR).promptWriter, enabled: true };
const say = (s) => process.stdout.write(s + '\n');

let s = await writerStatus(pw);
if (!s.up) { say('✗ Ollama is not running. Start it (`ollama serve`, or the Ollama app) and run this again.'); process.exit(1); }
if (!process.argv.includes('--check') && !s.pulled) {
  const bin = which('ollama');
  if (!bin) { say('✗ ollama is not on PATH'); process.exit(1); }
  say(`pulling ${pw.model} ...`);
  const r = spawnSync(bin, ['pull', pw.model], { stdio: 'inherit' });
  if (r.status !== 0) { say(`✗ ollama pull ${pw.model} failed`); process.exit(1); }
  s = await writerStatus(pw);
}
if (!s.pulled) { say(`✗ ${pw.model} is not pulled. Run without --check, or \`ollama pull ${pw.model}\`.`); process.exit(1); }
say(`✓ Ollama up · ${pw.model} present`);

const sample = 'Hey, so in the friday repo the /usage command should also show how many turns the prompt-writer rewrote, '
  + 'and the average percent saved, but it must not print any message text and never touch src/router.js. '
  + 'Add a test in test/promptwriter.test.js and make sure node --test still passes, thanks a lot!';
for (const label of ['cold', 'warm']) {
  const c = await curate(sample, { agent: 'claude', label: 'Claude Code', pw: { ...pw, timeoutMs: label === 'cold' ? 120000 : pw.timeoutMs }, projects: ['friday'] });
  const what = c.rewritten ? `~${c.stats.origTok} -> ~${c.stats.curTok} tokens (est.)` : `fell back: ${c.reason}`;
  say(`${c.rewritten ? '✓' : '!'} ${label} rewrite: ${c.stats.rewriteMs} ms · ${what}`);
  if (label === 'warm' && c.rewritten) say('\n' + c.text.replace(/^/gm, '    '));
}
say(`\nprompt-writer is ${loadProfile(CONFIG_DIR).promptWriter.enabled ? 'on' : 'off'}; turn it on in FRIDAY with /rewrite on`);
