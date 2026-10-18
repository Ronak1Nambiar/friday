# FRIDAY quick start

FRIDAY is one terminal prompt for all your AI coding agents. You type a message; FRIDAY
picks the agent that is best at it (Claude Code, Codex, Gemini CLI, opencode, or a local
Ollama model), runs it, and streams the answer. You never have to switch tools.

## 1. Install (5 minutes)

You need:

- **Node 20 or newer** (`node --version`).
- **At least one agent CLI, logged in.** Run each once on its own to log in:
  `claude`, `codex login`, `gemini`, `opencode`. You do not need all of them.
- **For the brain, one of:** an OpenRouter account (cloud, recommended: `friday setup` signs
  you in) or Ollama (https://ollama.com) for a fully local brain.

Then:

```sh
npm i -g friday-agents        # the `friday` command, in any folder
friday setup
```

Or from source:

```sh
git clone https://github.com/Ronak1Nambiar/friday
cd friday
npm link                      # adds a `friday` command you can run in any folder
friday setup                  # checks your agents and signs you in, picks the brain (cloud or local)
```

`friday setup` also runs by itself the first time you start FRIDAY.

Tell FRIDAY where your projects and notes are. Create the config file
(Windows: `%APPDATA%\friday\config.json`, Linux/macOS: `~/.config/friday/config.json`):

```json
{
  "roots": ["~/Downloads", "~/Projects"],
  "vault": "~/Documents/MyVault"
}
```

`roots` are folders that contain your projects. `vault` is an Obsidian vault (optional).

## 2. Start it

Open a terminal (PowerShell is fine) in a project folder and run:

```sh
friday
```

```
  ● claude   ● codex   ○ gemini   ○ opencode   ● ollama
  ~\Projects\myapp  ·  mode edit  ·  auto-routing  ·  vault ~\Documents\MyVault  ·  /help
  What FRIDAY can do   (/abilities shows this again)
  Just ask       a local model sends it to the right AI      why do the tests fail?
  Missions       research → build → test → fix, you approve  /mission build a CLI that …
  Council        every AI answers; /relay gets a check       /all which database fits?
  ...
auto myapp ❯
```

`●` = ready, `◌` = installed but not ready (not logged in, or Ollama not running),
`○` = not installed. Under that, **what FRIDAY can do**, each with something to try. An
ability that can't run right now is dimmed and says why (for example `(start Ollama)`).
`/abilities` shows the list again; `"showAbilities": false` in `profile.json` hides it.

## 3. Talk to it

Just type what you want. A small model on your own machine reads it first and decides:
it answers quick things itself, and hands real work (code, files, tests, research,
writing) to the agent best at it, sometimes one after another:

```
auto ❯ why does npm test fail on Windows?
  -> friday decides (local qwen2.5:7b-instruct)
  ◇ friday → codex: find why npm test fails on Windows
● Codex · via friday
  ...answer...
  friday · codex · 0.8s deciding, local
```

It needs Ollama running with `qwen2.5:7b-instruct` pulled; without it, FRIDAY's built-in
rules pick the agent instead. `/orchestrate off` switches to the rules for good.

Things to try:

| You type | What happens |
|---|---|
| `explain what src/router.js does` | goes to the best agent for it |
| `@codex fix the failing test` | you pick the agent for this one message |
| `fix the bug in login and have someone check the fix` | one agent fixes it, a second one reviews |
| `/all should I use SQLite or Postgres here?` | every agent answers; compare them |
| `/relay claude` | hand the last answer to Claude to review |
| `how is my-app going?` | switches to that project (and its folder) automatically |

### Bigger jobs: missions

For something with phases, just say it, or use `/mission`:

```
auto ❯ /mission build an app that shows today's free food events on campus. Research it first.
```

FRIDAY plans the research (one prompt per job, for the right AI), shows you the plan and
waits for `go`. Codex researches the market, competitors and risks while Claude works
out what is needed technically, in parallel. FRIDAY merges the findings into a brief,
writes the build prompt, shows you both and waits for `go` again. Then Claude Code builds
it (big builds split into parts that run at the same time), the tests run, another AI
reviews and gives a pass/fail verdict, and anything that fails goes back to the builder
to fix, up to 3 rounds before FRIDAY asks you. At each question you can also say
`cancel` or what to change.

The build happens on its own branch (`friday/<name>`), and at the end FRIDAY offers a pull
request if the repo has a GitHub remote and `gh` is installed. A question that only needs
an answer ("look at my app and tell me what to add next") stops after the research, with
a checked brief.

If an AI hits its usage limit, FRIDAY closes, or you press Esc mid-mission, nothing is
lost: start FRIDAY again and type `/mission resume`. When an AI is close to its limit,
FRIDAY asks before using it (`go`, `use codex`, or `pause`), or, with
`"overflow": "auto"` under `mission` in profile.json, hands the job to whichever AI has
the most room. After each mission FRIDAY writes a few lessons, and the next mission's plan
uses them.

**Run it in the background:** `friday mission "build ..." --bg` gives your terminal back.
`friday missions` shows where it is, `friday mission log` shows its output, and
`friday mission answer 1 go` answers its questions. Run `friday telegram` once and the
questions also come to your phone as buttons (or reply with what to change).

The first mission asks where to save plans and research: your notes vault, a folder, or
`Documents\FRIDAY\missions`.

## 4. The commands you will actually use

| Command | Does |
|---|---|
| `/mode plan` | agents may read but not change files (safest; good for questions) |
| `/mode edit` | agents may edit files (the default) |
| `/claude`, `/codex`, ... | always use that agent; `/auto` goes back to automatic |
| `/project <name>` | work on another project; `/project` lists them |
| `/hud` | open the project map beside the prompt |
| `/resume` or `←` on an empty prompt | pick up an earlier conversation |
| `/new` | start fresh |
| `/usage` | what each agent cost you (plan limits vs. money) |
| `/orchestrate` | is the local decision-maker on and loaded; `/orchestrate on\|off` |
| `/mission <goal>` | research first, then build, test and fix, with your OK at each step |
| `/mission resume` | carry on with a mission that was paused or cut off |
| `/route <message>` | see where a message would go, without sending it |
| `/help` | everything else |
| `Ctrl+C` | stop the running agent; twice on an empty prompt quits |
| `/quit` | exit |

## 5. Private data stays local

Messages about patient or health data (MIMIC, PhysioNet, PHI, ...) go **only** to the local
Ollama model. If Ollama is not running, nothing is sent and FRIDAY tells you. To send such a
message to a cloud agent anyway you must say so explicitly: `@codex! ...`.

## 6. Keeping it fast

- **Keep Ollama running** with `qwen2.5:7b-instruct` pulled. FRIDAY uses it to route
  messages it is unsure about (~0.1 s). Without it, FRIDAY routes by its rules instead.
- Claude turns skip your MCP connectors (Slack, Gmail, ...), which saves ~2 s per answer.
  Need them? Add `"claudeMcp": true` to `config.json`.
- The local model for private data is `ollamaModel` in `config.json`. A model larger than
  your GPU memory is slow (tens of seconds); one that fits answers in a second or two.

## 7. When something is wrong

| You see | Fix |
|---|---|
| `◌ gemini (not logged in)` | run `gemini` once and log in |
| `◌ ollama (not running)` | start the Ollama app, or `ollama serve` |
| Codex: "refresh token was revoked" | `codex login` |
| Claude: "You've hit your session limit" | wait for the reset time it shows, or `@codex` meanwhile |
| "looks private ... Nothing sent" | intended; see section 5 |
| An answer seems to go to the wrong agent | prefix the agent: `@claude ...`. Do it a few times for the same kind of task and FRIDAY learns it |

More detail on everything: [README](../README.md).
