// Hidden acceptance test (the agents never see it). cwd: the fixed repo.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const fails = [];
let splitBill;
try { ({ splitBill } = await import(pathToFileURL(path.resolve('src/money.js')).href)); } catch (e) { console.log(`FAIL: cannot load src/money.js: ${e.message}`); process.exit(1); }

let bad = null;
for (let n = 1; n <= 12 && !bad; n++) {
  for (const total of [0, 1, 2, 7, 99, 100, 101, 1000, 12345, 99999]) {
    const s = splitBill(total, n);
    const sum = s.reduce((a, b) => a + b, 0);
    const ok = Array.isArray(s) && s.length === n && s.every(Number.isInteger) && sum === total
      && Math.max(...s) - Math.min(...s) <= 1 && s.every((x, i) => i === 0 || s[i - 1] >= x);
    if (!ok) { bad = `splitBill(${total}, ${n}) = ${JSON.stringify(s)}`; break; }
  }
}
if (bad) fails.push(`wrong split: ${bad}`);
for (const [t, n] of [[-1, 2], [10, 0], [1.5, 2], [10, 2.5]]) {
  try { splitBill(t, n); fails.push(`no TypeError for (${t}, ${n})`); } catch (e) { if (!(e instanceof TypeError)) fails.push(`(${t}, ${n}) threw ${e.name}, not TypeError`); }
}
const t = spawnSync('npm', ['test', '--silent'], { cwd: process.cwd(), encoding: 'utf8', shell: process.platform === 'win32', timeout: 120000 });
if (t.status !== 0) fails.push('npm test fails');

console.log(fails.length ? `FAIL: ${fails.join('; ')}` : 'PASS');
process.exit(fails.length ? 1 : 0);
