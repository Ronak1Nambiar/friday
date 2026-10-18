// Terminal styling and a streaming markdown renderer. Chunks arrive at arbitrary
// boundaries, so the renderer is a small state machine rather than a regex pass.

export const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const esc = (c) => (tty ? `\x1b[${c}m` : '');
export const c = {
  reset: esc(0), bold: esc(1), dim: esc(2), italic: esc(3), under: esc(4),
  rgb: (r, g, b) => esc(`38;2;${r};${g};${b}`),
};
export const CYAN = [95, 225, 255];
export const AMBER = [255, 176, 59];
export const RED = [255, 95, 95];
export const GREEN = [110, 231, 140];
export const paint = (rgb, s) => c.rgb(...rgb) + s + c.reset;
export const dim = (s) => c.dim + s + c.reset;
export const bold = (s) => c.bold + s + c.reset;

export function gradient(text, from, to) {
  if (!tty) return text;
  const n = Math.max(1, text.length - 1);
  return [...text].map((ch, i) => {
    const t = i / n;
    return c.rgb(...from.map((v, k) => Math.round(v + (to[k] - v) * t))) + ch;
  }).join('') + c.reset;
}

// Renders markdown-ish text as it streams. write(chunk) returns the styled
// string to print; flush() closes any open style. `first` replaces the gutter on the
// first line (same visible width). Wrapped at word boundaries to `width` (default: the
// terminal's), with the gutter on every wrapped line too, the way Claude Code lays out an
// answer. Words are held until the space after them, so a word is never split across lines.
export function createStream(gutter = '  ', { width = tty ? () => process.stdout.columns || 100 : null, first = null } = {}) {
  const md = markdownStream(gutter, first);
  if (!width) return md;
  const max = () => Math.max(20, (typeof width === 'function' ? width() : width) - 1);
  const gw = gutter.length;
  let col = 0;
  let word = '';
  let wordLen = 0;
  let spaces = 0; // held until the next word: dropped at a wrap or the end of a line
  // A list item ("1. ", "- ") wraps under its text, not under the marker.
  let lineFirst = true;
  let hang = 0;
  const commit = () => {
    let out = '';
    if (!wordLen) { out += word; word = ''; return out; }
    if (col + spaces + wordLen > max() && col > gw + hang) { out += '\n' + gutter + ' '.repeat(hang); col = gw + hang; }
    else { out += ' '.repeat(spaces); col += spaces; }
    spaces = 0;
    if (lineFirst && /^(\d+[.)]|[-•])$/.test(word.replace(/\x1b\[[0-9;]*m/g, ''))) hang = col + wordLen + 1 - gw;
    lineFirst = false;
    // A word longer than the line: cut it.
    while (wordLen > max() - gw) {
      let take = '', n = 0, i = 0;
      while (i < word.length && n < max() - col) {
        const m = /^\x1b\[[0-9;]*m/.exec(word.slice(i));
        if (m) { take += m[0]; i += m[0].length; continue; }
        take += word[i++]; n++;
      }
      out += take + '\n' + gutter;
      word = word.slice(i); wordLen -= n; col = gw;
    }
    out += word; col += wordLen;
    word = ''; wordLen = 0;
    return out;
  };
  const wrap = (s) => {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const m = s[i] === '\x1b' ? /^\x1b\[[0-9;]*m/.exec(s.slice(i)) : null;
      if (m) { word += m[0]; i += m[0].length - 1; continue; }
      const ch = s[i];
      if (ch === '\n') { out += commit() + '\n'; col = 0; spaces = 0; lineFirst = true; hang = 0; continue; }
      if (ch === ' ') { out += commit(); spaces++; continue; }
      word += ch; wordLen++;
    }
    return out;
  };
  return {
    write: (chunk) => wrap(md.write(chunk)),
    flush: () => { const s = wrap(md.flush()); return s + commit(); },
    get atLineStart() { return md.atLineStart && !wordLen; },
  };
}

function markdownStream(gutter, first = null) {
  let lineStart = true;
  let inFence = false;
  let lineStyle = '';
  let bold = false;
  let code = false;
  let pending = ''; // held back: '*' or a run of backticks at line start
  // The very first line may start with its own marker (a "● " bullet) instead of the gutter.
  let firstLine = first != null;
  const lead = () => { if (firstLine) { firstLine = false; return first; } return gutter; };

  const style = () => c.reset + (inFence ? c.rgb(160, 200, 220) : '') + lineStyle
    + (bold ? c.bold : '') + (code ? c.rgb(...CYAN) : '');

  function emitChar(ch) {
    let s = '';
    if (lineStart) {
      s += c.reset + lead();
      lineStart = false;
      lineStyle = '';
      if (!inFence && ch === '#') lineStyle = c.bold + c.rgb(...CYAN);
      s += style();
    }
    if (ch === '\n') {
      bold = false; code = false; lineStyle = '';
      lineStart = true;
      return s + c.reset + '\n';
    }
    return s + ch;
  }

  function write(chunk) {
    let out = '';
    for (const ch of chunk) {
      if (pending) {
        if (pending[0] === '*') {
          pending = '';
          if (ch === '*') { bold = !bold; out += style(); continue; }
          out += emitChar('*');
        } else if (pending[0] === '`') {
          if (ch === '`') { pending += ch; continue; }
          const run = pending; pending = '';
          if (run.length >= 3 && lineStart) {
            // Fence lines print dim; the language tag follows on the same line.
            inFence = !inFence;
            out += c.reset + lead() + dim('```');
            lineStart = false;
            lineStyle = '';
          } else if (run.length === 1 && !inFence) {
            if (lineStart) out += emitChar('');
            code = !code; out += style();
          } else {
            for (const b of run) out += emitChar(b);
          }
        }
      }
      if (ch === '*' && !inFence && !code) { pending = '*'; continue; }
      if (ch === '`') { pending = '`'; continue; }
      out += emitChar(ch);
    }
    return out;
  }

  function flush() {
    let out = '';
    if (pending) { const p = pending; pending = ''; for (const b of p) out += emitChar(b); }
    bold = false; code = false;
    out += c.reset;
    if (!lineStart) { out += '\n'; lineStart = true; }
    return out;
  }

  return { write, flush, get atLineStart() { return lineStart && !pending; } };
}

// Plain text wrapped at word boundaries, every line indented: for one-line status text
// (a turn's stats) that may be wider than the terminal.
export function wrapText(text, { indent = '  ', width = process.stdout.columns || 100 } = {}) {
  const max = Math.max(20, width - 1);
  const lines = [];
  let line = indent;
  for (const w of String(text).split(/\s+/).filter(Boolean)) {
    if (line.length > indent.length && line.length + 1 + w.length > max) { lines.push(line); line = indent; }
    line += (line.length > indent.length ? ' ' : '') + w;
  }
  lines.push(line);
  return lines;
}

export function fmtMs(ms) {
  return ms < 1000 ? `${ms}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}
