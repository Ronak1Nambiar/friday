// The agent tree. FRIDAY is the root: its brain (src/brain.js) decides. Each provider
// is a limb (Claude Code, Codex, Gemini, opencode as CLIs; OpenRouter and Ollama as
// chat models). A limb runs twigs: small subagents, each one fresh headless turn with
// its own model, all at once up to the limb's limit. The brain hands out the twigs with
// the `dispatch` tool, gets every twig's answer back, and writes the combined answer.
//
// Twigs read and answer; a twig that changes files (writes: true) runs alone in its
// folder, after the readers, so two twigs never edit the same checkout at once.
// Everything here is pure: the cockpit passes runTwig (and the clock) in.

// How each limb runs a twig. cli: a headless agent turn (tools, files, the repo); chat:
// one model call, text only, so it gets no file or web work.
export const LIMB_KINDS = {
  claude: { kind: 'cli', modelArgs: (m) => ['--model', m] },
  codex: { kind: 'cli', modelArgs: (m) => ['-m', m] },
  gemini: { kind: 'cli', modelArgs: (m) => ['--model', m] },
  opencode: { kind: 'cli', modelArgs: (m) => ['-m', m] },
  openrouter: { kind: 'chat' },
  ollama: { kind: 'chat', local: true },
};

// profile.tree. models.small for simple work, models.large for hard work; null means the
// CLI's own default. max: twigs of that limb running at once.
export const DEFAULT_TREE = {
  enabled: true,
  maxTwigs: 8, // per dispatch
  twigTimeoutMs: 600000,
  resultChars: 2500, // of each twig's answer, back to the brain
  limbs: {
    claude: { max: 5, models: { small: 'sonnet', large: 'opus' } },
    codex: { max: 2, models: { small: 'gpt-6-luna', large: 'gpt-6-astra' } },
    gemini: { max: 2, models: { small: 'gemini-3.8-flash', large: 'gemini-4-argon' } },
    opencode: { max: 2, models: { small: null, large: null } },
    openrouter: { max: 4, models: { small: 'anthropic/claude-haiku-5.5', large: 'anthropic/claude-sonnet-5.5' } },
    ollama: { max: 1, models: { small: null, large: null } },
  },
};

export const TIERS = ['small', 'large'];

// The dispatch tool, offered only with the limbs that can run now.
export function dispatchTool(limbs, tree = DEFAULT_TREE) {
  const desc = limbs.map((l) => {
    const m = tree.limbs?.[l]?.models || {};
    const k = LIMB_KINDS[l]?.kind === 'chat' ? 'text only, no files or web' : 'files, code, shell';
    return `${l} (${k}; up to ${tree.limbs?.[l]?.max ?? 1} at once; small=${m.small || 'default'}, large=${m.large || 'default'})`;
  }).join('; ');
  return {
    type: 'function',
    function: {
      name: 'dispatch',
      description: `Run several subagents at once and get all their answers back. Use it when the work splits into independent parts (read or review several files, research several questions, compare options, draft alternatives, check one thing several ways). Limbs: ${desc}. tier small for simple, well-defined parts; large for hard ones. writes true only for a part that must change files; such parts run one at a time after the others.`,
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            maxItems: tree.maxTwigs || 8,
            items: {
              type: 'object',
              properties: {
                limb: { type: 'string', enum: limbs },
                tier: { type: 'string', enum: TIERS },
                task: { type: 'string', description: 'Complete and self-contained: every file, constraint and detail this part needs. The subagent sees nothing else.' },
                writes: { type: 'boolean' },
              },
              required: ['limb', 'task'],
            },
          },
        },
        required: ['tasks'],
      },
    },
  };
}

// The brain's tasks -> twigs that can run. A limb that cannot run hands its twig to one
// that can (a CLI limb for file work); the list is cut at maxTwigs.
// Returns { twigs: [{ n, limb, tier, model, task, writes, moved? }], notes: [] }.
export function planTwigs(tasks, { tree = DEFAULT_TREE, ready = [] } = {}) {
  const notes = [];
  const cli = ready.filter((l) => LIMB_KINDS[l]?.kind === 'cli');
  const list = (Array.isArray(tasks) ? tasks : []).filter((t) => t && String(t.task || '').trim());
  const max = tree.maxTwigs || 8;
  if (list.length > max) notes.push(`${list.length - max} part(s) over the limit of ${max} were dropped`);
  const twigs = list.slice(0, max).map((t, i) => {
    const tier = TIERS.includes(t.tier) ? t.tier : 'small';
    const writes = t.writes === true;
    let limb = String(t.limb || '').toLowerCase();
    let moved = null;
    // File changes need a CLI limb.
    const ok = (l) => ready.includes(l) && (!writes || LIMB_KINDS[l]?.kind === 'cli');
    if (!ok(limb)) {
      const to = (writes ? cli : ready).find(ok) || null;
      moved = limb || '(none)';
      limb = to;
    }
    if (!limb) return null;
    if (moved) notes.push(`part ${i + 1}: ${moved} cannot run it, ${limb} takes it`);
    return { n: i + 1, limb, tier, model: tree.limbs?.[limb]?.models?.[tier] || null, task: String(t.task).trim(), writes, ...(moved ? { moved } : {}) };
  });
  const dropped = twigs.filter((t) => !t).length;
  if (dropped) notes.push(`${dropped} part(s) dropped: no limb can run them`);
  return { twigs: twigs.filter(Boolean).map((t, i) => ({ ...t, n: i + 1 })), notes };
}

// Runs twigs: up to `max` per limb at once, readers first, writers one at a time.
// runTwig(twig) -> Promise<{ ok, text, ms, errors? }>. on.start(twig), on.end(twig, result).
// Results come back in twig order. A twig that throws counts as failed.
export async function runTwigs(twigs, { tree = DEFAULT_TREE, runTwig, on = {}, shouldStop = () => false }) {
  const results = new Array(twigs.length);
  const busy = new Map(); // limb -> running
  const limit = (l) => Math.max(1, tree.limbs?.[l]?.max ?? 1);
  const one = async (t) => {
    if (shouldStop()) { results[t.n - 1] = { ok: false, text: '', errors: ['stopped'], skipped: true }; return; }
    on.start?.(t);
    let r;
    try { r = (await runTwig(t)) || { ok: false, text: '', errors: ['not run'] }; } catch (e) { r = { ok: false, text: '', errors: [e.message] }; }
    results[t.n - 1] = r;
    on.end?.(t, r);
  };
  // Readers: a pool per limb.
  const readers = twigs.filter((t) => !t.writes);
  await new Promise((resolve) => {
    const queue = [...readers];
    let running = 0;
    const pump = () => {
      if (!queue.length && !running) return resolve();
      for (let i = 0; i < queue.length;) {
        const t = queue[i];
        if ((busy.get(t.limb) || 0) >= limit(t.limb)) { i++; continue; }
        queue.splice(i, 1);
        busy.set(t.limb, (busy.get(t.limb) || 0) + 1);
        running++;
        one(t).finally(() => { busy.set(t.limb, busy.get(t.limb) - 1); running--; pump(); });
      }
    };
    pump();
  });
  // Writers: one at a time.
  for (const t of twigs.filter((x) => x.writes)) await one(t);
  return results;
}

// What the brain reads back: every twig's answer, cut to resultChars, and whether it failed.
export function treeReport(twigs, results, { resultChars = 2500, notes = [] } = {}) {
  const lines = [`${results.filter((r) => r?.ok).length}/${twigs.length} subagents finished. The user has NOT seen their answers: write the combined answer for them yourself (what each found, and a conclusion). Do not claim anything a failed part was meant to do.`];
  if (notes.length) lines.push(`Notes: ${notes.join('; ')}`);
  for (const t of twigs) {
    const r = results[t.n - 1] || {};
    const who = `${t.limb}${t.model ? ` ${t.model}` : ''}`;
    const body = r.ok ? clip(r.text, resultChars) : `FAILED: ${(r.errors || []).join('; ').slice(0, 300) || 'error'}`;
    lines.push(`--- part ${t.n} (${who}${t.writes ? ', changed files' : ''}): ${oneLine(t.task, 140)}\n${body}`);
  }
  return lines.join('\n');
}

// Keep the end of a long answer (conclusions come last) and its start.
function clip(s, n) {
  const t = String(s || '').trim();
  if (t.length <= n) return t || '(empty answer)';
  const head = Math.floor(n * 0.4);
  return `${t.slice(0, head)}\n[… ${t.length - n} characters cut …]\n${t.slice(-(n - head))}`;
}
export const oneLine = (s, n = 80) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// The tree as lines for /tree: root, limbs (ready or why not), their models and limits.
export function treeLines({ tree = DEFAULT_TREE, root, status = {} }) {
  const lines = [`FRIDAY (root · ${root || 'brain'})${tree.enabled === false ? ' · tree off' : ''}`];
  const limbs = Object.keys(LIMB_KINDS);
  limbs.forEach((l, i) => {
    const c = tree.limbs?.[l] || {};
    const last = i === limbs.length - 1;
    const s = status[l] || 'not set up';
    lines.push(`${last ? '└─' : '├─'} ${l.padEnd(10)} ${s === 'ready' ? `×${c.max ?? 1}  small ${c.models?.small || 'default'} · large ${c.models?.large || 'default'}` : s}`);
  });
  return lines;
}

// The prompt a twig gets: its part, and that it is one of several.
export function twigPrompt(t, { total, request }) {
  return `You are subagent ${t.n} of ${total}, working for FRIDAY on one part of a larger request. Do only this part, completely, and end with what you found or did.${t.writes ? '' : ' Do not change any files.'}

Part: ${t.task}

The request it comes from (context only): ${oneLine(request, 600)}`;
}
