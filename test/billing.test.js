import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AGENTS } from '../src/agents.js';
import { createLedger } from '../src/billing.js';

function parse(events) {
  let meta = {};
  const out = { text() {}, tool() {}, error() {}, done: (m) => { meta = { ...meta, ...m }; } };
  for (const ev of events) AGENTS.claude.parse(ev, out, {});
  return meta;
}

test('claude on a subscription login: plan billing and usage windows', () => {
  const meta = parse([
    { type: 'system', subtype: 'init', apiKeySource: 'none', session_id: 's' },
    { type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.12 }, seven_day: { utilization: 0.2 } } } },
    { type: 'result', total_cost_usd: 0.19, session_id: 's' },
  ]);
  assert.equal(meta.billing, 'plan');
  assert.deepEqual(meta.limits, { five_hour: 0.12, seven_day: 0.2 });
  assert.equal(meta.cost, 0.19);
});

test('claude with an API key is billed', () => {
  assert.equal(parse([{ type: 'system', subtype: 'init', apiKeySource: 'ANTHROPIC_API_KEY' }]).billing, 'api');
});

test('plan turns say not billed; API turns say billed', () => {
  const l = createLedger({ claude: 'plan', codex: 'api', ollama: 'local' });
  const r = { cost: 0.19, billing: 'plan', limits: { five_hour: 0.12, seven_day: 0.2 } };
  l.record('claude', r);
  assert.deepEqual(l.describe('claude', r), ['plan 12% of 5h, 20% of week', 'not billed (~$0.19 at API prices)']);
  const a = { cost: 0.042 };
  l.record('codex', a);
  assert.deepEqual(l.describe('codex', a), ['$0.042 billed']);
  l.record('ollama', { tokens: 10 });
  assert.deepEqual(l.describe('ollama', { tokens: 10 }), ['local, free', '10 tokens']);
  assert.equal(l.totals.claude.turns, 1);
});
