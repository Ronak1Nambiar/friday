// First-run setup (`friday setup`, also offered on the first start): which agents are
// installed and signed in, sign in to the ones that are not, then pick the brain:
// cloud (OpenRouter, the default: nothing to download or warm up) or local (Ollama).
// The user signs in once and FRIDAY works.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { AGENTS, ollamaUp, which } from './agents.js';
import { AGENT_SETUP, runInteractive } from './signin.js';
import { CLOUD_MODELS, DEFAULT_CLOUD_MODEL, DEFAULT_LOCAL_MODEL, brainStatus, keyHint, loadKey, openBrowser, resolveBrain, saveKey, signInOpenRouter } from './brain.js';
import { loadProfile, saveProfile } from './profile.js';
import { botName, createTelegram, findChat } from './telegram.js';
import { bold, dim, paint, CYAN, GREEN, RED, AMBER } from './render.js';

// Telegram: a bot of the user's own (from @BotFather), and the chat they open with it.
// The token goes to keys.json; returns { chatId, enabled } for config.json, or null.
export async function telegramSetup({ configDir, ask, say, api = {} }) {
  say(dim('    1. In Telegram, message @BotFather: /newbot, pick any name. It gives you a token.'));
  const token = (await ask('Bot token:')).trim();
  if (!token) return null;
  let name;
  try { name = await botName({ token, ...api }); } catch (e) { say(paint(RED, `    ✗ that token did not work: ${e.message}`)); return null; }
  say(dim(`    2. Open t.me/${name} and send /start, then come back here.`));
  await ask('Press enter once you have sent /start');
  let chat = null;
  try { chat = await findChat({ token, ...api }); } catch (e) { say(paint(RED, `    ✗ ${e.message}`)); }
  if (!chat) { say(paint(RED, `    ✗ no /start from you yet; run \`friday telegram\` to try again`)); return null; }
  saveKey(configDir, 'telegram', token);
  try { await createTelegram({ token, chatId: chat.chatId, ...api }).send('FRIDAY is connected. Missions will ask you here.'); } catch {}
  say(`    ${paint(GREEN, '✓')} Telegram: @${name}${chat.name ? ` · ${chat.name}` : ''} · a test message is on your phone`);
  return { chatId: chat.chatId, enabled: true };
}

// `friday telegram`: just that step.
export async function runTelegramSetup({ configDir, input = process.stdin, output = process.stdout } = {}) {
  const rl = createInterface({ input, output });
  const say = (x = '') => output.write(x + '\n');
  const ask = async (q) => (await rl.question(`  ${q} `)).trim();
  try {
    const tg = await telegramSetup({ configDir, ask, say });
    if (!tg) return false;
    const cfgFile = path.join(configDir, 'config.json');
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8').replace(/^\uFEFF/, '')); } catch {}
    cfg.telegram = tg;
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n');
    return true;
  } finally { rl.close(); }
}

// What is installed and signed in, without asking anything.
export async function agentReport() {
  const rows = [];
  for (const id of Object.keys(AGENT_SETUP)) {
    if (!AGENTS[id]) continue;
    const installed = !!which(AGENTS[id].bin);
    let signedIn = null;
    if (installed) signedIn = id === 'ollama' ? await ollamaUp() : AGENT_SETUP[id].status?.() ?? null;
    rows.push({ id, label: AGENTS[id].label || id, installed, signedIn });
  }
  return rows;
}

const mark = (r) => (!r.installed ? paint(RED, '✗ not installed')
  : r.id === 'ollama' ? (r.signedIn ? paint(GREEN, '✓ running') : paint(AMBER, '○ installed, not running'))
    : r.signedIn === true ? paint(GREEN, '✓ signed in') : r.signedIn === false ? paint(AMBER, '○ not signed in') : paint(GREEN, '✓ installed'));

export const setupDone = (configDir) => fs.existsSync(path.join(configDir, 'setup.json'));

export { AGENT_SETUP };

export async function runSetup({ configDir, input = process.stdin, output = process.stdout } = {}) {
  const rl = createInterface({ input, output });
  const say = (s = '') => output.write(s + '\n');
  const ask = async (q, def = '') => ((await rl.question(`  ${q}${def ? dim(` [${def}]`) : ''} `)).trim() || def);
  const yes = async (q, def = true) => /^y/i.test(await ask(`${q} (y/n)`, def ? 'y' : 'n'));
  try {
    say(`\n${paint(CYAN, '◈')} ${bold('FRIDAY setup')} ${dim('· run it again any time: friday setup')}\n`);

    // 1. Agents
    say(bold('  1. Your AI agents'));
    let rows = await agentReport();
    for (const r of rows) say(`    ${r.label.padEnd(14)} ${mark(r)}`);
    for (const r of rows) {
      const s = AGENT_SETUP[r.id];
      if (!r.installed) { if (r.id !== 'ollama') say(dim(`    ${r.label}: install with \`${s.install}\`, then run friday setup again`)); continue; }
      if (r.signedIn === false && s.login && await yes(`Sign in to ${r.label} now?`)) {
        say(dim(`    running ${s.login[0]} ${s.login[1].join(' ')} · finish in the browser or here, then come back`));
        await runInteractive(...s.login);
      }
    }

    // Your name, so the agents know who is asking.
    {
      const prof = loadProfile(configDir);
      const name = await ask('Your name (the agents hear it in their prompts):', prof.user?.name || os.userInfo().username);
      saveProfile(configDir, { ...prof, user: { ...(prof.user || {}), name } });
    }

    // 2. The brain
    say(`\n${bold('  2. The brain')} ${dim('(decides each message, plans missions)')}`);
    say(`    ${bold('cloud')}  OpenRouter: one sign-in, hundreds of models, fast, nothing to download ${dim('(recommended)')}`);
    say(`    ${bold('local')}  Ollama on this machine: free and private, needs a GPU and a warm-up`);
    const profile = loadProfile(configDir);
    const choice = /^l/i.test(await ask('cloud or local?', 'cloud')) ? 'local' : 'cloud';
    if (choice === 'cloud') {
      let key = loadKey(configDir, 'openrouter');
      if (key && !(await yes(`Already signed in to OpenRouter (${keyHint(key)}). Keep it?`))) key = '';
      if (!key) {
        const how = await ask('Sign in with the browser, or paste an API key? (browser/key)', 'browser');
        if (/^k/i.test(how)) key = (await ask('OpenRouter API key (openrouter.ai/keys):')).trim();
        else {
          say(dim('    opening OpenRouter · sign in and approve FRIDAY (5 minutes)'));
          try { key = await signInOpenRouter({ open: async (url) => { if (!openBrowser(url)) say(`    open this link: ${url}`); } }); }
          catch (e) { say(paint(RED, `    ✗ ${e.message}`)); }
        }
        if (key) saveKey(configDir, 'openrouter', key);
      }
      say(dim(`    models: ${CLOUD_MODELS.map((m, i) => `${i + 1}. ${m.id} (${m.note})`).join('\n            ')}`));
      const pick = await ask('Model (number or OpenRouter id):', '1');
      const model = CLOUD_MODELS[+pick - 1]?.id || (pick.includes('/') ? pick : DEFAULT_CLOUD_MODEL);
      profile.brain = { ...(profile.brain || {}), provider: key ? 'openrouter' : 'auto', model };
    } else {
      const up = await ollamaUp();
      if (!up) say(paint(AMBER, '    Ollama is not running: install it from ollama.com and start it'));
      const model = await ask('Local model:', profile.brain?.localModel || DEFAULT_LOCAL_MODEL);
      profile.brain = { ...(profile.brain || {}), provider: 'ollama', localModel: model };
      if (up && await yes(`Download ${model} now (ollama pull)?`)) await runInteractive('ollama', ['pull', model]);
    }
    saveProfile(configDir, profile);
    const brain = resolveBrain(profile, configDir);
    const bs = await brainStatus(brain);
    say(`    brain: ${bold(brain.label)} ${bs.ready ? paint(GREEN, `✓ ${bs.reason}`) : paint(AMBER, `○ ${bs.reason}`)}`);

    // 3. Second brain (optional)
    const cfgFile = path.join(configDir, 'config.json');
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8').replace(/^﻿/, '')); } catch {}
    say(`\n${bold('  3. Second brain')} ${dim('(an Obsidian vault every agent reads; optional)')}`);
    const vault = await ask('Vault folder, or "none":', cfg.vault || 'none');
    if (vault && vault !== 'none') cfg.vault = vault.replace(/^~(?=$|[\\/])/, os.homedir());
    say(`\n${bold('  4. Project HUD')} ${dim('(a live map of the repo beside the terminal, agents shown as they work)')}`);
    cfg.autoHud = await yes('Open it by itself when you work on a project?', cfg.autoHud === true);
    say(`\n${bold('  5. Phone check-ins')} ${dim('(Telegram: a mission asks you on your phone and you tap Go; optional)')}`);
    if (await yes(cfg.telegram?.chatId ? 'Telegram is set up. Set it up again?' : 'Set up Telegram now?', false)) {
      const tg = await telegramSetup({ configDir, ask, say });
      if (tg) cfg.telegram = tg;
    }
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n');

    fs.writeFileSync(path.join(configDir, 'setup.json'), JSON.stringify({ done: new Date().toISOString(), brain: brain.provider }, null, 2) + '\n');
    rows = await agentReport();
    const ready = rows.filter((r) => r.installed && r.signedIn !== false).map((r) => r.id);
    say(`\n${paint(GREEN, '  ✓ set up')} ${dim(`· agents: ${ready.join(', ') || 'none yet'} · brain: ${brain.label}`)}`);
    say(dim('    type `friday` in any folder to start · /brain and /login inside to change the brain\n'));
    return true;
  } finally {
    rl.close();
  }
}
