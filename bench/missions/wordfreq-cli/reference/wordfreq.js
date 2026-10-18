// Reference solution: only used to check that accept.mjs is right (bench --check).
import fs from 'node:fs';

const args = process.argv.slice(2);
const i = args.indexOf('--top');
const top = i >= 0 ? Number(args[i + 1]) : 10;
const file = args.find((a, k) => !a.startsWith('--') && (i < 0 || k !== i + 1));
let text;
try { text = fs.readFileSync(file, 'utf8'); } catch (e) { console.error(`wordfreq: ${e.message}`); process.exit(1); }
const counts = new Map();
for (const w of text.toLowerCase().match(/[a-z]+/g) || []) counts.set(w, (counts.get(w) || 0) + 1);
for (const [w, n] of [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, top)) console.log(`${w} ${n}`);
