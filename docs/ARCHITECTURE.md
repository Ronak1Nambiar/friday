# How FRIDAY fits together

FRIDAY is plain Node 20 with no dependencies. Agents are CLIs it runs headless; everything
else is in `src/`. Most modules are pure functions with their I/O passed in, so `npm test`
exercises them without real agents.

## Entry and the cockpit

- **`bin/friday.js`**: the command. `friday` runs the cockpit under a small supervisor, so a
  self-change can restart it into the same conversation. `setup`, `login`, `telegram`,
  `hud`, `mission … [--bg] [--yes]`, `missions`, `mission log|answer` are handled here.
  `--mission-worker=<run>` starts a headless cockpit for one background mission.
- **`src/cockpit.js`**: the terminal UI and the glue. It owns the prompt and queue, the
  per-agent sessions, the HUD feed, the vault queue and the missions' I/O (`startMission`
  passes `runMission` its functions: research jobs, builds, tests, branch/commit/PR, the
  phone). `FRIDAY_CONFIG` points it at another config folder.
- **`src/render.js`, `src/asker.js`, `src/inputbox.js`, `src/suggest.js`,
  `src/abilities.js`, `src/brainmenu.js`**: what you see: the streaming markdown renderer,
  Claude-Code-style questions, the queue box, slash-command suggestions, the abilities
  list and the `/brain` menu.

## Agents and the brain

- **`src/agents.js`**: one adapter per CLI (Claude Code, Codex, Gemini, opencode) plus
  Ollama over HTTP. Each turns its JSON event stream into `text / tool / error / done`.
  A turn reports `ok`, `aborted` (someone stopped it), `timedOut` (past `timeoutMs`),
  the exit `code` and `stderrTail`. Claude can keep one process running per session (live
  turns) and passes its questions and permission requests back to FRIDAY.
- **`src/brain.js`**: the model behind FRIDAY's decisions: OpenRouter (OAuth sign-in) or a
  local Ollama model. **`src/signin.js`** knows how to install and sign in to each agent.
- **`src/orchestrator.js`**: the brain decides each message and calls agents as tools
  (`ask_claude`, `start_mission`, `remember`, …).
- **`src/router.js`**: rules first (private data, sealed projects, pipelines, council,
  design, self-change), then a small model for ties. `cloudBlock` is the one check every
  cloud-bound text passes.
- **`src/profile.js`**: the routing profile as editable data (`profile.json`), reloaded
  when the file changes, with migrations between versions. **`src/user.js`** holds the
  user's name for prompts.
- **`src/billing.js`**: plan limits versus API bills, per agent.

## Missions

- **`src/mission.js`**: the mission flow as one function, `runMission(goal, io)`: plan
  (brain draft, Claude review, your go), research in parallel (retry on another agent,
  pause when interrupted), then either a brief (research-only) or the brief and build
  prompts (your go), the build on its own branch, and verify-and-fix with reviewers'
  verdicts. Overflow to the agent with the most room, lessons, the saved markdown and the PR
  body are here too. Checkpointed after every phase.
- **`src/missiongit.js`**: the mission branch (`friday/<slug>`; a dirty repo is never
  touched), worktrees for parallel build parts and their merge, and `openPr` (push + `gh`).
- **`src/missionrun.js`**: background runs: run records, the pid lock (one worker per
  mission), questions and answers through files, `--yes` auto-answers, starting a worker.
- **`src/telegram.js`**: the phone: questions as Bot API messages with buttons, answers by
  long polling; every text passes the sealed/private guard first.
- **`scripts/bench-missions.js`** and **`bench/missions/`**: the benchmark (a mission
  against one Claude Code turn, judged by hidden acceptance checks).

## Knowledge and state

- **`src/vault.js`**: the optional Obsidian second brain: the protocol each agent reads
  (`context/`), per-agent read access and deny rules, retrieval for Ollama, and one write
  queue (pull, write, commit, push) for every agent's proposed edits.
- **`src/memory.js`**: FRIDAY's own memory across conversations (facts and summaries).
- **`src/convos.js`**: saved conversations with every agent's session id, for `/resume`.
- **`src/projects.js`**: the project registry (folders and vault notes), mention detection,
  and the repo scan that feeds the HUD.

## Changing FRIDAY and the rest

- **`src/selfmod.js`**: FRIDAY changing itself: settings parsed from a request, or code
  edited by an agent in a worktree, merged only when the tests pass; `/undo-self`.
- **`src/design.js`**: redesigns with Claude Design in an interactive pane, then build and
  review on a branch.
- **`src/promptwriter.js`**: an optional local model that rewrites a message into a compact
  prompt per agent, with a check that nothing important was lost.
- **`src/hud-server.js`**, **`src/term-hud.js`**, **`src/hudtheme.js`**, `hud/index.html`:
  the project HUD (local SSE server, the terminal and browser views, themes).
- **`src/setup.js`**: `friday setup`: agents, sign-ins, your name, the brain, the vault,
  the HUD and Telegram.
