// The queue box: while agents work, an input box stays pinned to the bottom of the
// terminal (like Claude Code's) and answers stream above it. What the user types there
// is queued and runs, in order, when the current work is done.
//
// The box lives below a scroll region (DECSTBM): output scrolls in rows 1..H-h and
// never touches the box, so a half-written line of a streaming answer is safe.
import { CYAN, c, dim, paint } from './render.js';

const MAX_SHOWN = 3; // queued messages listed above the box; the rest are counted

// The box as lines of styled text, no wider than `width`.
export function boxLines({ text = '', cursor = text.length, queued = [], width = 80, hint = '' }) {
  const w = Math.max(20, width - 1); // never the last column: some terminals wrap there
  const inner = w - 4; // "│ ❯ " ... "│" -> 2 borders, prompt 2, spaces
  const lines = [];
  const shown = queued.slice(-MAX_SHOWN);
  if (queued.length > shown.length) lines.push(dim(`  … ${queued.length - shown.length} more queued`));
  for (const q of shown) lines.push(`  ${paint(CYAN, '◦')} ${dim(clip(oneLine(q), w - 5))}`);
  // One visible line; a long message scrolls so the cursor stays in view.
  const flat = oneLine(text, '⏎');
  const room = inner - 2;
  const at = oneLine(text.slice(0, cursor), '⏎').length;
  const start = Math.max(0, Math.min(at - room + 1, flat.length - room + 1));
  const view = flat.slice(start, start + room);
  const cur = at - start;
  const body = view.slice(0, cur) + c.reset + inverse(view[cur] || ' ') + view.slice(cur + 1);
  const pad = ' '.repeat(Math.max(0, room - Math.max(view.length, cur + 1)));
  const edge = (s) => dim(s);
  lines.push(edge('╭' + '─'.repeat(w - 2) + '╮'));
  lines.push(`${edge('│')} ${paint(CYAN, '❯')} ${body}${pad} ${edge('│')}`);
  const h = hint ? ` ${clip(hint, w - 6)} ` : '';
  lines.push(edge('╰─' + h + '─'.repeat(Math.max(0, w - 3 - h.length)) + '╯'));
  return lines;
}

const oneLine = (s, nl = ' ') => String(s).replace(/\r?\n/g, nl).replace(/\t/g, ' ');
const clip = (s, n) => (s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s);
const inverse = (ch) => (c.reset ? `\x1b[7m${ch}\x1b[27m` : ch);

// Text editing on one keypress. Returns the new { text, cursor } or null when the key
// is not an edit.
export function edit({ text, cursor }, s, key = {}) {
  const k = key.name;
  if (key.ctrl && k === 'u') return { text: text.slice(cursor), cursor: 0 };
  if (key.ctrl && k === 'w') {
    const left = text.slice(0, cursor).replace(/\S+\s*$/, '');
    return { text: left + text.slice(cursor), cursor: left.length };
  }
  if ((key.ctrl && k === 'a') || k === 'home') return { text, cursor: 0 };
  if ((key.ctrl && k === 'e') || k === 'end') return { text, cursor: text.length };
  if (k === 'left') return { text, cursor: Math.max(0, cursor - 1) };
  if (k === 'right') return { text, cursor: Math.min(text.length, cursor + 1) };
  if (k === 'backspace') return cursor ? { text: text.slice(0, cursor - 1) + text.slice(cursor), cursor: cursor - 1 } : { text, cursor };
  if (k === 'delete') return { text: text.slice(0, cursor) + text.slice(cursor + 1), cursor };
  if (key.ctrl || key.meta || !s || /[\x00-\x1f\x7f]/.test(s)) return null;
  return { text: text.slice(0, cursor) + s + text.slice(cursor), cursor: cursor + s.length };
}

// The live box. `queued()` lists what is waiting; `submit(text)` queues a message;
// `interrupt()` stops the running work; `sigint()` is Ctrl+C.
// `status()`: a short mode line for the hint (e.g. "⏵⏵ bypass permissions").
export function createQueueBox({ write, size = () => ({ rows: process.stdout.rows || 24, cols: process.stdout.columns || 80 }), queued, submit, interrupt, sigint, takeLast, status = () => '' }) {
  let open = false;
  let text = '';
  let cursor = 0;
  let height = 0;
  let rows = 0;
  let pendingEnter = null; // an Enter that may be part of a paste
  const hint = () => {
    const base = text ? 'enter queue · esc clear' : `type to queue the next message · ${queued().length ? '↑ edit last queued · ' : ''}esc interrupt`;
    const s = status();
    return s ? `${s} (shift+tab) · ${base}` : base;
  };

  function draw() {
    if (!open) return;
    const { rows: R, cols } = size();
    const lines = boxLines({ text, cursor, queued: queued(), width: cols, hint: hint() });
    if (R !== rows) { rows = R; region(lines.length, true); }
    else if (lines.length !== height) region(lines.length);
    let s = '\x1b7';
    for (let i = 0; i < height; i++) s += `\x1b[${rows - height + 1 + i};1H\x1b[2K${lines[i] ?? ''}`;
    write(s + '\x1b8');
  }
  // Fit the scroll region above a box of `h` rows. Growing scrolls the output up
  // first, so nothing printed is covered. After a resize the region is just set again.
  function region(h, resized = false) {
    const grow = resized ? 0 : Math.max(0, h - height);
    let s = '\x1b7';
    if (grow) s += `\x1b[${rows - height};1H` + '\n'.repeat(grow);
    s += `\x1b[1;${Math.max(1, rows - h)}r\x1b8`;
    if (grow) s += `\x1b[${grow}A`;
    height = h;
    write(s);
  }

  return {
    get isOpen() { return open; },
    get text() { return text; },
    open() {
      if (open) return;
      open = true;
      rows = size().rows;
      const h = boxLines({ text, cursor, queued: queued(), width: size().cols, hint: hint() }).length;
      // Make room at the bottom, then fence it off.
      write('\n'.repeat(h) + `\x1b[${h}A\x1b7\x1b[1;${Math.max(1, rows - h)}r\x1b8\x1b[?25l`);
      height = h;
      draw();
    },
    close() {
      if (!open) return;
      open = false;
      clearTimeout(pendingEnter);
      let s = '\x1b7';
      for (let i = 0; i < height; i++) s += `\x1b[${rows - height + 1 + i};1H\x1b[2K`;
      write(s + '\x1b[r\x1b8\x1b[?25h');
      height = 0;
    },
    refresh: draw,
    resize() { if (open) { rows = 0; draw(); } },
    key(s, key = {}) {
      if (pendingEnter) {
        // More keys right behind an Enter: it was a paste, keep the newline.
        clearTimeout(pendingEnter); pendingEnter = null;
        text = text.slice(0, cursor) + '\n' + text.slice(cursor); cursor++;
      }
      if (key.ctrl && key.name === 'c') return sigint();
      if (key.name === 'return' || key.name === 'enter') {
        pendingEnter = setTimeout(() => {
          pendingEnter = null;
          const t = text.trim();
          if (!t) return;
          text = ''; cursor = 0;
          submit(t);
          draw();
        }, 25);
        return;
      }
      if (key.name === 'escape') {
        if (text) { text = ''; cursor = 0; draw(); } else interrupt();
        return;
      }
      if (key.name === 'up' && !text) {
        const last = takeLast();
        if (last != null) { text = last; cursor = text.length; draw(); }
        return;
      }
      const next = edit({ text, cursor }, s, key);
      if (next) { ({ text, cursor } = next); draw(); }
    },
  };
}
