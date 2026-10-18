#!/usr/bin/env node
// Reference solution: only used to check that accept.mjs is right (bench --check).
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(process.cwd(), 'todos.json');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { next: 1, items: [] }; }
}
function save(db) { fs.writeFileSync(FILE, JSON.stringify(db, null, 2)); }
function validDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const [cmd, ...rest] = process.argv.slice(2);
const db = load();
if (cmd === 'add') {
  const i = rest.indexOf('--due');
  const due = i >= 0 ? rest[i + 1] : null;
  const words = i >= 0 ? [...rest.slice(0, i), ...rest.slice(i + 2)] : rest;
  const text = words.join(' ').trim();
  if (!text) { console.error('usage: todo.js add "<text>" [--due YYYY-MM-DD]'); process.exit(1); }
  if (i >= 0 && !validDate(due)) { console.error(`not a date: ${due}`); process.exit(1); }
  const item = { id: db.next++, text, done: false, ...(due ? { due } : {}) };
  db.items.push(item);
  save(db);
  console.log(`added #${item.id}`);
} else if (cmd === 'list') {
  const overdue = rest.includes('--overdue');
  for (const t of db.items) {
    if (overdue && (t.done || !t.due || t.due >= today())) continue;
    console.log(`#${t.id} [${t.done ? 'x' : ' '}] ${t.text}${t.due ? ` (due ${t.due})` : ''}`);
  }
} else if (cmd === 'done') {
  const t = db.items.find((x) => x.id === Number(rest[0]));
  if (!t) { console.error(`no todo #${rest[0]}`); process.exit(1); }
  t.done = true;
  save(db);
  console.log(`done #${t.id}`);
} else {
  console.error('usage: todo.js add "<text>" [--due YYYY-MM-DD] | list [--overdue] | done <id>');
  process.exit(1);
}
