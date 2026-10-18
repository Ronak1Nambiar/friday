# FRIDAY: the full guide

*Every feature in detail. New here? Start with the [README](../README.md) or the [quick start](QUICKSTART.md).*

**Use every AI subscription you already pay for, from one terminal.** FRIDAY drives
**Claude Code, Codex, Gemini CLI, opencode and Ollama** from a single prompt. It tracks each
plan's usage limits and moves work to whichever agent has room, so a Claude limit doesn't
stop the job while your Codex or Gemini plan sits unused.

**Different AIs check each other's work.** Codex reviews what Claude built (and the other
way round), and each reviewer has to end with a verdict: `pass`, `fail` or `blocked`.
Failures go back to the builder in its own session; if the same failure shows up twice,
another agent takes the fix. A reviewer that couldn't actually look at the work never
counts as a pass.

**Missions run while you're away.** `friday mission "build X, research it first" --bg` plans
the research, runs it in parallel, writes a brief and build prompts, builds on its own git
branch, then tests, reviews and fixes until the work passes. It asks before it builds, on
your phone if you like: Telegram buttons, or reply with what to change. You end up with a
branch, a pull request and a saved write-up. A goal that only needs an answer ("what should
I add to my app?") ends with a checked, researched brief.

Does a mission beat one Claude Code turn? [BENCHMARKS.md](BENCHMARKS.md) runs
both on the same tasks, judged by hidden acceptance checks, and records the losses too.

The rest of FRIDAY: one message, and a **brain** (OpenRouter in the cloud, or a local Ollama
model) decides what to do with it. It answers small things itself and calls the agents as
tools for real work: one or several in turn, a council, a build-then-review pipeline,
Claude Design. Every agent can work from your Obsidian second brain (optional), and
vault writes go through one queue. Tell FRIDAY to change itself and it does, live, without
losing your conversation. When the conversation turns to a project, a **project HUD**
draws the repo as a radial map, with each agent firing a beam at every file it touches.

No npm dependencies. Node 20+. **New here? Start with the [quick start](QUICKSTART.md).**
How the code fits together: [ARCHITECTURE.md](ARCHITECTURE.md).

## Run

```sh
npm i -g friday-agents        # then `friday` anywhere
friday setup                  # agents, sign-ins, the brain, your name, optional vault and Telegram
node bin/friday.js            # in the current folder
node bin/friday.js ~/Projects/my-app
friday mission "<goal>" --bg  # a mission in the background; friday missions, friday mission log
friday mission answer 1 go    # answer it (or tap Go in Telegram)
node bin/friday.js --no-hud   # never open the HUD on its own
node bin/friday.js hud        # run the HUD in this terminal, linked to a running cockpit
```

Type `/` at the prompt and the matching commands show under it, as in Claude Code: `↑↓`
choose, `Tab` completes, `Enter` runs the highlighted one (a command that needs more, like
`/mission <goal>`, is completed instead), `Esc` hides the list. Menus such as `/brain` open
a list under the highlighted row: `→` into it, `←` back out.

HUD keys: `q` quit, `[` `]` switch project, `+` `-` zoom, arrows pan, `0` reset, `w` open
the browser version.

To have a `friday` command on Linux: `ln -s "$PWD/bin/friday.js" ~/.local/bin/friday`.

## Talking to agents

| Input | What it does |
|---|---|
| `message` | the brain decides, calling agents as tools (see The orchestrator); each agent's session continues between messages |
| `@codex message` | override the route for one message; FRIDAY records it and learns from repeats |
| `/route message` | dry run: where the message would go, nothing sent |
| `/claude`, `/codex`, ... or `/use <agent>` | pin one agent (routing off); `/auto` turns routing back on |
| `/profile` | the routing table, with which agents are ready |
| `/abilities` | what FRIDAY can do, with something to try for each; dimmed with a reason when not available now. Shown at startup (`profile.json` `"showAbilities": false` hides it; the list is `src/abilities.js`) |
| `/self`, `/undo-self` | self-changes so far; reverse the newest one |
| `/approve`, `/design [setup\|skip\|open\|cancel]` | approve a design for implementation; design status |
| `/all message` | **council**: every agent answers in parallel; answers print as they land |
| `/relay <agent> [ask]` | hand the last answer (or the whole council) to another agent to review |
| `/project [name]` | focus a project: working folder moves there, HUD updates; no name lists them |
| `/hud` | open the terminal HUD beside the cockpit; `/hud web` for the browser version |
| `/usage` | turns per agent, and whether they cost money or only plan limits |
| `/rewrite`, `/rewrite on\|off`, `/rewrite <message>` | prompt-writer status; turn it on or off; dry run: each target agent's rewrite, nothing sent |
| `/mode plan\|edit\|yolo` | plan = read-only, edit = file edits allowed, yolo = no guardrails |
| `/new` | fresh sessions for every agent in this folder, and a new conversation |
| `←` on an empty prompt, or `/resume` | browse past conversations (↑↓, enter, esc) and pick one up: transcript reprints, every agent's session resumes, folder and focus come back |
| `/cd <path>`, `!<shell command>`, `/agents`, `/clear`, `/quit` | |

Conversations are saved after every turn to `~/.config/friday/conversations/`.
Ctrl+C interrupts running agents; pressed twice at an empty prompt it quits. Tab completes
commands, agents and project names.

**Questions and permissions, Claude Code style.** Claude's process runs with
`--permission-prompt-tool stdio`, so instead of silently denying, it stops and asks:
its own questions (its AskUserQuestion tool), anything its mode does not already allow,
and, in plan mode, approval of the plan. FRIDAY shows each one as a numbered choice:
`↑↓` and Enter or the number, the last option to type your own answer, Esc to decline.
A permission offers *Yes*, *Yes, and don't ask again for <tool> this session*, *Yes, and
bypass permissions*, or *No, and tell it what to do instead*. FRIDAY's own mission
checkpoints ("Build it? go / cancel / ...") are asked the same way. (Codex, Gemini and
opencode have no way to ask headless; their modes decide.)

**Modes.** Shift+Tab cycles them, as in Claude Code: **edit** (file edits accepted,
anything else asks) → **⏸ plan** (read-only; Claude plans and asks before building) →
**⏵⏵ bypass** (every agent runs anything without asking) → edit. Also `/mode
edit|plan|bypass`, `/bypass` to toggle, and `"mode": "yolo"` in config.json to start in
bypass.

**Queue box.** While agents work, an input box stays pinned to the bottom of the terminal
(as in Claude Code) and the answer streams above it. Type the next message and press
Enter: it is queued (listed above the box) and runs when the current work is done. `↑` on
an empty box takes the last queued message back to edit, Esc clears the box or, when it is
empty, interrupts the running agent. A paste with several lines stays one message.

**Auto-focus.** Every message is checked for a project name (folder names under the
roots, plus titles and aliases of `01_Projects/project-*.md` notes in the vault). Saying
"how's my-app" (or an alias from its vault note) focuses that project, moves the agents into its folder,
and opens the HUD. Only real projects auto-focus (a vault note or a git repo, never the vault
folder), and a folder name's first word alone does not count, so "agent", "create" or
"claude" in a message leave the focus alone; `/project <name>` reaches any folder. The first message to each agent in a focused project gets a short
context block with the project's vault **Now** section.

## The brain: cloud or local

One model sits behind FRIDAY: it decides each message (the orchestrator), plans missions and
breaks routing ties (`src/brain.js`). Pick where it runs:

- **Cloud (default once signed in): OpenRouter.** One sign-in gives FRIDAY hundreds of
  models, billed to your own OpenRouter account. Nothing to download, no warm-up, ~1 s a
  decision. The default model is `anthropic/claude-haiku-5.5` (fast, strong at tool calls,
  $0.10 / $0.50 per million tokens); `/brain model <id>` picks any OpenRouter model.
- **Local: Ollama.** Free and fully private, needs a GPU, and the model has to load before
  its first answer (`brain.localModel`, default `qwen2.5:7b-instruct`).
- **Your own CLIs: Claude, Codex, Gemini.** The brain runs through the CLI you are already
  signed in to, on your own plan; nothing extra to pay for, but ~8 s a decision (a process
  per decision, answering in JSON). Claude takes `haiku`, `sonnet`, `opus`, `fable`; Codex
  lists the models your account has (from its own cache).

`/brain` opens a menu with one row per AI (Local, OpenRouter, Claude, Codex, Gemini), on the
one in use. `↑↓` move, `→` shows that AI's models, `←` goes back, `Enter` uses it, `Esc`
closes. Enter first makes sure the AI is ready, and fixes what is missing: the OpenRouter
sign-in in your browser, `claude auth login` / `codex login` / Gemini's Google sign-in,
installing a CLI (it asks first), starting Ollama, downloading a model.

```sh
friday setup     # checks your agents, signs you in to the ones that are not, picks the brain
friday login     # OpenRouter sign-in in your browser (OAuth PKCE, the key is saved locally)
```

Typed forms: `/brain cloud|local|auto`, `/brain model <id>`, `/login`. `profile.json` `brain`:
`{ "provider": "auto" | "openrouter" | "ollama" | "claude" | "codex" | "gemini", "model",
"localModel", "models": { "claude": "haiku", ... } }`; `auto` = OpenRouter when a key is
saved, else Ollama. The key lives in `keys.json` in the config folder, or
`OPENROUTER_API_KEY` in the environment (that wins).

**Private and sealed messages never reach a cloud brain**: they are routed to local agents
by the rules before the brain is asked, and a cloud brain never classifies a sealed message.

## Memory

FRIDAY remembers across conversations, like Claude does (`src/memory.js`). This is its own
memory, kept in the config folder under `memory/`, separate from the second brain (your
notes):

- **Facts**: say "remember that …" (the brain saves it) or `/memory add <fact>`. They live in
  `memory/memory.md`, one `- ` line each; edit it by hand if you like.
- **Past conversations**: when you quit, the brain writes a 2-4 sentence summary of the
  conversation (what you wanted, what was done, what is next) to `memory/summaries.json`. One
  that closed abruptly is summarized at the next start. Without a summary yet, the questions
  asked stand in for it.

The brain reads this memory on every message, so "what did we work on last?" is answered in
a new chat, and "continue that" goes to the right agent with what it needs in its task. Each
agent also gets it at the start of its session. `/memory` lists it; `/memory forget <n|text>`
removes facts. Private and sealed turns are never remembered (saved conversations hold only
placeholders for them), and a fact that looks private is not saved. For the full transcript
of one conversation, `/resume` still continues it with the same agent sessions.

## The orchestrator

Ordinary messages go to the brain (`src/orchestrator.js`, through tool calling). It sees one tool per ready agent (`ask_claude`, `ask_codex`, ...,
described by their `strengths`) and decides:

```
auto ❯ the selfmod tests might fail on windows, find out why, but do not change anything
  -> friday decides (OpenRouter anthropic/claude-haiku-5.5)
  ◇ friday → claude: Investigate why the selfmod tests might fail on Windows without making changes
● Claude Code · via friday
  ...answer...
  friday · claude · 0.9s deciding, cloud
```

- **Small talk and quick facts** it answers itself (~0.5-1 s, free).
- **Anything with files, code, tests, the repo or the web** must go to an agent. A small
  model will "answer" these from nothing, so FRIDAY checks: if the message needs tools and
  the model answers anyway, it is told once to delegate, and then the agent the rules
  would pick gets the message.
- **Several steps**: after an agent answers, the model sees a short excerpt and may call
  another (a review, a second opinion) or stop. At most `maxSteps` (4) decisions.
- **Your words reach the agent.** The model writes the task, and when that task leaves out
  part of what you said, your message is appended verbatim.
- **Failures move on.** An agent that fails (Codex with a revoked login, say) is dropped
  for the message and the same task goes to the next one; a login failure also skips that
  agent for the rest of the session (`/agents` says so). The model's closing line is not
  shown after a failure (small models claim success) or when it just repeats the answer.
- **Memory**: the last `history` (3) exchanges, as the real messages, so "now have codex
  check that" works.
- **Not used for** private or sealed messages (they never reach it), `@agent` and `/use`,
  councils, designs, self-changes and "have someone check" pipelines (rules). Pipelines also
  fail over: a step whose agent cannot log in goes to the next in its chain.
- **If the brain cannot be reached** (a local model still loading, or no connection), the
  rules route that message at once; a local model loads in the background.

`/orchestrate` shows status; `/orchestrate on|off` (saved to `profile.json`).

## The agent tree

FRIDAY is the root: the brain (`/brain`; e.g. Codex `gpt-6-astra`). Every provider is a
limb, and every limb runs twigs: small subagents, each a fresh headless turn with its own
model, many at once. The brain hands them out with one `dispatch` tool call, gets every
answer back, and writes the combined answer (`src/tree.js`).

```
auto ❯ use five sonnets: each names one different benefit of unit tests
◈ FRIDAY → 5 subagents
  ├─ ① claude · sonnet  Name one benefit of unit tests… catching regressions…
  ├─ ② claude · sonnet  … documenting expected behavior…
  ...
  └─ ⑤ claude · sonnet  … reducing manual verification…
  ✓ ① claude · sonnet · 3.8s
  ...
  5/5 done
● 1. Catches regressions … 5. Encourages better code design.
```

- **Limbs**: `claude`, `codex`, `gemini`, `opencode` (CLIs: files, code, shell) and
  `openrouter`, `ollama` (chat models: text only, so no file or web parts). A limb is offered
  only when it can run: installed and signed in, OpenRouter with a key, Ollama running.
- **Twigs**: `tier` small or large picks the limb's model; `max` is how many run at once.
  Defaults: Claude ×5 (small `sonnet`, large `opus`), Codex ×2 (`gpt-6-luna`, `gpt-6-astra`),
  Gemini ×2, opencode ×2, OpenRouter ×4, Ollama ×1; at most `maxTwigs` (8) per dispatch.
- **Safe by default**: twigs run read-only. A part marked `writes` runs alone, after the
  readers, in your current mode (plan stays plan), so two twigs never edit one checkout at
  once. A part a limb cannot run moves to one that can (file work only to a CLI limb).
- **Sealed and private** rules hold for every twig, as for any turn.
- **When the brain uses it**: work that splits into independent parts, or when you ask for
  several agents or models ("five sonnets", "have every agent check this"). One task still
  goes to one agent. `Ctrl+C` stops the running twigs and skips the rest.

`/tree` draws the tree with each limb's state, limits and models; `/tree on|off`. Limits
and models live in `profile.json` under `"tree"` (`limbs.<name>.max`, `.models.small|large`,
`maxTwigs`, `twigTimeoutMs`, `resultChars`).

## Missions

For a job with phases ("I want to build X, research it first"), FRIDAY leads it as a
**mission** (`src/mission.js`). Say it, and the orchestrator starts one
(`start_mission`), or type `/mission <goal>`:

1. **Plan.** The local model drafts 2-4 research jobs, each with its own complete prompt
   and an agent: Codex (ChatGPT, live web search via `codex --search`) for market
   validation, competitors, users, risks and biases; Claude for what is technically
   needed. Claude reviews the plan and sharpens the prompts. **FRIDAY shows it and asks:**
   `go`, `cancel`, or say what to change (it revises and asks again).
2. **Research.** The jobs run in parallel and read-only: inside the project when the goal
   names one of yours (Claude may also read the vault, minus sealed notes), else in a scratch
   folder. Each answer prints as it lands. A job whose agent can't log in moves to another
   agent, and a job that fails gets one retry on another agent. Each job has a time limit
   (`mission.researchTimeoutMs`, 20 min). A failed job's reason is saved with the mission.
   **Research only:** when the goal only asks for analysis or advice, the plan says so
   (`build_intent: "none"`), and after the research FRIDAY writes the brief, Claude checks
   it against the research, and the mission ends `researched`. Nothing gets built.
3. **Brief and build prompts.** The local model merges the findings into a research brief
   (decision, users, competitors, risks, approach, open questions) and writes the build
   jobs: a build prompt (usually Claude Code) that includes writing tests, the command
   that runs them (`test_command`), and a review or test by another agent. Claude checks
   both against the research. **FRIDAY shows them and asks:** `go`, `cancel`,
   `folder <path>` (where to build: the project's own folder when the goal names one,
   else `<first root>/<project-slug>`), or changes.
4. **Build.** The build runs on its own branch, `friday/<slug>`, never on the branch the
   folder was on. A repo with uncommitted changes pauses the mission until you commit or
   stash them. FRIDAY commits after the build and after every fix. The build job may edit
   files. If the build splits
   cleanly into 2-3 pieces that own separate paths (a CLI and a web page, say), the
   pieces run **at the same time, each in its own git worktree and branch** (the folder
   becomes a repo; worktrees live under `~/.local/share/friday/mission-worktrees`), then
   merge back one by one. Overlapping ownership means one ordinary build instead. A part
   that touches files it does not own is flagged; a merge conflict goes to the build's
   agent once, then to you. Branches are kept so every part can be inspected.
5. **Verify and fix.** The tests run (`test_command`, else `npm test` / `pytest` if the
   project has them). The review and test jobs read the result and must end with a
   verdict block (`{"verdict": "pass"|"fail", "issues": [...]}`); they never edit. Failing
   tests and failed verdicts go back to the builder **in its own session** as a fix
   round. The same problems twice in a row hand the fix to another agent. After
   `mission.fixRounds` (3) fixes FRIDAY asks: `more`, `accept` or `stop`. The status says
   what was proven: `built and verified`, `built, partly verified (no tests ran; codex:
   no verdict)`, `built, accepted with N open issues`, or `needs you: ...`. With `gh`
   installed and an `origin` remote, FRIDAY then offers a **pull request**: the brief plus a
   table of each verification round.
6. **Saved**, whatever the outcome (cancelled missions keep their plan and research):
   `config.json` `"missionStore"`: `"vault"` writes
   `03_Resources/friday-missions/<date>-<slug>.md` through the vault queue; a folder path
   writes `<folder>/<date>-<slug>/mission.md`. The first mission asks where to keep them
   (your vault if one is configured, a folder of your choice, or `~/Documents/FRIDAY/missions`).

**Resume.** The mission's state is checkpointed after every phase, research answer and
fix round (`<config>/missions/*.json`). An agent that hits its plan limit, a crash, an
interruption (Esc, Ctrl+C, quitting, a reload) or you answering `pause` leaves the mission
*paused*, not failed; FRIDAY mentions it at
startup, and `/mission resume [n]` carries on from that phase (only unanswered research
jobs run again; the builder's session is restored).

**Budget and overflow.** Before each agent job FRIDAY checks the usage it has seen: an
agent past `mission.pauseAt` (85%) of its 5-hour plan limit, or API-billed spend past
`mission.maxCost` dollars in this mission, makes it ask `go / use <agent> / pause`. A `go`
holds for that agent for the rest of the run. With `mission.overflow: "auto"` it does not
ask: the job moves to the ready agent with the most room left, and the mission note lists
each move. Every mission note ends with a plan-usage table per agent (5-hour and 7-day
limits before and after, API cost; `n/a` where an agent doesn't report it).

**In the background, and on your phone.** `friday mission "<goal>" --bg` (or
`friday mission resume <n> --bg`) runs the mission in a headless FRIDAY and gives the
terminal back. Its output goes to a log (`friday mission log`, `/mission log`), and its
questions wait until you answer: `friday mission answer <n> go`, `/mission answer`, or
Telegram. `--yes` approves the plan and the build by itself; budget limits, pull requests and
accepting a failing build still wait for a person. One worker per mission.
**Telegram** (`friday telegram`, or step 5 of `friday setup`): your own bot from @BotFather.
FRIDAY sends each question with its options as buttons, and a typed reply counts as "what
to change". In the cockpit, a mission's question can be answered from the terminal or the
phone, whichever comes first. Every text passes the sealed/private checks before it is sent.
`/telegram on|off|test`.

**Lessons.** When a mission ends, Claude writes up to 5 one-line lessons from what happened
(what failed and why, how many fix rounds, who fixed it, research gaps). A lesson about a
failure has to name the cause that was recorded; generic advice is not allowed. They are appended to
`03_Resources/friday-missions/_lessons.md` (or `lessons.md` in the mission folder), and the
newest 10 go into the next mission's planning and build prompts. Edit or delete them
freely: the note is the memory.

Profile keys: `mission: { fixRounds: 3, pauseAt: 0.85, maxCost: null, maxParallel: 3,
researchTimeoutMs: 1200000, buildTimeoutMs: 2700000, overflow: "ask" }`.
These patterns come from other multi-agent tools: verify-and-fix and resumable cycles
(kodo), evidence-driven review and non-overlapping write boundaries
(dynamic-task-router), auto-pause near limits and curated lessons (Addy Osmani's "Code
Agent Orchestra"), worktree-per-agent (Parallel Code, Claude Squad, Crystal).

Missions need the brain (cloud or local; see The brain) and Claude (the reviewer).
Private or sealed goals are refused: missions use cloud agents. Ctrl+C at a question
cancels. If the vault has uncommitted edits, FRIDAY writes the note but does not pull,
commit or push (a pull would re-apply your edits on top of the remote's; your next sync
includes the note).

## Routing

When the orchestrator is off or not loaded, and for the kinds of message above, rules
decide who handles it and print the decision:

```
auto ❯ Fix the failing test in my-app and have someone check the fix.
  -> codex, then claude reviews · build, then an independent review
```

In order, first match wins:

1. **Private data** (MIMIC, PhysioNet, patients, PHI, discharge summaries, ...): **Ollama
   only**. No fallback, no classifier, no council members in the cloud, no `/relay` of the
   answer to a cloud agent. If Ollama is down, nothing is sent. `@codex!` (with the `!`)
   is the only way to send such a message to a cloud agent.
   **Sealed projects** (`private.sealed`, none by default): any mention, focus on the project, or
   working inside its folder is local only, with **no** override; the check sits in the one
   function every agent call goes through, cloud agents get no vault notes about it, Claude
   is denied file access to it, and its turns are not saved to disk. A shell can still read
   any file your account can, so this is not OS isolation.
2. **Design** (redesign, mockup, landing page, new screen/theme): the Claude Design
   pipeline (below).
3. **Self-change** (talking to FRIDAY about FRIDAY: "from now on ...", "make the HUD ..."):
   see Self-changes.
4. **Council** ("what do you all think", "council"): every ready agent in parallel.
5. **Pipeline**: a coding task that asks for a check ("... and have someone check the
   fix") runs implement then an independent review by a different agent; "plan it out
   first" adds a planning step.
6. **One agent by category**: code, debug, review, research, long context, images,
   writing, vault, simple, chat; each maps to an agent with fallbacks.

Rules are regexes with weights (`src/router.js`). When they are unsure about a message of
six or more words, a small model breaks the tie: Ollama's `classifier.ollamaModel`
(`qwen2.5:7b-instruct`, ~0.1 s warm, loaded at startup) if it is pulled and in memory,
otherwise opencode's free model, otherwise the rules' own pick. A model that is not loaded
is never waited for: FRIDAY routes by the rules and loads it in the background. Agents that are not ready are skipped with a note: Gemini until it
is logged in, Ollama until `ollama serve`.

**The profile is data.** Strengths, the category table, pipelines, private-data patterns,
the classifier and standing instructions live in `~/.config/friday/profile.json`, written
with defaults on first run and re-read whenever it changes. Defaults:

| Agent | Takes | Why |
|---|---|---|
| Claude Code | code, writing, vault, chat; plans and reviews in pipelines | multi-file edits, already loads the vault rules |
| Codex | debug, review; implements in pipelines | `codex exec` sandbox runs tests; `codex exec review` exists |
| Gemini CLI | research, long context, images (falls back to Claude) | ~1M-token context, Google Search grounding |
| opencode | simple, bulk | free model here |
| Ollama | private data, only | local |
| Claude Design (via Claude Code) | redesigns, mockups, screens, themes | real components from the synced design system |

**Overrides teach it.** `@agent` on a message the router would have sent elsewhere is
recorded in `~/.config/friday/overrides.jsonl` (category and agents only, never the text).
When 3 of your last overrides for a category (at least 60%) pick the same agent, FRIDAY
makes that agent the route, says so, logs it to the vault, and `/undo-self` reverses it.

## The second brain

`context/VAULT_PROTOCOL.md` holds the vault rules once. FRIDAY renders it into
`~/.config/friday/context/{CLAUDE,AGENTS,GEMINI}.md` and hands it to each agent the way that
agent reads instructions, with read and write access to the vault (flags checked in each
`--help`):

| Agent | Rules | Vault access |
|---|---|---|
| Claude Code | `--append-system-prompt-file CLAUDE.md` | `--add-dir <vault>` |
| Codex | `-c developer_instructions=<AGENTS.md>` | reads the whole disk; `-c sandbox_workspace_write.writable_roots=[<vault>]` makes it writable (`exec resume` has no `--add-dir`) |
| Gemini CLI | GEMINI.md in the first message of each session (no instructions flag) | `--include-directories <vault>` |
| opencode | `OPENCODE_CONFIG_CONTENT` with `instructions: [AGENTS.md]` | `permission.external_directory` allows the vault |
| Ollama | system message | none (no tools): FRIDAY retrieves the notes for it |

**Agents work the vault the way Claude Code does**. They find notes
themselves (`CRITICAL_FACTS.md`, `_INDEX.md`, search) and edit them directly, following
`_System/CLAUDE.md`. Nothing retrieved is pasted into their messages. Before, they could
only propose writes as JSON ops, so a request like "fix the vault formatting" ended in
an agent explaining which ops it lacked.

**Commits.** FRIDAY takes the vault's `git status` when a turn starts and again when it
ends, and commits the files the agent changed, then pushes. Files that already had your
own uncommitted edits stay uncommitted (FRIDAY says so), so your unfinished work never
goes into its commits, and it never pulls over your uncommitted edits. `vaultSync: false`
in config.json keeps the commits local.

Ollama has no file tools: it gets the rules, `CRITICAL_FACTS.md` and the matching notes'
Now blocks in its system message, and proposes writes as fenced `friday-vault` blocks
(`log`, `decision`, `now`, `create`, `append`, see `context/VAULT_OPS.md`) that FRIDAY
applies one batch at a time. Any agent's `friday-vault` blocks still work. Every edit
keeps the file's own line endings (most of the vault is CRLF).

## Self-changes

Only when you ask. FRIDAY sorts the request:

- **Settings** (routing, fallbacks, pipelines' implementer/reviewer, standing instructions
  per agent or for all, colors, the conversations key, route line, manual/auto): parsed
  from the sentence, written to `profile.json`, live on the next message.
  "From now on, route all research questions to Gemini" pins research to Gemini with no
  fallback ("all"), and warns that Gemini is not logged in here.
- **Code** (a feature: "add a panel to the HUD ..."): Claude Code edits FRIDAY's source in a
  git worktree on a new `friday-self/<stamp>-<slug>` branch (`~/.config/friday/self-worktrees/`).
  FRIDAY then runs `node --test` itself. If it fails, nothing changes: the worktree and
  branch are removed, the failure lines are shown, and the attempted diff is kept in
  `~/.config/friday/self-failed/`. If it passes, the branch is committed and fast-forwarded
  into the running checkout, and FRIDAY restarts into the same conversation (agent
  sessions, folder, mode). `bin/friday.js` runs the cockpit under a small supervisor for
  this; `FRIDAY_NO_SUPERVISOR=1` turns it off.

Each change prints a short summary, is logged to the vault's `log.md`, goes to
`decisions.md` in your words, and is recorded in `~/.config/friday/self-history.json`.
`/undo-self` reverses the newest one (settings restored; code reverted with `git revert`
and a restart). FRIDAY's checkout must be clean for a code change.

## Redesigns with Claude Design

"Redesign the my-app dashboard: ..." runs as a pipeline:

1. **Design.** Headless `claude -p` has no Claude Design access (no Artifact tool), so FRIDAY opens an **interactive Claude Code pane** in the app's repo with
   the request, the app's synced design system (`profile.json` `designSystems`, or a
   `.design-sync/NOTES.md` in the repo or one of its `.claude/worktrees`), and edits to the repo denied. The pane writes the design link and a
   short spec to a handoff file; FRIDAY prints the link each revision. Iterate in the pane.
2. **Implement**, after `/approve`: the pipeline's implementer (Codex) works on a
   `friday-design/...` branch in a worktree of the app (CSS tokens for look, components for
   structure), the app's tests run, and the reviewer (Claude) checks the diff against the
   spec. The branch is not merged.
3. **Re-sync**: a Claude Code pane runs `/design-sync` so the design system matches the
   new code. An app without a design system gets `/design setup` first, with your OK.

`openPanes: false` prints the pane command instead of opening a window.

## Prompt-writer

Off by default. When on, a small local model (Ollama, `qwen2.5:7b-instruct`) rewrites your
message into a compact prompt for the agent it is going to, before it is sent:

```
auto ❯ Hey so the debug thing on Windows, can you look at why the selfmod tests ... tell me the root cause
  -> codex · debug
  rewrite for codex: ~73 → ~31 tokens (est.) · 0.8s
```

- **Only your message is rewritten.** The Now block, the vault notes, standing instructions,
  the vault rules and pipeline role wrappers are built from the original and added
  unchanged. The HUD, the transcript and `/relay` keep the original.
- **Per agent.** A single route gets one rewrite; each pipeline step and each council member
  gets its own, in the style for that agent (`promptWriter.styles` in `profile.json`).
- **Skipped** for messages under `minWords` (25), for Ollama, for `@agent` and `/use`
  (you chose the agent and the words), and for `/relay`, the classifier, self-changes and
  designs.
- **Checked before it is used.** The rewrite must be shorter and keep every file name, path,
  identifier, flag, number, quoted string, URL and project name, and every `must / never /
  don't / only / no` constraint with its force (a "never" must still sit before the same
  words). It may not add an action you did not ask for ("tell me the root cause" may not
  become "fix it"), or a placeholder like `[specific date]`. A message that is private
  stays private after the rewrite. Anything else: the original is sent, with one dim line
  `rewrite skipped for <agent>: <reason>`. Ollama down, a timeout (`timeoutMs`, 8 s), a
  missing model or a refusal do the same. A turn never fails because of the prompt-writer.
- **Private data** is checked on the original text, before any rewrite, and the route never
  changes because of one. The writer is local, so it never sends anything anywhere.

Setup and health check (pulls the model if needed, then times a cold and a warm rewrite):

```sh
node scripts/setup-promptwriter.js           # or --check to skip the pull
```

Then `/rewrite on` in FRIDAY (saved to `profile.json`), `/rewrite off` to stop, `/rewrite`
for status, `/rewrite <message>` for a dry run.

**Measurement.** Every turn while it is on appends one line to
`~/.config/friday/promptwriter.jsonl` (Windows: `%APPDATA%\friday\`): agent, category,
whether it rewrote or why not, message tokens before and after, rewrite time, the writer's
own token counts, and the agent's reported input, cached and output tokens, time and billing
kind. Numbers only, never text. Message tokens are **estimates** (chars/4; each CLI uses its
own tokenizer). Writer tokens are Ollama's `prompt_eval_count` / `eval_count`; agent tokens
are what each CLI reports (Claude: input + cache writes + cache reads; Codex: `input_tokens`,
which includes cached; opencode: the last step's). `/usage` shows the summary.

**Paid APIs.** FRIDAY has no direct HTTP provider yet; OpenAI is reached through Codex on its
own login. `config.json` reserves `"allowExternalApi": false` and `"externalApis": []`: both
must allow a provider before one may be called, and keys come only from the environment
(`OPENAI_API_KEY`).

## How each agent is driven

| Agent | Command | Mode mapping (plan / edit / yolo) |
|---|---|---|
| Claude Code | one process per session kept running: `claude -p --input-format stream-json --output-format stream-json --include-partial-messages`, one message per line; `--resume <id>` when it has to start again | `--permission-mode` plan / auto (edit mode; acceptEdits on a Claude Code without auto, or `FRIDAY_CLAUDE_EDIT`) / bypassPermissions. Auto runs routine commands and refuses risky ones, so a job never stops on a question nobody is there to answer |
| Codex | `codex exec --json`, `codex exec resume <id>` | `sandbox_mode` read-only / workspace-write / `--dangerously-bypass-approvals-and-sandbox` |
| Gemini | `gemini -p -o stream-json`, `--resume latest` | `--approval-mode` plan / auto_edit / yolo |
| opencode | `opencode run --format json`, `--session <id>` | `--agent plan` / default / `--auto` |
| Ollama | HTTP `/api/chat` on `127.0.0.1:11434`, history kept in FRIDAY | chat only, no tools |

Each agent runs headless, so none of them can stop to ask for permission mid-turn. Use
`plan` when you only want answers.

Claude's process starts when FRIDAY does (and again on `/mode`, `/cd` or a new project
focus), so the first message does not wait for Claude Code to boot, and it stays up
between messages. A change of folder, mode or flags ends it (its SessionEnd hooks run) and
the next one resumes the same session; so does an interrupt. Missions, design and
self-change worktrees still start one process per job.

## Money: plan limits vs. bills

Headless agents run on whatever login the CLI already has. On a subscription login
(claude.ai Pro/Max, ChatGPT Plus/Pro) tokens count against the plan's usage windows and
cost nothing extra; only an API key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ...) turns
tokens into a bill. FRIDAY reads which one each run used (Claude reports `apiKeySource`
per run; Codex from `~/.codex/auth.json`'s `auth_mode`) and says so after every turn:

```
8.7s · plan 33% of 5h, 23% of week · not billed (~$0.20 at API prices)
```

Claude Code always reports a dollar figure; on a plan it is what the same tokens would
cost at API prices, not a charge. The HUD's Agents panel shows the same per agent.

## The HUD

The HUD is **off by default**: `/hud` opens it once, `/hud on` opens it by itself whenever a
project is in focus (`config.json` `autoHud`; `friday setup` asks), `/hud off` turns that off.

The terminal HUD reads the cockpit's local event stream at `http://127.0.0.1:7777`
(next free port if taken; bound to localhost only). The same stream feeds the browser
version (`/hud web`). Both show:

- **Map**: every file, placed radially by folder, coloured by language, sized by bytes.
  Amber halos mark files changed most in the last 90 days; red rings mark uncommitted
  files. Agents orbit the edge and beam to files as they touch them.
- **Directive**: the project's vault Now block.
- **Telemetry, composition, activity, commits**: from `git`.
- **Comms**: the conversation and the live text of whichever agent is talking.
- **Agents**: status, turns, and plan usage or spend.

The terminal HUD opens as a tmux split when the cockpit runs inside tmux, otherwise in a
new window via `$TERMINAL` / `xdg-terminal-exec` (Omarchy). On Windows it is a split pane
when the cockpit runs in Windows Terminal, otherwise a new Windows Terminal window (or a
console window without WT). The browser version adds a command box and opens with
`omarchy-launch-webapp` or an `--app` mode Chromium-family window.

**Themes.** How both HUDs look is `hud-theme.json` in the config folder: colors, title,
which panels show, the map's rings and sweep, and (browser) an image faintly behind it.
Change it in words or from a picture:

```
/hud theme C:\Users\me\Pictures\cockpit.png        match an image's palette and mood
/hud theme darker, purple accents, hide commits    or describe it
make the HUD look like ~/pics/arc.jpg               plain messages work too
/hud theme undo · /hud theme reset
```

Claude designs the theme (it reads the image itself), FRIDAY rejects unreadable ones (text
or accent too close to the background) and both HUDs repaint live. In the browser HUD,
the ◐ theme button takes a dropped image and/or words. Hand edits to the file apply live.

## Config

Optional `~/.config/friday/config.json` (Windows: `%APPDATA%\friday\config.json`):

```json
{
  "roots": ["~/Projects", "~/Work", "~/Downloads"],
  "vault": "~/SecondBrain",
  "port": 7777,
  "defaultAgent": "claude",
  "mode": "edit",
  "autoHud": false,
  "hud": "terminal",
  "browser": null,
  "ollamaModel": "gemma4:26b",
  "vaultSync": true,
  "openPanes": true,
  "claudeMcp": false
}
```

`claudeMcp: false` (the default) starts FRIDAY's Claude turns without your MCP servers
(`--strict-mcp-config`): with many plugin connectors configured that saved ~2.4 s before every
answer. Set it to `true` to give FRIDAY's Claude your MCP tools.

## Tests

`npm test` covers every agent's event parser and CLI arguments, project detection and
scanning against a throwaway git repo and vault, the streaming markdown renderer, and the
HUD server (SSE, commands, origin check, path traversal). It also covers the router (the six
acceptance inputs, private data, fallbacks, profile-driven routes, hot reload, learning from
overrides); the vault (per-agent flags, retrieval, every write op and its guards, and ten
concurrent writers through one queue against a bare remote that another clone pushed to
first); self-modification (settings parse, apply and undo; a code change that lands and is
reverted; a code change whose tests fail and leaves nothing behind; dirty-checkout refusal);
and the design helpers. The prompt-writer adds: when to rewrite, key-term extraction and
the preservation check on FRIDAY-style messages, every fallback against a mocked `fetch` (no Ollama, no paid API), and a log that
holds no message text.
