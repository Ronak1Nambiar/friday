// Questions the way Claude Code asks them: the question, numbered options to pick with
// ↑↓ and Enter (or the number), and "Other" to type an answer instead. Used for Claude's
// own questions (its AskUserQuestion tool), its permission requests, and FRIDAY's
// mission checkpoints. Drawn where the cursor is and redrawn in place; nothing else
// prints while it is open (the agent is waiting for the answer).
import { edit } from './inputbox.js';
import { AMBER, CYAN, bold, c, dim, paint } from './render.js';

// The choice as lines of text. `sel` is the highlighted option and `child` the highlighted
// row inside it (null: the option itself); `typing` is the typed answer while it is being
// typed (null when not). An option with `children` drops them open underneath while it or
// one of them is highlighted (a model list under a provider, say); a child with `input`
// is typed instead of picked.
export function chooserLines({ title = '', question, options, sel = 0, child = null, picked = new Set(), multi = false, other = null, typing = null, width = 80, color = CYAN, cancel = 'decline', listWord = 'the list' }) {
  const w = Math.max(30, width - 2);
  const wrap = (s, n) => { const out = []; for (const para of String(s).split('\n')) { let l = para; while (l.length > n) { const k = l.lastIndexOf(' ', n) > n / 2 ? l.lastIndexOf(' ', n) : n; out.push(l.slice(0, k)); l = l.slice(k).trimStart(); } out.push(l); } return out; };
  const cursorMark = c.reset ? '\x1b[7m \x1b[27m' : '_';
  const lines = [];
  if (title) lines.push(`${paint(color, '●')} ${bold(title)}`);
  for (const l of wrap(question, w - 2)) lines.push(`  ${l}`);
  lines.push('');
  const rows = [...options, ...(other ? [{ label: other, other: true }] : [])];
  rows.forEach((o, i) => {
    const on = i === sel;
    const here = on && child === null;
    const box = multi && !o.other ? (picked.has(i) ? '[x] ' : '[ ] ') : '';
    const num = `${i + 1}.`;
    const caret = o.children?.length ? (on ? '▾ ' : '▸ ') : '';
    const label = o.other && typing !== null ? `${typing}${cursorMark}` : o.label;
    const desc = o.description && !o.other ? dim(`  ${o.description}`) : '';
    lines.push(here ? `${paint(color, '❯')} ${paint(color, `${num} ${box}${caret}${label}`)}${desc}`
      : `  ${dim(num)} ${box}${on ? paint(color, caret + label) : caret + label}${desc}`);
    if (!on || !o.children?.length) return;
    o.children.forEach((k, j) => {
      const at = child === j;
      const text = k.input && at && typing !== null ? `${typing}${cursorMark}` : k.label;
      const kd = k.description ? dim(`  ${k.description}`) : '';
      lines.push(`     ${dim(j === o.children.length - 1 ? '└' : '├')} ${at ? `${paint(color, '❯')} ${paint(color, text)}` : `  ${text}`}${kd}`);
    });
  });
  const into = child !== null ? ' · ← back' : options[sel]?.children?.length ? ` · → see ${listWord}` : '';
  const keys = typing !== null ? 'type it · enter use it · esc back'
    : `↑↓ move${into} · enter ${multi ? 'submit · space toggle' : child !== null ? 'use this one' : 'select'} · 1-${rows.length} · esc ${cancel}`;
  lines.push(dim(`  ${keys}`));
  return lines;
}

// "Build it? go / cancel / folder <path> / or say what to change" -> the question and
// its options; free-form parts become the Other hint. null when it is not a choice.
export function parseChoices(text) {
  const m = /^([\s\S]*?[?.:])\s*([^?.:]*\/[^?.:]*)$/.exec(String(text).trim());
  if (!m) return null;
  const parts = m[2].split('/').map((s) => s.trim()).filter(Boolean);
  const options = parts.filter((p) => !/[<>]|^or\b/i.test(p)).map((label) => ({ label }));
  const free = parts.filter((p) => /[<>]|^or\b/i.test(p));
  if (options.length < 2) return null;
  return { question: m[1].trim(), options, other: free.length ? free.map((p) => p.replace(/^or\s+/i, '')).join(' / ') : null };
}

// One open chooser at a time. choose() resolves with { index, label, labels, text } or
// null (Esc); a pick inside an option's list adds { child, childLabel }.
// The cockpit routes keys to `key` while `open` is true.
export function createAsker({ write, width = () => process.stdout.columns || 100 }) {
  let cur = null;
  let drawn = 0;
  const erase = () => { write((drawn ? `\x1b[${drawn}A` : '') + '\r\x1b[J'); drawn = 0; };
  const draw = () => {
    erase();
    const lines = chooserLines({ ...cur.spec, sel: cur.sel, child: cur.child, picked: cur.picked, typing: cur.typing, width: width() });
    write(lines.join('\n') + '\n');
    drawn = lines.length;
  };
  // Leave the question and the answer in the transcript, short.
  const finish = (result) => {
    const { spec, resolve } = cur;
    erase();
    cur = null;
    const said = result === null ? dim(spec.cancel === 'close' ? 'closed' : 'declined') : result.text != null ? result.text
      : result.childLabel ? `${result.label} › ${result.childLabel}` : result.labels.join(', ');
    write(`${paint(spec.color || CYAN, '●')} ${spec.title ? `${bold(spec.title)} ` : ''}${dim(oneLine(spec.question).slice(0, 90))}\n  ${paint(AMBER, '⎿')} ${said}\n`);
    resolve(result);
  };
  return {
    get open() { return !!cur; },
    // An answer is being typed ("Other"): every key belongs to it.
    get typing() { return cur?.typing != null; },
    choose(spec) {
      return new Promise((resolve) => {
        cur = { spec, resolve, sel: Math.min(spec.start || 0, spec.options.length - 1), child: null, picked: new Set(), typing: null };
        draw();
      });
    },
    cancel() { if (cur) finish(null); },
    key(s, key = {}) {
      if (!cur) return;
      const { spec } = cur;
      const n = spec.options.length + (spec.other ? 1 : 0);
      if (cur.typing !== null) {
        if (key.name === 'escape') { cur.typing = null; return draw(); }
        if (key.name === 'return' || key.name === 'enter') {
          const t = cur.typing.trim();
          if (!t) return undefined;
          return cur.child !== null
            ? finish({ index: cur.sel, child: cur.child, label: spec.options[cur.sel].label, labels: [], text: t })
            : finish({ index: spec.options.length, label: null, labels: [], text: t });
        }
        const next = edit({ text: cur.typing, cursor: cur.typing.length }, s, key);
        if (next) { cur.typing = next.text; draw(); }
        return;
      }
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) return finish(null);
      const kids = spec.options[cur.sel]?.children || [];
      if (key.name === 'up' || key.name === 'k') move(-1);
      else if (key.name === 'down' || key.name === 'j' || key.name === 'tab') move(1);
      else if ((key.name === 'right' || key.name === 'l') && cur.child === null && kids.length) cur.child = 0;
      else if ((key.name === 'left' || key.name === 'h') && cur.child !== null) cur.child = null;
      else if (spec.multi && key.name === 'space' && cur.sel < spec.options.length) {
        if (cur.picked.has(cur.sel)) cur.picked.delete(cur.sel); else cur.picked.add(cur.sel);
      } else if (/^[1-9]$/.test(s || '') && +s <= n) {
        cur.sel = +s - 1;
        cur.child = null;
        if (!spec.multi) return pick();
      } else if (key.name === 'return' || key.name === 'enter') return pick();
      else return;
      draw();
      // ↑↓ move between options (the highlighted one's list shows open); inside a list (→
      // to enter, ← to leave) they move between its rows, and past either end back out.
      function move(d) {
        if (cur.child === null) { cur.sel = (cur.sel + d + n) % n; return; }
        const j = cur.child + d;
        if (j < 0) cur.child = null;
        else if (j >= kids.length) { cur.sel = (cur.sel + 1) % n; cur.child = null; }
        else cur.child = j;
      }
      function pick() {
        if (cur.child !== null) {
          const o = spec.options[cur.sel];
          const k = o.children[cur.child];
          if (k.input) { cur.typing = ''; return draw(); }
          return finish({ index: cur.sel, child: cur.child, label: o.label, childLabel: k.label, labels: [k.label], text: null });
        }
        if (spec.other && cur.sel === spec.options.length) { cur.typing = ''; return draw(); }
        if (spec.multi) {
          const idx = cur.picked.size ? [...cur.picked].sort((a, b) => a - b) : [cur.sel];
          return finish({ index: idx[0], label: spec.options[idx[0]].label, labels: idx.map((i) => spec.options[i].label), text: null });
        }
        return finish({ index: cur.sel, label: spec.options[cur.sel].label, labels: [spec.options[cur.sel].label], text: null });
      }
    },
  };
}

const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
