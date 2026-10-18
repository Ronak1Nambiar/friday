// Hidden checklist (the agents never see it). argv[2]: a file with the answer.
// A crude but fixed score: does the answer cover what the goal asked for?
import fs from 'node:fs';

const text = fs.readFileSync(process.argv[2], 'utf8');
const items = [
  ['covers SQLite', /sqlite/i],
  ['covers DuckDB', /duckdb/i],
  ['covers PostgreSQL', /postgres/i],
  ['makes a recommendation', /\brecommend|\bgo with\b|\bpick\b|\bchoose\b|\bverdict\b/i],
  ['embedded / in-process vs a server', /embedded|in-process|serverless|no server|separate server|server process/i],
  ['columnar / analytical engine', /column(ar)?|vectori[sz]ed|OLAP|analytic/i],
  ['write patterns / concurrency', /WAL|concurren|single writer|write lock|insert/i],
  ['packaging with Electron', /packag|bundl|native module|electron-rebuild|prebuilt|binary/i],
  ['file size / storage', /file size|disk|compress|storage/i],
  ['risks', /\brisk|downside|drawback|caveat|trade-?off/i],
];
const missing = items.filter(([, re]) => !re.test(text)).map(([name]) => name);
const score = items.length - missing.length;
console.log(`${score >= 8 ? 'PASS' : 'FAIL'}: ${score}/${items.length}${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);
process.exit(score >= 8 ? 0 : 1);
