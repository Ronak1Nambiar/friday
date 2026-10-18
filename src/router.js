// Decides who handles a message: one agent, a pipeline (implement then review),
// a council, the design pipeline, or a change to FRIDAY itself. Cheap rules first;
// the caller asks a small model only when the rules are unsure. Pure functions,
// so the profile (data) is the only thing that changes the decisions.

export const CATEGORIES = ['code', 'debug', 'review', 'research', 'longContext', 'images', 'writing', 'vault', 'simple', 'chat'];
const AGENT_IDS = ['claude', 'codex', 'gemini', 'opencode', 'ollama'];
const AGENT_RE = '(claude|codex|gemini|opencode|ollama)';

// [regex, weight] per category.
const SIGNALS = {
  vault: [
    [/\bwhat (did|have) i (decide|decided|say|said|pick|picked|choose|chose)\b/, 3],
    [/\b(second brain|vault|obsidian|daily note|now block|critical facts)\b/, 2.5],
    [/\bmy (notes|priorities|projects|decisions|plans?|todo|tasks)\b/, 2],
    [/\bwhat'?s next\b|\bnext steps?\b|\bwhere (am|was) i\b|\bstatus of\b/, 1.5],
    [/\b(ingest|lint|weekly review|today'?s (top|plan))\b/, 2],
    [/\bdecid(e|ed|ing)\b|\bdecisions?\b/, 1],
  ],
  research: [
    [/\bresearch\b/, 3],
    [/\blook (it |this )?up\b|\bsearch (the web|online|for)\b|\bgoogle\b|\bon the web\b/, 2.5],
    [/\b(latest|news|recent|currently|this (week|month|year))\b/, 1],
    [/\bcompare\b|\bvs\.?\b|\balternatives?\b|\bbest \w+ for\b/, 1],
    [/\bhow much (does|is|do)\b|\bprices?\b|\bin stock\b/, 1],
    [/\bsources?\b|\bcite\b|\bcitations?\b|\bpapers?\b|\bstud(y|ies)\b/, 1],
  ],
  longContext: [
    [/\b\d{2,}\s*(pages?|pdfs?|files|documents|docs|chapters)\b/, 3],
    [/\b(whole|entire|full) (repo|repository|codebase|book|document|transcript)\b|\ball (the )?files\b/, 2.5],
    [/\bpdfs?\b|\blong (document|doc|transcript|report)\b|\btranscripts?\b/, 1.5],
  ],
  images: [
    [/\b(images?|screenshots?|photos?|pictures?|diagrams?|figures?)\b|\.(png|jpe?g|webp|gif)\b/, 2],
  ],
  debug: [
    [/\bfailing tests?\b|\btests? (are |is )?fail(ing|s)?\b|\bred tests?\b/, 3],
    [/\bdebug\b|\bstack ?trace\b|\btraceback\b|\bcrash(es|ed|ing)?\b|\bexception\b|\bsegfault\b/, 2.5],
    [/\bfix\b|\bbugs?\b|\berrors?\b|\bbroken\b|\b(does ?n'?t|won'?t|not) work(ing)?\b/, 1.5],
  ],
  code: [
    [/\b(write|add|build|create|implement) (a |an |the |some )?(script|function|tests?|component|cli|command|feature|page|endpoint|module|class|parser)\b/, 2.5],
    [/\bimplement\b|\brefactor\b|\bmigrate\b|\bendpoint\b|\bmulti-?file\b|\barchitecture\b|\bcodebase\b/, 1.5],
    [/\bcode\b|\brepo\b|\bfunction\b|\bapi\b|\.(js|ts|tsx|jsx|py|cs|swift|go|rs|mjs)\b/, 1],
  ],
  review: [
    [/\b(code )?review\b|\baudit\b|\bcheck (my|this|the) (code|diff|pr|change|changes|commit)\b/, 2.5],
    [/\bsecond (pair of eyes|look)\b/, 1],
  ],
  writing: [
    [/\b(write|draft|rewrite|edit|polish|proofread|tighten)\b.{0,40}\b(email|essay|post|readme|docs?|letter|bio|paragraph|statement|copy|message|tweet|thread|proposal|abstract|announcement|outline|story)\b/, 3],
    [/\b(email|essay|cover letter|blog post|linkedin|tweet)\b/, 1.5],
  ],
  simple: [
    [/\b(quick(ly)?|simple|tiny|one-?liner|trivial)\b/, 1],
    [/\b(rename|translate|reformat|convert|spell ?check|bulk|batch|regex|word count|sort these|list of)\b/, 1.5],
  ],
};

const REVIEW_REQUEST = new RegExp([
  `\\b(have|get|let|ask) (someone|somebody|another (agent|ai|model)|a reviewer|${AGENT_RE.slice(1, -1)}) (else )?(to )?(check|review|look (at|over)|verify|double-check)`,
  '\\b(and|then) (have it |get it )?(reviewed|review(ed)? it|check(ed)? it|double-check|verify the)\\b',
  '\\bpeer review\\b|\\bcross-?check\\b|\\bsecond (pair of eyes|opinion) on (the|my) (fix|change|code)\\b',
].join('|'));
const PLAN_REQUEST = /\bplan (it|this|that) (out|first)\b|\bplan,? (then )?(implement|build)\b|\b(design|architect|plan) and (build|implement)\b|\bplan, implement\b/;
const COUNCIL = /\bcouncil\b|\bask (everyone|all of you|every (agent|ai|model))\b|\bwhat do you all think\b|\bcompare (your|the|all) (answers|opinions|takes)\b|\bsecond opinions\b|\ball (the )?(agents|ais|models)\b/;
const DESIGN = /\bre-?design\b|\bmock ?-?ups?\b|\bwireframes?\b|\blanding page\b|\bnew (screen|page|layout|theme|look)\b|\bvisual (design|refresh)\b|\brestyle\b|\b(ui|ux) (overhaul|refresh|redesign)\b|\blook and feel\b|\bdesign (a|the|an) (new )?(screen|page|ui|layout|dashboard|onboarding|theme)\b/;
// Talking to FRIDAY about FRIDAY.
const SELF_TARGET = /\b(friday|yourself|your (own )?(code|source|prompt|routing|hud|colou?rs?|keybind\w*|settings|profile|commands?)|the (hud|cockpit|route line|prompt line))\b/;
const SELF_VERB = /\b(add|make|change|show|display|let|give|remove|stop|put|turn|use|switch|support|teach|set|rename|move|hide|draw)\b/;
const STANDING = /\b(from now on|going forward|always|never|by default|every time|in future|from here on)\b/;
const ROUTE_RULE = new RegExp(`\\b(route|send|give|hand|direct|use|prefer)\\b.{0,60}\\b(to|for|with)?\\s*${AGENT_RE}\\b|\\b${AGENT_RE}\\b.{0,30}\\b(should )?(handle|take|do|get)s?\\b`);

export function scoreCategories(text) {
  const t = text.toLowerCase();
  const scores = {};
  for (const [cat, sigs] of Object.entries(SIGNALS)) {
    let s = 0;
    for (const [re, w] of sigs) if (re.test(t)) s += w;
    if (s) scores[cat] = s;
  }
  if (t.split(/\s+/).length <= 6 && scores.simple) scores.simple += 0.5;
  return scores;
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Sealed projects (profile.private.sealed): nothing about them leaves this machine.
// A mention, or being focused on one, is enough; no override sends it to a cloud agent.
export function sealedProject(text, { profile, focus } = {}) {
  const t = (text || '').toLowerCase();
  for (const name of profile.private?.sealed || []) {
    const n = name.toLowerCase();
    if (new RegExp(`\\b${escRe(n)}\\b`).test(t) || (focus && focus.toLowerCase().includes(n))) return name;
  }
  return null;
}

// Why a cloud agent may not take this turn, or null. Checks the text, the focus and
// the folder the agent would run in (a sealed project's folder or anything inside it).
export function cloudBlock({ agent, text, cwd, profile, focus, sealedDirs = [] }) {
  if (profile.agents?.[agent]?.cloud === false) return null;
  const s = sealedProject(text, { profile, focus });
  if (s) return `${s} is sealed: it never leaves this machine`;
  const norm = (p) => (p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const c = norm(cwd);
  const d = sealedDirs.find((x) => x && (c === norm(x) || c.startsWith(norm(x) + '/')));
  if (d) return `this folder belongs to a sealed project (${d}); it never leaves this machine`;
  return null;
}

export function isPrivate(text, { profile, focus } = {}) {
  const t = text.toLowerCase();
  const p = profile.private;
  const sealed = sealedProject(t, { profile, focus });
  if (sealed) return { why: `${sealed} is sealed`, sealed };
  for (const src of p.patterns) {
    let re;
    try { re = new RegExp(src, 'i'); } catch { continue; }
    const m = re.exec(t);
    if (m) return { why: `"${m[0]}"` };
  }
  const data = p.dataWords.some((w) => new RegExp(`\\b${w}\\b`).test(t));
  const proj = p.projects.find((name) => new RegExp(`\\b${name}\\b`).test(t)
    || (focus && focus.toLowerCase().includes(name)));
  if (proj && data) return { why: `${proj} data` };
  return null;
}

// First agent in the chain that is ready; notes say why earlier ones were skipped.
export function pick(chain, ready, notes = []) {
  for (const id of chain) {
    if (!id) continue;
    if (ready(id)) return id;
    notes.push(`${id} ${ready.why?.(id) || 'unavailable'}`);
  }
  return null;
}

function namedAgent(t) {
  const m = new RegExp(`^(?:ask|have|let|get|tell) ${AGENT_RE}\\b`).exec(t)
    || new RegExp(`^${AGENT_RE}[,:]`).exec(t);
  return m?.[1] || null;
}

// route(text, { profile, ready(id) -> bool, focus }) -> a plan:
// { kind: single|pipeline|council|design|self, category, steps: [{agent, role}],
//   private, confidence, unsure, reason, notes }
export function route(text, { profile, ready = () => true, focus = null } = {}) {
  const t = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const notes = [];
  const plan = (o) => ({ kind: 'single', category: null, steps: [], private: false, confidence: 1, unsure: false, reason: '', notes, ...o });

  // 1. Private data never leaves the machine: no fallback, no classifier.
  const priv = isPrivate(t, { profile, focus });
  if (priv) {
    return plan({ category: 'private', private: true, sealed: priv.sealed || null, steps: [{ agent: profile.private.agent, role: 'answer' }],
      reason: `private: ${priv.why}, stays on this machine` });
  }

  // 2. Design work goes to Claude Design (before self, so "redesign the HUD" is design).
  if (DESIGN.test(t)) {
    return plan({ kind: 'design', category: 'design', steps: [
      { agent: 'claude', role: 'design' }, { agent: 'implement', role: 'implement' },
      { agent: 'review', role: 'review' }, { agent: 'claude', role: 'resync' }],
    reason: 'UI design: Claude Design first, code only after approval' });
  }

  // 3. Changes to FRIDAY itself, only when asked in so many words.
  const selfAsk = (STANDING.test(t) && (ROUTE_RULE.test(t) || SELF_TARGET.test(t) || /\b(tell|ask|instruct) \w+ to\b/.test(t)))
    || (SELF_TARGET.test(t) && SELF_VERB.test(t));
  if (selfAsk) return plan({ kind: 'self', category: 'self', reason: 'change to FRIDAY itself' });

  // 4. Council on request.
  if (COUNCIL.test(t)) return plan({ kind: 'council', category: 'council', reason: 'asked for everyone' });

  const scores = scoreCategories(t);

  // 5. Build-and-check pipelines.
  const codey = (scores.debug || 0) + (scores.code || 0) >= 1.5;
  if (codey && (REVIEW_REQUEST.test(t) || PLAN_REQUEST.test(t))) {
    const key = PLAN_REQUEST.test(t) ? 'planImplementReview' : 'implementReview';
    const named = new RegExp(`\\b(have|get|let|ask) ${AGENT_RE}\\b.{0,20}\\b(check|review|verify|look)`).exec(t)?.[2];
    const steps = [];
    for (const s of profile.pipelines[key]) {
      let chain = [s.agent, ...(s.fallback || [])];
      if (named && s.role === 'review') chain = [named, ...chain];
      const used = steps.filter((x) => x.role === 'implement').map((x) => x.agent);
      // A reviewer different from the implementer, when there is one.
      if (s.role === 'review') chain = [...chain.filter((a) => !used.includes(a)), ...chain.filter((a) => used.includes(a))];
      if (s.role === 'implement' && named) chain = [...chain.filter((a) => a !== named), named];
      const agent = pick(chain, ready, notes);
      if (agent) steps.push({ agent, role: s.role, chain }); // chain: who takes over if it fails
    }
    if (steps.length >= 2) {
      return plan({ kind: 'pipeline', category: scores.debug >= (scores.code || 0) ? 'debug' : 'code', steps,
        reason: key === 'planImplementReview' ? 'plan, build, then an independent review' : 'build, then an independent review' });
    }
  }

  // 6. Named agent in plain words ("ask gemini ...").
  const named = namedAgent(t);
  if (named && ready(named)) return plan({ category: 'named', steps: [{ agent: named, role: 'answer' }], reason: `you named ${named}` });

  // 7. One agent by category.
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [top, second] = ranked;
  let category = top?.[0] || 'chat';
  const margin = top ? top[1] - (second?.[1] || 0) : 0;
  const unsure = !top || top[1] < 1.5 || margin < 0.75;
  const confidence = top ? Math.min(1, top[1] / 3) * (second ? Math.min(1, margin / 1.5) : 1) : 0;
  if (!top) category = 'chat';
  return single(category, { profile, ready, notes, unsure, confidence, plan,
    reason: top ? `${category}${second ? ` over ${second[0]}` : ''}` : 'no strong signal' });
}

function single(category, { profile, ready, notes, unsure, confidence, plan, reason }) {
  const cat = profile.categories[category] || profile.categories.chat || {};
  const chain = [cat.agent, ...(cat.fallback || [])];
  let agent = pick(chain, ready, notes);
  if (!agent && cat.strict) {
    return plan({ category, unsure: false, confidence, steps: [{ agent: cat.agent, role: 'answer' }],
      reason: `${reason}; ${category} is pinned to ${cat.agent}`, blocked: `${cat.agent} is not available (${notes.join('; ')})` });
  }
  if (!agent) agent = pick([profile.default, ...AGENT_IDS.filter((a) => a !== 'ollama')], ready, notes);
  return plan({ category, unsure, confidence, steps: agent ? [{ agent, role: 'answer' }] : [], reason });
}

// Re-route once the small model has picked a category.
export function routeCategory(category, { profile, ready = () => true } = {}) {
  const notes = [];
  const plan = (o) => ({ kind: 'single', category, steps: [], private: false, confidence: 0.6, unsure: false, reason: '', notes, ...o });
  return single(category, { profile, ready, notes, unsure: false, confidence: 0.6, plan, reason: `${category} (model)` });
}

export function classifierPrompt(text) {
  return `Classify the request into exactly one category and reply with only that word.
Categories:
code: write or change code ("add a dark mode toggle")
debug: find why something fails or fix a bug ("npm install fails with EACCES")
review: review code or a diff ("look over my last commit")
research: needs current facts from the web ("latest version of node")
longContext: very long input ("summarize this 80 page pdf")
images: about images or screenshots ("what is in this screenshot")
writing: prose to be written ("draft an email")
vault: the user's own projects, plans, priorities, decisions or notes, including how a project is going or what to work on ("how is my app doing", "what did I decide about pricing")
simple: quick mechanical task ("rename foo to count", "translate this to spanish")
chat: questions, explanations, conversation ("explain how X works")

Request: ${text.slice(0, 1500)}`;
}

export function parseCategory(reply) {
  const w = (reply || '').toLowerCase();
  const hits = CATEGORIES.map((c) => [c, w.search(new RegExp(`\\b${c.toLowerCase()}\\b`))]).filter(([, i]) => i >= 0);
  hits.sort((a, b) => a[1] - b[1]);
  return hits[0]?.[0] || null;
}

// The dim line printed before a turn.
export function describeRoute(p) {
  const note = p.notes.length ? ` (${p.notes.join('; ')})` : '';
  if (p.blocked) return `-> ${p.steps[0].agent} only: ${p.blocked}`;
  switch (p.kind) {
    case 'single':
      if (!p.steps.length) return `-> no agent available${note}`;
      return `-> ${p.steps[0].agent}${p.private ? ' only, local' : ''} · ${p.reason}${note}`;
    case 'pipeline': {
      const words = p.steps.map((s, i) => (i === 0 ? `${s.agent}${s.role === 'plan' ? ' plans' : ''}`
        : s.role === 'review' ? `then ${s.agent} reviews` : `then ${s.agent} ${s.role === 'implement' ? 'implements' : s.role}`));
      return `-> ${words.join(', ')} · ${p.reason}${note}`;
    }
    case 'council': return `-> council · ${p.reason}`;
    case 'design': return '-> claude design (interactive pane), then implement, review, re-sync on your OK';
    case 'self': return '-> self-change · FRIDAY edits itself';
    default: return `-> ${p.kind}`;
  }
}
