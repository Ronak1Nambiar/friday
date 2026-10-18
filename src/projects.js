// Project registry (folders + vault notes), mention detection, and the scan
// that feeds the HUD.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GENERIC = new Set(['project', 'memory', 'health', 'launch', 'plan', 'portfolio', 'money',
  'map', 'second', 'brain', 'bot', 'services', 'idea', 'app', 'sim', 'llm', 'ai', 'co', 'the', 'and',
  'test', 'demo', 'web', 'site', 'api', 'data', 'core', 'main', 'docs', 'notes', 'tools',
  // Agents and words used about them all the time; a folder named after one
  // (a vault folder named Claude, say) must not grab focus when they come up.
  'agent', 'agents', 'claude', 'codex', 'gemini', 'opencode', 'ollama', 'remote', 'files', 'random']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.venv', 'venv',
  '__pycache__', 'target', 'bin', 'obj', '.idea', '.vscode', 'coverage', '.cache', '.claude']);

export const expandHome = (p) => (p?.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const tokens = (s) => s.toLowerCase().replace(/^project-/, '').split(/[^a-z0-9]+/).filter(Boolean);

function readNote(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'); // many notes are CRLF
  const fm = /^---\n([\s\S]*?)\n---/.exec(raw)?.[1] || '';
  const field = (k) => new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(fm)?.[1]?.trim() || '';
  const title = /^#\s+(.+)$/m.exec(raw)?.[1]?.trim() || path.basename(file, '.md');
  const now = (/^## Now\s*\n([\s\S]*?)(?=^---\s*$|^## )/m.exec(raw)?.[1] || '')
    .split('\n').filter((l) => !/^\*[^*].*\*$/.test(l.trim())).join('\n').trim();
  const links = [...new Set([...raw.matchAll(/\[\[([^\]|#]+)/g)].map((m) => m[1].trim()))];
  const aliases = field('aliases').replace(/[[\]"']/g, '').split(',').map((s) => s.trim()).filter(Boolean);
  return { title, now, links, aliases, type: field('type'), status: field('status') };
}

// Phrases that, said in conversation, mean this project.
export function aliasesFor(p) {
  const out = new Set();
  const add = (s, to = out) => { const t = tokens(s || ''); if (t.length) to.add(t.join(' ')); };
  add(p.name);
  if (p.dir) add(path.basename(p.dir));
  // Names the user gave the project in its vault note. Only these get the first-word
  // first-word shortcut: a folder name's first word is
  // too often an ordinary word ("Agent-TEST" would claim every mention of "agent").
  const named = new Set();
  if (p.note) {
    const main = p.note.title.replace(/\(.*?\)/g, '').replace(/[—:].*$/, '');
    add(main, named);
    for (const q of p.note.title.matchAll(/["“]([^"”]+)["”]/g)) add(q[1], named);
    p.note.aliases.forEach((a) => add(a, named));
  }
  for (const a of named) {
    out.add(a);
    const first = a.split(' ')[0];
    if (first.length >= 5 && !GENERIC.has(first)) out.add(first);
  }
  return [...out].filter((a) => a.length >= 3 && !GENERIC.has(a));
}

export function loadRegistry({ roots, vault }) {
  const byKey = new Map();
  for (const root of roots.map(expandHome)) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const dir = path.join(root, e.name);
      const key = tokens(e.name).join('-');
      if (!byKey.has(key)) byKey.set(key, { name: e.name, dir, git: fs.existsSync(path.join(dir, '.git')) });
    }
  }
  const notesDir = vault && path.join(expandHome(vault), '01_Projects');
  let notes = [];
  try { notes = fs.readdirSync(notesDir).filter((f) => f.startsWith('project-') && f.endsWith('.md')); } catch {}
  // Shortest names first, so a sub-note (project-x-viability) folds into project-x.
  notes.sort((a, b) => a.length - b.length);
  const seen = [];
  for (const f of notes) {
    const nt = tokens(f.replace(/\.md$/, ''));
    if (seen.some((s) => s.every((t, i) => nt[i] === t))) continue;
    seen.push(nt);
    const note = { ...readNote(path.join(notesDir, f)), file: path.join(notesDir, f) };
    if (note.status === 'archived') continue;
    // Attach to the folder whose name contains every note token, or vice versa;
    // failing that, the folder named after one of the note's own names (the
    // note titled `Name ("alias")` attaches to a repo named alias/).
    let match = null;
    for (const p of byKey.values()) {
      if (!p.dir || p.note) continue;
      const dt = tokens(path.basename(p.dir));
      if (nt.every((t) => dt.includes(t)) || dt.every((t) => nt.includes(t))) { match = p; break; }
    }
    if (!match) {
      const names = new Set(aliasesFor({ name: '', note }).filter((a) => a.includes(' ') || a.length >= 4));
      match = [...byKey.values()].find((p) => p.dir && !p.note && names.has(tokens(path.basename(p.dir)).join(' '))) || null;
    }
    if (match) match.note = note;
    else byKey.set(nt.join('-'), { name: nt.join('-'), note });
  }
  const list = [...byKey.values()];
  for (const p of list) {
    p.display = p.note ? p.note.title.replace(/\s*\(.*?\)\s*/g, ' ').replace(/[—:].*$/, '').trim() : p.name;
    p.aliases = aliasesFor(p);
  }
  return list;
}

// Find the project a message is talking about. Longest alias wins.
// `auto` is for mentions in conversation (auto-focus): only real projects count, a
// vault note or a git repo, never the vault itself. Loose folders (course downloads,
// "files", "random") are still reachable with /project.
export function detectProject(text, registry, { auto = false, vault = null } = {}) {
  const hay = ' ' + tokens(text).join(' ') + ' ';
  const vaultDir = vault && path.resolve(expandHome(vault));
  let best = null;
  for (const p of registry) {
    if (auto && ((!p.note && !p.git) || (vaultDir && p.dir && path.resolve(p.dir) === vaultDir))) continue;
    for (const a of p.aliases) {
      if (hay.includes(' ' + a + ' ') && (!best || a.length > best.len)) best = { p, len: a.length };
    }
  }
  return best?.p || null;
}

export function findProject(query, registry) {
  const q = tokens(query).join(' ');
  return registry.find((p) => p.aliases.includes(q) || tokens(p.name).join(' ') === q)
    || registry.find((p) => p.aliases.some((a) => a.startsWith(q)))
    || detectProject(query, registry);
}

const LANG = {
  js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript',
  py: 'Python', ipynb: 'Python', cs: 'C#', swift: 'Swift', html: 'HTML', css: 'CSS', scss: 'CSS',
  json: 'Data', yaml: 'Data', yml: 'Data', toml: 'Data', csv: 'Data', md: 'Docs', txt: 'Docs',
  c: 'C/C++', h: 'C/C++', cpp: 'C/C++', hpp: 'C/C++', ino: 'C/C++', rs: 'Rust', go: 'Go', java: 'Java',
  sh: 'Shell', ps1: 'Shell', bat: 'Shell', sql: 'SQL', png: 'Assets', jpg: 'Assets', svg: 'Assets',
  ico: 'Assets', gif: 'Assets', wav: 'Assets', mp3: 'Assets', mp4: 'Assets', stl: 'CAD', step: 'CAD', '3mf': 'CAD',
};
export const langOf = (f) => LANG[path.extname(f).slice(1).toLowerCase()] || 'Other';

function git(dir, args) {
  try {
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 32 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return ''; }
}

function walk(dir, limit) {
  const files = [];
  (function rec(d, rel, depth) {
    if (files.length >= limit || depth > 8) return;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (files.length >= limit) return;
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) rec(path.join(d, e.name), r, depth + 1); }
      else files.push(r);
    }
  })(dir, '', 0);
  return files;
}

// Everything the HUD needs to draw one project.
export function scanProject(p, { maxFiles = 1500 } = {}) {
  const scan = {
    name: p.display || p.name, dir: p.dir || null, git: !!p.git,
    now: p.note?.now || '', note: p.note ? path.basename(p.note.file, '.md') : null,
    links: p.note?.links || [], files: [], languages: {}, commits: [], activity: [],
    branch: null, dirty: [], ahead: 0, truncated: false, scannedAt: Date.now(),
  };
  if (!p.dir) return scan;

  let list = p.git ? git(p.dir, ['ls-files', '-co', '--exclude-standard']).split('\n').filter(Boolean) : walk(p.dir, maxFiles + 1);
  list = list.filter((f) => !f.split('/').some((s) => SKIP_DIRS.has(s)));
  if (list.length > maxFiles) { scan.truncated = list.length; list = list.slice(0, maxFiles); }

  const heat = {};
  if (p.git) {
    let cur = null;
    for (const line of git(p.dir, ['log', '--since=90.days', '--name-only', '--pretty=format:@@%h\t%at\t%an\t%s']).split('\n')) {
      if (line.startsWith('@@')) {
        const [h, t, a, ...s] = line.slice(2).split('\t');
        cur = { hash: h, time: +t * 1000, author: a, subject: s.join('\t') };
        scan.commits.push(cur);
      } else if (line && cur) heat[line] = (heat[line] || 0) + 1;
    }
    if (!scan.commits.length) {
      for (const line of git(p.dir, ['log', '-n', '15', '--pretty=format:%h\t%at\t%an\t%s']).split('\n').filter(Boolean)) {
        const [h, t, a, ...s] = line.split('\t');
        scan.commits.push({ hash: h, time: +t * 1000, author: a, subject: s.join('\t') });
      }
    }
    const status = git(p.dir, ['status', '--porcelain=v1', '-b']).split('\n').filter(Boolean);
    const head = status.shift() || '';
    scan.branch = /^## (?:No commits yet on )?([^.\s]+)/.exec(head)?.[1] || null;
    scan.ahead = +(/ahead (\d+)/.exec(head)?.[1] || 0);
    scan.dirty = status.map((l) => l.slice(3).replace(/^"|"$/g, '').split(' -> ').pop())
      .filter((f) => !f.replace(/\/$/, '').split('/').some((s) => SKIP_DIRS.has(s)));
  }

  const days = 90;
  const dayMs = 86400000;
  const today = Math.floor(Date.now() / dayMs);
  scan.activity = Array(days).fill(0);
  for (const c of scan.commits) {
    const i = days - 1 - (today - Math.floor(c.time / dayMs));
    if (i >= 0 && i < days) scan.activity[i]++;
  }

  const dirty = new Set(scan.dirty);
  for (const f of list) {
    let size = 0;
    try { size = fs.statSync(path.join(p.dir, f)).size; } catch {}
    const lang = langOf(f);
    scan.languages[lang] = (scan.languages[lang] || 0) + size;
    scan.files.push({ path: f, size, lang, heat: heat[f] || 0, dirty: dirty.has(f) });
  }
  scan.commits = scan.commits.slice(0, 40);
  return scan;
}
