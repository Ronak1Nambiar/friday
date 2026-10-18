#!/usr/bin/env node
// A tiny todo list kept in ./todos.json.
//   node todo.js add "<text>"   add a todo
//   node todo.js list           list them
//   node todo.js done <id>      mark one done
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(process.cwd(), 'todos.json');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { next: 1, items: [] }; }
}
function save(db) { fs.writeFileSync(FILE, JSON.stringify(db, null, 2)); }

const [cmd, ...rest] = process.argv.slice(2);
const db = load();
if (cmd === 'add') {
  const text = rest.join(' ').trim();
  if (!text) { console.error('usage: todo.js add "<text>"'); process.exit(1); }
  const item = { id: db.next++, text, done: false };
  db.items.push(item);
  save(db);
  console.log(`added #${item.id}`);
} else if (cmd === 'list') {
  for (const t of db.items) console.log(`#${t.id} [${t.done ? 'x' : ' '}] ${t.text}`);
} else if (cmd === 'done') {
  const t = db.items.find((x) => x.id === Number(rest[0]));
  if (!t) { console.error(`no todo #${rest[0]}`); process.exit(1); }
  t.done = true;
  save(db);
  console.log(`done #${t.id}`);
} else {
  console.error('usage: todo.js add "<text>" | list | done <id>');
  process.exit(1);
}
