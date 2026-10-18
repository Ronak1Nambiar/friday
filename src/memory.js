// FRIDAY's own memory, across every conversation (separate from the Obsidian second brain,
// which is the user's notes): what it was asked to remember, and what each past
// conversation was about. The brain reads it on every message, so "what did we work on
// last?" and "continue that" work in a new chat; each agent gets it at the start of its
// session. Lives in <config>/memory/:
//   memory.md        facts and preferences, one "- " line each (the user may edit it)
//   summaries.json   { <conversation id>: { at, cwd, focus, summary } }, written by the brain
// Sealed or private turns never get here: saved conversations hold only placeholders for
// them, and those are skipped.
import fs from 'node:fs';
import path from 'node:path';

const SKIP = (t) => t.private || t.sealed || /^\[sealed project: not saved\]$/.test(t.prompt || '');
const one = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

export function createMemory(configDir) {
  const dir = path.join(configDir, 'memory');
  const factsFile = path.join(dir, 'memory.md');
  const sumFile = path.join(dir, 'summaries.json');
  const readSums = () => { try { return JSON.parse(fs.readFileSync(sumFile, 'utf8')); } catch { return {}; } };
  const writeAtomic = (file, text) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file + '.tmp', text);
    fs.renameSync(file + '.tmp', file);
  };

  const mem = {
    dir,
    facts() {
      try { return fs.readFileSync(factsFile, 'utf8').split('\n').filter((l) => /^- /.test(l)).map((l) => l.slice(2).trim()).filter(Boolean); } catch { return []; }
    },
    remember(fact) {
      const f = one(fact, 400);
      if (!f) return false;
      const all = mem.facts();
      if (all.some((x) => x.toLowerCase() === f.toLowerCase())) return true;
      writeAtomic(factsFile, `# FRIDAY memory\n\nThings to remember across every conversation. Edit freely: one "- " line each.\n\n${[...all, f].map((x) => `- ${x}`).join('\n')}\n`);
      return true;
    },
    // Forget fact number n (1-based), or every fact containing the text.
    forget(what) {
      const all = mem.facts();
      const keep = /^\d+$/.test(String(what)) ? all.filter((_, i) => i !== +what - 1) : all.filter((x) => !x.toLowerCase().includes(String(what).toLowerCase()));
      if (keep.length === all.length) return 0;
      writeAtomic(factsFile, `# FRIDAY memory\n\nThings to remember across every conversation. Edit freely: one "- " line each.\n\n${keep.map((x) => `- ${x}`).join('\n')}${keep.length ? '\n' : ''}`);
      return all.length - keep.length;
    },
    summaries() { return readSums(); },
    saveSummary(conv, summary) {
      const all = readSums();
      all[conv.id] = { at: conv.updated, cwd: conv.cwd, focus: conv.focus || null, summary: one(summary, 1200), turns: conv.turns.length };
      writeAtomic(sumFile, JSON.stringify(all, null, 2));
    },
    // Conversations that changed since they were last summarized (newest first).
    unsummarized(convs, { exceptId = null, max = 3 } = {}) {
      const all = readSums();
      return convs.filter((c) => c.id !== exceptId && c.turns.some((t) => !SKIP(t)) && (!all[c.id] || all[c.id].turns < c.turns.length)).slice(0, max);
    },
    // What the brain (and an agent starting a session) is told. `convs`: saved
    // conversations, newest first; the current one is left out (the brain has it).
    recall(convs, { currentId = null, sessions = 6, lastTurns = 4, budget = 6000 } = {}) {
      const parts = [];
      const facts = mem.facts();
      if (facts.length) parts.push('Facts and preferences to remember:\n' + facts.map((f) => `- ${f}`).join('\n'));
      const sums = readSums();
      const past = convs.filter((c) => c.id !== currentId && c.turns.some((t) => !SKIP(t))).slice(0, sessions);
      if (past.length) {
        const lines = past.map((c) => {
          const when = new Date(c.updated).toISOString().slice(0, 16).replace('T', ' ');
          const where = c.focus || (c.cwd ? path.basename(c.cwd) : '');
          const s = sums[c.id]?.summary || `asked: ${c.turns.filter((t) => !SKIP(t)).slice(0, 4).map((t) => `"${one(t.prompt, 100)}"`).join('; ')}`;
          return `- ${when}${where ? ` (${where})` : ''}: ${s}`;
        });
        parts.push('Earlier conversations, newest first:\n' + lines.join('\n'));
        // The most recent one in more detail, for "continue where we left off".
        const last = past[0].turns.filter((t) => !SKIP(t)).slice(-lastTurns);
        if (last.length) {
          parts.push('The last exchanges of the most recent conversation:\n' + last.map((t) => `- user: ${one(t.prompt, 300)}\n  ${t.agent || 'agent'}: ${one(t.text, 600)}`).join('\n'));
        }
      }
      let text = parts.join('\n\n');
      if (text.length > budget) text = text.slice(0, budget) + '\n[older memory cut]';
      return text;
    },
  };
  return mem;
}

// The prompt that turns a conversation into its memory entry.
export function summaryPrompt(conv) {
  const turns = conv.turns.filter((t) => !SKIP(t)).slice(-30);
  const body = turns.map((t) => `User: ${one(t.prompt, 600)}\n${t.agent || 'Agent'}: ${one(t.text, 900)}`).join('\n\n');
  return `Summarize this conversation for your own memory, so a later conversation can pick it up. In 2-4 sentences: what the user wanted, what was done or decided (name files, projects and commands), and what is still open or next. No preamble.\n\nWorking folder: ${conv.cwd || '?'}${conv.focus ? `, project ${conv.focus}` : ''}\n\n${body}`;
}

// "remember that ..." as a tool the brain can call.
export const REMEMBER_TOOL = {
  type: 'function',
  function: {
    name: 'remember',
    description: 'Save a lasting fact or preference to FRIDAY\'s memory, used in every later conversation. Use when the user says to remember something, or states a lasting preference about how to work.',
    parameters: { type: 'object', properties: { fact: { type: 'string', description: 'The fact, short and self-contained.' } }, required: ['fact'] },
  },
};
