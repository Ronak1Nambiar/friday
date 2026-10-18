// Who pays for each agent's tokens. Subscription logins (claude.ai, ChatGPT) use
// plan limits, not money; only an API key turns tokens into a bill.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function detectBilling() {
  const env = process.env;
  const codexMode = (() => {
    if (env.OPENAI_API_KEY) return 'api';
    try {
      const auth = JSON.parse(fs.readFileSync(path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json'), 'utf8'));
      if (auth.auth_mode === 'chatgpt' || auth.tokens) return 'plan';
      if (auth.OPENAI_API_KEY) return 'api';
    } catch {}
    return 'unknown';
  })();
  return {
    // Claude reports the real source per run (apiKeySource); this is the prior.
    claude: env.ANTHROPIC_API_KEY ? 'api' : 'plan',
    codex: codexMode,
    gemini: env.GEMINI_API_KEY || env.GOOGLE_API_KEY ? 'api' : 'plan',
    opencode: 'provider',
    ollama: 'local',
  };
}

// Running totals per agent, and the line shown after each turn.
export function createLedger(billing) {
  const totals = {};
  const row = (id) => (totals[id] ||= { turns: 0, cost: 0, tokens: 0, billing: billing[id] || 'unknown', limits: null });
  return {
    totals,
    record(id, r) {
      const t = row(id);
      t.turns++;
      if (r.billing) t.billing = r.billing;
      if (r.cost) t.cost += r.cost;
      if (r.tokens) t.tokens += r.tokens;
      if (r.limits) t.limits = { ...t.limits, ...r.limits };
      return t;
    },
    describe(id, r) {
      const t = row(id);
      const parts = [];
      if (t.billing === 'api') {
        if (r.cost) parts.push(`$${r.cost.toFixed(3)} billed`);
      } else if (t.billing === 'plan') {
        const l = t.limits;
        if (l?.five_hour != null) parts.push(`plan ${pct(l.five_hour)} of 5h${l.seven_day != null ? `, ${pct(l.seven_day)} of week` : ''}`);
        else parts.push('plan');
        if (r.cost) parts.push(`not billed (~$${r.cost.toFixed(2)} at API prices)`);
      } else if (t.billing === 'local') parts.push('local, free');
      else if (r.cost) parts.push(`$${r.cost.toFixed(3)}`);
      if (r.tokens) parts.push(`${r.tokens} tokens`);
      return parts;
    },
  };
}

const pct = (x) => `${Math.round(x * 100)}%`;
