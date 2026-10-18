// The orchestrator: the brain (a cloud model via OpenRouter, or a small local Ollama
// model; src/brain.js) decides what to do with each message and uses the agents as
// tools. It answers small things itself, delegates real
// work (files, code, tests, research, writing) to the agent best at it, reads the
// result, and may call another agent (a review, a second opinion) before it stops.
// Agents' answers stream to the user as they come; the orchestrator adds at most a
// short closing line. Private and sealed messages never get here (see cockpit).

import { chat } from './brain.js';
import { REMEMBER_TOOL } from './memory.js';
import { dispatchTool } from './tree.js';
import { cap, userName, userPossessive } from './user.js';

// A mission: FRIDAY leads a multi-phase job itself (src/mission.js).
export const MISSION_TOOL = {
  type: 'function',
  function: {
    name: 'start_mission',
    get description() { return `Lead a multi-phase job: research and validate first (market, users, risks, technical needs, by several agents), then write the build prompts and build; or, when nothing is to be built, end with a researched brief. Use when ${userName()} wants something built or launched that also needs research, planning or validation first, or asks for a researched recommendation (e.g. what to add to a project, which option to pick) that needs several sources.`; },
    parameters: { type: 'object', properties: { goal: { type: 'string', get description() { return `${cap(userPossessive())} goal, in their words.`; } } }, required: ['goal'] },
  },
};

// One tool per ready cloud agent, described by its strengths from the profile, and
// `dispatch` (the agent tree, src/tree.js) when any limb can run.
export function agentTools(agents, profile, { missions = false, remember = false, limbs = [] } = {}) {
  return [...(missions ? [MISSION_TOOL] : []), ...(remember ? [REMEMBER_TOOL] : []), ...agentList(agents, profile),
    ...(limbs.length ? [dispatchTool(limbs, profile.tree)] : [])];
}
function agentList(agents, profile) {
  return agents.map((id) => ({
    type: 'function',
    function: {
      name: `ask_${id}`,
      description: `${id}: ${(profile.agents?.[id]?.strengths || []).join('; ')}`,
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'What this agent should do: complete and self-contained, with every file name, constraint and detail from the request. For a review, say what to review.' },
        },
        required: ['task'],
      },
    },
  }));
}

export function systemPrompt({ agents, focus, cwd, mode, missions = false, memory = '', limbs = [] }) {
  return [
    `You are FRIDAY, ${userPossessive()} orchestrator. You decide; the agents do the work.`,
    `Agents you can call as tools: ${agents.join(', ')}. Pick by their descriptions.`,
    ...(limbs.length ? [`You are the root of an agent tree: dispatch runs many subagents at once on ${limbs.join(', ')}, each with its own model, and gives you all their answers. Use it when the work splits into independent parts, or when ${userName()} asks for several agents or models at once (e.g. "five sonnets", "have every agent check this"); give each part everything it needs. Simple parts get tier small, hard ones tier large. One agent call is still right for a single task. After a dispatch you write the combined answer yourself: ${userName()} has not seen the parts.`] : []),
    'Delegate anything that needs reading or changing files, running code or tests, debugging, reviewing, web research, or writing more than a few sentences.',
    'Answer directly, without tools, only for greetings, thanks, or a quick fact you are sure of. Never pretend to have read files.',
    // Claude's process stays up between turns (~1-3 s an answer); the others start cold (codex ~12 s).
    ...(agents.includes('claude') ? ['ask_claude answers fastest: use it for questions, explanations, short reads of a file or two, and small edits. Use another agent when its description fits the work better (long implementation, debugging, test runs, research).'] : []),
    ...(missions ? [`If ${userName()} wants something built or launched that also needs research, validation or planning first, call start_mission with their goal instead of asking one agent: FRIDAY then leads it in phases. Also call it for a researched recommendation that needs several sources (market, users, the code); a plain question goes to one agent.`] : []),
    'Work one step at a time. Usually one agent is enough. Call a second agent only if the request asks for a check, review or second opinion, or the first agent failed: then call a different agent.',
    'After an agent has answered, the user has already seen its full answer: do not repeat it. Either call another agent if the request still needs it, or end with one short sentence (or nothing).',
    `Context: working folder ${cwd}${focus ? `, project ${focus}` : ''}, mode ${mode}.`,
    ...(memory ? [
      'Your memory of earlier conversations is below. Use it: "what did we do last?" or "what did we talk about?" you answer from it yourself; for "continue that" or "pick up where we left off", call the right agent and put what it needs from your memory (files, project, what is left to do) into its task. When the user tells you to remember something, call remember.',
      `[Memory]\n${memory}\n[end memory]`,
    ] : []),
  ].join('\n');
}

// Tool arguments arrive as an object or a JSON string, depending on the model.
export function parseCall(call) {
  const name = call?.function?.name || '';
  let args = call?.function?.arguments ?? {};
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = { task: args }; } }
  if (name === 'start_mission') return { name, agent: null, mission: true, task: String(args?.goal ?? args?.task ?? '').trim() };
  if (name === 'remember') return { name, agent: null, remember: true, task: String(args?.fact ?? args?.task ?? '').trim() };
  if (name === 'dispatch') {
    let tasks = args?.tasks;
    if (typeof tasks === 'string') { try { tasks = JSON.parse(tasks); } catch { tasks = []; } }
    return { name, agent: null, dispatch: true, tasks: Array.isArray(tasks) ? tasks : [], task: '' };
  }
  const m = /^ask_(\w+)$/.exec(name);
  return { name, agent: m ? m[1] : null, task: String(args?.task ?? '').trim() };
}

// The agent gets the orchestrator's task and, unless the task already carries them,
// The user's own words, so nothing they asked for is lost in a small model's summary.
export function agentPrompt(task, original) {
  const words = (s) => new Set((s.toLowerCase().match(/[a-z0-9_./-]{3,}/g) || []));
  const o = words(original);
  const t = words(task || '');
  const kept = o.size ? [...o].filter((w) => t.has(w)).length / o.size : 1;
  if (!task) return original;
  if (kept >= 0.9) return task;
  return `${task}\n\n${cap(userPossessive())} request, in their words:\n${original}`;
}

// Does this message need an agent with tools (files, code, the repo, the web)? A small
// model will happily "answer" these from nothing; FRIDAY does not let it.
const NEEDS_TOOLS = [
  /(?:^|[\s"'`(])[\w.-]*[\w-]\.(?:js|mjs|cjs|ts|tsx|jsx|py|md|json|ya?ml|toml|cs|swift|html|css|sh|ps1|txt|go|rs|java|c|cpp|h)\b/i, // a file name
  /(?:^|\s)(?:\.{0,2}\/|~\/|[a-z]:\\)?[\w.-]+[\/\\][\w.\/\\-]+/i, // a path
  /\b(read|open|look at|check|grep|search|scan|run|execute|install|build|compile|deploy|test|tests|debug|fix|refactor|implement|edit|change|rename|review|diff|commit|branch|merge|push|pull request|pr #?\d+)\b/i,
  /\b(this|the|my|our) (repo|repository|codebase|project|folder|file|files|code|function|class|module|script|app|readme)\b/i,
  /\b(latest|current|today|recent|news|price|release|web|online|search the)\b/i,
];
export const needsTools = (text) => NEEDS_TOOLS.some((re) => re.test(text));

// "What did we work on last?": answered from memory, so the brain may reply itself.
const MEMORY_Q = /\b(remember|last time|we (worked|talked|did|were|spoke|discussed)|earlier|previous(ly)?|before|left off|yesterday|last (session|chat|conversation|thing)|what(?:'s| is| was| are| were) (my|our))\b/i;
export const aboutMemory = (text) => MEMORY_Q.test(text);

// Does this message ask for more than one agent step (work, then a check of it)?
// Otherwise the first good answer ends the turn without asking the local model again.
const FOLLOW_UP = /\b(review|reviewed|check|checked|verify|double[- ]?check|cross[- ]?check|second opinion|compare|then|after that|and (have|ask|get|let)|both|each|all of them)\b/i;
export const wantsFollowUp = (text) => FOLLOW_UP.test(text);

// One brain call (cloud or local, src/brain.js). Never throws: { ok, message?, ms, reason? }.
export async function step({ brain, model, messages, tools, timeoutMs = 10000, keepAlive = '30m', fetchImpl = globalThis.fetch, base }) {
  return chat(brain || { provider: 'ollama', model }, { messages, tools, timeoutMs, keepAlive, fetchImpl, base });
}

// The loop. `callAgent(agent, prompt, { task })` runs a turn (streaming it to the
// user) and returns { ok, text } or null when it could not run. `on` gets:
// decide(ms), delegate(agent, task), answer(text), note(text), fail(reason), and
// remember(fact) -> bool (offers the brain a remember tool; context.memory is its memory).
// Returns { handled, calls: [{ agent, ok }], final } ; handled=false means fall back
// to the rules (the model could not be reached before anything happened).
export async function orchestrate(text, { agents, profile, brain, history = [], context, callAgent, on = {}, fetchImpl, base, defaultAgent = 'claude', missions = false, limbs = [] }) {
  const o = profile.orchestrator;
  let avail = [...agents]; // an agent that fails is dropped for the rest of this message
  const remember = !!on.remember;
  if (!on.dispatch) limbs = [];
  let tools = agentTools(avail, profile, { missions, remember, limbs });
  const messages = [{ role: 'system', content: systemPrompt({ agents, missions, limbs, ...context }) }, ...history, { role: 'user', content: text }];
  const calls = [];
  const seen = new Set();
  let final = '';
  let lastText = '';
  let lastTask = text;
  let pushedBack = false;
  let nudge = null; // FRIDAY's push-back: sent to the model, not kept in its memory
  for (let i = 0; i < (o.maxSteps || 4); i++) {
    on.thinking?.();
    const r = await step({ brain, model: o.model, messages, tools, timeoutMs: brain?.cloud ? (o.cloudTimeoutMs || 30000) : o.timeoutMs, keepAlive: o.keepAlive, fetchImpl, base });
    on.decide?.(r.ms);
    if (!r.ok) {
      if (!calls.length) return { handled: false, calls, reason: r.reason };
      on.fail?.(r.reason);
      break;
    }
    const m = r.message;
    messages.push({ role: 'assistant', content: m.content || '', ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}) });
    const wanted = (m.tool_calls || []).map(parseCall);
    // It tried to answer a files/code/web question itself. Tell it once; if it does it
    // again, the agent the rules would pick gets the message.
    if (!wanted.length && !calls.length && needsTools(text) && !aboutMemory(text)) {
      if (!pushedBack) {
        pushedBack = true;
        messages.pop();
        nudge = { role: 'user', content: 'You cannot read files, run code or browse. Delegate this to the best agent now by calling its tool.' };
        messages.push(nudge);
        continue;
      }
      const to = avail.includes(defaultAgent) ? defaultAgent : avail[0];
      if (to) { on.fallback?.('the local model', to); wanted.push({ name: `ask_${to}`, agent: to, task: text }); }
    }
    // The last agent failed and the model gave up although another agent is ready:
    // hand the same task to the next one ourselves (once per failure).
    if (!wanted.length && calls.length && !calls.at(-1).ok && !calls.at(-1).retried && avail.length) {
      const last = calls.at(-1);
      last.retried = true;
      on.fallback?.(last.agent, avail[0]);
      wanted.push({ name: `ask_${avail[0]}`, agent: avail[0], task: lastTask, fallback: true });
    }
    if (!wanted.length) {
      final = (m.content || '').trim();
      // After agents ran, keep only a closing line that adds something: none after a
      // failure (a small model will claim success), none that restates the answer.
      if (calls.length && (!calls.at(-1).ok || restates(final, lastText))) final = '';
      if (final) (calls.length ? on.note : on.answer)?.(final);
      break;
    }
    // A mission is FRIDAY's to lead: hand it back before any agent runs.
    const ms = wanted.find((c) => c.mission);
    if (ms && missions && !calls.length) return { handled: true, calls, final: '', mission: ms.task || text, transcript: [] };
    for (const c of wanted) {
      let content;
      const key = `${c.agent}\0${c.task}`;
      if (c.dispatch) {
        const key = `dispatch\0${JSON.stringify(c.tasks)}`;
        if (!limbs.length) content = `error: no tool dispatch. Available: ${avail.map((a) => `ask_${a}`).join(', ') || 'none'}`;
        else if (!c.tasks.length) content = 'error: dispatch needs tasks: [{limb, tier, task, writes}].';
        else if (seen.has(key)) content = 'error: you already dispatched exactly this. Write the answer or do something else.';
        else {
          seen.add(key);
          const r = await on.dispatch(c.tasks);
          calls.push({ agent: 'tree', ok: !!r?.ok, dispatch: true });
          lastText = '';
          content = r?.report || 'error: the subagents did not run.';
        }
      } else if (c.remember && remember) content = c.task && on.remember(c.task) ? 'saved to memory. Now tell the user, in a few words.' : 'error: not saved (empty, or it is private).';
      else if (!c.agent || !avail.includes(c.agent)) content = `error: no tool ${c.name}. Available: ${avail.map((a) => `ask_${a}`).join(', ') || 'none'}`;
      else if (seen.has(key)) content = 'error: you already asked this agent exactly this. Do something else or finish.';
      else {
        seen.add(key);
        on.delegate?.(c.agent, c.task || text);
        lastTask = c.task || text;
        // The next agent after one that stopped partway finishes the job, whatever task
        // the model wrote for it (a small model just repeats the original).
        const prior = calls.findLast((x) => x.partial && !x.handedOff && x.agent !== c.agent);
        if (prior) prior.handedOff = true;
        const prompt = agentPrompt(c.task, text);
        const res = await callAgent(c.agent, prior ? continueTask(prompt, prior) : prompt, { task: c.task });
        // An agent that stopped partway (a usage limit mid-job) has already changed things.
        const partial = !res?.ok && res?.text?.trim() ? res.text.trim().slice(-600) : '';
        calls.push({ agent: c.agent, ok: !!res?.ok, ...(partial ? { partial, why: (res.errors || []).join('; ').slice(0, 200) } : {}) });
        lastText = res?.text || '';
        if (res?.ok) content = `done. Answer (the user has seen it in full):\n${lastText.slice(-(o.resultChars || 1500))}`;
        else {
          // Take the agent out and point the model at the next one.
          avail = avail.filter((a) => a !== c.agent);
          tools = agentTools(avail, profile, { missions: missions && !calls.length, remember, limbs });
          const why = !res ? 'NOT RUN: blocked or unavailable' : `FAILED: ${(res.errors || []).join('; ').slice(0, 300) || 'error'}`;
          content = partial
            ? `${why}. ${c.agent} stopped partway: it already did part of the work (files may be changed). Its last words: "${partial}". Do not say it succeeded. ${c.agent} is unavailable now.`
              + (avail.length ? ` Call ask_${avail[0]} to finish it: tell it to check the current state first (git status, git diff), then do only what is left of the task, not redo finished work.` : ' No other agent is available: tell the user what was done and what is left, in two sentences.')
            : `${why}. Nothing was done; do not say it succeeded. ${c.agent} is unavailable now.`
              + (avail.length ? ` Call ask_${avail[0]} with the same task now.` : ' No other agent is available: tell the user in one sentence.');
        }
      }
      messages.push({ role: 'tool', tool_name: c.name, content });
    }
    // The answer is in and nothing more was asked for: done, without another model call.
    if (!o.alwaysFollowUp && calls.at(-1)?.ok && !calls.at(-1).dispatch && !wantsFollowUp(text)) {
      messages.push({ role: 'assistant', content: '' });
      break;
    }
  }
  // The parts came back but no combined answer (none written, or out of steps): show the parts.
  if (!final && calls.at(-1)?.dispatch) on.unsummarized?.();
  // This exchange as real messages (tool results cut short) for the next message's memory.
  const transcript = messages.slice(1 + history.length).filter((x) => x !== nudge).map((x) => (x.role === 'tool' ? { ...x, content: x.content.slice(0, 600) } : x));
  if (transcript.at(-1)?.role === 'assistant' && !transcript.at(-1).tool_calls) transcript.at(-1).content = final;
  return { handled: true, calls, final, transcript };
}

// The task for the agent that takes over from one that stopped partway: finish, don't redo.
export function continueTask(task, { agent, partial, why }) {
  return `${task}\n\n${agent} already started this and stopped partway${why ? ` (${why})` : ''}. What it reported last:\n"${partial}"\nFirst check the current state (git status, git diff, the files it touched), then do only what is left. Do not redo work that is already done; say what you finished.`;
}

// Does this closing line mostly repeat the agent's answer? (half its words are in it)
export function restates(note, answer) {
  const w = (s) => (s.toLowerCase().match(/[a-z0-9]{4,}/g) || []);
  const n = w(note);
  if (!n.length || !answer) return false;
  const a = new Set(w(answer));
  return n.filter((x) => a.has(x)).length / n.length >= 0.5;
}

// What the next message's orchestrator remembers: the last `keep` exchanges, as the
// real messages (the user's words, its tool calls, short results), so it can resolve
// "have codex check that" without a summary format it might copy into answers.
export function rememberExchange(history, transcript = [], keep = 3) {
  const all = [...history, ...transcript];
  const starts = all.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i >= 0);
  return starts.length > keep ? all.slice(starts[starts.length - keep]) : all;
}
