// Saved conversations. Each cockpit conversation is one JSON file holding the
// transcript and every agent's session id, so resuming it continues the same
// Claude / Codex / opencode sessions rather than starting new ones.
import fs from 'node:fs';
import path from 'node:path';

const MAX_TEXT = 20000;

export function newConvo(cwd) {
  const now = new Date();
  const id = now.toISOString().replace(/[:.]/g, '-') + '-' + Math.random().toString(36).slice(2, 6);
  return { id, started: now.getTime(), updated: now.getTime(), cwd, focus: null, turns: [], sessions: {} };
}

export function createConvoStore(dir) {
  const file = (id) => path.join(dir, path.basename(id) + '.json');
  return {
    dir,
    save(conv) {
      if (!conv.turns.length) return;
      try {
        fs.mkdirSync(dir, { recursive: true });
        const tmp = file(conv.id) + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(conv));
        fs.renameSync(tmp, file(conv.id));
      } catch {}
    },
    load(id) {
      try { return JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch { return null; }
    },
    // Newest first.
    list() {
      let names = [];
      try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch {}
      return names.map((n) => this.load(n.slice(0, -5))).filter((c) => c?.turns?.length)
        .sort((a, b) => b.updated - a.updated);
    },
  };
}

export function addTurn(conv, turn) {
  conv.turns.push({ ...turn, text: (turn.text || '').slice(0, MAX_TEXT), at: Date.now() });
  conv.updated = Date.now();
}

// Session map (key "agent\0cwd") to and from plain JSON.
export function dumpSessions(map) {
  return Object.fromEntries([...map].filter(([, s]) => s.id || s.history?.length));
}
export function loadSessions(obj) {
  return new Map(Object.entries(obj || {}).map(([k, s]) => [k, { ...s }]));
}

export function ago(t, now = Date.now()) {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toISOString().slice(0, 10);
}

// One-line summary for the picker: title, agents used, size.
export function summarize(conv) {
  const first = conv.turns[0]?.prompt || '';
  const agents = [...new Set(conv.turns.map((t) => t.agent))];
  return {
    title: first.replace(/\s+/g, ' ').trim() || '(empty)',
    agents,
    turns: conv.turns.length,
  };
}
