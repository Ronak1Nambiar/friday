// Missions: FRIDAY as the lead agent on a multi-phase job ("build X, research it
// first"). The local model drafts a research plan with one written prompt per job,
// Claude reviews it, the user approves it; the research jobs run in parallel (Codex with
// web search for market/users/bias, Claude for the technical side); the local model
// merges the findings into a brief and writes the build prompts, Claude reviews them,
// The user approves; then the build runs (in parallel worktrees when it splits into parts
// that own separate files). Then verify-and-fix: the tests run, the reviewers give a
// verdict, and the builder fixes what failed until it passes or the rounds run out.
// State is checkpointed after every phase, so a crash or a session limit resumes.
// Lessons from each mission feed the next one's plan. Everything is saved.
//
// The flow takes its I/O as functions, so it runs the same in the cockpit and in tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { userName, userPossessive } from './user.js';

export const slugify = (s) => String(s || 'mission').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'mission';

// ---- schemas the local model must fill (Ollama structured output) -------------------
export function planSchema(agents) {
  return {
    type: 'object', required: ['title', 'research', 'build_intent'],
    properties: {
      title: { type: 'string' },
      build_intent: { type: 'string' },
      research: {
        type: 'array', minItems: 1, maxItems: 4,
        items: {
          type: 'object', required: ['id', 'agent', 'purpose', 'prompt'],
          properties: { id: { type: 'string' }, agent: { type: 'string', enum: agents }, purpose: { type: 'string' }, prompt: { type: 'string' } },
        },
      },
    },
  };
}
export function buildSchema(agents) {
  return {
    type: 'object', required: ['brief', 'build'],
    properties: {
      brief: { type: 'string' },
      test_command: { type: 'string' },
      build: {
        type: 'array', minItems: 1, maxItems: 3,
        items: {
          type: 'object', required: ['id', 'agent', 'role', 'prompt'],
          properties: {
            id: { type: 'string' }, agent: { type: 'string', enum: agents }, role: { type: 'string', enum: ['build', 'review', 'test'] }, prompt: { type: 'string' },
            parts: {
              type: 'array', maxItems: 3,
              items: {
                type: 'object', required: ['id', 'agent', 'owns', 'prompt'],
                properties: { id: { type: 'string' }, agent: { type: 'string', enum: agents }, owns: { type: 'array', items: { type: 'string' } }, prompt: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  };
}
export const briefSchema = { type: 'object', required: ['brief'], properties: { brief: { type: 'string' } } };
export const lessonsSchema = { type: 'object', required: ['lessons'], properties: { lessons: { type: 'array', maxItems: 5, items: { type: 'string' } } } };

// Lessons from earlier missions, as a short block for a prompt ('' when none).
const lessonsBlock = (lessons) => (lessons ? `Lessons from earlier missions (follow them):\n${lessons}` : '');

// A goal that only asks for analysis or advice: the plan says build_intent "none", and
// the mission ends with the brief.
export const researchOnly = (plan) => /^\s*none\b/i.test(String(plan?.build_intent || ''));
const RESEARCH_ONLY_RULE = 'build_intent: one paragraph on what will be built once the research is in. If the goal only asks for analysis, advice or a recommendation (nothing to build or change), build_intent is exactly "none".';
// The project the mission is about, when it names one: research runs inside its folder.
const projectBlock = (project) => (project?.dir ? `The goal is about an existing project, "${project.name}", at ${project.dir}. Research jobs run inside that folder and can read its code, so job prompts should tell the agent to start from the code there.` : '');

const ROLES = {
  codex: 'Codex (ChatGPT, has live web search): market validation, competitors, pricing, user needs, risks and biases; also code review and tests',
  claude: 'Claude Code: technical options, architecture, what is needed to build it; builds multi-file projects',
  gemini: 'Gemini: web research with sources, very long documents',
  opencode: 'opencode: small, cheap tasks',
};

export function planMessages(goal, { agents, feedback = '', previous = null, lessons = '', project = null }) {
  const sys = [
    `You are FRIDAY, ${userPossessive()} lead agent. Before anything is built, plan the research.`,
    'Write 2 to 4 research jobs that together cover: market validation and competitors; who the users are and their real problem; risks, biases and blind spots in the idea; what is technically needed to build it.',
    `Agents: ${agents.map((a) => ROLES[a] || a).join('. ')}.`,
    'Each prompt is sent to that agent as it is, so it must be complete and self-contained: the goal in one line, the exact questions to answer, what to search, and the output format (markdown with headings; sources as links). The agents cannot run surveys or talk to people: they research what is published.',
    RESEARCH_ONLY_RULE,
    projectBlock(project),
    lessonsBlock(lessons),
  ].filter(Boolean).join('\n');
  const msgs = [{ role: 'system', content: sys }, { role: 'user', content: goal }];
  if (previous) msgs.push({ role: 'assistant', content: JSON.stringify(previous) }, { role: 'user', content: `Revise the plan: ${feedback}` });
  return msgs;
}

const BUILD_RULES = [
  'The build prompt must have the builder write automated tests for the first version, runnable with one command; put that command in test_command (e.g. "python -m pytest -q" or "npm test").',
  'Only if the build splits cleanly into 2-3 independent pieces that touch different files (e.g. a CLI and a separate web page), give the build job "parts": each with its own agent, "owns" (the folders or files only it may write, never shared) and a self-contained prompt. Otherwise leave parts out.',
].join('\n');

export function buildMessages(goal, { agents, plan, results, feedback = '', previous = null, lessons = '' }) {
  // Short excerpts and explicit lengths: with neither, a 7B model wrote 5000 tokens and overflowed its context.
  const found = results.map((r) => `## ${r.id} (${r.agent}${r.ok ? '' : ', FAILED'})\n${(r.text || '(no answer)').slice(0, 2500)}`).join('\n\n');
  const sys = [
    `You are FRIDAY, ${userPossessive()} lead agent. The research is in. Do two things.`,
    '1. brief: a research brief in markdown: the decision (build or not, and what), target users and their problem, competitors and how this differs, risks and biases to watch, technical approach, open questions. Cite which job each finding came from. Only use what the research says. Keep it under 350 words: short bullets, no tables.',
    `2. build: 1 to 3 jobs for the build. Agents: ${agents.map((a) => ROLES[a] || a).join('. ')}. The first job is role "build" (usually claude): a complete, self-contained prompt that tells the agent exactly what to build from the brief, the scope of a first version, the stack, the files to create, and how to verify it, in under 250 words. Then a "review" or "test" job for a different agent if one is available, in under 120 words.`,
    BUILD_RULES,
    lessonsBlock(lessons),
  ].filter(Boolean).join('\n');
  const msgs = [{ role: 'system', content: sys }, { role: 'user', content: `Goal: ${goal}\nPlanned build: ${plan.build_intent}\n\nResearch:\n${found}` }];
  if (previous) msgs.push({ role: 'assistant', content: JSON.stringify(previous) }, { role: 'user', content: `Revise: ${feedback}` });
  return msgs;
}

// ---- Claude's review: same structure back, improved ----------------------------------
export function reviewPlanPrompt(goal, plan, agents, lessons = '', project = null) {
  return [
    'You are reviewing a research plan that a small local model drafted for this goal. Improve it before it runs.',
    `Goal: ${goal}`,
    ...(project?.dir ? [projectBlock(project)] : []),
    RESEARCH_ONLY_RULE,
    `Agents that can be assigned: ${agents.join(', ')} (${agents.map((a) => ROLES[a] || a).join('; ')}).`,
    'Make each job prompt sharp, complete and self-contained; fix wrong agent choices; drop impossible steps (agents cannot run surveys or interviews); keep 2-4 jobs; do not add build steps.',
    ...(lessons ? [lessonsBlock(lessons)] : []),
    'Do not use any tools. Reply with only a JSON object in a ```json block, with exactly these keys: title, build_intent, research: [{id, agent, purpose, prompt}].',
    '',
    '```json',
    JSON.stringify(plan, null, 2),
    '```',
  ].join('\n');
}

export function reviewBuildPrompt(goal, draft, results, agents, lessons = '') {
  const found = results.map((r) => `## ${r.id} (${r.agent}${r.ok ? '' : ', FAILED'})\n${(r.text || '').slice(0, 6000)}`).join('\n\n');
  return [
    draft
      ? 'A small local model merged this research into a brief and wrote the build prompts. Check them against the research and improve them before anything is built.'
      : 'The local model could not merge this research. Write the research brief (the decision, users and their problem, competitors, risks and biases, technical approach, open questions; under 350 words) and the build prompts from it.',
    `Goal: ${goal}`,
    `Agents: ${agents.join(', ')}.`,
    'Correct anything the brief gets wrong or leaves out (it must only state what the research supports, and say where research failed). Make the build prompt complete and buildable: scope of a first version, stack, files, how to verify. Keep a review or test job by a different agent if one is available.',
    BUILD_RULES,
    ...(lessons ? [lessonsBlock(lessons)] : []),
    'Do not use any tools. Reply with only a JSON object in a ```json block, with these keys: brief (markdown string), test_command (string), build: [{id, agent, role ("build"|"review"|"test"), prompt, parts (optional, build job only): [{id, agent, owns: [paths], prompt}]}].',
    '',
    ...(draft ? ['## Draft', '```json', JSON.stringify(draft, null, 2), '```', ''] : []),
    '## Research',
    found,
  ].join('\n');
}

// Research-only missions: the brief is the result.
export function briefMessages(goal, { results, feedback = '', previous = null, lessons = '' }) {
  const found = results.map((r) => `## ${r.id} (${r.agent}${r.ok ? '' : ', FAILED'})\n${(r.text || '(no answer)').slice(0, 2500)}`).join('\n\n');
  const sys = [
    `You are FRIDAY, ${userPossessive()} lead agent. The research is in; nothing will be built. Write the answer to the goal as a brief in markdown: the recommendation first, then the findings that support it (cite which job each came from), risks, and open questions. Only use what the research says, and say where research failed. Under 450 words: short bullets, no tables.`,
    lessonsBlock(lessons),
  ].filter(Boolean).join('\n');
  const msgs = [{ role: 'system', content: sys }, { role: 'user', content: `Goal: ${goal}\n\nResearch:\n${found}` }];
  if (previous) msgs.push({ role: 'assistant', content: JSON.stringify({ brief: previous }) }, { role: 'user', content: `Revise: ${feedback}` });
  return msgs;
}
export function reviewBriefPrompt(goal, draft, results) {
  const found = results.map((r) => `## ${r.id} (${r.agent}${r.ok ? '' : ', FAILED'})\n${(r.text || '').slice(0, 6000)}`).join('\n\n');
  return [
    draft
      ? 'A small local model merged this research into a brief that answers the goal. Check it against the research and improve it.'
      : 'The local model could not merge this research. Write the brief that answers the goal.',
    `Goal: ${goal}`,
    'The brief: the recommendation first, then the findings that support it (cite the job), risks, open questions; only what the research supports; say where research failed; under 450 words.',
    'Do not use any tools. Reply with only a JSON object in a ```json block: {"brief": "<markdown>"}.',
    '',
    ...(draft ? ['## Draft', draft, ''] : []),
    '## Research',
    found,
  ].join('\n');
}
const briefOf = (j) => (typeof j?.brief === 'string' && j.brief.trim() ? j.brief.trim() : null);

// ---- spending what you already pay for ----------------------------------------------------
// The agent to take a job from one that is over its limit: a ready one that is not over
// budget itself, with the most headroom (lowest 5-hour use; unknown counts as half used).
export function pickHeadroom(agent, agents, { ready = () => true, over = () => null, used = () => null } = {}) {
  const cands = agents.filter((a) => a !== agent && ready(a) && !over(a));
  const u = (a) => { const x = used(a); return typeof x === 'number' ? x : 0.5; };
  return cands.sort((a, b) => u(a) - u(b))[0] || null;
}

// Plan use per agent, before and after a mission, as a markdown table.
export function usageTable(before = {}, after = {}) {
  const ids = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  if (!ids.length) return '';
  const pct = (x) => (typeof x === 'number' ? `${Math.round(x * 100)}%` : 'n/a');
  const usd = (x) => (typeof x === 'number' && x > 0 ? `$${x.toFixed(2)}` : '-');
  const rows = ids.map((id) => {
    const b = before[id] || {};
    const a = after[id] || {};
    const cost = typeof a.cost === 'number' ? a.cost - (b.cost || 0) : null;
    return `| ${id} | ${pct(b.five_hour)} → ${pct(a.five_hour)} | ${pct(b.seven_day)} → ${pct(a.seven_day)} | ${usd(cost)} |`;
  });
  return ['| Agent | 5-hour limit | 7-day limit | API cost |', '|---|---|---|---|', ...rows].join('\n');
}

// ---- results as a branch and a pull request ------------------------------------------
// The body of the PR a mission opens: the brief, then what verification found.
export function prBody(m) {
  const lines = [`FRIDAY mission: ${m.goal.replace(/\s+/g, ' ').slice(0, 300)}`, '', '## Brief', '', m.build?.brief || '(none)', ''];
  if (m.rounds?.length) {
    lines.push('## Verification', '', '| Round | Tests | Verdicts | Open issues |', '|---|---|---|---|');
    for (const r of m.rounds) {
      const tests = r.tests?.ran ? (r.tests.ok ? 'pass' : 'fail') : 'not run';
      const verdicts = (r.verdicts || []).map((v) => `${v.agent}: ${v.verdict}`).join(', ') || '-';
      lines.push(`| ${r.round} | ${tests} | ${verdicts.replace(/\|/g, '/')} | ${r.issues.length} |`);
    }
    lines.push('');
  }
  lines.push(`Status: ${m.status}`);
  return lines.join('\n');
}

// The first JSON object in a reply (a ```json block, or bare).
export function extractJson(text) {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text || '');
  const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  if (fenced) { const j = tryParse(fenced[1]); if (j) return j; }
  const a = (text || '').indexOf('{');
  const b = (text || '').lastIndexOf('}');
  return a >= 0 && b > a ? tryParse(text.slice(a, b + 1)) : null;
}

// ---- keep model output honest and runnable -------------------------------------------
export function normalizePlan(p, agents) {
  if (!p || !Array.isArray(p.research) || !p.research.length) return null;
  const pick = (a) => (agents.includes(a) ? a : agents.includes('codex') ? 'codex' : agents[0]);
  const ids = new Set();
  const research = p.research.slice(0, 4).map((j, i) => {
    let id = slugify(j.id || j.purpose || `job-${i + 1}`);
    while (ids.has(id)) id += '-2';
    ids.add(id);
    return { id, agent: pick(j.agent), purpose: String(j.purpose || '').trim(), prompt: String(j.prompt || '').trim() };
  }).filter((j) => j.prompt);
  if (!research.length) return null;
  return { title: String(p.title || 'Mission').trim(), build_intent: String(p.build_intent || '').trim(), research };
}

export function normalizeBuild(b, agents) {
  if (!b || typeof b.brief !== 'string' || !Array.isArray(b.build) || !b.build.length) return null;
  const pick = (a, fallback) => (agents.includes(a) ? a : fallback);
  const build = b.build.slice(0, 3).map((j, i) => ({
    id: slugify(j.id || `${j.role || 'job'}-${i + 1}`),
    role: ['build', 'review', 'test'].includes(j.role) ? j.role : (i === 0 ? 'build' : 'review'),
    agent: pick(j.agent, i === 0 && agents.includes('claude') ? 'claude' : agents[0]),
    prompt: String(j.prompt || '').trim(),
    parts: j.parts,
  })).filter((j) => j.prompt);
  if (!build.length) return null;
  if (build[0].role !== 'build') build[0].role = 'build';
  for (const [i, j] of build.entries()) {
    const parts = i === 0 ? normalizeParts(j.parts, agents, j.agent) : null;
    if (parts) j.parts = parts; else delete j.parts;
  }
  const out = { brief: b.brief.trim(), build };
  const cmd = String(b.test_command || '').trim();
  if (cmd && !/[\r\n]/.test(cmd) && cmd.length < 200) out.test_command = cmd;
  return out;
}

// Parts of one build, run at once in separate worktrees. Each owns its own paths;
// any overlap (or a part that owns nothing) means one sequential build instead.
const ownPath = (p) => String(p || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/(\/\*\*?)+$|\/+$/g, '');
export function partsOverlap(a, b) {
  return a.some((x) => b.some((y) => x === y || !x || !y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)));
}
export function normalizeParts(parts, agents, fallback) {
  if (!Array.isArray(parts) || parts.length < 2) return null;
  const ids = new Set();
  const out = parts.slice(0, 3).map((p, i) => {
    let id = slugify(p?.id || `part-${i + 1}`);
    while (ids.has(id)) id += '-2';
    ids.add(id);
    const owns = (Array.isArray(p?.owns) ? p.owns : []).map(ownPath).filter((x) => x && !x.startsWith('..') && !/^[a-z]:|^\//i.test(x));
    return { id, agent: agents.includes(p?.agent) ? p.agent : fallback, owns, prompt: String(p?.prompt || '').trim() };
  });
  if (out.some((p) => !p.prompt || !p.owns.length)) return null;
  for (let i = 0; i < out.length; i++) for (let k = i + 1; k < out.length; k++) if (partsOverlap(out[i].owns, out[k].owns)) return null;
  return out;
}
export function partPrompt(part, all) {
  const others = all.filter((p) => p !== part).map((p) => `${p.id} (${p.owns.join(', ')})`).join('; ');
  return `${part.prompt}\n\nYou are building one part of a larger build, in parallel with other agents. Create or change files only under: ${part.owns.join(', ')}. The other parts own: ${others}; do not touch their files. When done, reply with a short summary of what you made.`;
}

// ---- verify and fix (kodo / "evidence, not optimism") --------------------------------
// "blocked": the checker could not read the files or run anything. That is no evidence
// either way: it never passes a build (a sandbox that cannot open the folder may still
// answer "pass"), and the check moves to another agent.
export const VERDICT_RULE = 'End your reply with a ```json block: {"verdict": "pass", "fail" or "blocked", "issues": ["one concrete defect per item, with the file"]}. Fail only for real defects against the spec or broken behaviour, not style. If you could not read the files or run anything, the verdict is "blocked" with the reason as the issue, never "pass".';

export function checkPrompt(job, tests) {
  const t = !tests?.ran ? 'No automated tests ran.' : tests.ok ? `The tests pass (\`${tests.command}\`).` : `The tests fail (\`${tests.command}\`):\n${tests.summary}`;
  return `${job.prompt}\n\n${t}\nDo not change any files: report only.\n${VERDICT_RULE}`;
}

// The last JSON block with a verdict; null when the reply gives none.
export function parseVerdict(text) {
  const s = String(text || '');
  const blocks = [...s.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)].map((m) => m[1]).reverse();
  const bare = s.lastIndexOf('{"verdict"');
  if (bare >= 0) blocks.push(s.slice(bare, s.lastIndexOf('}') + 1));
  for (const b of blocks) {
    try {
      const j = JSON.parse(b);
      if (j && /^(pass|fail|blocked)$/i.test(j.verdict)) {
        const issues = (Array.isArray(j.issues) ? j.issues : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 12);
        return /^blocked$/i.test(j.verdict) ? { pass: false, blocked: true, issues } : { pass: /^pass$/i.test(j.verdict), issues };
      }
    } catch {}
  }
  return null;
}

export function fixPrompt(issues, round) {
  return [`Fix round ${round}. The build was checked and these problems were found:`, '', ...issues.map((x) => `- ${x}`), '',
    'Fix each one at its root (do not weaken or delete tests to make them pass) and reply with what you changed. FRIDAY runs the tests again after you, so you do not need to.'].join('\n');
}

// The same problems again: the fixer is stuck and someone else should try.
const signature = (issues) => issues.map((x) => x.toLowerCase().replace(/\d+(\.\d+)?/g, '#').replace(/\s+/g, ' ').trim()).sort().join('\n').slice(0, 800);

// Why a job did not give an answer, in a few words (for the saved note and the lessons).
export function failReason(r) {
  if (!r || r.ok) return '';
  if (r.interrupted) return 'interrupted';
  const first = (r.errors || []).map((e) => String(e).replace(/\s+/g, ' ').trim()).find(Boolean);
  if (first) return first.slice(0, 300);
  if (r.paused) return 'hit its usage limit';
  return r.text ? 'stopped before it finished' : 'no answer and no error reported';
}

// ---- lessons (AGENTS.md / REFLECTION.md pattern) ---------------------------------------
export function lessonsPrompt(m) {
  const rounds = (m.rounds || []).map((r) => `round ${r.round}: tests ${r.tests?.ran ? (r.tests.ok ? 'pass' : 'fail') : 'none'}; ${r.issues.length} issues${r.fixer ? `; fixed by ${r.fixer}` : ''}`).join('\n');
  return [
    'A FRIDAY mission just ended. Write 1 to 5 lessons that would make the NEXT mission go better: what to plan, research, prompt or check differently. Concrete and reusable, one line each, no praise. Skip anything specific to this one project.',
    `Goal: ${m.goal}`,
    `Status: ${m.status}`,
    `Research: ${(m.results || []).map((r) => `${r.id} by ${r.agent}: ${r.ok ? 'ok' : `failed (${failReason(r)})`}${r.retriedFrom ? ` (retried after ${r.retriedFrom})` : ''}`).join('; ') || 'none'}`,
    `Build jobs: ${(m.outcomes || []).map((o) => `${o.role} by ${o.agent}: ${o.ok ? 'ok' : `failed (${failReason(o)})`}`).join('; ') || 'none'}`,
    rounds ? `Verify rounds:\n${rounds}` : '',
    (m.rounds || []).flatMap((r) => r.issues).slice(0, 12).map((x) => `- issue: ${x.slice(0, 200)}`).join('\n'),
    'A lesson about a failure must name the cause shown above and what to do about it. Where no cause is shown, write no lesson about that failure. No generic advice ("use more robust services", "document failures"). Fewer lessons are better than vague ones; an empty list is fine.',
    'Reply with only a JSON object in a ```json block: {"lessons": ["..."]}.',
  ].filter(Boolean).join('\n');
}
export function parseLessons(text) {
  const j = extractJson(text);
  return (Array.isArray(j?.lessons) ? j.lessons : []).map((x) => String(x).replace(/\s+/g, ' ').trim()).filter((x) => x && x.length < 400).slice(0, 5);
}
// The newest lessons from the lessons note, newest last, capped for a prompt.
export function recentLessons(markdown, { count = 10, chars = 1500 } = {}) {
  const lines = String(markdown || '').split('\n').filter((l) => /^- /.test(l)).slice(-count);
  while (lines.join('\n').length > chars && lines.length) lines.shift();
  return lines.join('\n');
}

// ---- how it looks -----------------------------------------------------------------------
const cut = (s, n) => (s.length > n ? s.slice(0, n).trimEnd() + ' …' : s);
export function renderPlan(plan) {
  return [`${plan.title}`, '', 'Research, in parallel:', ...plan.research.map((j, i) => `  ${i + 1}. ${j.agent.padEnd(7)} ${j.purpose}\n     ${cut(j.prompt.replace(/\s+/g, ' '), 260)}`),
    '', `Then: ${cut(plan.build_intent.replace(/\s+/g, ' '), 300)}`].join('\n');
}
export function renderBuild(b, workdir) {
  const job = (j, i) => {
    const head = `  ${i + 1}. ${j.agent.padEnd(7)} ${j.role}${j.parts ? `, in ${j.parts.length} parallel parts` : ''}`;
    if (!j.parts) return `${head}\n     ${cut(j.prompt.replace(/\s+/g, ' '), 400)}`;
    return [head, ...j.parts.map((p) => `     · ${p.agent.padEnd(7)} ${p.id} owns ${p.owns.join(', ')}\n       ${cut(p.prompt.replace(/\s+/g, ' '), 260)}`)].join('\n');
  };
  return ['Build, in order:', ...b.build.map(job), '',
    `Then: ${b.test_command ? `tests (\`${b.test_command}\`)` : 'tests if the project has them'}, the reviewers' verdicts, and fixes until they pass.`,
    `Folder: ${workdir}`].join('\n');
}

export function missionMarkdown(m) {
  const lines = [
    `# ${m.plan?.title || m.goal}`, '',
    `*FRIDAY mission, ${m.date}. Status: ${m.status}.*`, '',
    '## Goal', '', m.goal, '',
  ];
  if (m.plan) {
    lines.push('## Plan', '', m.plan.build_intent, '');
    for (const j of m.plan.research) lines.push(`### Research job: ${j.id} (${j.agent})`, '', `*${j.purpose}*`, '', '```text', j.prompt, '```', '');
  }
  if (m.build) {
    lines.push(researchOnly(m.plan) ? '## Brief' : '## Research brief', '', m.build.brief, '');
    if (m.build.build.length) lines.push('## Build prompts', '');
    for (const j of m.build.build) lines.push(`### ${j.role}: ${j.id} (${j.agent})`, '', '```text', j.prompt, '```', '');
  }
  if (m.workdir && !researchOnly(m.plan)) lines.push(`Built in: \`${m.workdir}\`${m.branch ? ` on branch \`${m.branch}\`` : ''}`, '');
  if (m.pr) lines.push(`Pull request: ${m.pr}`, '');
  if (m.lessons?.length) lines.push('## Lessons', '', ...m.lessons.map((l) => `- ${l}`), '');
  if (m.overflow?.length) lines.push('## Moved to another agent', '', ...m.overflow.map((o) => `- ${o.from} → ${o.to}: ${o.why}`), '');
  const usage = usageTable(m.usage?.before, m.usage?.after);
  if (usage) lines.push('## Plan usage', '', usage, '');
  if (m.rounds?.length) {
    lines.push('## Verification', '');
    for (const r of m.rounds) {
      lines.push(`### Round ${r.round}: tests ${r.tests?.ran ? (r.tests.ok ? 'pass' : 'fail') : 'not run'}, ${r.issues.length ? `${r.issues.length} issues` : 'clean'}${r.fixer ? `, fixed by ${r.fixer}` : ''}`, '');
      for (const v of r.verdicts || []) lines.push(`- ${v.agent} (${v.id}): ${v.verdict}`);
      for (const x of r.issues) lines.push(`- issue: ${x}`);
      lines.push('');
    }
  }
  const took = (x) => (x.ms ? `, ${Math.round(x.ms / 1000)} s` : '');
  if (m.outcomes?.length) {
    lines.push('## Build results', '');
    for (const o of m.outcomes) {
      lines.push(`### ${o.role}: ${o.agent} (${o.ok ? 'done' : 'failed'}${took(o)})`, '');
      if (!o.ok) lines.push(`**Failed:** ${failReason(o)}`, '');
      lines.push((o.text || '').slice(0, 8000), '');
    }
  }
  if (m.results?.length) {
    lines.push('## Research results', '');
    for (const r of m.results) {
      lines.push(`### ${r.id} (${r.agent}${r.ok ? '' : ', failed'}${took(r)})`, '');
      if (r.retriedFrom) lines.push(`*Retried on ${r.agent} after ${r.retriedFrom} failed: ${r.firstFailure || 'no reason'}*`, '');
      if (!r.ok) lines.push(`**Failed:** ${failReason(r)}`, '');
      lines.push(r.text || '(no answer)', '');
    }
  }
  return lines.join('\n');
}

// ---- where missions are kept ---------------------------------------------------------
// config.missionStore: "vault", a folder path, or unset (FRIDAY asks once).
export function defaultMissionDir(home = os.homedir()) {
  const docs = path.join(home, 'Documents');
  return path.join(fs.existsSync(docs) ? docs : home, 'FRIDAY', 'missions');
}

export function writeMissionFolder(dir, m) {
  const out = path.join(dir, `${m.date}-${m.slug}`);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'mission.md'), missionMarkdown(m));
  return out;
}

export const vaultMissionPath = (m) => `03_Resources/friday-missions/${m.date}-${m.slug}.md`;
export const LESSONS_PATH = '03_Resources/friday-missions/_lessons.md';

// Checkpoints: one JSON file per mission, rewritten after every phase (tmp + rename,
// so a crash mid-write leaves the last good one). list() gives unfinished ones, newest first.
export function missionStateStore(dir) {
  const file = (id) => path.join(dir, `${id}.json`);
  return {
    save(m) {
      m.id ||= `${m.date}-${m.slug}-${Date.now().toString(36).slice(-4)}`;
      m.updated = Date.now();
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(`${file(m.id)}.tmp`, JSON.stringify(m));
      fs.renameSync(`${file(m.id)}.tmp`, file(m.id));
    },
    list() {
      let names = [];
      try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch {}
      return names.map((n) => { try { return JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { return null; } })
        .filter((m) => m && !m.done).sort((a, b) => (b.updated || 0) - (a.updated || 0));
    },
    // By number in list() (1 = newest) or by a piece of the id or title.
    find(key) {
      const all = this.list();
      if (/^\d+$/.test(String(key))) return all[Number(key) - 1] || null;
      const k = String(key || '').toLowerCase();
      return all.find((m) => m.id.includes(k) || (m.plan?.title || m.goal).toLowerCase().includes(k)) || null;
    },
  };
}

// ---- the flow ------------------------------------------------------------------------------
// io: agents (ready cloud agents); local(messages, { format }) -> string;
//     claude(prompt) -> { ok, text }; ask(question) -> reply; show(text); status(text);
//     runResearch(jobs, onResult) -> [{ id, agent, ok, text, paused }];
//     runBuild(job, workdir) -> { ok, text, paused }; runParts(job, workdir) -> same (optional);
//     verify(workdir, command) -> { ran, ok, command, summary } (optional);
//     budget(agent) -> reason it is over budget, or null (optional);
//     overflow(agent) -> another agent to take the job when it is over budget, or null
//       (optional; "auto" overflow); usage() -> { agent: { five_hour, seven_day, cost } };
//     nextAgent(agent) -> another ready agent, or null (optional);
//     reflect(prompt) -> text (optional); lessons: earlier lessons (optional);
//     checkpoint(mission) (optional); workdir(plan) -> path; save(mission) -> where;
//     project: { name, dir } the goal is about (optional);
//     branch(mission) -> { branch } or { error } (optional, before the build);
//     commit(mission, message) (optional, after the build and each fix);
//     canPr(mission) -> bool, pr(mission, body) -> url (optional, at the end).
// A paused mission (an agent hit its limit, or the user said pause) is checkpointed, not
// saved; runMission(goal, io, { state }) carries on from the phase it stopped in.
// Who paused a mission, in its status line ("you" until the user has a name).
const who = () => (userName() === 'the user' ? 'you' : userName());

// What is kept of a build/fix job: enough to say why it failed.
const outcome = (id, role, agent, r) => ({
  id, role, agent, ok: !!r?.ok, text: r?.text || '',
  ...(r?.ok ? {} : { errors: (r?.errors || []).slice(0, 3), ...(r?.timedOut ? { timedOut: true } : {}), ...(r?.paused ? { paused: true } : {}) }),
  ...(r?.ms ? { ms: r.ms } : {}),
});
const GO = /^\s*(go|yes|y|ok|okay|run|start|build|approve|approved|do it|proceed)\s*[.!]?\s*$/i;
const STOP = /^\s*(cancel|stop|no|n|abort|quit|exit)\s*[.!]?\s*$/i;
const PHASES = ['plan', 'research', 'brief', 'build', 'verify'];

export async function runMission(goal, io, { maxRevisions = 3, fixRounds = 3, date = new Date().toISOString().slice(0, 10), state = null } = {}) {
  const agents = io.agents;
  const lessons = io.lessons || '';
  const m = state || { goal, date, slug: slugify(goal), phase: 'plan', status: 'planning' };
  m.results ||= []; m.outcomes ||= []; m.rounds ||= [];
  try { if (io.usage && !m.usage?.before) m.usage = { before: io.usage() }; } catch {}
  if (m.done || !PHASES.includes(m.phase)) return m;
  delete m.paused;

  const checkpoint = async () => { try { await io.checkpoint?.(m); } catch {} };
  const pause = async (why) => { m.status = `paused: ${why}`; m.paused = true; await checkpoint(); return m; };
  const finish = async (status) => {
    m.status = status;
    m.done = true;
    try { if (io.usage) (m.usage ||= {}).after = io.usage(); } catch {}
    if (io.reflect && m.phase !== 'plan') {
      io.status('writing lessons for next time');
      try { m.lessons = parseLessons(await io.reflect(lessonsPrompt(m))); } catch { m.lessons = []; }
    }
    try { m.saved = await io.save(m); } catch (e) { m.saveError = e.message; }
    await checkpoint();
    return m;
  };
  const commit = async (message) => { try { await io.commit?.(m, message); } catch (e) { io.status(`could not commit: ${e.message}`); } };
  // A finished build: offer a pull request when the folder has somewhere to push.
  const built = async (status) => {
    m.status = status;
    let can = false;
    try { can = !!io.pr && !!(await io.canPr?.(m)); } catch {}
    if (can && /^\s*(y|yes|go|ok|okay|sure|pr|open)\b/i.test(await io.ask(`Open a pull request from ${m.branch || 'this branch'}? yes / no`))) {
      try { m.pr = await io.pr(m, prBody(m)); } catch (e) { m.prError = e.message; io.status(`no PR: ${e.message}`); }
    }
    return finish(status);
  };
  // Before an agent job: over budget means the user decides (go, another agent, or pause).
  // A "go" holds for that agent for the rest of this run.
  const allowed = new Set();
  const gate = async (agent) => {
    const why = allowed.has(agent) ? null : io.budget?.(agent);
    if (!why) return agent;
    // overflow "auto": the job moves to the agent with the most room, without asking.
    const alt = io.overflow?.(agent);
    if (alt) {
      io.status(`${why}; ${alt} takes it`);
      (m.overflow ||= []).push({ from: agent, to: alt, why });
      return alt;
    }
    for (;;) {
      const reply = await io.ask(`${why}. go / use <agent> / pause`);
      if (GO.test(reply)) { allowed.add(agent); return agent; }
      const use = /^\s*use\s+(\w+)/i.exec(reply);
      if (use && agents.includes(use[1].toLowerCase())) return use[1].toLowerCase();
      if (/^\s*pause\b/i.test(reply) || STOP.test(reply)) return null;
    }
  };

  // 1. Plan: local draft, Claude review, the user's go.
  if (m.phase === 'plan') {
    let draft = null;
    let feedback = '';
    for (let round = 0; ; round++) {
      io.status(round ? 'revising the plan (local)' : 'drafting the research plan (local)');
      const raw = await io.local(planMessages(goal, { agents, feedback, previous: draft, lessons, project: io.project }), { format: planSchema(agents) });
      draft = normalizePlan(extractJson(raw), agents);
      if (!draft) return finish('failed: the local model did not produce a plan');
      io.status('Claude is reviewing the plan');
      const rev = await io.claude(reviewPlanPrompt(goal, draft, agents, lessons, io.project));
      const better = rev?.ok ? normalizePlan(extractJson(rev.text), agents) : null;
      if (!better) io.status('Claude\'s review was not usable; showing the local draft');
      m.plan = better || draft;
      m.slug = slugify(m.plan.title);
      io.show(renderPlan(m.plan));
      const reply = await io.ask(researchOnly(m.plan) ? 'Run this research (nothing gets built)? go / cancel / or say what to change' : 'Run this research? go / cancel / or say what to change');
      if (GO.test(reply)) break;
      if (STOP.test(reply) || round + 1 >= maxRevisions) return finish('cancelled at the plan');
      feedback = reply;
      draft = m.plan;
    }
    m.phase = 'research'; m.status = 'researching';
    await checkpoint();
  }

  // 2. Research, in parallel. On a resume only the jobs without an answer run again.
  if (m.phase === 'research') {
    m.status = 'researching';
    const have = new Set(m.results.filter((r) => r.ok).map((r) => r.id));
    const todo = [];
    for (const j of m.plan.research.filter((x) => !have.has(x.id))) {
      const agent = await gate(j.agent);
      if (!agent) return pause(`${who()} paused it before the research`);
      todo.push({ ...j, agent });
    }
    const keep = (r) => { m.results = [...m.results.filter((x) => x.id !== r.id), r]; };
    if (todo.length) {
      const got = await io.runResearch(todo, async (r) => { keep(r); await checkpoint(); });
      for (const r of got || []) keep(r);
    }
    // Stopped by Esc, Ctrl+C, a quit or a reload: not a failure. Pause, so a resume
    // runs only the jobs without an answer.
    if (m.results.some((r) => r.interrupted)) return pause('interrupted; /mission resume carries on');
    // A job that failed for its own reasons gets one more try on another agent.
    const retry = [];
    for (const r of m.results.filter((x) => !x.ok && !x.paused && !x.retriedFrom && todo.some((j) => j.id === x.id))) {
      const next = io.nextAgent?.(r.agent);
      if (!next) continue;
      const agent = await gate(next);
      if (!agent) return pause(`${who()} paused it before a retry`);
      io.status(`${r.id}: ${r.agent} failed (${failReason(r)}); ${agent} tries it`);
      retry.push({ ...m.plan.research.find((j) => j.id === r.id), agent, retriedFrom: r.agent, firstFailure: failReason(r) });
    }
    if (retry.length) {
      const tag = (r) => { const j = retry.find((x) => x.id === r.id); return j ? { ...r, retriedFrom: j.retriedFrom, firstFailure: j.firstFailure } : r; };
      const got = await io.runResearch(retry.map(({ retriedFrom, firstFailure, ...j }) => j), async (r) => { keep(tag(r)); await checkpoint(); });
      for (const r of got || []) keep(tag(r));
      if (m.results.some((r) => r.interrupted)) return pause('interrupted; /mission resume carries on');
    }
    m.results = m.plan.research.map((j) => m.results.find((r) => r.id === j.id)).filter(Boolean);
    if (!m.results.some((r) => r.ok)) {
      return m.results.some((r) => r.paused) ? pause('the research agents hit their limits') : finish('failed: every research job failed');
    }
    m.phase = 'brief'; m.status = 'writing the brief';
    await checkpoint();
  }

  // 3. Brief + build prompts: local draft, Claude review, the user's go.
  if (m.phase === 'brief' && researchOnly(m.plan)) {
    m.status = 'writing the brief';
    let draft = null;
    let feedback = '';
    for (let round = 0; ; round++) {
      io.status(round ? 'revising the brief (brain)' : 'merging the research into a brief (brain)');
      const raw = await io.local(briefMessages(goal, { results: m.results, feedback, previous: draft, lessons }), { format: briefSchema });
      draft = briefOf(extractJson(raw));
      io.status(draft ? 'Claude is checking the brief against the research' : 'the brain did not produce a brief; Claude is writing it');
      const rev = await io.claude(reviewBriefPrompt(goal, draft, m.results));
      const brief = (rev?.ok ? briefOf(extractJson(rev.text)) : null) || draft;
      if (!brief) return finish('failed: neither the brain nor Claude produced a brief');
      m.build = { brief, build: [] };
      io.show(brief);
      const reply = await io.ask('Done? ok / or say what to change');
      if (GO.test(reply) || STOP.test(reply) || round + 1 >= maxRevisions) break;
      feedback = reply;
      draft = brief;
    }
    return finish('researched');
  }

  if (m.phase === 'brief') {
    m.status = 'writing the brief';
    m.workdir ||= io.workdir(m.plan);
    let bdraft = null;
    let feedback = '';
    for (let round = 0; ; round++) {
      io.status(round ? 'revising the brief and build prompts (local)' : 'merging the research into a brief and writing the build prompts (local)');
      const raw = await io.local(buildMessages(goal, { agents, plan: m.plan, results: m.results, feedback, previous: bdraft, lessons }), { format: buildSchema(agents) });
      bdraft = normalizeBuild(extractJson(raw), agents);
      io.status(bdraft ? 'Claude is checking the brief and build prompts against the research' : 'the local model did not produce a brief; Claude is writing it from the research');
      const rev = await io.claude(reviewBuildPrompt(goal, bdraft, m.results, agents, lessons));
      const better = rev?.ok ? normalizeBuild(extractJson(rev.text), agents) : null;
      if (!better && !bdraft) return finish('failed: neither the local model nor Claude produced a brief');
      if (!better) io.status('Claude\'s review was not usable; showing the local draft');
      m.build = better || bdraft;
      io.show(`${m.build.brief}\n\n${renderBuild(m.build, m.workdir)}`);
      let reply;
      // "folder <path>" only moves the build; ask again without redoing anything.
      for (;;) {
        reply = await io.ask('Build it? go / cancel / folder <path> / or say what to change');
        const folder = /^\s*folder\s+(.+)$/i.exec(reply);
        if (!folder) break;
        m.workdir = folder[1].trim().replace(/^["']|["']$/g, '');
        io.show(renderBuild(m.build, m.workdir));
      }
      if (GO.test(reply)) break;
      if (STOP.test(reply) || round + 1 >= maxRevisions) return finish('cancelled before the build');
      feedback = reply;
      bdraft = m.build;
    }
    m.phase = 'build'; m.status = 'approved, building';
    await checkpoint();
  }

  // 4. Build: one agent, or parts at once in their own worktrees.
  if (m.phase === 'build') {
    m.status = 'building';
    // The work goes on its own branch, never on the branch the folder was on.
    if (io.branch && !m.branch) {
      const b = await io.branch(m);
      if (b?.error) return pause(b.error);
      m.branch = b?.branch;
      await checkpoint();
    }
    const job = { ...m.build.build[0] };
    if (job.parts && io.runParts) {
      job.parts = job.parts.map((p) => ({ ...p }));
      for (const p of job.parts) { p.agent = await gate(p.agent); if (!p.agent) return pause(`${who()} paused it before the build`); }
    } else {
      delete job.parts;
      job.agent = await gate(job.agent);
      if (!job.agent) return pause(`${who()} paused it before the build`);
    }
    const r = job.parts ? await io.runParts(job, m.workdir) : await io.runBuild(job, m.workdir);
    if (r?.interrupted) return pause('interrupted during the build; /mission resume runs it again');
    m.outcomes.push(outcome(job.id, 'build', job.agent, r));
    if (!r?.ok) return r?.paused ? pause(`${job.agent} hit its limit during the build`) : finish(`failed at build (${job.agent})`);
    await commit(`FRIDAY mission: build (${job.agent})`);
    m.fixer = job.agent;
    m.phase = 'verify'; m.status = 'verifying';
    await checkpoint();
  }

  // 5. Verify and fix: tests + reviewers' verdicts; the builder fixes what fails, in its
  // own session; the same problems twice in a row go to another agent; past the cap,
  // The user decides.
  m.status = 'verifying';
  const checks = m.build.build.slice(1);
  let cap = m.fixCap || fixRounds;
  for (;;) {
    const round = m.rounds.length + 1;
    io.status(`verifying, round ${round}: running the tests`);
    const tests = io.verify ? await io.verify(m.workdir, m.build.test_command) : { ran: false };
    const verdicts = [];
    for (const job of checks) {
      let agent = await gate(job.agent);
      if (!agent) return pause(`${who()} paused it during verification`);
      let r = await io.runBuild({ ...job, agent, prompt: checkPrompt(job, tests) }, m.workdir);
      if (r?.interrupted) return pause('interrupted while checking the build');
      if (!r?.ok && r?.paused) return pause(`${agent} hit its limit while checking the build`);
      let v = r?.ok ? parseVerdict(r.text) : null;
      // Blocked: it saw nothing. Another agent does the check once.
      const other = v?.blocked ? io.nextAgent?.(agent) : null;
      if (other) {
        io.status(`${agent} could not check the build (${v.issues[0] || 'blocked'}); ${other} checks it instead`);
        const again = await gate(other);
        if (!again) return pause(`${who()} paused it during verification`);
        agent = again;
        r = await io.runBuild({ ...job, agent, prompt: checkPrompt(job, tests) }, m.workdir);
        if (r?.interrupted) return pause('interrupted while checking the build');
        if (!r?.ok && r?.paused) return pause(`${agent} hit its limit while checking the build`);
        v = r?.ok ? parseVerdict(r.text) : null;
      }
      const verdict = !r?.ok ? `did not run (${failReason(r)})` : !v ? 'no verdict' : v.blocked ? `blocked (${(v.issues[0] || 'no reason given').slice(0, 120)})` : v.pass ? 'pass' : 'fail';
      verdicts.push({ id: job.id, agent, verdict, issues: v && !v.pass && !v.blocked ? v.issues : [] });
    }
    const issues = [
      ...(tests.ran && !tests.ok ? [`The tests fail (\`${tests.command}\`):\n${tests.summary}`] : []),
      ...verdicts.filter((v) => v.verdict === 'fail').flatMap((v) => (v.issues.length ? v.issues.map((x) => `${v.agent}: ${x}`) : [`${v.agent} failed the build without naming a defect; re-check the spec`])),
    ];
    const rec = { round, tests: { ran: !!tests.ran, ok: !!tests.ok, command: tests.command || null, summary: tests.summary || '' }, verdicts, issues };
    m.rounds.push(rec);
    await checkpoint();

    if (!issues.length) {
      const missing = [...(tests.ran ? [] : ['no tests ran']), ...verdicts.filter((v) => v.verdict !== 'pass').map((v) => `${v.agent}: ${v.verdict}`)];
      return built(missing.length ? `built, partly verified (${missing.join('; ')})` : 'built and verified');
    }
    const fixes = m.rounds.filter((r) => r.fixer).length;
    if (fixes >= cap) {
      io.show(`Still failing after ${fixes} fix round${fixes === 1 ? '' : 's'}:\n${issues.map((x) => `- ${x}`).join('\n')}`);
      const reply = await io.ask('more (more fix rounds) / accept (keep it as it is) / stop');
      if (/^\s*more\b/i.test(reply)) { cap += fixRounds; m.fixCap = cap; }
      else if (/^\s*accept\b/i.test(reply)) return built(`built, accepted with ${issues.length} open issue${issues.length === 1 ? '' : 's'}`);
      else return finish(`needs you: ${issues.length} open issue${issues.length === 1 ? '' : 's'} after ${fixes} fix rounds`);
    }
    // The same problems as before the last fix: that agent is stuck; another tries.
    const prev = m.rounds[m.rounds.length - 2];
    if (prev?.fixer && signature(prev.issues) === signature(issues)) {
      const next = io.nextAgent?.(m.fixer);
      if (next) { io.status(`${m.fixer} could not fix this; ${next} takes over`); m.fixer = next; }
    }
    const agent = await gate(m.fixer);
    if (!agent) return pause(`${who()} paused it before a fix`);
    m.fixer = agent;
    rec.fixer = agent;
    const r = await io.runBuild({ id: `fix-${round}`, role: 'fix', agent, prompt: fixPrompt(issues, round) }, m.workdir);
    if (r?.interrupted) { m.rounds.pop(); await checkpoint(); return pause('interrupted during a fix; /mission resume carries on'); }
    m.outcomes.push(outcome(`fix-${round}`, 'fix', agent, r));
    await checkpoint();
    if (!r?.ok) return r?.paused ? pause(`${agent} hit its limit during a fix`) : finish(`failed at fix round ${round} (${agent})`);
    await commit(`FRIDAY mission: fix round ${round} (${agent})`);
  }
}
