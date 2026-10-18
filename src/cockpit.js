// The terminal cockpit: one prompt in front of every agent.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { abilityLines } from './abilities.js';
import { AGENTS, MODES, availableAgents, closeLive, describeTool, geminiLoggedIn, ollamaLoaded, ollamaUp, runTurn, sessionExited, settleAgents, touchedPaths, warmLive, which } from './agents.js';
import { createLedger, detectBilling } from './billing.js';
import { addTurn, ago, createConvoStore, dumpSessions, loadSessions, newConvo, summarize } from './convos.js';
import {
  commitAll, createDsPrompt, designPrompt, designWorktree, findDesignSystem, implementPrompt, paneCommand,
  readHandoff, resyncPrompt, reviewPrompt, testCommandFor, watchHandoff,
} from './design.js';
import { createHud, openWindow } from './hud-server.js';
import { createThemeStore, findImagePath, isThemeRequest, parseThemeReply, themeProblems, themePrompt } from './hudtheme.js';
import { learn, liveProfile, readOverrides, recordOverride } from './profile.js';
import { orchestrate, rememberExchange } from './orchestrator.js';
import { brainMenu } from './brainmenu.js';
import { createMemory, summaryPrompt } from './memory.js';
import { runInteractive } from './signin.js';
import { CLOUD_MODELS, brainStatus, chat, keyHint, loadKey, openBrowser, resolveBrain, saveKey, signInOpenRouter, warmBrain } from './brain.js';
import { createTelegram } from './telegram.js';
import {
  LESSONS_PATH, defaultMissionDir, lessonsSchema, missionMarkdown, missionStateStore, parseLessons, partPrompt, pickHeadroom, recentLessons, runMission, slugify,
  vaultMissionPath, writeMissionFolder,
} from './mission.js';
import { ensureRepo, hasRemote, mergeParts, missionBranch, openPr, outsideOwned, partWorktree, removeWorktree } from './missiongit.js';
import { curate, logEntry, readLog, shouldRewrite, summarizeLog, warmWriter, writerStatus } from './promptwriter.js';
import { detectProject, expandHome, findProject, loadRegistry, scanProject } from './projects.js';
import { acquire, answerRun, askByFile, autoAnswer, findRun, listRuns, logTail, readRun, runsDir, workerFor, writeRun } from './missionrun.js';
import { createAsker, parseChoices } from './asker.js';
import { commandCatalog, createSuggester } from './suggest.js';
import { createQueueBox } from './inputbox.js';
import { AMBER, CYAN, GREEN, RED, bold, c, createStream, dim, fmtMs, gradient, paint, tty, wrapText } from './render.js';
import { classifierPrompt, cloudBlock, describeRoute, isPrivate, parseCategory, route, routeCategory } from './router.js';
import { applySettingsChange, codeChange, createSelfHistory, parseSettingsChange, repoRoot, runTests, testFailureSummary, undoSelf } from './selfmod.js';
import { createVaultQueue, denyGlob, ollamaSystem, parseProposals, vaultAccess, vaultStatus, writeAgentContext } from './vault.js';
import { cap, setUserName, userName, userPossessive } from './user.js';

const FRIDAY_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'friday.js');
const FRIDAY_ROOT = path.dirname(path.dirname(FRIDAY_BIN));
// Exit code that tells the supervisor in bin/friday.js to restart into the same conversation.
export const RESTART_CODE = 75;
// Where self-change worktrees go. Not under ~/.claude or a repo's .claude/: Claude Code
// refuses headless edits in those paths.
const DATA_DIR = process.env.FRIDAY_DATA || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'friday');
const SELF_WORKTREES = path.join(DATA_DIR, 'self-worktrees');
const DESIGN_WORKTREES = path.join(DATA_DIR, 'design-worktrees');
const MISSION_WORKTREES = path.join(DATA_DIR, 'mission-worktrees');
// An agent stopped by its plan's usage limit: the mission pauses (resumable), not fails.
const LIMIT_ERROR = /session limit|usage limit|rate limit|limit reached|hit your limit|quota/i;
// FRIDAY_CONFIG: another config folder (a clean first run, the mission benchmark).
export const CONFIG_DIR = process.env.FRIDAY_CONFIG ? path.resolve(process.env.FRIDAY_CONFIG) : process.platform === 'win32'
  ? path.join(process.env.APPDATA || os.homedir(), 'friday')
  : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'friday');

const DEFAULTS = {
  roots: ['~/Projects', '~/Work', '~/Downloads'],
  vault: '~/SecondBrain',
  port: 7777,
  browser: null,
  defaultAgent: null,
  mode: 'edit',
  autoHud: false, // opt-in: friday setup asks, /hud on|off changes it; /hud opens it once
  hud: 'terminal', // or 'web'
  ollamaModel: null,
  // Direct HTTP providers billed per API key (none exist yet; see README,
  // "Prompt-writer"). Both must allow a provider before FRIDAY may call it, and keys
  // come only from the environment (OPENAI_API_KEY). TODO(model-id): "Astra 6" is
  // not a confirmed OpenAI model id; ask the user before adding any provider for it.
  allowExternalApi: false,
  externalApis: [],
  // Headless Claude connects every MCP server the user has (here ~80 plugin
  // connectors, most unauthenticated) before it answers: ~2.4 s per turn. FRIDAY's
  // turns run without them; true restores them (Gmail, Drive, Docs, Playwright, ...).
  claudeMcp: false,
};

// Open the terminal HUD beside the cockpit: a tmux split if we are in tmux,
// otherwise a new terminal window (the tiling WM puts it next to this one).
export function openTerminalHud(port) {
  // The port as a bare argument: Windows Terminal reads `--port` as one of its own options.
  return openTerminal([process.execPath, FRIDAY_BIN, 'hud', String(port)], { detach: true });
}

// Run a command in a terminal beside the cockpit (tmux split or new window).
// `detach` keeps focus in the cockpit; interactive panes take focus.
export function openTerminal(cmd, { cwd = process.cwd(), detach = false } = {}) {
  const q = (a) => `'${a.replace(/'/g, `'\\''`)}'`;
  const tries = [];
  if (process.env.TMUX) tries.push(['tmux', ['split-window', '-h', '-l', '62%', ...(detach ? ['-d'] : []), '-c', cwd, cmd.map(q).join(' ')]]);
  if (process.platform === 'linux') {
    if (process.env.TERMINAL) tries.push([process.env.TERMINAL, ['-e', ...cmd]]);
    tries.push(['xdg-terminal-exec', cmd]);
    for (const t of ['ghostty', 'alacritty', 'kitty', 'foot', 'wezterm']) tries.push([t, t === 'foot' || t === 'kitty' ? cmd : ['-e', ...cmd]]);
  } else if (process.platform === 'darwin') {
    tries.push(['osascript', ['-e', `tell application "Terminal" to do script "${cmd.map(q).join(' ').replace(/"/g, '\\"')}"`]]);
  } else if (process.platform === 'win32') {
    // Inside Windows Terminal: a pane beside this one. Elsewhere `-w 0` would split
    // whichever WT window was used last, so open a window of its own.
    if (process.env.WT_SESSION) tries.push(['wt', ['-w', '0', 'split-pane', '-V', '--size', '0.6', '-d', cwd, ...cmd]]);
    tries.push(['wt', ['-w', 'new', 'new-tab', '--title', 'FRIDAY HUD', '-d', cwd, ...cmd]]);
    // cmd.exe parses its own command line: built by hand, or Node's quoting of the
    // window title ("\"FRIDAY HUD\"") makes `start` treat the title as the program.
    tries.push(['cmd', ['/d', '/s', '/c', `"start "FRIDAY HUD" ${cmd.map(winArg).join(' ')}"`], { windowsVerbatimArguments: true }]);
  }
  for (const [bin, args, opts = {}] of tries) {
    if (!which(bin)) continue;
    // xdg-terminal-exec takes the command directly; TERMINAL may be it too.
    const a = /xdg-terminal-exec$/.test(bin) && args[0] === '-e' ? args.slice(1) : args;
    try { spawn(bin, a, { cwd, detached: true, stdio: 'ignore', ...opts }).on('error', () => {}).unref(); return bin; } catch {}
  }
  return null;
}
// One argument for a cmd.exe command line.
const winArg = (a) => (/[\s"&|<>^()%!]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);

export function loadConfig() {
  // A BOM (Notepad, PowerShell's Set-Content -Encoding utf8) would fail JSON.parse silently.
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'config.json'), 'utf8').replace(/^\uFEFF/, '')) }; }
  catch { return { ...DEFAULTS }; }
}

// Set one key in config.json, keeping everything else the user wrote.
export function saveConfigKey(key, value, dir = CONFIG_DIR) {
  const file = path.join(dir, 'config.json');
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch {}
  cur[key] = value;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(cur, null, 2) + '\n');
  fs.renameSync(file + '.tmp', file);
}

const BANNER = [
  '███████╗██████╗ ██╗██████╗  █████╗ ██╗   ██╗',
  '██╔════╝██╔══██╗██║██╔══██╗██╔══██╗╚██╗ ██╔╝',
  '█████╗  ██████╔╝██║██║  ██║███████║ ╚████╔╝ ',
  '██╔══╝  ██╔══██╗██║██║  ██║██╔══██║  ╚██╔╝  ',
  '██║     ██║  ██║██║██████╔╝██║  ██║   ██║   ',
  '╚═╝     ╚═╝  ╚═╝╚═╝╚═════╝ ╚═╝  ╚═╝   ╚═╝   ',
];

const HELP = [
  ['<message>', 'FRIDAY routes it: one agent, a build-and-review pipeline, a council, design, or a self-change'],
  ['@codex <message>', 'override the route for one message (recorded; repeated overrides retune the profile)'],
  ['/route <message>', 'show where a message would go, without sending it'],
  ['/use <agent>', 'pin one agent, routing off  (shortcut: /claude, /codex, ...)  · /auto turns routing back on'],
  ['/profile', 'routing table and where profile.json lives (edits apply on the next message)'],
  ['/self  /undo-self', 'self-changes so far · reverse the last one'],
  ['/approve  /design', 'approve the current design for implementation · design status'],
  ['/all <message>', 'council: ask every agent at once, answers side by side'],
  ['/relay <agent> [ask]', 'hand the last answer to another agent ("review this")'],
  ['/project [name]', 'focus a project (cwd + HUD); no name lists them'],
  ['/hud [web]', 'open the project HUD in a terminal beside this one (web: browser)'],
  ['/hud on|off', 'open the HUD by itself when a project is in focus, or never (off by default)'],
  ['/hud theme <image|words>', 'change how the HUD looks: from an image, a description, or both · reset · undo'],
  ['/usage', 'turns per agent, and whether they cost money or plan limits'],
  ['/mission <goal>', 'lead a multi-step job: plan research (the brain plans, Claude reviews), run it in parallel, brief + build prompts, build (in parallel parts when it splits), then tests + review verdicts + fixes until it passes; asks before research and before building'],
  ['/memory', 'what FRIDAY remembers across conversations (facts and summaries of past chats) · /memory add <fact> · /memory forget <n>'],
  ['/abilities', 'what FRIDAY can do, and what is not available right now (shown at startup; profile "showAbilities": false hides it)'],
  ['/mission resume [n]', 'carry on with an unfinished mission (paused by a limit, a crash or you) from where it stopped'],
  ['/missions', 'background missions (friday mission "<goal>" --bg): running, waiting for an answer, done'],
  ['/telegram on|off|test', 'phone check-ins for missions (set up with `friday telegram`)'],
  ['/mission log [n]', "the last lines of a background mission's log"],
  ['/mission answer <n> <reply>', 'answer a background mission that is waiting (go, cancel, or what to change)'],
  ['/orchestrate [on|off]', 'the brain decides each message and calls the agents as tools (on by default)'],
  ['/brain', 'a menu: the model behind FRIDAY in the cloud (OpenRouter, fast) or on this machine (Ollama), which model, sign in or out · typed: /brain cloud|local|auto, /brain model <id>'],
  ['/login', 'sign in to OpenRouter in your browser (the cloud brain)'],
  ['/rewrite [on|off|<message>]', 'local prompt-writer: status, toggle, or a dry run that shows the rewrite and sends nothing'],
  ['/mode plan|edit|bypass', 'plan = read-only, edit = file edits ok, bypass = no permission questions · shift+tab cycles · /bypass toggles'],
  ['/new', 'fresh sessions for every agent in this folder'],
  ['/resume  (← on empty)', 'browse past conversations and pick one up where it left off'],
  ['/cd <path>', 'change working folder'],
  ['!<command>', 'run a shell command here'],
  ['/agents  /clear  /quit', ''],
];

const SPIN = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
const out = (s) => process.stdout.write(s);
const LOGIN_ERROR = /refresh token (was )?revoked|log ?in again|sign in again|not logged in|please (log|sign) in|authentication (failed|required)|invalid api key/i;
const tilde = (p) => (p && p.startsWith(os.homedir()) ? '~' + p.slice(os.homedir().length) : p);

// `worker`: run id of a background mission (src/missionrun.js). FRIDAY then runs that one
// mission headless, its questions answered through the run's files (or Telegram), and exits.
export async function startCockpit({ cwd = process.cwd(), noHud = false, resumeId = null, restarted = false, worker = null } = {}) {
  const config = loadConfig();
  const RUNS = runsDir(CONFIG_DIR);
  const W = worker ? { id: worker } : null;
  if (W) {
    const got = acquire(RUNS, W.id);
    if (got.error) { out(`  ✗ ${got.error}\n`); process.exit(1); }
    W.run = got.run;
  }
  const setRun = (patch) => { if (W) { try { W.run = writeRun(RUNS, { ...readRun(RUNS, W.id), ...patch }); } catch {} } };
  // After a self-change restart: where we were.
  let rs = null;
  if (restarted) {
    try { rs = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'restart.json'), 'utf8')); fs.unlinkSync(path.join(CONFIG_DIR, 'restart.json')); } catch {}
    if (rs?.cwd && fs.existsSync(rs.cwd)) cwd = rs.cwd;
    if (rs?.conv) resumeId = rs.conv;
  }
  const installed = availableAgents();
  const order = ['claude', 'codex', 'gemini', 'opencode', 'ollama'];

  // Routing profile: data, re-read whenever profile.json changes.
  const baseColors = Object.fromEntries(order.map((id) => [id, AGENTS[id].color]));
  const applyColors = (p) => { for (const id of order) AGENTS[id].color = p.colors?.[id] || baseColors[id]; };
  const profiles = liveProfile(CONFIG_DIR, { onReload: (p) => {
    applyColors(p);
    setUserName(p.user?.name);
    notify(dim(`  ◈ profile reloaded${p.error ? ` · ${p.error}` : ''}`));
  } });
  const profile = () => profiles.get();
  applyColors(profile());
  setUserName(profile().user?.name);

  // The vault: one protocol for every agent, one writer.
  const vault = expandHome(config.vault);
  const vaultOk = !!vault && fs.existsSync(vault);
  let ctxFiles = {};
  try { if (vaultOk) ctxFiles = writeAgentContext(CONFIG_DIR, vault, { sealed: profile().private.sealed || [] }); } catch {}
  const vaultQueue = vaultOk ? createVaultQueue({ vault, sync: config.vaultSync !== false }) : null;
  const selfHistory = createSelfHistory(CONFIG_DIR);
  const missionStates = missionStateStore(path.join(CONFIG_DIR, 'missions'));
  const selfRepo = repoRoot(FRIDAY_ROOT);

  // Who can take work right now. Gemini needs a login; Ollama needs its server.
  let ollamaRunning = false;
  // The router's tie-break model, when it is pulled (checked with each ping).
  let routerModelReady = false;
  const routerModel = () => profile().classifier.ollamaModel || config.ollamaModel;
  const pingOllama = async () => {
    if (!installed.includes('ollama')) return;
    ollamaRunning = await ollamaUp();
    const was = routerModelReady;
    routerModelReady = ollamaRunning && !!routerModel() && (await writerStatus({ model: routerModel() })).pulled;
    // Load it now, not on the first unsure message (a cold load takes ~8 s).
    if (routerModelReady && !was) warmWriter({ model: routerModel(), keepAlive: profile().classifier.keepAlive });
  };
  await pingOllama();
  setInterval(pingOllama, 60000).unref();
  // Agents whose login failed this session (e.g. a revoked Codex token): skipped until restart.
  const loggedOut = new Set();
  const ready = (id) => installed.includes(id) && !loggedOut.has(id) && (id !== 'gemini' || geminiLoggedIn()) && (id !== 'ollama' || ollamaRunning);
  ready.why = (id) => (!installed.includes(id) ? 'not installed' : loggedOut.has(id) ? `not logged in (run "${id === 'codex' ? 'codex login' : id}")` : id === 'gemini' ? 'not logged in' : id === 'ollama' ? 'not running' : 'unavailable');
  const st = {
    agent: [config.defaultAgent, ...order].find((a) => a && installed.includes(a)) || null,
    mode: MODES.includes(config.mode) ? config.mode : 'edit',
    cwd,
    focus: null,
    sessions: new Map(),
    last: null,
    running: new Set(),
    orchHistory: [], // what the local orchestrator remembers of recent exchanges
    allowed: new Set(), // "don't ask again" answers: agent\0tool, for this session
    queue: [],
    busy: false,
    hudOpened: false,
    conv: newConvo(cwd),
    auto: profile().routing !== 'manual', // false once /use pins an agent
    design: null,
  };
  let registry = loadRegistry(config);
  const convos = createConvoStore(path.join(CONFIG_DIR, 'conversations'));
  // Memory across conversations (src/memory.js): facts to remember and a summary of each
  // past conversation, read by the brain on every message and by agents at session start.
  const memory = createMemory(CONFIG_DIR);
  const recall = (o = {}) => { try { return memory.recall(convos.list(), { currentId: st.conv.id, ...o }); } catch { return ''; } };
  // Saved by the brain only when nothing in it is private or sealed.
  const rememberFact = (fact) => !sealedBlock('claude', fact) && !isPrivate(fact, { profile: profile(), focus: st.focus?.name }) && memory.remember(fact);
  // The brain writes a short summary of past conversations that have none yet (or have
  // grown since). Cloud brains only: a local or CLI one would hold up the machine.
  async function summarizePast(convs, { timeoutMs = 20000 } = {}) {
    const brain = resolveBrain(profile(), CONFIG_DIR);
    if (!brain.cloud || brain.cli) return 0;
    let n = 0;
    for (const conv of convs) {
      const r = await chat(brain, { messages: [{ role: 'user', content: summaryPrompt(conv) }], maxTokens: 300, timeoutMs });
      const text = r.ok ? (r.message?.content || '').trim() : '';
      if (text) { memory.saveSummary(conv, text); n++; }
    }
    return n;
  }
  // Saved conversations live outside every project: a turn about a sealed project is
  // kept only as a placeholder, never its words.
  function record(agent, asked, text, extra = {}) {
    if (sealedBlock('claude', `${asked}\n${text}`)) {
      asked = '[sealed project: not saved]';
      text = '[sealed project: not saved]';
      extra = { ...extra, private: true, sealed: true };
    }
    addTurn(st.conv, { agent, prompt: asked, text, ...extra });
    st.conv.sessions = dumpSessions(st.sessions);
    st.conv.cwd = st.cwd;
    st.conv.focus = st.focus?.name || null;
    convos.save(st.conv);
  }

  // How the HUDs look (src/hudtheme.js): hud-theme.json, changed by /hud theme.
  const themes = createThemeStore(CONFIG_DIR);
  const hud = createHud({
    port: config.port, assets: themes.assets, theme: themes.get(),
    onCommand: (cmd) => {
      if (typeof cmd !== 'string' || !cmd.trim()) return;
      clearPromptLine();
      out(dim(`  hud › ${cmd}\n`));
      enqueue(cmd);
    },
    // An image (and/or words) from the web HUD's theme form: saved, then run as /hud theme.
    onTheme: ({ data, ext, request }) => {
      let file = null;
      if (data) {
        fs.mkdirSync(themes.assets, { recursive: true });
        file = path.join(themes.assets, `upload-${Date.now()}.${ext}`);
        fs.writeFileSync(file, data);
      }
      const cmd = `/hud theme ${file ? `"${file}" ` : ''}${request.replace(/\s+/g, ' ')}`.trim();
      clearPromptLine();
      out(dim(`  hud › theme ${file ? 'image' : ''}${file && request ? ' + ' : ''}${request ? `"${request.slice(0, 80)}"` : ''}\n`));
      enqueue(cmd);
    },
  });
  await hud.listen();
  // Hand edits to hud-theme.json apply live.
  themes.watch((t) => hud.set({ theme: t }));
  // Lets `friday hud` in another pane find this cockpit.
  try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); fs.writeFileSync(path.join(CONFIG_DIR, 'hud.json'), JSON.stringify({ port: hud.port, pid: process.pid })); } catch {}
  const ledger = createLedger(detectBilling());
  const account = (id, r) => {
    ledger.record(id, r);
    hud.set({ usage: { ...ledger.totals } });
    return ledger.describe(id, r);
  };

  const agentRow = (id) => ({ id, label: AGENTS[id].label, color: AGENTS[id].color, installed: installed.includes(id), status: 'idle' });
  hud.set({ agents: order.map(agentRow), mode: st.mode, active: st.agent, cwd: st.cwd,
    projects: registry.map((p) => ({ name: p.display, dir: p.dir || null, note: !!p.note })) });
  const setAgent = (id, patch) => hud.set({ agents: hud.state.agents.map((a) => (a.id === id ? { ...a, ...patch } : a)) });

  // ---- banner -------------------------------------------------------------
  if (rs) {
    if (MODES.includes(rs.mode)) st.mode = rs.mode;
    st.auto = rs.auto !== false;
    if (rs.agent && installed.includes(rs.agent)) st.agent = rs.agent;
    hud.set({ mode: st.mode, active: st.agent });
  } else {
    out('\n');
    for (const line of BANNER) out('  ' + gradient(line, [80, 240, 255], [40, 120, 255]) + '\n');
    out('  ' + dim('multi-agent cockpit') + '   ' + paint(CYAN, '◈') + dim(` HUD ${hud.url}`) + '\n\n');
    out('  ' + order.map((id) => {
      const a = AGENTS[id];
      if (!installed.includes(id)) return dim('○ ' + id);
      return ready(id) ? paint(a.color, '●') + ' ' + id : paint(a.color, '◌') + ' ' + dim(`${id} (${ready.why(id)})`);
    }).join('   ') + '\n');
    out(dim(`  ${tilde(st.cwd)}  ·  mode ${st.mode}  ·  ${st.auto ? 'auto-routing' : 'manual'}  ·  vault ${vaultOk ? tilde(vault) : 'not found'}  ·  /help\n\n`));
    if (!st.agent) out(paint(RED, '  No agent CLIs found on PATH. Install claude, codex, gemini or opencode.\n\n'));
    if (profile().showAbilities !== false) showAbilities({ hint: true });
    const open = missionStates.list();
    if (open.length) out(`  ${paint(CYAN, '◈')} ${dim(`${open.length} unfinished mission${open.length > 1 ? 's' : ''} (${open[0].plan?.title || open[0].goal.slice(0, 50)}: ${open[0].status}) · /mission resume`)}\n\n`);
  }
  // What FRIDAY can do (src/abilities.js), fitted to the terminal; dimmed when not available now.
  function showAbilities({ hint = false } = {}) {
    const state = { agents: ['claude', 'codex', 'gemini', 'opencode'].filter((a) => installed.includes(a) && ready(a)).length, ollama: ollamaRunning, brain: resolveBrain(profile(), CONFIG_DIR).cloud || ollamaRunning, vault: vaultOk };
    const lines = abilityLines(state, { width: process.stdout.columns || 100, style: { name: (t) => paint(CYAN, t), dim, warn: (t) => paint(AMBER, t) } });
    out(`  ${bold('What FRIDAY can do')}${hint ? dim('   (/abilities shows this again)') : ''}\n${lines.join('\n')}\n\n`);
  }

  // The prompt-writer, when on: load its model now so the first rewrite is not a cold start.
  if (profile().promptWriter?.enabled) {
    writerStatus(profile().promptWriter).then((s) => {
      if (s.up && s.pulled) warmWriter(profile().promptWriter);
      else notify(paint(AMBER, `  ! prompt-writer is on but ${s.up ? `${profile().promptWriter.model} is not pulled (node scripts/setup-promptwriter.js)` : 'Ollama is not running'}; messages go unrewritten`));
    });
  }

  warmClaude();
  // The HUD comes up with FRIDAY (standing by until a project is in focus). One still
  // open from an earlier run (or before a self-change restart) links back within ~1.5 s
  // by itself, so wait for it before opening another.
  if (config.autoHud && !noHud) {
    setTimeout(() => {
      if (hud.viewers || st.hudOpened || quitting) return;
      if (st.busy || picker) return openHud();
      clearPromptLine(); openHud(); prompt();
    }, 2000).unref();
  }

  // ---- input --------------------------------------------------------------
  const histFile = path.join(CONFIG_DIR, 'history');
  let history = [];
  try { history = fs.readFileSync(histFile, 'utf8').split('\n').filter(Boolean).reverse().slice(0, 500); } catch {}

  const words = () => [
    ...HELP.map(([k]) => k.split(' ')[0]).filter((k) => k.startsWith('/')),
    ...order.map((id) => '/' + id), ...order.map((id) => '@' + id),
    '/agents', '/clear', '/quit', '/mode plan', '/mode edit', '/mode bypass', '/bypass', '/rewrite on', '/rewrite off',
    ...registry.map((p) => '/project ' + (p.aliases[0] || p.name)),
  ];
  const rl = readline.createInterface({
    input: process.stdin, output: process.stdout, history, historySize: 500, terminal: tty,
    completer: (line) => {
      const hits = [...new Set(words())].filter((w) => w.startsWith(line));
      return [hits.length ? hits : [], line];
    },
  });

  const routing = () => st.auto && profile().routing !== 'manual';
  // Print something while the prompt may be showing, then put the prompt back.
  function notify(line) {
    if (st.busy || quitting || picker) { out(line + '\n'); return; }
    clearPromptLine();
    out(line + '\n');
    prompt();
  }

  function prompt() {
    if (st.busy || quitting || picker) return;
    showPrompt();
  }
  function showPrompt() {
    if (quitting || picker) return;
    const a = routing() ? paint(CYAN, 'auto') : st.agent ? paint(AGENTS[st.agent].color, st.agent) : dim('none');
    const f = st.focus ? ' ' + paint(AMBER, st.focus.display) : '';
    const m = st.mode === 'edit' ? '' : ' ' + (st.mode === 'yolo' ? paint(RED, '⏵⏵ bypass') : dim('⏸ plan'));
    rl.setPrompt(`${a}${f}${m} ${paint(CYAN, '❯')} `);
    rl.prompt();
  }
  function clearPromptLine() { if (tty) { suggester.clear(); out('\r\x1b[2K'); } }

  // ← on an empty prompt opens the conversation picker. readline owns the
  // keypress stream, so route keys through here and only hand it the rest.
  let picker = null;
  // Questions and permission requests, asked the way Claude Code asks them (src/asker.js).
  // One at a time: council agents may ask at once.
  const asker = createAsker({ write: out });
  const suggester = createSuggester({
    write: out,
    catalog: () => commandCatalog(HELP, [...order.map((id) => ({ cmd: '/' + id, desc: `pin ${AGENTS[id].label || id} (routing off; /auto turns it back on)` })),
      { cmd: '/agents', desc: 'which agents are installed and ready' }, { cmd: '/clear', desc: 'clear the screen' }, { cmd: '/quit', desc: 'leave FRIDAY' }]),
  });
  let askChain = Promise.resolve();
  function choose(spec) {
    if (!tty) return Promise.resolve(null);
    const p = askChain.then(() => asker.choose(spec));
    askChain = p.catch(() => {});
    return p;
  }
  // While work runs, keys go to the queue box at the bottom instead of readline.
  const box = createQueueBox({
    write: out,
    status: () => (st.mode === 'yolo' ? '⏵⏵ bypass permissions' : st.mode === 'plan' ? '⏸ plan mode' : ''),
    queued: () => st.queue.map((q) => q.text),
    submit(text) {
      if (!sealedBlock('claude', text)) {
        try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); fs.appendFileSync(histFile, text.replace(/\n/g, ' ') + '\n'); } catch {}
      }
      rl.history?.unshift(text);
      enqueue(text, { echo: true });
    },
    takeLast() {
      const i = st.queue.findLastIndex((q) => q.echo);
      return i < 0 ? null : st.queue.splice(i, 1)[0].text;
    },
    interrupt,
    sigint: () => rl.emit('SIGINT'),
  });
  if (tty) process.stdout.on('resize', () => box.resize());
  if (tty) {
    const passthrough = process.stdin.listeners('keypress');
    process.stdin.removeAllListeners('keypress');
    process.stdin.on('keypress', (s, key) => {
      if (asker.open) return asker.key(s, key || {});
      if (picker) return picker.key(key || {});
      // Shift+Tab cycles the permission mode, as in Claude Code: edit -> plan -> bypass.
      if (key?.name === 'tab' && key.shift && !quitting) return cycleMode();
      if (box.isOpen && !st.awaiting) return box.key(s, key || {});
      if (key?.name === 'left' && !rl.line && !st.busy && !quitting) return openPicker();
      // Slash-command suggestions under the prompt (src/suggest.js).
      const idle = !st.busy && !quitting && !st.awaiting;
      if (idle && suggester.visible && key) {
        const c = suggester.selected;
        if (key.name === 'up' || key.name === 'down') return suggester.move(key.name === 'up' ? -1 : 1, rl.getCursorPos().cols);
        if (key.name === 'escape') return suggester.hide(rl.line);
        if (key.name === 'tab' && c) return setLine(`${c.cmd} `);
        if ((key.name === 'return' || key.name === 'enter') && c && rl.line !== c.cmd) {
          // A command that needs more (/mission <goal>) is completed, not run.
          if (/</.test(c.args)) return setLine(`${c.cmd} `);
          suggester.clear();
          setLine(c.cmd, { quiet: true });
        } else if (key.name === 'return' || key.name === 'enter') suggester.clear();
      }
      for (const f of passthrough) f.call(process.stdin, s, key);
      if (idle && !picker && !asker.open && key?.name !== 'return' && key?.name !== 'enter') suggester.update(rl.line, rl.getCursorPos().cols);
    });
  }
  // Replace what is typed at the prompt (readline's own keys: end of line, delete to start, type).
  function setLine(text, { quiet = false } = {}) {
    rl.write(null, { ctrl: true, name: 'e' });
    rl.write(null, { ctrl: true, name: 'u' });
    rl.write(text);
    if (!quiet) suggester.update(rl.line, rl.getCursorPos().cols);
  }

  function openPicker() {
    const items = convos.list();
    if (!items.length) { clearPromptLine(); out(dim('  no saved conversations yet\n')); return prompt(); }
    const rows = Math.min(10, items.length);
    let sel = Math.max(0, items.findIndex((c) => c.id !== st.conv.id));
    let top = 0;
    let drawn = 0;
    const erase = () => { out((drawn ? `\x1b[${drawn}A` : '') + '\r\x1b[J'); drawn = 0; };
    const draw = () => {
      if (sel < top) top = sel;
      if (sel >= top + rows) top = sel - rows + 1;
      const width = (process.stdout.columns || 100) - 4;
      const lines = [`  ${paint(CYAN, '◈')} ${bold('Conversations')} ${dim(`${items.length} · ↑↓ choose · enter resume · esc back`)}`];
      for (let i = top; i < top + rows; i++) {
        const cv = items[i];
        const s = summarize(cv);
        const dots = s.agents.map((a) => paint(AGENTS[a]?.color || CYAN, '●')).join('');
        const meta = ` · ${s.turns} turn${s.turns > 1 ? 's' : ''}` + (cv.focus ? ` · ${cv.focus}` : '') + (cv.id === st.conv.id ? ' · this one' : '');
        const room = Math.max(10, width - 14 - s.agents.length - meta.length);
        const title = s.title.length > room ? s.title.slice(0, room - 1) + '…' : s.title;
        const when = ago(cv.updated).padEnd(10);
        lines.push(i === sel
          ? `  ${paint(CYAN, '❯')} ${dim(when)} ${dots} ${bold(title)}${dim(meta)}`
          : `    ${dim(when)} ${dots} ${title}${dim(meta)}`);
      }
      if (items.length > rows) lines.push(dim(`    ${top + 1}-${top + rows} of ${items.length}`));
      erase();
      out(lines.join('\n') + '\n');
      drawn = lines.length;
    };
    const close = (chosen) => {
      erase();
      picker = null;
      if (chosen) resume(chosen);
      prompt();
    };
    picker = {
      key(k) {
        if (k.name === 'up' || k.name === 'k') sel = (sel - 1 + items.length) % items.length;
        else if (k.name === 'down' || k.name === 'j') sel = (sel + 1) % items.length;
        else if (k.name === 'return' || k.name === 'enter' || k.name === 'right') return close(items[sel]);
        else if (k.name === 'escape' || k.name === 'q' || (k.ctrl && k.name === 'c')) return close(null);
        else return;
        draw();
      },
    };
    clearPromptLine();
    draw();
  }

  // Pick a saved conversation back up: its sessions, folder, focus and transcript.
  function resume(conv, { quiet = false } = {}) {
    if (conv.id === st.conv.id) { out(dim('  already in this conversation\n')); return; }
    st.conv = conv;
    closeLive();
    st.sessions = loadSessions(conv.sessions);
    if (conv.cwd && fs.existsSync(conv.cwd)) { st.cwd = conv.cwd; hud.set({ cwd: st.cwd }); }
    const p = conv.focus && registry.find((x) => x.name === conv.focus);
    if (p) { st.focus = p; hud.set({ project: scanProject(p) }); }
    const last = conv.turns.at(-1);
    if (installed.includes(last.agent) && last.agent !== st.agent) { st.agent = last.agent; hud.set({ active: st.agent }); }
    st.last = { agent: last.agent, prompt: last.prompt, text: last.text, private: !!last.private };
    if (quiet) {
      for (const t of conv.turns.slice(-6)) {
        hud.feed({ kind: 'user', agent: t.agent, text: t.prompt });
        hud.feed({ kind: 'agent', agent: t.agent, text: t.text.slice(0, 600) });
      }
      out(`${paint(CYAN, '◈')} ${dim(`reloaded · same conversation (${conv.turns.length} turns) · sessions restored`)}\n`);
      return;
    }

    const SHOW = 6;
    out(`\n${paint(CYAN, '◈')} ${bold('Resumed')} ${dim(`· started ${ago(conv.started)} · ${conv.turns.length} turns · ${tilde(st.cwd)}`)}\n`);
    if (conv.turns.length > SHOW) out(dim(`  … ${conv.turns.length - SHOW} earlier turns\n`));
    for (const t of conv.turns.slice(-SHOW)) {
      out(`\n${paint(CYAN, '❯')} ${t.prompt.replace(/\s+/g, ' ').slice(0, 300)}\n`);
      const a = AGENTS[t.agent];
      out(`${paint(a?.color || CYAN, '●')} ${bold(a?.label || (t.agent === 'friday' ? 'FRIDAY' : 'Council'))}\n`);
      const s = createStream('  ');
      out(s.write(t.text) + s.flush());
      hud.feed({ kind: 'user', agent: t.agent, text: t.prompt });
      hud.feed({ kind: 'agent', agent: t.agent, text: t.text.slice(0, 600) });
    }
    out(dim('\n  sessions restored · keep talking\n\n'));
  }

  // A mission waiting at a checkpoint takes the next line itself (the queue is busy with it).
  // `echo`: typed in the queue box, so the transcript has not shown it yet.
  function enqueue(line, { echo = false } = {}) {
    if (st.awaiting) { const r = st.awaiting; st.awaiting = null; r(line); return; }
    st.queue.push({ text: line, echo });
    box.refresh();
    pump();
  }
  // FRIDAY's own questions (mission checkpoints). "Build it? go / cancel / or say what
  // to change" becomes a Claude-style choice; anything else is typed at the prompt.
  async function ask(question) {
    if (W) return workerAsk(question);
    // In a mission with Telegram set up, the phone can answer too: whichever is first.
    // A background worker that is waiting has the bot to itself (one poller per bot).
    const tg = st.inMission && !st.queue.length && !listRuns(RUNS).some((r) => r.alive && r.asking) ? phone() : null;
    if (!tg) return terminalAsk(question);
    const ac = new AbortController();
    let fromPhone = null;
    tg.ask(question, { summary: st.lastShown, signal: ac.signal }).then((a) => {
      if (a == null) return;
      fromPhone = a;
      asker.cancel();
      if (st.awaiting) { const r = st.awaiting; st.awaiting = null; r(a); }
    }).catch((e) => notify(dim(`  telegram: ${e.message}`)));
    const local = await terminalAsk(question);
    ac.abort();
    if (fromPhone != null) { out(dim(`  ❯ ${fromPhone} (answered from your phone)\n`)); return fromPhone; }
    return local;
  }
  async function terminalAsk(question) {
    // Lines typed (or piped) ahead of the question answer it first.
    if (st.queue.length) {
      out(`  ${paint(CYAN, '?')} ${question}\n`);
      const { text } = st.queue.shift(); box.refresh(); out(dim(`  ❯ ${text}\n`)); return text;
    }
    const ch = tty ? parseChoices(question) : null;
    box.close();
    if (ch) {
      const r = await choose({ title: 'FRIDAY asks', question: ch.question, options: ch.options, other: ch.other ? `Other: ${ch.other}` : 'Other (type an answer)', cancel: 'cancel' });
      if (st.busy && tty) box.open();
      return r ? (r.text ?? r.label) : 'cancel';
    }
    out(`  ${paint(CYAN, '?')} ${question}\n`);
    // The answer is typed at the prompt, not queued: the box steps aside until then.
    return new Promise((resolve) => {
      st.awaiting = (line) => { resolve(line); if (st.busy && tty) box.open(); };
      showPrompt();
    });
  }

  // Telegram, when set up and on (friday telegram; /telegram on|off|test). Everything
  // it sends passes the sealed/private checks first.
  function phone() {
    const t = config.telegram;
    if (!t?.chatId || t.enabled === false) return null;
    const token = loadKey(CONFIG_DIR, 'telegram');
    if (!token) return null;
    const guard = (text) => (sealedBlock('claude', text) || isPrivate(text, { profile: profile(), focus: st.focus?.name }) ? 'A FRIDAY mission needs you in the terminal.' : text);
    return createTelegram({ token, chatId: t.chatId, guard });
  }
  const ping = (text) => { phone()?.send(text).catch(() => {}); };

  // A background mission's question: answered by itself (--yes, approval gates only),
  // or from the cockpit (/mission answer) or the phone, whichever comes first.
  async function workerAsk(question) {
    out(`  ? ${question}\n`);
    const auto = W.run?.yes ? autoAnswer(question) : null;
    if (auto) { out(`  ❯ ${auto} (auto, --yes)\n`); return auto; }
    setRun({ status: `waiting: ${question}` });
    const tg = phone();
    const ac = new AbortController();
    const also = tg ? tg.ask(question, { summary: st.lastShown, signal: ac.signal }).catch((e) => { out(`  ! telegram: ${e.message}\n`); return null; }) : null;
    const { answer, from } = await askByFile(RUNS, W.id, question, { also });
    ac.abort();
    out(`  ❯ ${answer} (from ${from})\n`);
    setRun({ status: 'running' });
    return answer;
  }

  // ---- permissions and questions from agents ----------------------------------
  // Claude asks before a tool runs that its mode does not cover, and for its own
  // questions (AskUserQuestion). The user answers here, Claude Code style.
  const modeName = (m) => (m === 'yolo' ? 'bypass permissions' : m === 'plan' ? 'plan mode' : 'edit (accept edits)');
  function setMode(m, { quiet = false } = {}) {
    if (st.mode === m) return;
    st.mode = m;
    hud.set({ mode: m });
    box.refresh();
    if (!st.busy) warmClaude();
    if (!quiet) notify(m === 'yolo' ? paint(RED, '  ⏵⏵ bypass permissions on · agents run anything without asking (shift+tab to cycle)') : dim(`  ${m === 'plan' ? '⏸ plan mode · read-only, agents plan before they change anything' : 'edit mode · file edits accepted, anything else asks'} (shift+tab to cycle)`));
  }
  function cycleMode() {
    const order = ['edit', 'plan', 'yolo'];
    setMode(order[(order.indexOf(st.mode) + 1) % order.length]);
  }
  const allow = (input) => ({ behavior: 'allow', updatedInput: input });
  async function permissionFor(id, req) {
    const name = req.tool_name || 'tool';
    const input = req.input || {};
    const who = AGENTS[id]?.label || id;
    const color = AGENTS[id]?.color || CYAN;
    if (name === 'AskUserQuestion') {
      const answers = {};
      for (const q of input.questions || []) {
        const r = await choose({ title: `${who} asks`, question: q.question, color, multi: !!q.multiSelect,
          options: (q.options || []).map((o) => ({ label: o.label, description: o.description })), other: 'Other (type your answer)' });
        if (!r) return { behavior: 'deny', message: `${cap(userName())} declined to answer. Carry on without it, or ask in plain text.` };
        answers[q.question] = r.text ?? r.labels.join(', ');
      }
      return allow({ ...input, answers });
    }
    if (st.mode === 'yolo' || st.allowed.has(`${id}\0${name}`)) return allow(input);
    if (name === 'ExitPlanMode') {
      if (input.plan) { const s = createStream('  '); out(`\n${paint(color, '●')} ${bold(`${who}'s plan`)}\n` + s.write(String(input.plan)) + s.flush()); }
      const r = await choose({ title: `${who} is ready to build`, question: 'Go ahead with this plan?', color, cancel: 'keep planning',
        options: [{ label: 'Yes, build it', description: 'edit mode: file edits accepted' }, { label: 'Yes, and bypass permissions', description: 'no more questions' }, { label: 'No, keep planning' }],
        other: 'No, and tell it what to change' });
      if (!r || r.index === 2) return { behavior: 'deny', message: `${cap(userName())} wants to keep planning. Stay in plan mode.` };
      if (r.text) return { behavior: 'deny', message: `${cap(userName())} wants changes to the plan: ${r.text}` };
      setMode(r.index === 1 ? 'yolo' : 'edit');
      return allow(input);
    }
    const cmd = input.command || input.cmd;
    const r = await choose({
      title: `${who} wants to use ${name}`, color, cancel: 'no',
      question: cmd ? `${cmd}${input.description ? `\n(${input.description})` : ''}` : describeTool(name, input, st.cwd),
      options: [{ label: 'Yes' }, { label: `Yes, and don't ask again for ${name} this session` }, { label: 'Yes, and bypass permissions', description: 'every agent, until shift+tab' }],
      other: 'No, and tell it what to do instead',
    });
    if (!r) return { behavior: 'deny', message: `${cap(userName())} said no. Do not retry it; ask them or do something else.` };
    if (r.text) return { behavior: 'deny', message: `${cap(userName())} said no, and: ${r.text}` };
    if (r.index === 1) st.allowed.add(`${id}\0${name}`);
    if (r.index === 2) setMode('yolo');
    return allow(input);
  }
  async function pump() {
    if (st.busy) return;
    while (st.queue.length) {
      const { text, echo } = st.queue.shift();
      st.busy = true;
      st.t0 = Date.now(); // one clock per message: every spinner in it counts from here
      if (tty) { box.open(); box.refresh(); }
      if (echo) out(`\n${dim('>')} ${text.replace(/\n/g, '\n  ')}\n`);
      try { await handle(text); } catch (e) { out(paint(RED, `  ${e.stack || e.message}\n`)); }
      st.busy = false;
    }
    box.close();
    if (st.closing) return quit();
    prompt();
  }
  // Stop whatever agents are running (Esc in the box, or the first Ctrl+C).
  function interrupt() {
    asker.cancel();
    if (!st.running.size) return false;
    for (const r of st.running) r.abort();
    out('\n' + paint(AMBER, '  ■ interrupted\n'));
    return true;
  }

  rl.on('line', (line) => {
    // What was sent stays on screen as "> message", the way Claude Code shows it: the
    // prompt line (however many rows it wrapped to) is replaced.
    if (tty && line.trim() && !st.awaiting) {
      const vis = (rl.getPrompt().replace(/\x1b\[[0-9;]*m/g, '') + line).length;
      const rows = Math.max(1, Math.ceil(vis / (process.stdout.columns || 100)));
      out(`\x1b[${rows}A\r\x1b[J${dim('>')} ${line}\n`);
    }
    // Lines about a sealed project are not written to the history file (outside the project).
    if (line.trim() && !sealedBlock('claude', line)) {
      try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); fs.appendFileSync(histFile, line.replace(/\n/g, ' ') + '\n'); } catch {}
    }
    enqueue(line);
  });
  let lastSigint = 0;
  rl.on('SIGINT', () => {
    if (st.awaiting) { const r = st.awaiting; st.awaiting = null; out('\n'); r('cancel'); return; }
    if (interrupt()) return;
    if (Date.now() - lastSigint < 1500) return quit();
    lastSigint = Date.now();
    out('\n' + dim('  (ctrl+c again to quit)\n'));
    rl.line && rl.write(null, { ctrl: true, name: 'u' });
    prompt();
  });
  // Piped input closes stdin early; finish the queued work before leaving.
  rl.on('close', () => { st.closing = true; if (!st.busy && !st.queue.length) quit(); });

  let quitting = false;
  async function quit() {
    if (quitting) return;
    quitting = true;
    // A worker that ends before its mission did (no brain, no Claude, a crash): say so.
    if (W && !readRun(RUNS, W.id)?.done) setRun({ done: true, status: 'ended before the mission finished; see /mission log' });
    box.close();
    for (const r of st.running) r.abort();
    hud.close();
    // Let queued vault writes land (bounded, so a stuck push cannot hold the exit).
    if (vaultQueue?.pending) {
      out(dim('\n  finishing vault writes…'));
      await Promise.race([vaultQueue.idle(), new Promise((r) => setTimeout(r, 30000).unref())]);
    }
    // This conversation goes into memory now, so the next one knows about it (bounded;
    // missed ones are summarized at the next start).
    if (memory.unsummarized([st.conv]).length) {
      out(dim('\n  saving this conversation to memory…'));
      await Promise.race([summarizePast([st.conv], { timeoutMs: 8000 }).catch(() => 0), new Promise((r) => setTimeout(r, 9000).unref())]);
    }
    // Agents that already answered may still be running their hooks; let them finish.
    closeLive();
    await settleAgents(10000);
    out(dim('\n  powering down.\n'));
    setTimeout(() => process.exit(0), 50);
  }

  // ---- helpers ------------------------------------------------------------
  function session(id, cwd = st.cwd) {
    const key = `${id}\0${cwd}`;
    if (!st.sessions.has(key)) st.sessions.set(key, {});
    return st.sessions.get(key);
  }

  // Claude Code's spinner: a pulsing star, the verb, and the time with how to stop it.
  // The time is the whole message's (st.t0), in whole seconds, so it keeps counting up
  // through routing, thinking and every tool call instead of restarting at each.
  // Drawn over itself (text first, then erase what is left of the line) so it never blinks.
  function spinner(label) {
    if (!tty) return { stop() {} };
    let i = 0;
    const t0 = st.busy && st.t0 ? st.t0 : Date.now();
    let on = true;
    const verb = label.charAt(0).toUpperCase() + label.slice(1) + (/[….]$/.test(label) ? '' : '…');
    const draw = () => on && out(`\r${paint(AMBER, SPIN[i++ % SPIN.length])} ${paint(AMBER, verb)} ${dim(`(${Math.floor((Date.now() - t0) / 1000)}s · esc to interrupt)`)}\x1b[K`);
    draw();
    const h = setInterval(draw, 200);
    return { stop() { if (on) { on = false; clearInterval(h); out('\r\x1b[2K'); } } };
  }

  function focusProject(p, { auto = false } = {}) {
    st.focus = p;
    if (p.dir && fs.existsSync(p.dir)) st.cwd = p.dir;
    warmClaude();
    const scan = scanProject(p);
    hud.set({ project: scan, cwd: st.cwd });
    const where = p.dir ? tilde(p.dir) : 'vault note only';
    out(`  ${paint(AMBER, '◆')} ${bold(p.display)} ${dim(`· ${where} · ${scan.files.length} files`)}`
      + (auto ? dim(' · auto-focused') : '') + '\n');
    if (config.autoHud && !noHud && hud.viewers === 0 && !st.hudOpened) openHud();
  }
  function openHud(kind = config.hud) {
    st.hudOpened = true;
    if (kind === 'web') {
      const how = openWindow(hud.url, config.browser);
      out(dim(how ? `  ◈ web HUD opened (${how})\n` : `  ◈ open ${hud.url} in a browser\n`));
      return;
    }
    const how = openTerminalHud(hud.port);
    out(dim(how ? `  ◈ HUD opened in ${how}\n` : `  ◈ run \`node ${FRIDAY_BIN} hud\` in another terminal\n`));
  }
  let rescanTimer = null;
  function rescanSoon() {
    if (!st.focus) return;
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => hud.set({ project: scanProject(st.focus) }), 400);
  }

  // First message to each agent session: the focused project's Now block, and
  // (Gemini only, it has no instructions flag) the vault protocol.
  function preamble(id, sess) {
    let s = '';
    // FRIDAY's memory (src/memory.js), once per agent session, so "continue what we did
    // last time" works in a fresh session too.
    if (!sess.remembered) {
      sess.remembered = true;
      const m = recall({ budget: 3000 });
      if (m) s += `[FRIDAY's memory of earlier conversations, not from the user: use it when the user refers to earlier work]\n${m}\n[end memory]\n\n`;
    }
    if (!sess.protocol && id === 'gemini' && vaultOk) {
      sess.protocol = true;
      const a = vaultAccess(id, { vault, files: ctxFiles });
      if (a.firstTurn) s += `[FRIDAY instructions, not from the user]\n${a.firstTurn}\n[end instructions]\n\n`;
    }
    if (sess.primed || !st.focus) return s;
    sess.primed = true;
    const p = st.focus;
    const bits = [`Focus project: ${p.display}.`];
    if (p.note) bits.push(`Vault note: ${p.note.file}.`);
    if (p.note?.now) bits.push(`Current state (Now block):\n${p.note.now.slice(0, 1500)}`);
    return s + `[FRIDAY cockpit context, not from the user]\n${bits.join('\n')}\n[end context]\n\n`;
  }

  // Every message: standing instructions from the profile. Agents with file tools find
  // the vault notes they need themselves (the protocol says how), as Claude Code does;
  // nothing retrieved is pasted into the message. Ollama gets its notes in ollamaSystem.
  function perTurn(id) {
    const ins = [...(profile().instructions?.all || []), ...(profile().instructions?.[id] || [])];
    return ins.length ? `[${cap(userPossessive())} standing instructions]\n${ins.map((x) => `- ${x}`).join('\n')}\n[end]\n\n` : '';
  }

  // ---- one streamed turn --------------------------------------------------
  // `original` is the prompt before the prompt-writer touched it: vault retrieval,
  // the HUD and the transcript use it, so only what the agent reads changes.
  // `waitExit`: return only once the agent process is gone (its hooks done), for
  // callers that remove the folder it ran in right after (worktrees).
  // Laid out like Claude Code: "● Agent(task)" with its tool calls under it ("⎿ Read x"),
  // the answer as "● text" wrapped to the terminal, then one dim line of stats. `task`:
  // what FRIDAY asked it (shown in the brackets); `note`: extra stats (how it was routed).
  async function turn(id, prompt, { label, task = null, note = null, asked = prompt, mode = st.mode, cwd = st.cwd, category, private: priv = false, noVault = false, args = [], original = prompt, rw = null, waitExit = false, timeoutMs = 0 } = {}) {
    if (!installed.includes(id)) { out(paint(RED, `  ${id} is not installed\n`)); return null; }
    // Every agent turn passes here: a sealed project never reaches a cloud agent,
    // whatever the route, pin, override, relay or pipeline step.
    const blocked = sealedBlock(id, `${original}\n${prompt}`, cwd);
    if (blocked) { out(paint(RED, `  ✗ nothing sent to ${id}: ${blocked}. Use @${profile().private.agent} (local).\n`)); return null; }
    const a = AGENTS[id];
    const sess = session(id, cwd);
    await sessionExited(sess);
    const full = preamble(id, sess) + perTurn(id) + prompt;
    const opts = runOpts(id, cwd, { mode, noVault, args });
    const vb = id !== 'ollama' && !noVault ? vaultBefore() : null;
    const system = id === 'ollama' && vaultOk && !noVault ? ollamaSystem(vault, prompt).system : undefined;
    const name = label || a.label;
    const flags = `${sess.id ? '' : ' · new session'}${priv ? ' · local only' : ''}`;
    const room = Math.max(10, (process.stdout.columns || 100) - name.length - flags.length - 6);
    const brief = task ? oneLine(task) : '';
    const shown = brief.length > room ? brief.slice(0, brief.lastIndexOf(' ', room - 1) > room / 2 ? brief.lastIndexOf(' ', room - 1) : room - 1) + '…' : brief;
    out(`\n${paint(a.color, '●')} ${bold(name)}${shown ? `(${shown})` : ''}${dim(flags)}\n`);
    // Each run of answer text is its own "● " block; a tool call in between ends it.
    let stream = null;
    const say = (t) => {
      if (!stream) { out('\n'); stream = createStream('  ', { first: `${paint(a.color, '●')} ` }); }
      out(stream.write(t));
    };
    const endText = () => { if (stream) { out(stream.flush()); stream = null; } };
    let spin = spinner('thinking');
    let tools = 0;
    let edited = false;
    setAgent(id, { status: 'working', since: Date.now() });
    hud.feed({ kind: 'user', agent: id, text: original });
    hud.publish('turn', { agent: id, phase: 'start' });

    const run = runTurn(id, full, {
      cwd, session: sess, ollamaModel: config.ollamaModel, ...opts, system, live: !waitExit, timeoutMs,
      on: {
        text(t) { spin.stop(); say(t); hud.publish('say', { agent: id, text: t }); },
        tool(name, input) {
          spin.stop();
          if (stream) { endText(); out('\n'); }
          tools++;
          out(`  ${dim('⎿')}  ${describeTool(name, input, st.cwd)}\n`);
          const paths = touchedPaths(input, st.cwd);
          if (/edit|write|update|add|delete|patch|create|multi/i.test(name)) edited = true;
          hud.publish('touch', { agent: id, tool: name, paths, label: describeTool(name, input, st.cwd) });
          spin = spinner('working');
        },
        error(m) { spin.stop(); endText(); out(paint(RED, `  ⎿  ✗ ${m}\n`)); },
        // Claude stops to ask (a question, a permission): the spinner steps aside.
        async permission(req) {
          spin.stop();
          endText();
          const r = await permissionFor(id, req);
          spin = spinner('working');
          return r;
        },
      },
    });
    st.running.add(run);
    const r = await run.done;
    st.running.delete(run);
    spin.stop();
    endText();

    const bits = [fmtMs(r.ms)];
    if (tools) bits.push(`${tools} tool${tools > 1 ? 's' : ''}`);
    if (r.model) bits.push(r.model);
    bits.push(...account(id, r));
    if (note) bits.push(note);
    out('\n' + wrapText(`${r.ok ? '' : r.aborted ? 'interrupted · ' : 'failed · '}${bits.join(' · ')}`).map(dim).join('\n') + '\n');

    setAgent(id, { status: r.ok ? 'idle' : 'error', since: Date.now() });
    hud.publish('turn', { agent: id, phase: 'end', ok: r.ok });
    if (rw) logRewrite(id, rw.c, r, { category, kind: rw.kind });
    if (!r.ok && !r.aborted && LOGIN_ERROR.test((r.errors || []).join(' '))) {
      loggedOut.add(id);
      out(paint(AMBER, `  ! ${id} is not logged in; skipping it for this session. Fix: ${id === 'codex' ? 'codex login' : `run ${id} once`}
`));
    }
    if (r.text.trim()) {
      st.last = { agent: id, prompt: original, text: r.text.trim(), private: priv };
      hud.feed({ kind: 'agent', agent: id, text: r.text.trim().slice(0, 600) });
      record(id, asked, r.text.trim(), priv ? { private: true } : {});
      vaultWrites(r.text, id);
    }
    if (edited || tools) rescanSoon();
    if (vb && tools) await commitVaultEdits(vb, id);
    if (waitExit) await run.exited;
    return r;
  }

  // ---- sealed projects (profile.private.sealed) ----------------------------
  // Folders of sealed projects: a registry entry whose name, title or alias names one.
  function sealedDirs() {
    const names = (profile().private.sealed || []).map((s) => s.toLowerCase());
    return registry.filter((p) => p.dir && names.some((n) => [p.name, p.display, ...(p.aliases || [])]
      .some((x) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(String(x).replace(/[-_]/g, ' ')))))
      .map((p) => p.dir);
  }
  function sealedBlock(id, text, cwd = st.cwd) {
    return cloudBlock({ agent: id, text, cwd, profile: profile(), focus: st.focus?.name, sealedDirs: sealedDirs() });
  }

  // Claude's own file tools may not touch a sealed project's folder or vault notes
  // named after it. A shell command can still read any file this account can, so
  // this backs up the checks above; it does not replace them.
  function sealedDenyArgs(id) {
    if (id !== 'claude') return [];
    const names = profile().private.sealed || [];
    if (!names.length) return [];
    const globs = sealedDirs().map((d) => denyGlob(d));
    if (vaultOk) {
      const v = denyGlob(vault).replace(/\/\*\*$/, '');
      for (const n of names) for (const c of new Set([n.toLowerCase(), n.toUpperCase(), n[0].toUpperCase() + n.slice(1).toLowerCase()])) globs.push(`${v}/**/*${c}*`);
    }
    return ['--disallowedTools', ...globs.flatMap((g) => ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'NotebookEdit'].map((t) => `${t}(${g})`))];
  }

  // How an agent runs in a folder: vault access, mode, flags.
  function runOpts(id, cwd = st.cwd, { mode = st.mode, noVault = false, args = [] } = {}) {
    const access = vaultOk && !noVault ? vaultAccess(id, { vault, files: ctxFiles }) : { args: [], env: {} };
    return { mode, extraArgs: [...access.args, ...args, ...speedArgs(id)], env: access.env };
  }

  // Agents edit the vault directly. What a turn changed there (git status after vs.
  // before) is committed and pushed through the vault queue; files that already had
  // The user's uncommitted edits stay uncommitted, so their unfinished work never rides along.
  const mtime = (p) => { try { return fs.statSync(path.join(vault, p)).mtimeMs; } catch { return 0; } };
  // Files already uncommitted before the turn, with their modification times.
  const vaultBefore = () => (vaultOk && vaultQueue ? vaultStatus(vault).then((s) => s && new Map([...s].map((p) => [p, mtime(p)]))) : null);
  const short = (ps) => (ps.length <= 3 ? ps.map((p) => path.posix.basename(p, '.md')).join(', ') : `${ps.length} notes`);
  async function commitVaultEdits(before, source) {
    const b = await before;
    if (!b) return;
    const after = await vaultStatus(vault);
    if (!after) return;
    const changed = [...after].filter((p) => !b.has(p) && !/^00_Raw\//i.test(p));
    const held = [...after].filter((p) => b.has(p) && mtime(p) !== b.get(p));
    if (held.length) notify(paint(AMBER, `  ! vault: ${source} edited ${short(held)}, which already had your uncommitted edits; left uncommitted for your sync`));
    if (!changed.length) return;
    const rep = await vaultQueue.commitEdits(changed, { source });
    notify(dim(`  ◈ vault: ${source} edited ${short(changed)} · ${rep.pushed ? 'committed, pushed' : rep.committed ? 'committed' : 'not committed'}`));
    for (const w of rep.warnings) notify(paint(AMBER, `  ! vault ${w}`));
  }
  // Boot Claude for this folder now, so the next message does not wait for it.
  function warmClaude(cwd = st.cwd) {
    if (ready('claude') && !sealedBlock('claude', '', cwd)) warmLive('claude', { cwd, session: session('claude', cwd), ...runOpts('claude', cwd) });
  }

  // Flags that make an agent start faster (see config.claudeMcp).
  function speedArgs(id) {
    return [...(id === 'claude' && config.claudeMcp !== true ? ['--strict-mcp-config'] : []), ...sealedDenyArgs(id)];
  }

  // ---- prompt-writer --------------------------------------------------------
  // Rewrites only the user's message, for one target agent. Returns null when the
  // prompt-writer is off; otherwise curate()'s result, whose `text` is always
  // sendable (the original on any skip or failure). `force` is for /rewrite dry runs.
  async function curateFor(id, text, { kind = 'message', pinned = false, spin = true, force = false } = {}) {
    const pw = { ...profile().promptWriter, ...(force ? { enabled: true } : {}) };
    if (!pw.enabled) return null;
    const sp = spin && shouldRewrite(text, { agent: id, pw, pinned, kind }).ok ? spinner(`rewriting for ${id}`) : null;
    const c = await curate(text, { agent: id, label: AGENTS[id].label, pw, pinned, kind, profile: profile(),
      projects: registry.flatMap((p) => [p.display, p.name]) });
    sp?.stop();
    if (c.rewritten) out(dim(`  rewrite for ${id}: ~${c.stats.origTok} → ~${c.stats.curTok} tokens (est.) · ${fmtMs(c.stats.rewriteMs)}\n`));
    else if (c.fallback) out(dim(`  rewrite skipped for ${id}: ${c.reason}\n`));
    return c;
  }
  // One counts-only line per turn in promptwriter.jsonl.
  function logRewrite(id, c, r, { category, kind }) {
    if (!c) return;
    logEntry(CONFIG_DIR, {
      agent: id, category, kind, rewritten: c.rewritten, fallback: c.fallback, reason: c.reason, ...c.stats,
      respInTok: r?.inTokens, respCachedIn: r?.cachedIn, respOutTok: r?.outTokens, respMs: r?.ms,
      billing: ledger.totals[id]?.billing, ok: r?.ok,
    });
  }

  // Agents propose vault writes in ```friday-vault blocks; apply them through the queue.
  function vaultWrites(text, source) {
    const { ops, errors } = parseProposals(text);
    for (const e of errors) out(paint(RED, `  ✗ vault proposal from ${source}: ${e}\n`));
    if (!ops.length) return null;
    if (!vaultQueue) { out(dim('  vault writes skipped: no vault configured\n')); return null; }
    out(dim(`  ◈ vault: ${ops.length} write${ops.length > 1 ? 's' : ''} queued (${ops.map((o) => o.op).join(', ')})\n`));
    return applyVault(ops, { source });
  }
  function applyVault(ops, opts) {
    return vaultQueue.submit(ops, opts).then((rep) => {
      const okd = rep.results.filter((x) => x.ok).map((x) => x.op + (x.path ? ` ${x.path}` : ''));
      const bad = rep.results.filter((x) => !x.ok);
      const git = rep.pushed ? 'committed, pushed' : rep.committed ? 'committed' : '';
      if (okd.length) notify(dim(`  ◈ vault: ${okd.join(', ')}${git ? ` · ${git}` : ''}`));
      for (const b of bad) notify(paint(RED, `  ✗ vault ${b.op}${b.path ? ` ${b.path}` : ''}: ${b.error}`));
      for (const w of rep.warnings) notify(paint(AMBER, `  ! vault ${w}`));
      return rep;
    }).catch((e) => notify(paint(RED, `  ✗ vault: ${e.message}`)));
  }

  // ---- council: every agent, in parallel ----------------------------------
  async function council(prompt) {
    let ids = order.filter((id) => installed.includes(id) && id !== 'ollama' && (id !== 'gemini' || ready(id)))
      .concat(installed.includes('ollama') ? ['ollama'] : []);
    const priv = isPrivate(prompt, { profile: profile(), focus: st.focus?.name });
    const sealedWhy = sealedBlock('claude', prompt);
    if (priv || sealedWhy) {
      ids = ids.filter((id) => id === profile().private.agent);
      out(dim(`  private (${priv?.why || sealedWhy}): council limited to ${ids.join(', ') || 'no local agent'}\n`));
      if (!ids.length) return;
    }
    // Each member gets its own rewrite, in parallel, before the live status line starts.
    let cur = {};
    if (profile().promptWriter?.enabled) {
      const sp = spinner(`rewriting for ${ids.length} agents`);
      cur = Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await curateFor(id, prompt, { spin: false })])));
      sp.stop();
    }
    out(`\n${paint(CYAN, '◈')} ${bold('Council')} ${dim(`· ${ids.join(', ')}`)}\n`);
    const status = Object.fromEntries(ids.map((id) => [id, { state: 'run', t0: Date.now(), tools: 0 }]));
    let i = 0;
    const line = () => '  ' + ids.map((id) => {
      const s = status[id];
      const icon = s.state === 'run' ? SPIN[i % SPIN.length] : s.state === 'ok' ? '✓' : '✗';
      const col = s.state === 'err' ? RED : AGENTS[id].color;
      return paint(col, icon) + ' ' + dim(id + (s.state === 'run' ? ' ' + fmtMs(Date.now() - s.t0) : ''));
    }).join('   ');
    const draw = () => { if (tty && !asker.open) out('\r\x1b[2K' + line()); i++; };
    const h = tty ? setInterval(draw, 120) : null;
    draw();

    const jobs = ids.map(async (id) => {
      const sess = session(id);
      await sessionExited(sess);
      const errs = [];
      setAgent(id, { status: 'working', since: Date.now() });
      hud.publish('turn', { agent: id, phase: 'start' });
      const vb = id !== 'ollama' ? vaultBefore() : null;
      const run = runTurn(id, preamble(id, sess) + perTurn(id) + (cur[id]?.text ?? prompt), {
        cwd: st.cwd, session: sess, ollamaModel: config.ollamaModel, ...runOpts(id), live: true,
        system: id === 'ollama' && vaultOk ? ollamaSystem(vault, prompt).system : undefined,
        on: {
          text(t) { hud.publish('say', { agent: id, text: t }); },
          tool(name, input) { status[id].tools++; hud.publish('touch', { agent: id, tool: name, paths: touchedPaths(input, st.cwd), label: describeTool(name, input, st.cwd) }); },
          error(m) { errs.push(m); },
          async permission(req) {
            if (tty) out('\r\x1b[2K');
            const r = await permissionFor(id, req);
            draw();
            return r;
          },
        },
      });
      st.running.add(run);
      const r = await run.done;
      st.running.delete(run);
      status[id].state = r.ok ? 'ok' : 'err';
      logRewrite(id, cur[id], r, { category: 'council', kind: 'council' });
      if (vb && status[id].tools) await commitVaultEdits(vb, id);
      setAgent(id, { status: r.ok ? 'idle' : 'error', since: Date.now() });
      hud.publish('turn', { agent: id, phase: 'end', ok: r.ok });
      // Print this answer as soon as it lands, above the live status line.
      if (tty) out('\r\x1b[2K');
      const s = createStream('  ');
      out(`\n${paint(AGENTS[id].color, '●')} ${bold(AGENTS[id].label)}\n`);
      out(s.write(r.text.trim() || '') + s.flush());
      for (const e of errs) out(paint(RED, `  ✗ ${e}\n`));
      out(dim(`  ${[fmtMs(r.ms), status[id].tools ? `${status[id].tools} tools` : '', ...account(id, r)].filter(Boolean).join(' · ')}\n`));
      if (r.text.trim()) hud.feed({ kind: 'agent', agent: id, text: r.text.trim().slice(0, 600) });
      draw();
      return { id, r };
    });
    hud.feed({ kind: 'user', agent: 'council', text: prompt });
    const results = await Promise.all(jobs);
    if (h) clearInterval(h);
    if (tty) out('\r\x1b[2K');
    const good = results.filter((x) => x.r.ok && x.r.text.trim());
    if (good.length) {
      st.last = { agent: 'council', prompt, text: good.map((x) => `## ${AGENTS[x.id].label}\n${x.r.text.trim()}`).join('\n\n'), private: !!priv };
      record('council', `/all ${prompt}`, st.last.text, priv ? { private: true } : {});
    }
    out(dim(`\n  council done · ${good.length}/${ids.length} answered · /relay <agent> to have one judge the rest\n`));
    rescanSoon();
  }

  // ---- command dispatch ---------------------------------------------------
  async function handle(raw) {
    const line = raw.trim();
    if (!line) return;

    if (line.startsWith('!')) return shell(line.slice(1));

    if (line.startsWith('@')) {
      const m = /^@(\w+)(!?)\s*([\s\S]*)$/.exec(line);
      const id = m?.[1].toLowerCase();
      const msg = m?.[3] || '';
      if (id === 'all') { autoFocus(msg); return council(msg); }
      if (!AGENTS[id]) { out(paint(RED, `  unknown agent @${id}\n`)); return; }
      if (!msg) return use(id);
      autoFocus(msg);
      const p = route(msg, { profile: profile(), ready, focus: st.focus?.name });
      const local = profile().private.agent;
      if (p.sealed && id !== local) {
        out(paint(RED, `  ✗ ${p.sealed} is sealed: it never leaves this machine, and no override changes that. Nothing sent. Use @${local}.\n`));
        return;
      }
      if (p.private && id !== local && m[2] !== '!') {
        out(paint(AMBER, `  ! looks private (${p.reason.replace(/^private: /, '').replace(/, stays on this machine$/, '')}). Nothing sent. FRIDAY keeps this on ${local}; @${id}! sends it anyway.\n`));
        return;
      }
      noteOverride(p, id);
      return void (await turn(id, msg, { private: p.private && id === local, category: p.category }));
    }

    if (line.startsWith('/')) {
      const [cmd, ...rest] = line.slice(1).split(/\s+/);
      const arg = rest.join(' ');
      if (AGENTS[cmd]) return use(cmd);
      switch (cmd) {
        case 'abilities': showAbilities(); return;
        case 'memory': {
          // /memory · /memory add <fact> · /memory forget <n|text>
          const [sub, ...rest] = arg.split(/\s+/);
          const what = rest.join(' ').trim();
          if (sub === 'add' && what) {
            out(dim(rememberFact(what) ? `  remembered: ${what}\n` : '  not saved: it looks private\n'));
            return;
          }
          if ((sub === 'forget' || sub === 'remove') && what) {
            const n = memory.forget(what);
            out(dim(n ? `  forgot ${n} fact${n > 1 ? 's' : ''}\n` : `  nothing matches "${what}"\n`));
            return;
          }
          const facts = memory.facts();
          const sums = memory.summaries();
          const past = convos.list().filter((cv) => cv.id !== st.conv.id).slice(0, 6);
          out(`\n${paint(CYAN, '●')} ${bold('Memory')} ${dim(`· ${tilde(memory.dir)} · separate from the second brain`)}\n`);
          out(facts.length ? facts.map((f, i) => `  ${dim(`${i + 1}.`)} ${f}`).join('\n') + '\n' : dim('  no facts yet · say "remember that …" or /memory add <fact>\n'));
          if (past.length) {
            out(dim('\n  Earlier conversations\n'));
            for (const cv of past) {
              const s = (sums[cv.id]?.summary || summarize(cv).title).replace(/\*\*|`/g, '');
              // Every line indented to the text; the first starts with when it was.
              for (const [i, l] of wrapText(s, { indent: ' '.repeat(12) }).entries()) out((i ? l : `  ${dim(ago(cv.updated).padEnd(9))} ${l.slice(12)}`) + '\n');
            }
          }
          out(dim('\n  /memory add <fact> · /memory forget <number or text>\n\n'));
          return;
        }
        case 'help': case '?':
          out('\n' + HELP.map(([k, v]) => `  ${paint(CYAN, k.padEnd(24))} ${dim(v)}`).join('\n') + '\n\n');
          return;
        case 'use': return use(arg);
        case 'agents':
          out('\n');
          for (const id of order) {
            const a = AGENTS[id];
            const sess = st.sessions.get(`${id}\0${st.cwd}`);
            out(`  ${installed.includes(id) ? paint(a.color, '●') : dim('○')} ${id.padEnd(9)} ${dim(a.label.padEnd(12))}`
              + dim(!installed.includes(id) ? ' not installed' : !ready(id) ? ` ${ready.why(id)}` : sess?.id ? ` session ${String(sess.id).slice(0, 12)}` : ' ready')
              + (id === st.agent ? paint(CYAN, '  ◂ active') : '') + '\n');
          }
          out('\n');
          return;
        case 'all': case 'council':
          if (!arg) { out(dim('  /all <message>\n')); return; }
          autoFocus(arg);
          return council(arg);
        case 'relay': {
          const [to, ...ask] = rest;
          if (!AGENTS[to]) { out(dim('  /relay <agent> [instruction]\n')); return; }
          if (!st.last) { out(dim('  nothing to relay yet\n')); return; }
          if (st.last.private && to !== profile().private.agent) {
            out(paint(AMBER, `  ! the last answer came from private data; it stays on ${profile().private.agent}\n`));
            return;
          }
          const from = st.last.agent === 'council' ? 'the council' : AGENTS[st.last.agent]?.label || 'FRIDAY';
          const instr = ask.join(' ') || `Review this answer from ${from}. Say what is right, what is wrong, and what you would do instead.`;
          const body = `${instr}\n\nThe original question was:\n${st.last.prompt}\n\n--- answer from ${from} ---\n${st.last.text.slice(0, 24000)}`;
          return void (await turn(to, body, { label: `${AGENTS[to].label} ← ${from}`, asked: line }));
        }
        case 'project': case 'p': {
          registry = loadRegistry(config);
          if (!arg) {
            out('\n');
            for (const p of registry) {
              out(`  ${p === st.focus ? paint(AMBER, '◆') : dim('◇')} ${p.display.padEnd(26)} ${dim(p.dir ? tilde(p.dir) : 'vault only')}\n`);
            }
            out('\n');
            return;
          }
          const p = findProject(arg, registry);
          if (!p) { out(dim(`  no project matches "${arg}"\n`)); return; }
          return focusProject(p);
        }
        case 'hud':
          if (/^theme\b/i.test(arg)) return hudTheme(arg.replace(/^theme\b\s*/i, ''));
          if (arg === 'on' || arg === 'off') {
            config.autoHud = arg === 'on';
            saveConfigKey('autoHud', config.autoHud);
            out(dim(`  HUD ${arg === 'on' ? 'opens by itself when a project is in focus' : 'stays closed unless you type /hud'} · saved to config.json\n`));
            return;
          }
          return openHud(arg === 'web' ? 'web' : arg === 'term' ? 'terminal' : undefined);
        case 'usage': {
          out('\n');
          for (const id of order) {
            const t = ledger.totals[id];
            if (!t) continue;
            out(`  ${paint(AGENTS[id].color, '●')} ${id.padEnd(9)} ${dim(`${t.turns} turns · ${t.billing}`)}`
              + dim(t.billing === 'api' ? ` · $${t.cost.toFixed(3)} billed` : t.billing === 'plan' ? ` · $0 billed (~$${t.cost.toFixed(2)} at API prices)` : '')
              + (t.limits?.five_hour != null ? dim(` · ${Math.round(t.limits.five_hour * 100)}% of 5h limit`) : '') + '\n');
          }
          out(dim(Object.keys(ledger.totals).length ? '\n' : '  no turns yet\n'));
          const s = summarizeLog(readLog(CONFIG_DIR));
          if (s.turns) {
            out(`  ${paint(CYAN, '◈')} ${'rewrite'.padEnd(9)} ${dim(`${s.rewritten} of ${s.turns} turns rewritten`
              + (s.avgSaved != null ? ` · ${Math.round(s.avgSaved * 100)}% of the message saved (est., chars/4), ${s.tokSaved} tokens` : '')
              + (s.avgMs != null ? ` · +${fmtMs(Math.round(s.avgMs))} per rewrite` : '')
              + (s.fallbacks ? ` · ${s.fallbacks} fell back (${Object.entries(s.reasons).map(([k, v]) => `${k} ${v}`).join(', ')})` : '')
              + ` · since ${ago(s.since)}`)}\n\n`);
          }
          return;
        }
        case 'rewrite': return rewriteCommand(arg);
        case 'mission': {
          if (!arg) { out(dim('  /mission <goal>   e.g. /mission build an app that finds free food on campus; research it first\n  /mission resume [n]   carry on with an unfinished one\n  /missions   background missions · /mission log <n> · /mission answer <n> <go|cancel|…>\n')); return; }
          const lg = /^log\b\s*(\S*)\s*$/i.exec(arg);
          if (lg) {
            const r = findRun(RUNS, lg[1] || '1');
            if (!r) { out(dim('  no background missions\n')); return; }
            out(dim(`  ${r.id} · ${r.goal || `resume ${r.resume}`} · ${r.alive ? 'running' : r.done ? 'done' : 'stopped'}\n`) + logTail(RUNS, r.id, 40).split('\n').map((l) => `  ${l}`).join('\n') + '\n');
            return;
          }
          const an = /^answer\s+(\S+)\s+([\s\S]+)$/i.exec(arg);
          if (an) {
            const r = findRun(RUNS, an[1]);
            if (!r) { out(paint(RED, `  no background mission "${an[1]}"\n`)); return; }
            out(answerRun(RUNS, r.id, an[2].trim()) ? paint(GREEN, `  ✓ answered ${r.id}: ${an[2].trim()}\n`) : dim(`  ${r.id} is not waiting for an answer\n`));
            return;
          }
          const res = /^resume\b\s*(.*)$/i.exec(arg);
          if (!res) return startMission(arg);
          const open = missionStates.list();
          if (!open.length) { out(dim('  no unfinished missions\n')); return; }
          const pick = res[1].trim() ? missionStates.find(res[1].trim()) : open.length === 1 ? open[0] : null;
          if (pick) return startMission(pick.goal, { state: pick });
          if (res[1].trim()) { out(paint(RED, `  no unfinished mission matches "${res[1].trim()}"\n`)); }
          out(open.map((mm, i) => `  ${dim(`${i + 1}.`)} ${mm.plan?.title || mm.goal.slice(0, 70)} ${dim(`· ${mm.status} · ${ago(mm.updated)}`)}`).join('\n') + dim('\n  /mission resume <n>\n'));
          return;
        }
        case 'telegram': {
          const t = config.telegram;
          if (!t?.chatId) { out(dim('  not set up · run `friday telegram` in a terminal (a bot from @BotFather, then /start)\n')); return; }
          if (arg === 'on' || arg === 'off') {
            config.telegram = { ...t, enabled: arg === 'on' };
            saveConfigKey('telegram', config.telegram);
            out(dim(`  telegram ${arg}\n`));
            return;
          }
          if (arg === 'test') {
            try { await phone()?.send('FRIDAY test: missions will ask you here.'); out(paint(GREEN, '  ✓ sent\n')); } catch (e) { out(paint(RED, `  ✗ ${e.message}\n`)); }
            return;
          }
          out(dim(`  telegram ${t.enabled === false ? 'off' : 'on'} · /telegram on|off|test\n`));
          return;
        }
        case 'missions': {
          const runs = listRuns(RUNS).slice(0, 10);
          if (!runs.length) { out(dim('  no background missions · friday mission "<goal>" --bg starts one\n')); return; }
          out(runs.map((r, i) => `  ${dim(`${i + 1}.`)} ${(r.goal || `resume ${r.resume}`).replace(/\s+/g, ' ').slice(0, 60)} ${dim(`· ${r.alive ? (r.asking ? paint(AMBER, `waiting: ${r.asking.slice(0, 80)}`) : 'running') : r.done ? r.status : 'stopped'} · ${ago(r.started)}`)}`).join('\n')
            + dim('\n  /mission log <n> · /mission answer <n> <go|cancel|…>\n'));
          return;
        }
        case 'orchestrate': {
          const o = profile().orchestrator;
          if (arg === 'on' || arg === 'off') {
            profiles.save({ ...profile(), orchestrator: { ...o, enabled: arg === 'on' } });
            out(dim(`  orchestrator ${arg} · saved to profile.json${arg === 'off' ? ' · the rules route messages' : ''}
`));
            if (arg === 'on') warmBrain(resolveBrain(profile(), CONFIG_DIR), { keepAlive: o.keepAlive });
            return;
          }
          const brain = resolveBrain(profile(), CONFIG_DIR);
          const bs = await brainStatus(brain);
          out(`  ${paint(CYAN, '◈')} orchestrator ${o.enabled !== false ? bold('on') : dim('off')} ${dim(`· ${brain.label} · ${bs.reason} · tools: ${(o.agents || []).filter((a) => installed.includes(a) && ready(a)).join(', ') || 'none ready'} · /orchestrate on|off · /brain`)}
`);
          return;
        }
        case 'brain': {
          // /brain · /brain cloud|local|auto · /brain model <id>
          const [sub, ...rest] = arg.split(/\s+/);
          const b = profile().brain || {};
          if (['cloud', 'local', 'auto'].includes(sub)) {
            const provider = sub === 'cloud' ? 'openrouter' : sub === 'local' ? 'ollama' : 'auto';
            profiles.save({ ...profile(), brain: { ...b, provider } });
            const nb = resolveBrain(profile(), CONFIG_DIR);
            out(dim(`  brain: ${nb.label} · saved to profile.json${nb.cloud || sub !== 'cloud' ? '' : ' · not signed in: /login'}\n`));
            warmBrain(nb);
            return;
          }
          if (sub === 'model' && rest.length) {
            const model = rest.join(' ');
            const p = resolveBrain(profile(), CONFIG_DIR).provider;
            const patch = p === 'ollama' ? { localModel: model } : p === 'openrouter' ? { model } : { models: { ...(b.models || {}), [p]: model } };
            profiles.save({ ...profile(), brain: { ...b, ...patch } });
            out(dim(`  brain: ${resolveBrain(profile(), CONFIG_DIR).label} · saved to profile.json\n`));
            return;
          }
          if (tty && !arg) {
            await brainMenu({
              configDir: CONFIG_DIR, profile, saveProfile: (p) => profiles.save(p), choose,
              say: (l) => out(dim(l) + '\n'), login: loginOpenRouter, warm: (nb) => warmBrain(nb),
              runInteractive: handOverTerminal,
            });
            return;
          }
          const brain = resolveBrain(profile(), CONFIG_DIR);
          const bs = await brainStatus(brain);
          out(`  ${paint(CYAN, '◈')} brain ${bold(brain.label)} ${dim(`· ${bs.reason}`)}\n`);
          out(dim(`  /brain cloud | local | auto · /brain model <id> · /login (OpenRouter sign-in)\n  cloud models: ${CLOUD_MODELS.map((m) => `${m.id} (${m.note})`).join(', ')}\n`));
          return;
        }
        case 'login': {
          if (await loginOpenRouter()) {
            const b = profile().brain || {};
            if (!b.provider || b.provider === 'ollama') profiles.save({ ...profile(), brain: { ...b, provider: 'auto' } });
            const nb = resolveBrain(profile(), CONFIG_DIR);
            out(dim(`  brain: ${nb.label} · ${(await brainStatus(nb)).reason}\n`));
          }
          return;
        }
        case 'mode': {
          const m = arg === 'bypass' ? 'yolo' : arg;
          if (!MODES.includes(m)) { out(dim(`  mode is ${modeName(st.mode)}. /mode plan|edit|bypass (shift+tab cycles them)\n`)); return; }
          if (m === st.mode) { out(dim(`  already ${modeName(m)}\n`)); return; }
          setMode(m);
          return;
        }
        case 'bypass': setMode(st.mode === 'yolo' ? 'edit' : 'yolo'); return;
        case 'new':
          closeLive([...st.sessions].filter(([k]) => k.endsWith('\0' + st.cwd)).map(([, v]) => v));
          for (const k of [...st.sessions.keys()]) if (k.endsWith('\0' + st.cwd)) st.sessions.delete(k);
          st.conv = newConvo(st.cwd);
          st.orchHistory = [];
          out(dim('  fresh sessions · new conversation (← on an empty prompt to go back)\n'));
          return;
        case 'resume': {
          if (!arg && tty) return openPicker();
          const items = convos.list();
          if (!arg) {
            out('\n' + (items.slice(0, 20).map((cv, i) => {
              const s = summarize(cv);
              return `  ${String(i + 1).padStart(2)}  ${dim(ago(cv.updated).padEnd(10))} ${s.title.slice(0, 70)} ${dim(`· ${s.turns} turns`)}`;
            }).join('\n') || dim('  no saved conversations yet')) + '\n' + dim('\n  /resume <n>\n\n'));
            return;
          }
          const cv = items[Number(arg) - 1];
          if (!cv) { out(dim(`  no conversation ${arg}\n`)); return; }
          return resume(cv);
        }
        case 'cd': {
          const to = path.resolve(st.cwd, expandHome(arg || '~'));
          if (!fs.existsSync(to)) { out(paint(RED, `  no such folder ${to}\n`)); return; }
          st.cwd = to; hud.set({ cwd: to });
          warmClaude();
          out(dim(`  ${tilde(to)}\n`));
          return;
        }
        case 'auto':
          st.auto = true;
          out(dim(profile().routing === 'manual' ? '  profile.json has routing "manual"; say "turn routing back on" or edit it\n' : '  routing on: FRIDAY picks the agent\n'));
          return;
        case 'route': {
          if (!arg) { out(dim('  /route <message>  (dry run, nothing is sent)\n')); return; }
          const p = await decide(arg, { useModel: false });
          if (p.kind === 'single' && !p.private && !p.blocked && orchestratorOn()) {
            out(dim(`  -> friday decides (${resolveBrain(profile(), CONFIG_DIR).label}), calling agents as tools · if it cannot be reached: ${describeRoute(p)}\n`));
            return;
          }
          out(dim(`  ${describeRoute(p)}${p.unsure ? ` · unsure: a real message would ask ${profile().classifier.agents.filter(ready).join(' or ') || 'no classifier (none ready)'}` : ''}\n`));
          return;
        }
        case 'profile': {
          const p = profile();
          out(`\n  ${paint(CYAN, '◈')} ${bold('Routing profile')} ${dim(`${tilde(profiles.file)} · ${p.routing}${st.auto ? '' : ' (pinned to ' + st.agent + ')'}`)}\n`);
          if (p.error) out(paint(RED, `  ${p.error}\n`));
          for (const [cat, v] of Object.entries(p.categories)) {
            const chain = [v.agent, ...(v.fallback || [])].map((a) => (ready(a) ? a : dim(`${a}(${ready.why(a)})`))).join(dim(' > '));
            out(`  ${cat.padEnd(12)} ${chain}${v.strict ? dim(' only') : ''}\n`);
          }
          out(`  ${'private'.padEnd(12)} ${p.private.agent} ${dim('only, never a cloud model')}\n`);
          for (const [k, steps] of Object.entries(p.pipelines)) out(`  ${dim(k.padEnd(20))} ${steps.map((s) => `${s.agent} ${s.role}`).join(dim(' -> '))}\n`);
          const ins = Object.entries(p.instructions || {}).filter(([, v]) => v?.length);
          for (const [a, v] of ins) out(dim(`  ${a} always: ${v.join('; ')}\n`));
          out(dim('  edits to profile.json apply on the next message\n\n'));
          return;
        }
        case 'self': {
          const list = selfHistory.list().slice(-10);
          if (!list.length) { out(dim('  no self-changes yet\n')); return; }
          out('\n');
          for (const e of list) {
            out(`  ${e.undone ? dim('↺') : paint(CYAN, '◈')} ${dim(ago(e.t).padEnd(9))} ${dim(e.type.padEnd(8))} ${e.undone ? dim(e.text.slice(0, 70)) : e.text.slice(0, 70)}\n`);
          }
          out(dim('\n  /undo-self reverses the newest one not yet undone\n\n'));
          return;
        }
        case 'undo-self': {
          const res = undoSelf({ history: selfHistory, profileStore: profiles, repo: selfRepo });
          if (!res.ok) { out(paint(AMBER, `  ${res.why}\n`)); return; }
          applyColors(profile());
          out(`  ${paint(CYAN, '◈')} undone: ${res.summary}\n`);
          await logSelf({ title: `Undo self-change: ${res.entry.text.replace(/\s+/g, ' ').slice(0, 60)}`, body: res.summary });
          if (res.restart) return restart('undo');
          return;
        }
        case 'approve': return approveDesign();
        case 'design': return designCommand(arg);
        case 'clear': out('\x1b[2J\x1b[H'); return;
        case 'quit': case 'exit': case 'q': return quit();
        default: out(dim(`  unknown command /${cmd} · /help\n`)); return;
      }
    }

    // "make the HUD look like C:\pics\cockpit.png", "give the HUD purple accents"
    if (isThemeRequest(line)) return hudTheme(line);

    autoFocus(line);
    if (!routing()) {
      if (!st.agent) { out(paint(RED, '  no agent available\n')); return; }
      // A pinned agent does not skip the private-data rule.
      const priv = isPrivate(line, { profile: profile(), focus: st.focus?.name });
      const local = profile().private.agent;
      if (priv && st.agent !== local) {
        out(paint(AMBER, `  ! looks private (${priv.why}). Nothing sent to ${st.agent}. Use @${local}${priv.sealed ? '' : `, or @${st.agent}! to send it anyway`}.\n`));
        return;
      }
      return void (await turn(st.agent, line, { private: !!priv }));
    }
    // The orchestrator decides itself; the router's tie-break would only add latency.
    return execute(await decide(line, { useModel: !orchestratorOn() }), line);
  }

  // /hud theme: show, reset, undo, or a new look from an image and/or words. Claude
  // designs it (it reads the image itself); FRIDAY checks it is readable, saves it,
  // and both HUDs repaint live.
  async function hudTheme(arg) {
    const help = dim('/hud theme <image path and/or words> · /hud theme reset · /hud theme undo · or the ◐ theme button in /hud web');
    if (!arg) {
      const t = themes.get();
      out(`  ${paint(t.colors.accent, '◈')} HUD theme ${bold(t.name)} ${dim(`· ${tilde(themes.file)} (hand edits apply live)`)}\n  ${help}\n`);
      return;
    }
    if (/^reset$/i.test(arg)) { hud.set({ theme: themes.reset() }); out(dim('  HUD theme back to the default · /hud theme undo puts yours back\n')); return; }
    if (/^undo$/i.test(arg)) {
      const t = themes.undo();
      if (!t) { out(dim('  no earlier theme to go back to\n')); return; }
      hud.set({ theme: t });
      out(`  ${paint(t.colors.accent, '◈')} HUD theme back to ${bold(t.name)}\n`);
      return;
    }
    let image = null;
    let request = arg;
    const found = findImagePath(arg);
    if (found) {
      const p = path.resolve(st.cwd, expandHome(found));
      if (!fs.existsSync(p)) { out(paint(RED, `  ✗ no image at ${p}\n`)); return; }
      try { image = path.dirname(p) === themes.assets ? p : path.join(themes.assets, themes.addImage(p)); }
      catch (e) { out(paint(RED, `  ✗ ${e.message}\n`)); return; }
      request = arg.replace(found, '').replace(/["']/g, '').trim();
    }
    if (!ready('claude')) { out(paint(RED, `  ✗ designing a HUD theme needs Claude (${ready.why('claude')}). Edit ${tilde(themes.file)} by hand meanwhile.\n`)); return; }
    let prompt = themePrompt({ image, request, current: themes.get() });
    for (let attempt = 0; attempt < 2; attempt++) {
      const sp = spinner(image ? 'designing a HUD theme from the image' : 'designing a HUD theme');
      const run = runTurn('claude', prompt, { cwd: themes.assets, mode: 'plan', session: {}, on: {}, extraArgs: speedArgs('claude') });
      st.running.add(run);
      const r = await run.done;
      st.running.delete(run);
      sp.stop();
      account('claude', r);
      if (!r.ok) { out(paint(RED, `  ✗ ${r.aborted ? 'stopped' : `Claude failed: ${(r.errors || []).join('; ').slice(0, 200)}`}; the HUD is unchanged\n`)); return; }
      const got = parseThemeReply(r.text);
      const problems = got.error ? [got.error] : themeProblems(got.theme);
      if (problems.length && attempt === 0) {
        prompt += `\n\nThat reply was not used: ${problems.join('; ')}. Reply again with the complete theme, fixed.`;
        continue;
      }
      if (got.error) break;
      // Only an image FRIDAY holds may sit behind the web HUD.
      const bg = got.theme.background.image;
      if (bg && !fs.existsSync(path.join(themes.assets, bg))) got.theme.background.image = null;
      const t = themes.save(got.theme);
      hud.set({ theme: t });
      out(`  ${paint(t.colors.accent, '◈')} HUD theme ${bold(t.name)}${got.note ? dim(` · ${got.note}`) : ''}`
        + (problems.length ? paint(AMBER, ` · still: ${problems.join('; ')}`) : '') + '\n'
        + dim(`  /hud theme undo puts the last one back${hud.viewers ? '' : ' · /hud to see it'}\n`));
      return;
    }
    out(paint(RED, '  ✗ Claude did not return a usable theme; the HUD is unchanged\n'));
  }

  // /rewrite: status; on/off (saved to profile.json); anything else is a dry run.
  async function rewriteCommand(arg) {
    const pw = profile().promptWriter;
    if (!arg || arg === 'status') {
      const s = await writerStatus(pw);
      const health = !s.up ? paint(RED, 'Ollama not running') : s.pulled ? paint(CYAN, 'ready') : paint(AMBER, 'model not pulled (node scripts/setup-promptwriter.js)');
      out(`  ${paint(CYAN, '◈')} prompt-writer ${pw.enabled ? bold('on') : dim('off')} ${dim(`· ${pw.model} ·`)} ${health}\n`);
      out(dim(`    rewrites messages of ${pw.minWords}+ words for ${Object.keys(pw.styles).filter((a) => !pw.skipAgents.includes(a)).join(', ')} · timeout ${fmtMs(pw.timeoutMs)} · /rewrite on|off|<message>\n`));
      return;
    }
    if (arg === 'on' || arg === 'off') {
      profiles.save({ ...profile(), promptWriter: { ...pw, enabled: arg === 'on' } });
      out(dim(`  prompt-writer ${arg} · saved to profile.json\n`));
      if (arg === 'on') {
        const s = await writerStatus(pw);
        if (s.up && s.pulled) warmWriter(pw);
        else out(paint(AMBER, `  ! ${s.up ? `${pw.model} is not pulled: node scripts/setup-promptwriter.js` : 'Ollama is not running'}. Messages go unrewritten until then.\n`));
      }
      return;
    }
    // Dry run: where it would go, and what each target agent would read.
    const p = await decide(arg, { useModel: false });
    out(dim(`  ${describeRoute(p)} · dry run, nothing sent\n`));
    const targets = p.kind === 'council'
      ? order.filter((id) => installed.includes(id) && ready(id))
      : p.kind === 'pipeline' || p.kind === 'single' ? [...new Set(p.steps.map((s) => s.agent).filter(Boolean))] : [];
    if (!targets.length) { out(dim(`  ${p.kind} messages are not rewritten\n`)); return; }
    for (const id of targets) {
      const c = await curateFor(id, arg, { force: true });
      if (c.rewritten) out(`${paint(AGENTS[id].color, '●')} ${bold(AGENTS[id].label)} ${dim('would read')}\n${c.text.replace(/^/gm, '  ')}\n`);
      else if (!c.fallback) out(dim(`  ${id}: not rewritten (${c.reason})\n`));
    }
  }

  function use(id) {
    if (!AGENTS[id]) { out(dim(`  agents: ${order.join(', ')}\n`)); return; }
    if (!installed.includes(id)) { out(paint(RED, `  ${id} is not installed\n`)); return; }
    st.agent = id; st.auto = false; hud.set({ active: id });
    out(dim(`  talking to ${AGENTS[id].label} · routing off until /auto\n`));
  }

  // ---- routing ------------------------------------------------------------
  async function decide(text, { useModel = true } = {}) {
    const prof = profile();
    let p = route(text, { profile: prof, ready, focus: st.focus?.name });
    // Working inside a sealed project's folder: local only, decided before any
    // classifier (opencode's is a cloud model) sees the text.
    const sealedWhy = !p.private && sealedBlock('claude', text);
    if (sealedWhy) {
      return { kind: 'single', category: 'private', private: true, sealed: true, confidence: 1, unsure: false, notes: [],
        steps: [{ agent: prof.private.agent, role: 'answer' }], reason: `private: ${sealedWhy}` };
    }
    if (p.kind === 'single' && p.unsure && useModel && text.trim().split(/\s+/).length >= 6) {
      const got = await classify(text);
      if (got && got.category !== p.category) p = { ...routeCategory(got.category, { profile: prof, ready }), reason: `${got.category} (asked ${got.by})` };
    }
    return p;
  }

  // Small-model tie-break: local Ollama first, then opencode's free model.
  async function classify(text) {
    const prof = profile();
    // A cloud brain answers first: no warm-up, ~1 s. Never for anything sealed.
    const brain = resolveBrain(prof, CONFIG_DIR);
    if (brain.cloud && !brain.cli && !sealedBlock('claude', text)) {
      const sp = spinner('routing (asking the brain)');
      const r = await chat(brain, { messages: [{ role: 'user', content: classifierPrompt(text) }], maxTokens: 8, timeoutMs: prof.classifier.timeoutMs || 6000 });
      sp.stop();
      const category = r.ok ? parseCategory(r.message?.content || '') : null;
      if (category) return { category, by: 'brain' };
    }
    for (const id of prof.classifier.agents || []) {
      if (!ready(id)) continue;
      // A big local model would make every unsure message wait; skip it and route by the rules.
      if (id === 'ollama' && !routerModelReady) continue;
      if (sealedBlock(id, text)) continue;
      // Pushed out of memory (a private turn loaded the big model): route by the rules
      // now and load it again in the background, instead of waiting out a cold start.
      if (id === 'ollama' && !(await ollamaLoaded(routerModel()))) {
        warmWriter({ model: routerModel(), keepAlive: prof.classifier.keepAlive });
        continue;
      }
      const sp = spinner(`routing (asking ${id})`);
      const run = runTurn(id, classifierPrompt(text), {
        cwd: os.tmpdir(), mode: 'plan', session: {}, on: {}, ollamaModel: routerModel(),
        ollamaOptions: { temperature: 0, num_predict: 8 }, keepAlive: prof.classifier.keepAlive,
      });
      const timer = setTimeout(() => run.abort(), prof.classifier.timeoutMs || 6000);
      const r = await run.done;
      clearTimeout(timer);
      sp.stop();
      const category = r.ok ? parseCategory(r.text) : null;
      if (category) return { category, by: id };
    }
    return null;
  }

  // A login, install or download that needs the terminal (claude auth login, ollama pull):
  // FRIDAY stops reading keys until it exits.
  async function handOverTerminal(bin, args) {
    const raw = process.stdin.isRaw;
    rl.pause();
    try { if (tty) process.stdin.setRawMode(false); } catch {}
    out(dim(`  ── ${bin} ${args.join(' ')} ──\n`));
    const ok = await runInteractive(bin, args);
    try { if (tty) process.stdin.setRawMode(raw); } catch {}
    rl.resume();
    out(dim(`  ── back in FRIDAY ──\n`));
    return ok;
  }

  // OpenRouter sign-in in the browser (src/brain.js). true once a key is saved.
  async function loginOpenRouter() {
    out(dim('  opening OpenRouter in your browser · sign in and approve FRIDAY (5 minutes)\n'));
    try {
      const key = await signInOpenRouter({ open: async (url) => { if (!openBrowser(url)) out(dim(`  open this link: ${url}\n`)); } });
      saveKey(CONFIG_DIR, 'openrouter', key);
      out(paint(GREEN, `  ✓ signed in to OpenRouter (${keyHint(key)})\n`));
      return true;
    } catch (e) { out(paint(RED, `  ✗ ${e.message}\n`)); return false; }
  }

  // ---- local orchestrator ---------------------------------------------------
  const orchestratorOn = () => routing() && profile().orchestrator?.enabled !== false;
  // Runs the message through the brain (OpenRouter or a local model, src/brain.js),
  // which calls agents as tools. Returns false (the rules route it instead) when the
  // brain cannot be used right now.
  async function runOrchestrator(text, p = {}) {
    const prof = profile();
    const o = prof.orchestrator;
    const brain = resolveBrain(prof, CONFIG_DIR);
    if (!brain.cloud) {
      if (!ollamaRunning) return false;
      if (!(await ollamaLoaded(brain.model))) {
        const pulled = (await writerStatus({ model: brain.model })).pulled;
        if (pulled) warmBrain(brain, { keepAlive: o.keepAlive });
        out(dim(`  local orchestrator (${brain.model}) is ${pulled ? 'loading' : 'not pulled'}; the rules route this one · /brain cloud uses OpenRouter instead\n`));
        return false;
      }
    }
    const agents = (o.agents || []).filter((a) => AGENTS[a] && !AGENTS[a].http && installed.includes(a) && ready(a));
    if (!agents.length) return false;
    const short = brain.model.split('/').pop();
    hud.set({ route: `friday decides (${brain.label})` });
    let sp = null;
    let localMs = 0;
    let asked = null; // the task the brain wrote for the next agent
    const routed = () => `routed by ${short} in ${fmtMs(localMs)}`;
    // FRIDAY's own words, as a "● " block like any answer.
    const fridaySays = (t) => {
      const s = createStream('  ', { first: `${paint(CYAN, '●')} ` });
      out('\n' + s.write(t) + s.flush());
    };
    const res = await orchestrate(text, {
      agents, profile: prof, brain, history: st.orchHistory, defaultAgent: p.steps?.[0]?.agent, missions: true,
      context: { cwd: tilde(st.cwd), focus: st.focus?.display || null, mode: st.mode, memory: recall() },
      callAgent: async (agent, prompt) => {
        st.agent = agent; hud.set({ active: agent });
        const r = await turn(agent, prompt, { original: text, asked: text, category: 'orchestrated', task: asked, note: routed() });
        return r;
      },
      on: {
        thinking() { sp = spinner('routing'); },
        decide(ms) { sp?.stop(); sp = null; localMs += ms; },
        delegate(agent, task) { asked = task; },
        remember(fact) {
          const ok = rememberFact(fact);
          if (ok) out(`  ${dim('⎿')}  ${dim(`remembered: ${fact}`)}\n`);
          return ok;
        },
        answer(t) {
          fridaySays(t);
          out(dim(`\n  FRIDAY · ${short} · ${fmtMs(localMs)}\n`));
          record('friday', text, t);
        },
        note(t) { fridaySays(t); },
        fail(reason) { out(dim(`  ⎿  FRIDAY stopped: ${reason}\n`)); },
        fallback(from, to) { out(dim(`  ⎿  handing it to ${to} (${from === 'the local model' ? 'it needs files or tools' : `${from} failed`})\n`)); },
      },
    });
    sp?.stop();
    if (!res.handled) { out(dim(`  ⎿  ${brain.label} could not decide (${res.reason}); the rules route this one\n`)); return false; }
    // It judged this a multi-phase job: FRIDAY leads it as a mission (the user's words as the goal).
    if (res.mission) { out(dim(`  ⎿  a mission: research first, then build · ${routed()}\n`)); await startMission(text); return true; }
    st.orchHistory = rememberExchange(st.orchHistory, res.transcript, o.history || 3);
    return true;
  }

  // ---- missions: FRIDAY leads a multi-step job (src/mission.js) --------------------
  async function startMission(goal, { state = null } = {}) {
    const busy = state && workerFor(RUNS, state.id, { exceptRun: W?.id });
    if (busy) { out(paint(AMBER, `  ! a background worker is running this mission (${busy.id}) · /mission log, /mission answer\n`)); return; }
    if (state) setRun({ missionId: state.id });
    st.inMission = true;
    try { return await runMissionHere(goal, { state }); } finally { st.inMission = false; st.lastShown = null; }
  }
  async function runMissionHere(goal, { state }) {
    const prof = profile();
    const o = prof.orchestrator;
    const mp = prof.mission;
    // A mission runs on cloud agents: nothing private or sealed goes into one.
    const priv = isPrivate(goal, { profile: prof, focus: st.focus?.name });
    const sealedWhy = sealedBlock('claude', goal);
    if (priv || sealedWhy) { out(paint(RED, `  ✗ missions use cloud agents, and this looks private (${priv?.why || sealedWhy}). Nothing sent.\n`)); return; }
    // The local model plans and merges; a mission resumed at the build no longer needs it.
    const brain = resolveBrain(prof, CONFIG_DIR);
    const needsLocal = !state || ['plan', 'research', 'brief'].includes(state.phase);
    const localReady = brain.cloud ? (await brainStatus(brain)).ready : ollamaRunning && (await writerStatus({ model: brain.model })).pulled;
    if (needsLocal && !localReady) {
      const fix = brain.cloud ? 'run `friday login` to sign in to OpenRouter' : ollamaRunning ? `pull it with \`ollama pull ${brain.model}\`` : 'start Ollama, or /brain cloud';
      out(paint(RED, `  ✗ missions are planned by the brain (${brain.label}): ${fix}.\n`));
      return;
    }
    const agents = ['codex', 'claude', 'gemini', 'opencode'].filter((a) => installed.includes(a) && ready(a));
    if (!agents.includes('claude')) { out(paint(RED, `  ✗ missions need Claude to review the plan; claude is ${ready.why('claude')}\n`)); return; }
    if (!agents.includes('codex')) out(dim(`  codex is ${ready.why('codex')}; its research goes to ${agents.join(', ')}\n`));
    if (!(await chooseMissionStore())) return;
    // A goal about one of the user's projects: research reads its code, and the build
    // goes into it (on a branch). Sealed folders never count.
    const proj = state?.project || missionProject(goal);
    out(`\n${paint(CYAN, '◈')} ${bold(state ? 'Mission resumed' : 'Mission')} ${dim(`· ${(state?.plan?.title || goal).replace(/\s+/g, ' ').slice(0, 110)}${state ? ` · from ${state.phase}` : ''}${proj ? ` · on ${proj.name} (${tilde(proj.dir)})` : ''}`)}\n`);
    hud.set({ route: 'mission' });
    // A resumed builder carries on in its own session.
    if (state?.workdir) for (const [id, sid] of Object.entries(state.sessions || {})) if (sid) session(id, state.workdir).id = sid;
    const sessions = { ...(state?.sessions || {}) };
    const apiCost = () => Object.values(ledger.totals).reduce((s, t) => s + (t.billing === 'api' ? t.cost || 0 : 0), 0);
    const cost0 = apiCost();
    const lessons = readLessons();
    // Past pauseAt of its 5-hour plan limit, or the mission's API spend past maxCost.
    const overBudget = (agent) => {
      const five = ledger.totals[agent]?.limits?.five_hour;
      if (mp.pauseAt != null && five != null && five >= mp.pauseAt) return `${agent} is at ${Math.round(five * 100)}% of its 5-hour limit`;
      const spent = apiCost() - cost0;
      if (mp.maxCost != null && spent >= mp.maxCost) return `this mission has spent $${spent.toFixed(2)} on API-billed agents (limit $${mp.maxCost})`;
      return null;
    };
    let sp = null;
    const stopSp = () => { sp?.stop(); sp = null; };
    const m = await runMission(goal, {
      agents,
      lessons,
      local: (messages, { format }) => brainJson(brain, o, messages, format),
      claude: quietClaude,
      ask: (q) => { stopSp(); return ask(q); },
      show: (t) => { stopSp(); st.lastShown = t; const s = createStream('  '); out('\n' + s.write(t) + s.flush() + '\n'); },
      status: (t) => { stopSp(); sp = spinner(t); },
      project: proj,
      runResearch: (jobs, onResult) => { stopSp(); return runResearchJobs(jobs, agents, onResult, proj?.dir); },
      runBuild: async (job, dir) => {
        stopSp();
        const r = await runBuildJob(job, dir, goal);
        if (r?.agent) sessions[r.agent] = session(r.agent, dir).id || sessions[r.agent];
        return r;
      },
      runParts: (job, dir) => { stopSp(); return runParts(job, dir, goal, mp.maxParallel || 3); },
      verify: (dir, cmd) => { stopSp(); return verifyBuild(dir, cmd); },
      budget: overBudget,
      overflow: (agent) => (mp.overflow === 'auto' ? pickHeadroom(agent, agents, { ready, over: overBudget, used: (a) => ledger.totals[a]?.limits?.five_hour }) : null),
      usage: () => Object.fromEntries(agents.map((a) => [a, { five_hour: ledger.totals[a]?.limits?.five_hour ?? null, seven_day: ledger.totals[a]?.limits?.seven_day ?? null, cost: ledger.totals[a]?.cost ?? null }])),
      nextAgent: (agent) => agents.filter((a) => a !== agent && ready(a)).sort((a, b) => (b === 'claude') - (a === 'claude') || (b === 'codex') - (a === 'codex'))[0] || null,
      reflect: async (prompt) => {
        const r = await quietClaude(prompt);
        if (r?.ok && parseLessons(r.text).length) return r.text;
        return localReady ? brainJson(brain, o, [{ role: 'user', content: prompt }], lessonsSchema) : '';
      },
      checkpoint: (mm) => { mm.sessions = sessions; if (proj) mm.project = proj; missionStates.save(mm); setRun({ missionId: mm.id, status: mm.status }); },
      workdir: (plan) => proj?.dir || path.join(expandHome(config.roots?.[0] || '~'), slugify(plan.title)),
      branch: (mm) => {
        try {
          const b = missionBranch(mm.workdir, mm.slug);
          if (b.branch) out(dim(`  ◇ building on branch ${b.branch}${b.base ? ` (from ${b.base})` : ''}\n`));
          return b;
        } catch (e) { return { error: `cannot set up a branch in ${tilde(mm.workdir)}: ${e.message}` }; }
      },
      commit: (mm, message) => commitAll(mm.workdir, message),
      canPr: (mm) => !!mm.branch && !!which('gh') && hasRemote(mm.workdir),
      pr: (mm, body) => {
        const blocked = sealedBlock('claude', body, mm.workdir);
        if (blocked) throw new Error(`not sent to GitHub: ${blocked}`);
        out(dim(`  ◇ pushing ${mm.branch} and opening a pull request\n`));
        const url = openPr(mm.workdir, { branch: mm.branch, title: (mm.plan?.title || mm.goal).slice(0, 72), body },
          (file, args, cwd) => execFileSync(file === 'gh' ? which('gh') : file, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 }));
        out(paint(GREEN, `  ✓ ${url}\n`));
        return url;
      },
      save: async (mm) => { stopSp(); const where = await saveMission(mm); await saveLessons(mm); return where; },
    }, { state, fixRounds: mp.fixRounds || 3 });
    stopSp();
    const tail = m.paused ? dim(' · /mission resume carries on from here') : '';
    const where = m.pr ? dim(` · PR: ${m.pr}`) : m.branch && m.done ? dim(` · branch ${m.branch} in ${tilde(m.workdir)}`) : '';
    out(`\n${paint(CYAN, '◈')} ${bold('Mission')} ${m.paused ? paint(AMBER, m.status) : dim(m.status)}${where}${m.saved ? dim(` · saved: ${m.saved}`) : ''}${m.saveError ? paint(RED, ` · not saved: ${m.saveError}`) : ''}${tail}\n`);
    if (m.lessons?.length) out(dim(`  lessons for next time:\n${m.lessons.map((l) => `    - ${l}`).join('\n')}\n`));
    record('friday', `/mission ${goal}`, `Mission ${m.status}.${m.saved ? ` Saved: ${m.saved}` : ''}`);
    ping(`◈ Mission ${m.paused ? 'paused' : 'done'}: ${(m.plan?.title || goal).slice(0, 120)}\n${m.status}${m.pr ? `\n${m.pr}` : m.branch && m.done ? `\nbranch ${m.branch}` : ''}`);
    if (W) { setRun({ missionId: m.id, status: m.status, done: true, paused: !!m.paused, pr: m.pr || null, branch: m.branch || null, saved: m.saved || null }); st.closing = true; }
  }

  // The project a mission goal is about: a registered project with a folder, not sealed.
  function missionProject(goal) {
    // FRIDAY_MISSION_DIR pins the mission to one folder (the benchmark uses it).
    const pinned = process.env.FRIDAY_MISSION_DIR;
    if (pinned && fs.existsSync(pinned)) return { name: path.basename(pinned), dir: path.resolve(pinned) };
    const p = detectProject(goal, registry, { auto: true, vault: config.vault });
    if (!p?.dir || !fs.existsSync(p.dir)) return null;
    if (sealedDirs().some((d) => path.resolve(d).toLowerCase() === path.resolve(p.dir).toLowerCase())) return null;
    return { name: p.display || p.name, dir: p.dir };
  }

  // Lessons live next to the missions: the vault note, or lessons.md in the mission folder.
  function lessonsFile() {
    const store = config.missionStore || defaultMissionDir();
    return store === 'vault' ? (vaultOk ? path.join(vault, LESSONS_PATH) : null) : path.join(store, 'lessons.md');
  }
  function readLessons() {
    try { const f = lessonsFile(); return f ? recentLessons(fs.readFileSync(f, 'utf8')) : ''; } catch { return ''; }
  }
  async function saveLessons(m) {
    if (!m.lessons?.length) return;
    const entry = [`## ${m.date} · ${m.plan?.title || m.goal.slice(0, 60)} (${m.status})`, ...m.lessons.map((l) => `- ${l}`)].join('\n');
    const store = config.missionStore || defaultMissionDir();
    try {
      if (store !== 'vault') {
        fs.mkdirSync(store, { recursive: true });
        const f = path.join(store, 'lessons.md');
        if (!fs.existsSync(f)) fs.writeFileSync(f, '# FRIDAY mission lessons\n');
        fs.appendFileSync(f, `\n${entry}\n`);
        return;
      }
      if (!vaultQueue) return;
      const exists = fs.existsSync(path.join(vault, LESSONS_PATH));
      const op = exists ? { op: 'append', path: LESSONS_PATH, content: entry }
        : { op: 'create', path: LESSONS_PATH, content: `# FRIDAY mission lessons\n\n*Written by FRIDAY after each mission; the newest 10 go into the next mission's prompts. Edit or delete freely.*\n\n${entry}\n`, index: 'FRIDAY mission lessons (fed into every new mission)' };
      await vaultQueue.submit([op], { source: 'mission', message: 'FRIDAY mission lessons' });
    } catch (e) { out(dim(`  lessons not saved: ${e.message}\n`)); }
  }

  // The build's tests: the command the brief named, else whatever the project has.
  async function verifyBuild(dir, cmd) {
    const command = cmd || testCommandFor(dir);
    if (!command || !fs.existsSync(dir)) { out(dim('  no tests to run\n')); return { ran: false }; }
    out(dim(`  ◇ tests: ${command}\n`));
    const t = await runTests(dir, command, { timeoutMs: 600000 });
    out(t.ok ? paint(GREEN, '  ✓ tests pass\n') : paint(RED, `  ✗ tests fail\n${testFailureSummary(t.out).split('\n').map((l) => `    ${l}`).join('\n')}\n`));
    return { ran: true, ok: t.ok, command, summary: t.ok ? '' : testFailureSummary(t.out) };
  }

  // The brain, asked for JSON in a given shape (structured output). A local model is
  // capped and penalised for repeats: unchecked, qwen2.5 7B looped on one link until it
  // overflowed num_ctx and Ollama returned 500.
  async function brainJson(brain, o, messages, format) {
    const r = await chat(brain, {
      messages, format, temperature: 0.2, maxTokens: o.missionMaxTokens || (brain.cloud ? 4096 : 2048),
      timeoutMs: o.missionTimeoutMs || 240000, keepAlive: o.keepAlive,
      ollamaOptions: { num_ctx: o.missionCtx || 8192, repeat_penalty: 1.15, repeat_last_n: 256 },
    });
    return r.ok ? r.message?.content || '' : '';
  }

  // Claude as reviewer: no tools needed, no project folder, nothing streamed.
  async function quietClaude(prompt) {
    if (!ready('claude') || sealedBlock('claude', prompt, os.tmpdir())) return { ok: false, text: '' };
    const run = runTurn('claude', prompt, { cwd: os.tmpdir(), mode: 'plan', session: {}, on: {}, extraArgs: speedArgs('claude') });
    st.running.add(run);
    const r = await run.done;
    st.running.delete(run);
    account('claude', r);
    return r;
  }

  // Research jobs in parallel; each answer prints as it lands. Codex searches the web;
  // Claude may use WebSearch/WebFetch. A job whose agent cannot log in moves on once.
  // One agent turn with nothing streamed, for jobs that run side by side (research, build
  // parts): the HUD shows the work; the answer prints in one block when it lands. A job
  // whose agent cannot log in moves to another agent once.
  async function quietJob(job, { cwd, mode, kind, avail, preArgs = () => [], extraArgs = () => [], show = 60, timeoutMs = 0 }, moved = false) {
    const blocked = sealedBlock(job.agent, job.prompt, cwd);
    if (!job.agent || blocked) return { id: job.id, agent: job.agent, ok: false, text: '', errors: [blocked || 'no agent'] };
    const errs = [];
    let tools = 0;
    setAgent(job.agent, { status: 'working', since: Date.now() });
    const run = runTurn(job.agent, job.prompt, {
      cwd, mode, session: {}, preArgs: preArgs(job.agent), extraArgs: extraArgs(job.agent), timeoutMs,
      on: {
        tool(name, input) { tools++; hud.publish('touch', { agent: job.agent, tool: name, paths: touchedPaths(input, cwd), label: describeTool(name, input, cwd) }); },
        error(e) { errs.push(e); },
      },
    });
    st.running.add(run);
    const r = await run.done;
    st.running.delete(run);
    setAgent(job.agent, { status: r.ok ? 'idle' : 'error', since: Date.now() });
    if (!r.ok && !r.aborted && LOGIN_ERROR.test(errs.join(' '))) {
      loggedOut.add(job.agent);
      const next = avail().find((a) => a !== job.agent);
      if (next && !moved) { out(dim(`  ${job.agent} is not logged in; ${next} takes "${job.id}"\n`)); return quietJob({ ...job, agent: next }, { cwd, mode, kind, avail, preArgs, extraArgs, show, timeoutMs }, true); }
    }
    const text = (r.text || '').trim();
    // Finished without a word: say so, rather than fail silently.
    if (r.ok && !text) { errs.push('answered with no text'); out(paint(RED, '  ✗ answered with no text\n')); }
    out(`\n${paint(AGENTS[job.agent].color, '●')} ${bold(AGENTS[job.agent].label)} ${dim(`· ${kind}: ${job.id}`)}\n`);
    const lines = text.split('\n');
    const s = createStream('  ');
    out(s.write(lines.slice(0, show).join('\n')) + s.flush());
    if (lines.length > show) out(dim(`  … ${lines.length - show} more lines, saved with the mission\n`));
    for (const e of errs) out(paint(RED, `  ✗ ${e}\n`));
    out(dim(`  ${[fmtMs(r.ms), tools ? `${tools} tools` : '', ...account(job.agent, r)].filter(Boolean).join(' · ')}\n`));
    // A worktree is removed right after an edit job: wait until the agent's process is gone.
    if (mode !== 'plan') await run.exited;
    return jobResult(job, r, text, errs);
  }

  // What a mission keeps of one agent turn: the answer, and enough to say why it failed.
  // `interrupted`: stopped by Esc, Ctrl+C, a quit or a reload (the mission pauses);
  // a timeout is a failure, not an interruption.
  function jobResult(job, r, text, errs) {
    const ok = !!r.ok && !!text;
    return {
      id: job.id, agent: job.agent, ok, text, errors: errs, ms: r.ms,
      ...(ok ? {} : { code: r.code ?? null, stderrTail: r.stderrTail || '' }),
      ...(r.timedOut ? { timedOut: true } : {}),
      ...(r.aborted && !r.timedOut ? { interrupted: true } : {}),
      paused: !r.ok && !r.aborted && LIMIT_ERROR.test(errs.join(' ')),
    };
  }

  // Research jobs in parallel; each answer is reported (and checkpointed) as it lands.
  // `dir`: the project the mission is about; research runs inside it (read-only), and
  // Claude may also read the vault (minus sealed notes).
  async function runResearchJobs(jobs, agents, onResult = async () => {}, dir = null) {
    const avail = () => agents.filter((a) => ready(a));
    const planned = jobs.map((j) => ({ ...j, agent: ready(j.agent) ? j.agent : (avail().includes('claude') ? 'claude' : avail()[0]) }));
    out(`\n${paint(CYAN, '◈')} ${bold('Research')} ${dim(`· ${planned.map((j) => `${j.agent} (${j.id})`).join(', ')} · in parallel${dir ? ` · in ${tilde(dir)}` : ''}`)}\n`);
    const vaultArgs = vaultOk ? ['--add-dir', vault, ...sealedDenyArgs('claude')] : [];
    const opts = {
      cwd: dir || os.tmpdir(), mode: 'plan', kind: 'research', avail, timeoutMs: profile().mission.researchTimeoutMs || 0,
      preArgs: (a) => (a === 'codex' ? ['--search'] : []),
      extraArgs: (a) => (a === 'claude' ? [...speedArgs('claude'), ...vaultArgs, '--allowedTools', 'WebSearch', 'WebFetch'] : []),
    };
    return Promise.all(planned.map(async (j) => { const r = await quietJob(j, opts); await onResult(r); return r; }));
  }

  // A build split into parts that own separate paths: each part in its own worktree and
  // branch, maxParallel at a time; then the branches merge into the mission folder. A
  // conflict goes to the build's agent once; past that, the user decides.
  async function runParts(job, dir, goal, maxParallel) {
    const fail = (text, paused = false, interrupted = false) => ({ ok: false, text, agent: job.agent, paused, errors: [text], ...(interrupted ? { interrupted } : {}) });
    let base;
    try { base = ensureRepo(dir); } catch (e) { out(paint(RED, `  ✗ cannot make ${tilde(dir)} a git repo: ${e.message}\n`)); return fail(e.message); }
    const slug = slugify(path.basename(dir));
    const avail = () => ['claude', 'codex', 'gemini', 'opencode'].filter((a) => installed.includes(a) && ready(a));
    out(`\n${paint(CYAN, '◈')} ${bold('Build')} ${dim(`· ${job.parts.map((p) => `${p.agent} (${p.id}: ${p.owns.join(', ')})`).join(', ')} · in parallel, each in its own worktree`)}\n`);
    const wts = [];
    try {
      for (const p of job.parts) wts.push({ part: p, ...partWorktree(dir, slug, p.id, MISSION_WORKTREES) });
    } catch (e) {
      for (const w of wts) removeWorktree(dir, w.dir);
      out(paint(RED, `  ✗ worktree: ${e.message}\n`));
      return fail(e.message);
    }
    const results = [];
    const queue = [...wts];
    const worker = async () => {
      for (let w; (w = queue.shift());) {
        const r = await quietJob({ id: w.part.id, agent: ready(w.part.agent) ? w.part.agent : avail()[0], prompt: partPrompt(w.part, job.parts) },
          { cwd: w.dir, mode: 'edit', kind: 'build part', avail, extraArgs: (a) => speedArgs(a), show: 25, timeoutMs: profile().mission.buildTimeoutMs || 0 });
        let strays = [];
        if (r.ok) {
          commitAll(w.dir, `FRIDAY mission part ${w.part.id}: ${goal.slice(0, 60)}`);
          try { strays = outsideOwned(w.dir, w.part.owns, base); } catch {}
          if (strays.length) out(paint(AMBER, `  ! ${w.part.id} also changed files it does not own: ${strays.slice(0, 6).join(', ')}\n`));
        }
        results.push({ w, r, strays });
      }
    };
    // Worktrees go whatever happens (a crash in a part included); branches stay.
    try {
      await Promise.all(Array.from({ length: Math.max(1, Math.min(maxParallel, wts.length)) }, worker));
      const failed = results.filter((x) => !x.r.ok);
      if (failed.length) return fail(`parts failed: ${failed.map((x) => `${x.w.part.id} (${x.r.errors?.[0] || 'no reason'})`).join(', ')}; their branches are kept`, failed.some((x) => x.r.paused), failed.some((x) => x.r.interrupted));
      const merged = await mergeParts(dir, wts.map((w) => w.branch), async (files, branch) => {
        out(paint(AMBER, `  ! merging ${branch} conflicts in ${files.join(', ')}; ${job.agent} resolves it\n`));
        const r = await turn(job.agent, `The parallel build parts were merged in this folder and git reports conflicts in: ${files.join(', ')}. Edit those files so both parts' work is kept and the conflict markers are gone. Do not run git commands; FRIDAY commits.`,
          { cwd: dir, mode: 'edit', label: `${AGENTS[job.agent].label} · resolve merge`, asked: `/mission ${goal}`, noVault: true, waitExit: true });
        return !!r?.ok;
      });
      if (!merged.ok) {
        out(paint(RED, `  ✗ could not merge ${merged.failed}: conflicts in ${merged.conflicts.join(', ')}\n`));
        return fail(`merge conflict in ${merged.conflicts.join(', ')} (branch ${merged.failed} kept)`);
      }
      out(paint(GREEN, `  ✓ ${merged.merged.length} parts merged into ${tilde(dir)}\n`));
      const strays = results.flatMap((x) => x.strays.map((f) => `${x.w.part.id}: ${f}`));
      return { ok: true, agent: job.agent, text: results.map((x) => `## ${x.w.part.id} (${x.r.agent})\n${x.r.text}`).join('\n\n') + (strays.length ? `\n\nOutside owned paths: ${strays.join(', ')}` : '') };
    } finally {
      for (const w of wts) removeWorktree(dir, w.dir);
    }
  }

  // One build job, in the mission's folder. A build or fix may edit files (the user said
  // go); a review or test job only reads. Each agent keeps one session per folder, so a
  // fix round continues the builder's own conversation.
  async function runBuildJob(job, dir, goal) {
    const agent = ready(job.agent) ? job.agent : ['claude', 'codex', 'gemini', 'opencode'].find((a) => installed.includes(a) && ready(a));
    if (!agent) return { ok: false, text: '', errors: ['no agent is ready'] };
    if (agent !== job.agent) out(dim(`  ${job.agent} is ${ready.why(job.agent)}; ${agent} takes the ${job.role}\n`));
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { out(paint(RED, `  ✗ cannot create ${dir}: ${e.message}\n`)); return { ok: false, text: '', errors: [`cannot create ${dir}: ${e.message}`] }; }
    const writes = job.role === 'build' || job.role === 'fix';
    const r = await turn(agent, job.prompt, { cwd: dir, mode: writes ? 'edit' : 'plan', label: `${AGENTS[agent].label} · mission ${job.role}`, asked: `/mission ${goal}`, noVault: true, waitExit: true, timeoutMs: profile().mission.buildTimeoutMs || 0 });
    if (!r) return { ok: false, text: '', agent, errors: [`${agent} was not run (not installed, or the text is sealed)`] };
    return {
      ...r, agent,
      ...(r.aborted && !r.timedOut ? { interrupted: true } : {}),
      paused: !r.ok && !r.aborted && LIMIT_ERROR.test(`${(r.errors || []).join(' ')} ${r.text || ''}`),
    };
  }

  // Where missions are kept: asked once, saved to config.json ("missionStore").
  async function chooseMissionStore() {
    if (config.missionStore) return true;
    const def = defaultMissionDir();
    out(`\n  ${paint(CYAN, '◈')} Missions save their plan, research and build prompts. Where should they go?\n`);
    const reply = (await ask(`${vaultOk ? `"vault" (your notes at ${tilde(vault)}), ` : ''}a folder path, or Enter for ${tilde(def)}`)).trim().replace(/^["']|["']$/g, '');
    if (/^(cancel|stop)$/i.test(reply)) return false;
    let store;
    if (/^vault$/i.test(reply)) {
      if (!vaultOk) { out(paint(RED, '  no vault is configured (config.json "vault"); give a folder instead\n')); return false; }
      store = 'vault';
    } else store = reply ? path.resolve(expandHome(reply)) : def;
    saveConfigKey('missionStore', store);
    config.missionStore = store;
    out(dim(`  missions are saved to ${store === 'vault' ? 'the vault (03_Resources/friday-missions/)' : tilde(store)} · change it in config.json "missionStore"\n`));
    return true;
  }

  async function saveMission(m) {
    const store = config.missionStore || defaultMissionDir();
    if (store !== 'vault') return tilde(writeMissionFolder(store, m));
    if (!vaultQueue) throw new Error('no vault configured');
    let p = vaultMissionPath(m);
    for (let i = 2; fs.existsSync(path.join(vault, p)) && i < 50; i++) p = vaultMissionPath({ ...m, slug: `${m.slug}-${i}` });
    const rep = await vaultQueue.submit([{ op: 'create', path: p, content: missionMarkdown(m), index: `FRIDAY mission: ${m.plan?.title || m.goal} (${m.status})` }],
      { source: 'mission', message: `FRIDAY mission: ${m.plan?.title || m.slug}` });
    const bad = rep.results.find((x) => !x.ok);
    if (bad) throw new Error(bad.error);
    return `vault ${p}${rep.pushed ? ' (pushed)' : rep.committed ? ' (committed)' : ''}`;
  }

  async function execute(p, text) {
    // Ordinary messages go to the local orchestrator; private, sealed, council,
    // design, self-change and pipeline messages keep their rules.
    if (p.kind === 'single' && !p.private && !p.blocked && orchestratorOn()) {
      if (await runOrchestrator(text, p)) return;
    }
    const line = describeRoute(p);
    if (profile().showRoute !== false) out(dim(`  ${line}\n`));
    hud.set({ route: line });
    if (p.blocked) { out(paint(AMBER, `  nothing sent: ${p.blocked}. Log in to ${p.steps[0].agent}, or /undo-self to un-pin.\n`)); return; }
    switch (p.kind) {
      case 'council': return council(text);
      case 'pipeline': return pipeline(p, text);
      case 'design': return startDesign(text);
      case 'self': return selfChange(text);
      default: {
        const id = p.steps[0]?.agent;
        if (p.private && (!id || !ready(id))) {
          out(paint(RED, `  ✗ ${id || 'no local agent'} is ${id ? ready.why(id) : 'configured'}. Private data stays on this machine, so nothing was sent.${id === 'ollama' ? ' Start it with `ollama serve` and ask again.' : ''}\n`));
          return;
        }
        if (!id) { out(paint(RED, `  no agent available (${p.notes.join('; ')})\n`)); return; }
        st.agent = id; hud.set({ active: id });
        const c = await curateFor(id, text);
        return void (await turn(id, c?.text ?? text, { private: p.private, category: p.category, original: text, asked: text, rw: c && { c, kind: 'single' } }));
      }
    }
  }

  // Overrides teach the profile: N of the last few overrides for one category to
  // the same agent makes that agent the route (reversible with /undo-self).
  function noteOverride(p, id) {
    if (!routing() || p.private) return;
    const routed = p.kind === 'single' || p.kind === 'pipeline' ? p.steps[0]?.agent : null;
    if (!routed || routed === id || !profile().categories[p.category]) return;
    recordOverride(CONFIG_DIR, { category: p.category, routed, chosen: id });
    out(dim(`  override noted: ${p.category} -> ${id} (router picked ${routed})\n`));
    const prof = profile();
    const l = learn(prof, readOverrides(CONFIG_DIR), p.category);
    if (!l) return;
    const cat = prof.categories[l.category];
    const summary = `${l.category}: ${l.from} -> ${l.to} (learned from ${l.count} of your last ${l.of} overrides)`;
    applySettingsChange({ profileStore: profiles, history: selfHistory, text: `(learned) ${summary}`, change: { summary, ops: [
      { path: ['categories', l.category], value: { ...cat, agent: l.to, fallback: [cat.agent, ...(cat.fallback || [])].filter((a, i, arr) => a !== l.to && arr.indexOf(a) === i) } },
      { path: ['learned'], value: [...prof.learned, { t: Date.now(), category: l.category, from: l.from, to: l.to, count: l.count, of: l.of }] },
    ] } });
    out(`  ${paint(CYAN, '◈')} learned: ${summary} ${dim('· /undo-self reverts')}\n`);
    logSelf({ title: `Learned route: ${l.category} -> ${l.to}`, body: `${summary}. From @agent overrides; profile.json updated.` });
  }

  // ---- pipelines: plan / implement / review --------------------------------
  async function pipeline(p, text) {
    let plan = null;
    let impl = null;
    const ran = [];
    for (const step of p.steps) {
      // Who runs this step: its agent if it is still ready (a login can fail mid-way),
      // else the next in its chain; a reviewer other than the implementer when possible.
      const pickFor = (tried) => {
        const chain = [step.agent, ...(step.chain || [])].filter((x, i, arr) => arr.indexOf(x) === i && !tried.includes(x) && ready(x));
        const notImpl = chain.filter((x) => !(step.role === 'review' && impl && x === impl.agent));
        return notImpl[0] || chain[0] || null;
      };
      const tried = [];
      let s = { ...step, agent: pickFor(tried) };
      if (!s.agent) { out(paint(AMBER, `  pipeline stopped at ${step.role}: no agent available\n`)); return; }
      if (s.agent !== step.agent) out(dim(`  ${step.role}: ${step.agent} is ${ready.why(step.agent)}; ${s.agent} takes it\n`));
      if (step.role === 'review' && impl && s.agent === impl.agent) out(paint(AMBER, `  ! no other agent is ready: ${s.agent} reviews its own change, so this is not an independent review\n`));
      let r = null;
      for (;;) {
        const a = AGENTS[s.agent];
        // The role wrapper is FRIDAY's; only the task inside it is rewritten, per step's agent.
        const build = (task) => {
          if (s.role === 'plan') return `Plan this before anyone writes code. Do not change files. Give a short, concrete plan: files, steps, tests.\n\nTask: ${task}`;
          if (s.role === 'implement') {
            return task + (plan ? `\n\nPlan from ${AGENTS[plan.agent].label}:\n${plan.text.slice(0, 8000)}` : '')
              + '\n\nWhen done, list the files you changed and how you verified the change.';
          }
          if (s.role === 'review') {
            return `Independently review the change ${impl ? AGENTS[impl.agent].label : 'another agent'} just made in this folder for this request:\n"${task}"\n\n`
              + 'Read the actual diff (git status, git diff) and run the relevant tests if you can. Report: is it correct, what is wrong or risky, and the exact fixes. Do not edit files.'
              + (impl ? `\n\nThe implementer's own summary:\n${impl.text.slice(-3000)}` : '');
          }
          return task;
        };
        const mode = s.role === 'plan' || s.role === 'review' ? 'plan' : st.mode;
        const c = await curateFor(s.agent, text);
        r = await turn(s.agent, build(c?.text ?? text), { label: `${a.label} · ${s.role}`, asked: text, mode, category: p.category,
          original: build(text), rw: c && { c, kind: `pipeline:${s.role}` } });
        if (r?.ok) break;
        tried.push(s.agent);
        // Only an agent that cannot run (not logged in) is replaced; a real failure stops.
        const next = !r?.aborted && loggedOut.has(s.agent) ? pickFor(tried) : null;
        if (!next) { out(paint(AMBER, `  pipeline stopped at ${s.role} (${s.agent} ${r?.aborted ? 'interrupted' : 'failed'})\n`)); return; }
        out(dim(`  ${s.role}: ${s.agent} cannot run; ${next} takes it\n`));
        s = { ...s, agent: next };
      }
      ran.push(`${s.agent} ${s.role}`);
      if (s.role === 'plan') plan = { agent: s.agent, text: r.text };
      if (s.role === 'implement') impl = { agent: s.agent, text: r.text };
    }
    out(dim(`  pipeline done · ${ran.join(' -> ')}\n`));
  }

  // ---- self-changes -------------------------------------------------------
  // Every self-change goes to log.md; one the user asked for is also their decision, in their words.
  function logSelf({ title, body, quote, summary }) {
    if (!vaultQueue) return Promise.resolve();
    const ops = [{ op: 'log', kind: 'friday', title, body }];
    if (quote) ops.push({ op: 'decision', note: 'project-friday', summary: `FRIDAY self-change: ${summary || title}`, quote });
    return applyVault(ops, { source: 'self-change', message: `FRIDAY: ${title}` });
  }

  async function selfChange(text) {
    const prof = profile();
    const change = parseSettingsChange(text, prof);
    if (change?.refuse) { out(paint(AMBER, `  ${change.refuse}\n`)); return; }
    if (change && !change.ops.length) { out(dim(`  no change needed: ${change.summary}\n`)); return; }
    const short = text.replace(/\s+/g, ' ').trim().slice(0, 60);
    if (change) {
      applySettingsChange({ profileStore: profiles, history: selfHistory, text, change });
      applyColors(profile());
      out(`  ${paint(CYAN, '◈')} ${bold('settings changed')} ${dim('· live now, profile.json reloaded')}\n`);
      for (const l of change.summary.split('\n')) out(`    ${l}\n`);
      const pinned = change.ops.filter((o) => o.path[0] === 'categories' && !ready(o.value.agent)).map((o) => o.value.agent);
      for (const a of new Set(pinned)) out(paint(AMBER, `    ! ${a} is ${ready.why(a)} here${prof.categories[change.ops[0].path[1]] && change.ops[0].value.strict ? `, so these messages will not run until it is (run \`${a}\` once to log in)` : ''}\n`));
      out(dim('    /undo-self reverts\n'));
      await logSelf({ title: `Self-change (settings): ${short}`, body: change.summary, quote: text, summary: change.summary.split('\n')[0] });
      return;
    }
    const agent = [prof.self.agent, 'claude', 'codex'].find((a) => ready(a));
    if (!agent) { out(paint(RED, '  no coding agent available for a code change\n')); return; }
    out(dim(`  code change: ${agent} edits FRIDAY on a new branch in a worktree; \`${prof.self.testCommand}\` must pass before anything changes\n`));
    const res = await codeChange({
      repo: selfRepo, configDir: CONFIG_DIR, history: selfHistory, text, testCommand: prof.self.testCommand, worktreeRoot: SELF_WORKTREES,
      // Headless Claude cannot ask before running Bash, so allow just the checks it needs.
      runAgent: async (dir, prompt) => (await turn(agent, prompt, {
        cwd: dir, mode: 'edit', label: `${AGENTS[agent].label} · self-change`, asked: text, noVault: true, waitExit: true,
        args: agent === 'claude' ? ['--allowedTools', 'Bash(node --test:*)', 'Bash(node --check:*)', 'Bash(git diff:*)', 'Bash(git status:*)'] : [],
      })) || { ok: false, text: `${agent} unavailable` },
      on: { step: (m) => out(dim(`  ◈ ${m.replace(os.homedir(), '~')}\n`)) },
    });
    if (!res.ok) {
      out(paint(RED, `  ✗ self-change not applied: ${res.why}\n`));
      if (res.patch) out(dim(`  the attempted diff is saved at ${tilde(res.patch)}\n`));
      return;
    }
    const e = res.entry;
    out(`  ${paint(CYAN, '◈')} ${bold('code changed')} ${dim(`· ${e.branch} · tests ${e.tests}`)}\n`);
    out(`    ${e.files.join(', ')}\n${dim(`    ${e.stat}\n    /undo-self reverts`)}\n`);
    await logSelf({ title: `Self-change (code): ${short}`, body: `${e.files.length} file(s) on \`${e.branch}\` (${e.stat}); tests ${e.tests}; merged into the running checkout and reloaded.`, quote: text, summary: `code (${e.files.join(', ')})` });
    return restart('code change applied');
  }

  // Restart into the same conversation (bin/friday.js supervises the cockpit).
  async function restart(reason) {
    if (vaultQueue) await vaultQueue.idle();
    st.conv.sessions = dumpSessions(st.sessions);
    convos.save(st.conv);
    if (process.env.FRIDAY_SUPERVISED !== '1') {
      out(paint(AMBER, `  restart FRIDAY to load it: node ${tilde(FRIDAY_BIN)} --resume=${st.conv.id}\n`));
      return;
    }
    try {
      fs.writeFileSync(path.join(CONFIG_DIR, 'restart.json'), JSON.stringify({
        conv: st.conv.turns.length ? st.conv.id : null, cwd: st.cwd, mode: st.mode, auto: st.auto, agent: st.agent, reason, t: Date.now(),
      }));
    } catch {}
    out(dim(`  ◈ reloading FRIDAY (${reason})\n`));
    quitting = true;
    box.close();
    for (const r of st.running) r.abort();
    hud.close();
    closeLive();
    await settleAgents(10000);
    try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch {}
    setTimeout(() => process.exit(RESTART_CODE), 50);
  }

  // ---- design (Claude Design) ---------------------------------------------
  const shq = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
  function designTarget(text) {
    if (/\bfriday\b|\bhud web\b|\/hud web|\bcockpit\b|\byour hud\b/i.test(text)) return { name: 'friday', display: 'FRIDAY web HUD', dir: FRIDAY_ROOT };
    return detectProject(text, registry, { auto: true, vault: config.vault }) || st.focus;
  }

  async function startDesign(text) {
    const app = designTarget(text);
    if (!app) { out(dim('  which app? name it ("redesign the <app> ...") or /project <name> first\n')); return; }
    if (!installed.includes('claude')) { out(paint(RED, '  Claude Design needs Claude Code\n')); return; }
    st.design?.watch?.stop();
    const id = Date.now().toString(36);
    const handoff = path.join(CONFIG_DIR, 'design', `${id}.json`);
    fs.mkdirSync(path.dirname(handoff), { recursive: true });
    const ds = findDesignSystem(app, profile());
    st.design = { id, request: text, app: { name: app.name, display: app.display || app.name, dir: app.dir || null }, ds, handoff, phase: ds ? 'design' : 'needs-ds' };
    if (!ds) {
      out(`  ${bold(st.design.app.display)} has no Claude Design system yet. Designing from one uses the app's real components and tokens; creating it takes a while.\n`);
      out(dim('  /design setup  create it first (opens a Claude Code pane) · /design skip  design without it\n'));
      return;
    }
    openDesignPane();
  }

  // An interactive Claude Code pane beside the cockpit, or (openPanes: false, or no
  // terminal found) the command to run by hand.
  function pane(cmd, cwd, what) {
    const how = config.openPanes === false ? null : openTerminal(cmd, { cwd });
    if (how) out(`  ${paint(CYAN, '◈')} ${what} in an interactive Claude Code pane (${how})\n`);
    else out(paint(AMBER, `  ${what}: run this in another terminal\n`) + dim(`  cd ${shq(cwd)} && ${cmd.map(shq).join(' ')}\n`));
    return how;
  }

  function openDesignPane() {
    const d = st.design;
    const cmd = paneCommand({ prompt: designPrompt({ request: d.request, app: d.app, ds: d.ds, handoff: d.handoff }), repoDir: d.app.dir, handoffDir: path.dirname(d.handoff) });
    out(dim(`  ◈ design system: ${d.ds ? `${d.ds.name} (${d.ds.project})` : 'none'} · headless claude -p has no Claude Design access, so the design step is interactive\n`));
    pane(cmd, d.app.dir || os.homedir(), 'Claude Design');
    out(dim(`  the link appears here when the design is published (handoff ${tilde(d.handoff)}) · iterate in that pane · /approve when it is right · no code changes until then\n`));
    d.phase = 'design';
    d.watch?.stop();
    d.watch = watchHandoff(d.handoff, (h) => {
      d.link = h.link; d.spec = h.spec; d.revision = h.revision;
      notify(`  ${paint(CYAN, '◈')} ${bold('design')}${h.revision ? dim(` r${h.revision}`) : ''}: ${h.link || '(no link yet)'}\n${dim('  /approve to implement · or keep iterating in the pane')}`);
    });
  }

  function designCommand(arg) {
    const d = st.design;
    if (!d) { out(dim('  no design in progress. Ask for one: "redesign the <app> ..."\n')); return; }
    if (arg === 'cancel') { d.watch?.stop(); st.design = null; out(dim('  design cancelled\n')); return; }
    if (arg === 'skip') { openDesignPane(); return; }
    if (arg === 'open') { openDesignPane(); return; }
    if (arg === 'setup') {
      pane(paneCommand({ prompt: createDsPrompt({ app: d.app }), blockRepoWrites: false }), d.app.dir || os.homedir(), 'creating the design system');
      out(dim('  when it finishes: /design open\n'));
      d.phase = 'ds-setup';
      return;
    }
    if (d.phase === 'ds-setup' || d.phase === 'needs-ds') d.ds = findDesignSystem(d.app, profile()) || d.ds;
    out(`  ${bold(d.app.display)} ${dim(`· ${d.phase}${d.ds ? ` · ${d.ds.name}` : ' · no design system'}`)}\n`);
    if (d.link) out(`  ${d.link}\n`);
    if (d.branch) out(dim(`  branch ${d.branch}\n`));
  }

  async function approveDesign() {
    const d = st.design;
    if (!d || !['design', 'needs-ds'].includes(d.phase)) { out(dim('  no design waiting for approval\n')); return; }
    if (!d.app.dir) { out(paint(RED, `  ${d.app.display} has no repo folder to implement in\n`)); return; }
    const h = readHandoff(d.handoff) || { link: d.link, spec: d.spec };
    if (!h.link) out(paint(AMBER, '  no design link recorded yet; implementing from the request alone\n'));
    d.watch?.stop();
    d.phase = 'implement';
    let wt;
    try { wt = designWorktree(d.app.dir, d.request, DESIGN_WORKTREES); } catch (e) { out(paint(RED, `  could not create a branch: ${e.message}\n`)); d.phase = 'design'; return; }
    // A fresh worktree has no node_modules; borrow the main checkout's.
    const nm = path.join(d.app.dir, 'node_modules');
    if (fs.existsSync(nm) && !fs.existsSync(path.join(wt.dir, 'node_modules'))) {
      try {
        fs.symlinkSync(nm, path.join(wt.dir, 'node_modules'), 'dir');
        const common = execGit(wt.dir, ['rev-parse', '--git-common-dir']);
        const excl = path.resolve(wt.dir, common, 'info', 'exclude');
        fs.mkdirSync(path.dirname(excl), { recursive: true });
        if (!(fs.existsSync(excl) ? fs.readFileSync(excl, 'utf8') : '').split('\n').includes('/node_modules')) fs.appendFileSync(excl, '\n/node_modules\n');
      } catch {}
    }
    out(dim(`  ◈ branch ${wt.branch} in ${tilde(wt.dir)}\n`));
    const steps = profile().pipelines.implementReview;
    const impl = [steps[0].agent, ...(steps[0].fallback || [])].find(ready);
    const rev = [steps[1].agent, ...(steps[1].fallback || [])].filter((a) => a !== impl).concat(impl).find(ready);
    if (!impl) { out(paint(RED, '  no agent available to implement\n')); return; }
    out(dim(`  -> ${impl} implements, tests run, then ${rev} reviews against the design\n`));
    const r1 = await turn(impl, implementPrompt({ request: d.request, handoff: h, app: d.app }), { cwd: wt.dir, mode: 'edit', label: `${AGENTS[impl].label} · implement design`, asked: '/approve', noVault: true, waitExit: true });
    if (!r1?.ok) { out(paint(AMBER, `  stopped: ${impl} did not finish. The branch ${wt.branch} is kept.\n`)); d.phase = 'design'; return; }
    const tc = testCommandFor(wt.dir);
    if (tc) {
      const sp = spinner(`tests: ${tc}`);
      const t = await runTests(wt.dir, tc);
      sp.stop();
      if (!t.ok) {
        out(paint(RED, `  ✗ tests fail on ${wt.branch}; not reviewed or synced:\n${t.out.split('\n').slice(-12).join('\n')}\n`));
        d.phase = 'design';
        return;
      }
      out(paint(GREEN, `  ✓ tests pass (${tc})\n`));
    } else out(dim('  no test command found in the repo\n'));
    const head = commitAll(wt.dir, `Design: ${d.request.replace(/\s+/g, ' ').slice(0, 64)}`);
    if (!head) { out(paint(AMBER, `  ${impl} made no changes\n`)); d.phase = 'design'; return; }
    if (rev) await turn(rev, reviewPrompt({ request: d.request, handoff: h, base: wt.base, implementer: AGENTS[impl].label }), { cwd: wt.dir, mode: 'plan', label: `${AGENTS[rev].label} · design review`, asked: '/approve', noVault: true, waitExit: true });
    d.phase = 'resync';
    d.branch = wt.branch;
    if (d.ds) {
      pane(paneCommand({ prompt: resyncPrompt({ app: d.app, ds: d.ds, branch: wt.branch }), blockRepoWrites: false }), wt.dir, 're-syncing the design system (takes a while)');
    }
    out(dim(`  design implemented on ${wt.branch} (not merged). Merge when happy: git -C ${tilde(d.app.dir)} merge ${wt.branch}\n`));
    if (vaultQueue) applyVault([{ op: 'log', kind: 'design', title: `${d.app.display} redesign implemented`, body: `"${d.request}". Design ${h.link || '(no link)'}; ${impl} implemented on \`${wt.branch}\`${rev ? `, ${rev} reviewed` : ''}; design-system re-sync ${d.ds ? 'started' : 'skipped (no design system)'}.` }], { source: 'design' });
  }

  function execGit(cwd, args) {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  }

  // Talking about a project brings it up on the HUD.
  function autoFocus(text) {
    const p = detectProject(text, registry, { auto: true, vault: config.vault });
    if (p && p !== st.focus) focusProject(p, { auto: true });
  }

  function shell(cmd) {
    return new Promise((resolve) => {
      rl.pause();
      const sh = process.platform === 'win32' ? ['cmd', ['/c', cmd]] : [process.env.SHELL || 'sh', ['-c', cmd]];
      const child = spawn(sh[0], sh[1], { cwd: st.cwd, stdio: 'inherit' });
      child.on('close', (code) => { rl.resume(); if (code) out(dim(`  exit ${code}\n`)); rescanSoon(); resolve(); });
      child.on('error', (e) => { rl.resume(); out(paint(RED, `  ${e.message}\n`)); resolve(); });
    });
  }

  // Start focused if launched inside a known project.
  const here = registry.find((p) => p.dir && (st.cwd === p.dir || st.cwd.startsWith(p.dir + path.sep)));
  if (here) { st.focus = here; hud.set({ project: scanProject(here) }); }
  if (resumeId) {
    const conv = convos.load(resumeId);
    if (conv?.turns?.length) resume(conv, { quiet: !!rs });
    else out(dim(`  no saved conversation ${resumeId}\n`));
  } else if (rs) out(`${paint(CYAN, '◈')} ${dim('reloaded')}\n`);
  // Past conversations not yet in memory (FRIDAY closed abruptly) get summarized quietly.
  setTimeout(() => { summarizePast(memory.unsummarized(convos.list(), { exceptId: st.conv.id })).catch(() => {}); }, 3000).unref();
  if (W) {
    setRun({ status: 'running' });
    enqueue(W.run.resume ? `/mission resume ${W.run.resume}` : `/mission ${W.run.goal}`);
    return { hud, st, handle: enqueue };
  }
  prompt();
  return { hud, st, handle: enqueue };
}
