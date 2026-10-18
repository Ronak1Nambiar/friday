// Slash-command suggestions under the prompt as you type, the way Claude Code shows them:
// "/br" lists /brain (and anything else that matches) with what it does. ↑↓ choose, Tab
// completes, Enter runs the highlighted command, Esc hides the list.
import { CYAN, dim, paint } from './render.js';

// HELP rows (['/hud [web]', 'what it does']) and plain command names -> one entry per
// command: { cmd, args, desc }. The first row for a command wins.
export function commandCatalog(help, extra = []) {
  const seen = new Map();
  for (const [k, desc] of help) {
    const [cmd, ...rest] = k.split(' ');
    if (!cmd.startsWith('/') || seen.has(cmd)) continue;
    seen.set(cmd, { cmd, args: rest.join(' '), desc: String(desc || '') });
  }
  for (const e of extra) {
    const x = typeof e === 'string' ? { cmd: e, args: '', desc: '' } : e;
    if (!seen.has(x.cmd)) seen.set(x.cmd, { args: '', desc: '', ...x });
  }
  return [...seen.values()];
}

// The commands that fit what is typed: only while the line is "/" plus a command name
// (no space yet). Prefix matches first, then names that contain it.
export function matchCommands(line, catalog, max = 8) {
  if (!/^\/[\w-]*$/.test(line)) return [];
  const q = line.toLowerCase();
  const pre = catalog.filter((c) => c.cmd.toLowerCase().startsWith(q));
  const mid = q.length > 2 ? catalog.filter((c) => !pre.includes(c) && c.cmd.toLowerCase().includes(q.slice(1))) : [];
  const hits = [...pre, ...mid];
  // An exact, complete command needs no list.
  if (hits.length === 1 && hits[0].cmd.toLowerCase() === q) return [];
  return hits.slice(0, max);
}

// Lines to draw under the prompt.
export function suggestLines(hits, sel, width = 100) {
  const name = Math.min(22, Math.max(...hits.map((h) => (h.cmd + (h.args ? ` ${h.args}` : '')).length)) + 2);
  return hits.map((h, i) => {
    const left = (h.cmd + (h.args ? ` ${h.args}` : '')).slice(0, name).padEnd(name);
    const room = Math.max(0, width - name - 6);
    const desc = h.desc.length > room ? h.desc.slice(0, Math.max(0, room - 1)) + '…' : h.desc;
    return i === sel ? `  ${paint(CYAN, '❯')} ${paint(CYAN, left)} ${dim(desc)}` : `    ${left} ${dim(desc)}`;
  });
}

// Drawn below the readline prompt without moving it: the lines go under the cursor's row
// and the cursor comes back to where it was (relative moves, so a scroll at the bottom of
// the screen is fine).
export function createSuggester({ write, catalog, width = () => process.stdout.columns || 100 }) {
  let hits = [];
  let sel = 0;
  let shown = 0;
  let hiddenFor = null; // Esc hides the list until the line changes
  const clear = () => {
    if (!shown) return;
    // Save, jump to the far right of this row, clear from there down, restore.
    write('\x1b7\x1b[999C\x1b[J\x1b8');
    shown = 0;
  };
  const draw = (col) => {
    clear();
    if (!hits.length) return;
    const lines = suggestLines(hits, sel, width());
    write('\r\n' + lines.map((l) => `\r\x1b[2K${l}`).join('\r\n') + `\x1b[${lines.length}A\r` + (col ? `\x1b[${col}C` : ''));
    shown = lines.length;
  };
  return {
    get visible() { return hits.length > 0; },
    get selected() { return hits[sel] || null; },
    update(line, col) {
      if (hiddenFor !== null && line !== hiddenFor) hiddenFor = null;
      const next = hiddenFor === null ? matchCommands(line, catalog()) : [];
      const same = next.length === hits.length && next.every((h, i) => h === hits[i]);
      if (!same) sel = 0;
      hits = next;
      draw(col);
    },
    move(d, col) { if (hits.length) { sel = (sel + d + hits.length) % hits.length; draw(col); } },
    hide(line) { hiddenFor = line; hits = []; clear(); },
    clear() { hits = []; clear(); },
  };
}
