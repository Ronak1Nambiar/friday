// The project HUD, drawn in a terminal. It subscribes to the cockpit's local
// event stream, so it can live in its own window or tmux pane.
import http from 'node:http';
import { normalizeTheme } from './hudtheme.js';

// Colors come from the HUD theme (src/hudtheme.js); these are the default theme's.
let CYAN = [95, 225, 255];
let AMBER = [255, 176, 59];
let RED = [255, 95, 95];
let GREEN = [110, 231, 140];
let TEXT = [200, 230, 240];
let DIM = [93, 131, 153];
let LINE = [38, 92, 112];
let EDGE = [36, 96, 118];
let BG = null; // null: the terminal's own background
let BRIGHT = [235, 248, 255];
let THEME = normalizeTheme();
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
export function applyTheme(t) {
  THEME = normalizeTheme(t);
  const c = THEME.colors;
  [CYAN, AMBER, RED, GREEN, TEXT, DIM, LINE, BG] = [c.accent, c.warn, c.error, c.ok, c.text, c.dim, c.line, c.bg];
  EDGE = mix(LINE, CYAN, 0.1);
  BRIGHT = mix(TEXT, [255, 255, 255], 0.6);
  return THEME;
}
// Shades of the accent for the map's quiet parts (rings, sweep), from the theme.
const shade = (t) => mix(BG || [2, 6, 12], CYAN, t);
const LANG = {
  JavaScript: [247, 223, 30], TypeScript: [61, 143, 224], Python: [90, 159, 212], 'C#': [180, 111, 209],
  Swift: [240, 81, 56], HTML: [232, 102, 60], CSS: [138, 111, 209], Data: [143, 188, 187], Docs: [154, 169, 187],
  'C/C++': [101, 154, 210], Rust: [222, 165, 132], Go: [0, 173, 216], Java: [201, 138, 58], Shell: [137, 224, 81],
  SQL: [227, 140, 0], Assets: [95, 111, 132], CAD: [255, 127, 80], Other: [74, 90, 106],
};
const BOLD = 1;
const FAINT = 2;
const BLOCKS = ' ▁▂▃▄▅▆▇█';

// ---------------------------------------------------------------------------
// Screen: a cell grid that redraws only the rows that changed.
export class Screen {
  constructor(w, h) {
    this.w = w; this.h = h;
    this.ch = new Array(w * h).fill(' ');
    this.fg = new Array(w * h).fill(null);
    this.st = new Uint8Array(w * h);
  }
  put(x, y, s, fg = TEXT, st = 0) {
    if (y < 0 || y >= this.h) return x;
    for (const c of s) {
      if (x >= this.w) break;
      if (x >= 0) { const i = y * this.w + x; this.ch[i] = c; this.fg[i] = fg; this.st[i] = st; }
      x++;
    }
    return x;
  }
  segs(x, y, segs, max) {
    const end = x + max;
    for (const sg of segs) {
      const room = end - x;
      if (room <= 0) break;
      x = this.put(x, y, sg.t.length > room ? sg.t.slice(0, room) : sg.t, sg.fg || TEXT, sg.st || 0);
    }
    return x;
  }
  row(y, w = this.w) {
    let out = '', cur = '';
    for (let x = 0; x < w; x++) {
      const i = y * this.w + x;
      const f = this.fg[i] || TEXT, s = this.st[i];
      const sgr = `\x1b[0;${s & BOLD ? '1;' : ''}${s & FAINT ? '2;' : ''}${BG ? `48;2;${BG[0]};${BG[1]};${BG[2]};` : ''}38;2;${f[0]};${f[1]};${f[2]}m`;
      if (sgr !== cur) { out += sgr; cur = sgr; }
      out += this.ch[i];
    }
    return out + '\x1b[0m';
  }
}

// Braille canvas: each cell is 2x4 dots, so dots come out roughly square.
const DOT = [[0x01, 0x02, 0x04, 0x40], [0x08, 0x10, 0x20, 0x80]];
export class Canvas {
  constructor(cw, ch) {
    this.cw = cw; this.chh = ch; this.pw = cw * 2; this.ph = ch * 4;
    this.bits = new Uint8Array(cw * ch);
    this.col = new Array(cw * ch).fill(null);
    this.pri = new Float32Array(cw * ch).fill(-1);
    this.text = [];
  }
  set(x, y, color, pri = 1) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.pw || y >= this.ph) return;
    const i = (y >> 2) * this.cw + (x >> 1);
    this.bits[i] |= DOT[x & 1][y & 3];
    if (pri >= this.pri[i]) { this.pri[i] = pri; this.col[i] = color; }
  }
  line(x0, y0, x1, y1, color, pri, step = 1) {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let k = 0; k <= n; k += step) this.set(x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n, color, pri);
  }
  circle(cx, cy, r, color, pri, gap = 1, phase = 0) {
    const n = Math.max(12, Math.round(r * 2 * Math.PI));
    for (let k = 0; k < n; k++) {
      if (gap > 1 && Math.floor(k / gap) % 2) continue;
      const a = phase + k / n * Math.PI * 2;
      this.set(cx + Math.cos(a) * r, cy + Math.sin(a) * r, color, pri);
    }
  }
  label(px, py, s, fg, st = 0, align = 'left') {
    let x = Math.round(px / 2), y = Math.round(py / 4);
    if (align === 'right') x -= s.length;
    if (align === 'center') x -= Math.floor(s.length / 2);
    this.text.push({ x, y, s, fg, st });
  }
  blit(scr, ox, oy) {
    for (let y = 0; y < this.chh; y++) {
      for (let x = 0; x < this.cw; x++) {
        const i = y * this.cw + x;
        if (this.bits[i]) scr.put(ox + x, oy + y, String.fromCharCode(0x2800 + this.bits[i]), this.col[i] || EDGE);
      }
    }
    for (const t of this.text) {
      const x = Math.max(0, Math.min(this.cw - t.s.length, t.x));
      if (t.y >= 0 && t.y < this.chh) scr.put(ox + x, oy + t.y, t.s.slice(0, this.cw), t.fg, t.st);
    }
  }
}

// ---------------------------------------------------------------------------
function ago(t) {
  const s = (Date.now() - t) / 1000;
  return s < 60 ? 'now' : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}

// Markdown line -> styled segments.
export function mdSegs(line, base = TEXT) {
  const segs = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`|\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
  let last = 0, m;
  while ((m = re.exec(line))) {
    if (m.index > last) segs.push({ t: line.slice(last, m.index), fg: base });
    if (m[1]) segs.push({ t: m[1], fg: BRIGHT, st: BOLD });
    else if (m[2]) segs.push({ t: m[2], fg: CYAN });
    else segs.push({ t: m[4] || m[3], fg: AMBER });
    last = re.lastIndex;
  }
  if (last < line.length) segs.push({ t: line.slice(last), fg: base });
  return segs;
}

// Word-wrap styled segments to a width; `indent` pads continuation lines.
export function wrap(segs, width, indent = '') {
  const lines = [[]];
  let w = 0;
  const words = [];
  for (const sg of segs) for (const part of sg.t.split(/(\s+)/)) if (part) words.push({ ...sg, t: part });
  for (const wd of words) {
    if (/^\s+$/.test(wd.t)) {
      if (w && w < width) { lines.at(-1).push({ ...wd, t: ' ' }); w++; }
      continue;
    }
    let t = wd.t;
    while (t.length) {
      if (w + t.length > width && w > indent.length) {
        const prevLine = lines.at(-1);
        if (prevLine.at(-1)?.t === ' ') prevLine.pop();
        lines.push(indent ? [{ t: indent }] : []); w = indent.length;
      }
      const take = Math.min(t.length, width - w);
      lines.at(-1).push({ ...wd, t: t.slice(0, take) });
      w += take; t = t.slice(take);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
export function runTermHud({ port, host = '127.0.0.1' }) {
  const out = (s) => process.stdout.write(s);
  let S = { agents: [], project: null, projects: [], feed: [], mode: 'edit', active: null, cwd: '', usage: {} };
  let linked = false;
  let tree = null;
  let view = { x: 0, y: 0, k: 1 };
  let liveAgent = null, liveText = '';
  const pings = [];
  const touched = new Map();
  let prev = [];
  let dirty = true;

  // --- data link ---
  function connect() {
    const req = http.get({ host, port, path: '/events' }, (res) => {
      linked = true; dirty = true;
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => {
        buf += d;
        let k;
        while ((k = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, k); buf = buf.slice(k + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (ev && data) { try { onEvent(ev, JSON.parse(data)); } catch {} }
        }
      });
      res.on('end', drop);
    });
    req.on('error', drop);
  }
  let retry = null;
  function drop() {
    linked = false; dirty = true;
    clearTimeout(retry);
    retry = setTimeout(connect, 1500);
  }
  // A new theme repaints every cell (the background may have changed too).
  function retheme(t) { applyTheme(t); prev = []; out(`\x1b[0m${BG ? `\x1b[48;2;${BG.join(';')}m` : ''}\x1b[2J`); }
  function onEvent(type, d) {
    dirty = true;
    if (type === 'state') { S = { usage: {}, ...d }; retheme(d.theme); build(true); return; }
    if (type === 'patch') {
      const changed = 'project' in d && (d.project?.dir !== S.project?.dir || d.project?.name !== S.project?.name);
      Object.assign(S, d);
      if ('theme' in d) retheme(d.theme);
      if ('project' in d) build(changed);
    } else if (type === 'feed') { S.feed.push(d); if (S.feed.length > 80) S.feed.shift(); }
    else if (type === 'say') {
      if (d.agent !== liveAgent) { liveAgent = d.agent; liveText = ''; }
      liveText = (liveText + d.text).slice(-6000);
    } else if (type === 'turn' && d.phase === 'start') { liveAgent = d.agent; liveText = ''; }
    else if (type === 'touch') {
      const col = agentColor(d.agent);
      for (const p of d.paths || []) {
        const n = resolve(p);
        if (!n) continue;
        pings.push({ path: n.path, agent: d.agent, color: col, t: Date.now(), label: d.label });
        touched.set(n.path, col);
      }
      S.feed.push({ kind: 'tool', agent: d.agent, text: d.label, t: Date.now() });
      if (S.feed.length > 80) S.feed.shift();
    }
  }
  const agentColor = (id) => S.agents.find((a) => a.id === id)?.color || CYAN;

  // --- project tree, laid out radially in unit space ---
  function build(resetView) {
    const p = S.project;
    tree = null;
    if (resetView) { view = { x: 0, y: 0, k: 1 }; touched.clear(); }
    if (!p) return;
    const root = { name: p.name, path: '', dir: true, children: [], depth: 0 };
    const byPath = new Map([['', root]]);
    const files = p.files?.length ? p.files : (p.links || []).map((l) => ({ path: l, lang: 'Docs', size: 400 }));
    for (const f of files) {
      const parts = f.path.split('/');
      let cur = root;
      for (let i = 0; i < parts.length; i++) {
        const sub = parts.slice(0, i + 1).join('/');
        let n = byPath.get(sub);
        if (!n) {
          const leaf = i === parts.length - 1;
          n = { name: parts[i], path: sub, dir: !leaf, children: [], depth: i + 1, parent: cur };
          if (leaf) Object.assign(n, f);
          n.path = sub;
          cur.children.push(n); byPath.set(sub, n);
        }
        cur = n;
      }
    }
    (function count(n) { n.leaves = n.children.length ? n.children.reduce((a, c) => a + count(c), 0) : 1; return n.leaves; })(root);
    (function sort(n) { n.children.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name)); n.children.forEach(sort); })(root);
    const nodes = [...byPath.values()];
    const maxDepth = Math.max(1, ...nodes.map((n) => n.depth));
    (function place(n, a0, a1) {
      n.a = (a0 + a1) / 2;
      n.r = n.depth ? Math.pow(n.depth / maxDepth, 0.75) : 0;
      let a = a0;
      for (const c of n.children) { const span = (a1 - a0) * c.leaves / n.leaves; place(c, a, a + span); a += span; }
    })(root, -Math.PI / 2, Math.PI * 1.5);
    tree = { root, byPath, nodes, maxDepth, maxHeat: Math.max(1, ...nodes.map((n) => n.heat || 0)) };
  }
  function resolve(p) {
    if (!tree) return null;
    let rel = p;
    if (S.project?.dir && rel.startsWith(S.project.dir)) rel = rel.slice(S.project.dir.length + 1);
    rel = rel.replace(/\\/g, '/').replace(/^\.\//, '');
    while (rel && !tree.byPath.has(rel)) rel = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    return tree.byPath.get(rel) || tree.root;
  }

  // --- panels ---
  function box(scr, x, y, w, h, title, note = '') {
    if (w < 4 || h < 2) return;
    scr.put(x, y, '┌' + '─'.repeat(w - 2) + '┐', LINE);
    for (let i = 1; i < h - 1; i++) { scr.put(x, y + i, '│', LINE); scr.put(x + w - 1, y + i, '│', LINE); }
    scr.put(x, y + h - 1, '└' + '─'.repeat(w - 2) + '┘', LINE);
    scr.put(x + w - 2, y + h - 1, '◢', LINE);
    let cx = scr.put(x + 2, y, ' ▸ ', AMBER);
    cx = scr.put(cx, y, title.toUpperCase().split('').join(' '), CYAN, BOLD);
    scr.put(cx, y, ' ', LINE);
    const room = x + w - 2 - (cx + 2);
    if (note && room > 4) {
      const n = note.length + 2 > room ? note.slice(0, room - 3) + '…' : note;
      scr.put(x + w - 2 - n.length - 2, y, ` ${n} `, DIM);
    }
  }
  function lines(scr, x, y, w, h, ls) {
    ls.slice(0, Math.max(0, h)).forEach((l, i) => scr.segs(x, y + i, l, w));
  }

  function directive(w) {
    const p = S.project;
    const now = (p?.now || '').split('\n').filter((l) => l.trim());
    if (!now.length) return [[{ t: p ? 'No vault note for this project.' : 'No project in focus.', fg: DIM }]];
    const ls = [];
    for (const l of now) ls.push(...wrap([{ t: '• ', fg: AMBER }, ...mdSegs(l.replace(/^\s*[-*]\s+/, ''), mix(TEXT, DIM, 0.25))], w, '  '));
    return ls;
  }
  function telemetry(w) {
    const p = S.project;
    if (!p) return [];
    const c90 = (p.activity || []).reduce((a, b) => a + b, 0);
    const last = p.commits?.[0];
    const half = Math.floor(w / 2);
    const cell = (v, k, col = CYAN) => [{ t: String(v).padEnd(5) + ' ', fg: col, st: BOLD }, { t: k.slice(0, half - 6).padEnd(half - 6), fg: DIM }];
    const dirtyCol = p.dirty?.length ? AMBER : CYAN;
    return [
      [...cell(p.files.length + (p.truncated ? '+' : ''), 'files'), ...cell(c90, w < 34 ? 'commits' : 'commits 90d')],
      [...cell(p.dirty?.length || 0, w < 34 ? 'dirty' : 'uncommitted', dirtyCol), ...cell(last ? ago(last.time) : '-', w < 34 ? 'last' : 'last commit')],
      [{ t: 'branch ', fg: DIM }, { t: p.branch || '-', fg: CYAN }, { t: p.ahead ? `  ↑${p.ahead} unpushed` : '', fg: AMBER }],
    ];
  }
  function composition(w) {
    const langs = Object.entries(S.project?.languages || {}).filter(([k, v]) => v && !['Assets', 'CAD', 'Other'].includes(k))
      .sort((a, b) => b[1] - a[1]).slice(0, 8);
    const tot = langs.reduce((a, [, v]) => a + v, 0) || 1;
    const bw = Math.max(4, w - 17);
    return langs.map(([k, v]) => {
      const f = v / tot * bw, full = Math.floor(f), rest = Math.round((f - full) * 8);
      const bar = '█'.repeat(full) + (rest ? '▏▎▍▌▋▊▉█'[rest - 1] : '');
      return [{ t: k.slice(0, 10).padEnd(11), fg: TEXT }, { t: bar.padEnd(bw), fg: LANG[k] || LANG.Other },
        { t: `${Math.round(v / tot * 100)}%`.padStart(5), fg: DIM }];
    });
  }
  function agentsPanel(w, compact = false) {
    const ls = [];
    for (const a of S.agents) {
      const u = S.usage?.[a.id];
      const working = a.status === 'working';
      const blink = working && Math.floor(Date.now() / 400) % 2;
      const st = !a.installed ? 'offline' : working ? 'working' : a.status === 'error' ? 'error' : 'standby';
      const stc = st === 'working' ? AMBER : st === 'error' ? RED : DIM;
      const name = a.id.toUpperCase() + (a.id === S.active ? ' ◂' : '');
      if (compact) {
        ls.push([{ t: blink ? '◉ ' : '● ', fg: a.installed ? a.color : DIM }, { t: name.padEnd(11), fg: a.installed ? TEXT : DIM, st: BOLD },
          { t: st.padEnd(8), fg: stc }, { t: usageLine(a, u).replace(/^\d+ turns? · /, '').slice(0, Math.max(0, w - 21)), fg: DIM }]);
        continue;
      }
      ls.push([{ t: blink ? '◉ ' : '● ', fg: a.installed ? a.color : DIM }, { t: name.padEnd(w - 10), fg: a.installed ? TEXT : DIM, st: BOLD },
        { t: st.padStart(8), fg: stc }]);
      ls.push([{ t: '  ' + usageLine(a, u).slice(0, w - 2), fg: DIM }]);
    }
    return ls;
  }
  function usageLine(a, u) {
    if (!a.installed) return 'not installed';
    if (!u || !u.turns) return a.id === 'ollama' ? 'local · free' : 'no turns yet';
    const n = `${u.turns} turn${u.turns > 1 ? 's' : ''}`;
    if (u.billing === 'api') return `${n} · $${u.cost.toFixed(2)} billed`;
    if (u.billing === 'local') return `${n} · local · free`;
    if (u.billing === 'plan') {
      const l = u.limits;
      return `${n} · plan${l?.five_hour != null ? ` ${Math.round(l.five_hour * 100)}% 5h` : ''}${l?.seven_day != null ? ` ${Math.round(l.seven_day * 100)}% wk` : ''} · $0`;
    }
    return `${n}${u.cost ? ` · $${u.cost.toFixed(2)}` : ' · $0'}`;
  }
  function activity(w) {
    const a = S.project?.activity || [];
    if (!a.length) return [];
    const per = Math.ceil(a.length / w);
    const buckets = [];
    for (let i = 0; i < a.length; i += per) buckets.push(a.slice(i, i + per).reduce((x, y) => x + y, 0));
    const max = Math.max(1, ...buckets);
    const two = buckets.map((v) => Math.round(v / max * 16));
    return [
      [{ t: two.map((v) => (v > 8 ? BLOCKS[v - 8] : ' ')).join(''), fg: CYAN }],
      [{ t: two.map((v) => (v ? BLOCKS[Math.min(8, v)] : '▁')).join(''), fg: CYAN }],
      [{ t: '90d ago'.padEnd(w - 5) + 'today', fg: DIM }],
    ];
  }
  function commits(w) {
    return (S.project?.commits || []).slice(0, 30).map((c) => [
      { t: c.hash.slice(0, 7) + ' ', fg: AMBER }, { t: c.subject.slice(0, w - 13).padEnd(w - 12), fg: TEXT }, { t: ago(c.time).padStart(4), fg: DIM }]);
  }
  function feedLines(w, h) {
    const ls = [];
    for (const f of S.feed.slice(-40)) {
      const col = f.agent === 'council' ? CYAN : agentColor(f.agent);
      const who = f.kind === 'user' ? [{ t: `you → ${f.agent} `, fg: DIM, st: BOLD }] : [{ t: `${f.agent} `, fg: col, st: BOLD }];
      const body = f.kind === 'tool' ? [{ t: '⎿ ' + f.text, fg: DIM }] : [{ t: f.text.replace(/\s+/g, ' '), fg: f.kind === 'user' ? DIM : TEXT }];
      ls.push(...wrap([...who, ...body], w, '  ').slice(0, f.kind === 'agent' ? 4 : 2));
    }
    return ls.slice(-h);
  }
  function liveLines(w, h) {
    const ls = [];
    for (const para of liveText.split('\n')) ls.push(...(para.trim() ? wrap(mdSegs(para, mix(TEXT, DIM, 0.25)), w) : [[]]));
    return ls.slice(-h);
  }

  // --- the map ---
  function drawMap(scr, x, y, w, h) {
    const cv = new Canvas(w, h);
    const now = Date.now(), t = now / 1000;
    const cx = cv.pw / 2, cy = cv.ph / 2;
    const OR = Math.min(cv.pw, cv.ph) / 2 - 3;
    const R = OR - 10;
    // reactor rings and radar sweep
    if (THEME.map.rings) {
      cv.circle(cx, cy, OR, shade(0.4), 0, 3, t * 0.05);
      cv.circle(cx, cy, OR - 3, mix(BG || [2, 6, 12], AMBER, 0.25), 0, 9, -t * 0.08);
    }
    const sw = t * 0.6;
    if (THEME.map.sweep) cv.line(cx, cy, cx + Math.cos(sw) * (OR - 5), cy + Math.sin(sw) * (OR - 5), shade(0.3), 0.5, 2);

    const sx = (n) => cx + (Math.cos(n.a) * n.r * R + view.x) * view.k;
    const sy = (n) => cy + (Math.sin(n.a) * n.r * R + view.y) * view.k;

    if (!tree) {
      for (let i = 0; i < 3; i++) cv.circle(cx, cy, 6 + i * 6, mix(CYAN, shade(0.15), i * 0.3), 2, 3 + i, t * (i % 2 ? -0.8 : 0.6));
      cv.label(cx, cy, '◉', CYAN, BOLD, 'center');
      const ly = Math.min(cy + 30, cv.ph - 10);
      cv.label(cx, ly, linked ? 'STANDING BY' : 'NO LINK TO COCKPIT', linked ? CYAN : RED, BOLD, 'center');
      cv.label(cx, ly + 4, linked ? 'mention a project in the cockpit' : `waiting for 127.0.0.1:${port}`, DIM, 0, 'center');
    } else {
      const { root, nodes, maxDepth, maxHeat } = tree;
      for (let d = 1; d <= maxDepth; d++) cv.circle(cx + view.x * view.k, cy + view.y * view.k, Math.pow(d / maxDepth, 0.75) * R * view.k, shade(0.2), 0.2, 2);
      for (const n of nodes) if (n.parent) cv.line(sx(n.parent), sy(n.parent), sx(n), sy(n), EDGE, 1);
      for (const n of nodes) {
        if (n.dir) continue;
        const px = sx(n), py = sy(n);
        let col = LANG[n.lang] || LANG.Other, pri = 3;
        if (n.heat) { col = mix(col, AMBER, 0.3 + 0.5 * n.heat / maxHeat); pri = 4; }
        if (n.dirty) { col = RED; pri = 5; }
        const tc = touched.get(n.path);
        if (tc) { col = tc; pri = 6; }
        cv.set(px, py, col, pri);
        if ((n.size || 0) > 20000 || n.heat || tc) { cv.set(px + 1, py, col, pri); cv.set(px, py + 1, col, pri); cv.set(px + 1, py + 1, col, pri); }
      }
      for (const n of root.children) {
        if (!n.dir) continue;
        const right = Math.cos(n.a) >= 0;
        cv.label(sx(n) + (right ? 3 : -3), sy(n), n.name.toUpperCase(), TEXT, 0, right ? 'left' : 'right');
      }
      cv.label(cx + view.x * view.k, cy + view.y * view.k, '◉', CYAN, BOLD, 'center');
    }

    // agents orbit the outer ring
    const sats = {};
    const list = S.agents.filter((a) => a.installed);
    list.forEach((a, i) => {
      const ang = i / list.length * Math.PI * 2 + t * 0.04 - Math.PI / 2;
      const px = cx + Math.cos(ang) * OR, py = cy + Math.sin(ang) * OR;
      sats[a.id] = { px, py };
      const working = a.status === 'working';
      for (let r = 1; r <= (working ? 3 : 1); r++) cv.circle(px, py, r + (working ? (t * 4) % 2 : 0), a.color, 7);
      cv.label(px, py + (Math.sin(ang) > 0 ? 6 : -6), a.id.toUpperCase(), a.color, BOLD, 'center');
    });

    // pings: beam from the agent to the file, ripple, label
    let li = 0;
    for (let i = pings.length - 1; i >= 0; i--) {
      const p = pings[i], age = (now - p.t) / 1000;
      if (age > 4) { pings.splice(i, 1); continue; }
      const n = tree?.byPath.get(p.path);
      if (!n) continue;
      const px = sx(n), py = sy(n);
      const s = sats[p.agent];
      if (s && age < 1.8) cv.line(s.px, s.py, px, py, p.color, 8, 2);
      cv.circle(px, py, 2 + (age * 6) % 8, p.color, 8, 2);
      if (age < 3 && li < 4) {
        cv.label(px + 4, py - 4 - li * 4, p.label.slice(0, 48), p.color, BOLD);
        li++;
      }
    }
    cv.blit(scr, x, y);
  }

  // --- frame ---
  function frame() {
    const W = process.stdout.columns || 120, H = process.stdout.rows || 40;
    const scr = new Screen(W, H);
    const p = S.project;

    // top bar
    const T = THEME;
    const logo = T.title.length <= 14 ? T.title.split('').join(' ') : T.title;
    const lx = scr.put(1, 0, logo, CYAN, BOLD);
    scr.put(lx + 2, 0, T.subtitle, DIM);
    const on = T.panels;
    const title = p ? p.name.toUpperCase() : 'STANDING BY';
    const meta = p ? `${p.dir || 'vault note only'}${p.branch ? `  ⎇ ${p.branch}` : ''}` : '';
    const mid = Math.floor(W / 2);
    if (W > 90) {
      scr.put(mid - Math.floor(title.length / 2), 0, title, BRIGHT, BOLD);
      scr.put(Math.max(40, mid - Math.floor(meta.length / 2)), 1, meta.slice(0, W - 40), DIM);
    }
    const clock = new Date().toLocaleTimeString([], { hour12: false });
    const status = `${linked ? '●' : '○'} ${linked ? 'linked' : 'offline'} · ${S.mode} · ${clock}`;
    scr.put(W - status.length - 1, 0, status, linked ? GREEN : RED);
    if (W <= 90) scr.put(1, 1, (title + '  ' + meta).slice(0, W - 2), TEXT);

    const top = 2;
    const commsH = on.comms ? Math.max(7, Math.min(14, Math.floor(H * 0.27))) : 0;
    const midH = H - top - commsH - 1;
    const rightOn = on.agents || on.activity || on.commits;
    const rightW = W >= 140 && rightOn ? Math.min(38, Math.floor(W * 0.22)) : 0;
    const leftOn = on.directive || on.telemetry || on.composition || (on.agents && !rightW);
    const leftW = W >= 110 && leftOn ? Math.min(40, Math.max(32, Math.floor(W * 0.24))) : 0;
    const mapX = leftW, mapW = W - leftW - rightW;

    function agentsH() { return S.agents.length * 2 + 2; }
    if (leftW) {
      // The first panel (Directive, when on) takes what is left; the others drop out
      // when space runs short.
      const w = leftW - 4;
      const stack = [];
      if (on.agents && !rightW) stack.push({ title: 'Agents', h: S.agents.length + 2, body: () => agentsPanel(w, true) });
      if (on.telemetry) stack.push({ title: 'Telemetry', h: 5, body: () => telemetry(w) });
      if (on.composition) stack.push({ title: 'Composition', h: Math.min(10, Math.max(4, composition(w).length + 2)), body: () => composition(w) });
      const first = on.directive ? { title: 'Directive', note: p?.note || '', body: () => directive(w) } : stack.pop();
      const MIN_FIRST = 6;
      while (stack.length && midH - stack.reduce((a, s) => a + s.h, 0) < MIN_FIRST) stack.pop();
      const dH = midH - stack.reduce((a, s) => a + s.h, 0);
      box(scr, 0, top, leftW, dH, first.title, first.note || '');
      lines(scr, 2, top + 1, w, dH - 2, first.body());
      let y = top + dH;
      for (const s of stack.reverse()) {
        box(scr, 0, y, leftW, s.h, s.title);
        lines(scr, 2, y + 1, w, s.h - 2, s.body());
        y += s.h;
      }
    }

    box(scr, mapX, top, mapW, midH, 'Map', p ? `${p.files?.length || 0} files` : '');
    drawMap(scr, mapX + 1, top + 1, mapW - 2, midH - 2);
    if (p && mapW > 60) {
      const langs = Object.entries(p.languages || {}).filter(([, v]) => v).sort((a, b) => b[1] - a[1]).slice(0, 6);
      let lx = mapX + 2;
      for (const [k] of langs) { lx = scr.put(lx, top + midH - 2, '● ', LANG[k] || LANG.Other); lx = scr.put(lx, top + midH - 2, k + '  ', DIM); }
    }

    if (rightW) {
      // Agents and Activity keep their size; Commits (or the last one on) takes the rest.
      const col = [];
      if (on.agents) col.push({ title: 'Agents', note: 'usage', h: agentsH(), body: (w) => agentsPanel(w) });
      if (on.activity) col.push({ title: 'Activity', h: 5, body: (w) => activity(w) });
      if (on.commits) col.push({ title: 'Commits', h: 0, body: (w) => commits(w) });
      col.at(-1).h = Math.max(3, midH - col.slice(0, -1).reduce((a, s) => a + s.h, 0));
      let y = top;
      for (const s of col) {
        const h = Math.min(s.h, top + midH - y);
        if (h < 3) break;
        box(scr, W - rightW, y, rightW, h, s.title, s.note || '');
        lines(scr, W - rightW + 2, y + 1, rightW - 4, h - 2, s.body(rightW - 4));
        y += h;
      }
    }

    // comms
    if (commsH) {
      const cy = top + midH;
      const half = Math.floor(W / 2);
      box(scr, 0, cy, half, commsH, 'Comms');
      lines(scr, 2, cy + 1, half - 4, commsH - 2, feedLines(half - 4, commsH - 2));
      box(scr, half, cy, W - half, commsH, 'Live', liveAgent ? `${liveAgent} transmitting` : '');
      lines(scr, half + 2, cy + 1, W - half - 4, commsH - 2, liveLines(W - half - 4, commsH - 2));
    }
    scr.put(1, H - 1, 'q quit · [ ] switch project · + - zoom · arrows pan · 0 reset · w web view', DIM);

    // Only rewrite rows that changed. The bottom-right cell is never written: some
    // Windows consoles scroll the whole screen up a line when it is.
    let buf = '';
    for (let yy = 0; yy < H; yy++) {
      const r = scr.row(yy, yy === H - 1 ? W - 1 : W);
      if (prev[yy] !== r) { buf += `\x1b[${yy + 1};1H` + r; prev[yy] = r; }
    }
    prev.length = H;
    if (buf) out(buf);
  }

  // --- input ---
  function send(command) {
    const body = JSON.stringify({ command });
    const req = http.request({ host, port, path: '/api/command', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } });
    req.on('error', () => {});
    req.end(body);
  }
  function cycle(dir) {
    const list = S.projects || [];
    if (!list.length) return;
    const i = list.findIndex((x) => x.name === S.project?.name);
    send('/project ' + list[(i + dir + list.length) % list.length].name);
  }
  function quit() {
    out('\x1b[?1049l\x1b[?25h\x1b[0m');
    process.exit(0);
  }
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (k) => {
    if (k === 'q' || k === '\x03') return quit();
    if (k === ']') cycle(1);
    else if (k === '[') cycle(-1);
    else if (k === '+' || k === '=') view.k = Math.min(6, view.k * 1.25);
    else if (k === '-') view.k = Math.max(0.5, view.k / 1.25);
    else if (k === '0') view = { x: 0, y: 0, k: 1 };
    else if (k === '\x1b[A') view.y += 8 / view.k;
    else if (k === '\x1b[B') view.y -= 8 / view.k;
    else if (k === '\x1b[C') view.x -= 8 / view.k;
    else if (k === '\x1b[D') view.x += 8 / view.k;
    else if (k === 'w') send('/hud web');
    dirty = true;
  });
  process.stdout.on('resize', () => { prev = []; out('\x1b[2J'); dirty = true; });
  process.on('SIGTERM', quit);

  out('\x1b[?1049h\x1b[?25l\x1b[2J');
  connect();
  // Animate faster while something is happening, idle slowly otherwise.
  let lastFrame = 0;
  setInterval(() => {
    const busy = pings.length || S.agents.some((a) => a.status === 'working');
    const gap = busy ? 100 : 400;
    if (dirty || Date.now() - lastFrame >= gap) { dirty = false; lastFrame = Date.now(); frame(); }
  }, 50);
}
