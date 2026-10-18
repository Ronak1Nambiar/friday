// Redesigns with Claude Design. Headless `claude -p` has no Artifact tool (it
// answers NO_ARTIFACT_TOOL), so the design step and the design-system
// re-sync run in an interactive Claude Code pane. That pane writes the design link
// and a short spec to a handoff file, which FRIDAY watches; no code changes until
// The user says /approve. Then one agent implements on a branch, the tests run, and
// another agent reviews the diff against the spec.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { denyGlob } from './vault.js';
import { cap, userName, userPossessive } from './user.js';

// The synced design system for an app: profile.designSystems first, then a
// .design-sync/NOTES.md in the repo or in one of its .claude/worktrees.
export function findDesignSystem(app, profile = {}) {
  const key = (app?.name || '').toLowerCase();
  const fromProfile = Object.entries(profile.designSystems || {}).find(([k]) => k.toLowerCase() === key)?.[1];
  if (fromProfile?.project) return { ...fromProfile, source: 'profile' };
  if (!app?.dir) return null;
  const candidates = [path.join(app.dir, '.design-sync')];
  try {
    for (const w of fs.readdirSync(path.join(app.dir, '.claude', 'worktrees'))) candidates.push(path.join(app.dir, '.claude', 'worktrees', w, '.design-sync'));
  } catch {}
  for (const dir of candidates) {
    let notes = '';
    try { notes = fs.readFileSync(path.join(dir, 'NOTES.md'), 'utf8'); } catch { continue; }
    const project = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/.exec(notes)?.[1];
    const name = /project "([^"]+)"/.exec(notes)?.[1] || `${app.display || app.name} design system`;
    if (project) return { project, name, dir, worktree: path.dirname(dir), source: 'design-sync' };
  }
  return null;
}

// A Claude Design project link pasted into a request ("... https://claude.ai/design/p/<id>").
export function designLinkIn(text, app) {
  const m = /https?:\/\/claude\.ai\/design\/p\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b[^\s"'<>)]*/i.exec(text || '');
  if (!m) return null;
  return { project: m[1].toLowerCase(), link: m[0].replace(/[.,;:!?]+$/, ''), name: `${app?.display || app?.name || 'app'} design`, source: 'link' };
}

export function readHandoff(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Calls cb(handoff) each time the pane writes a new revision.
export function watchHandoff(file, cb, { interval = 1000 } = {}) {
  let last = '';
  const check = () => {
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return; }
    if (raw === last) return;
    last = raw;
    try { cb(JSON.parse(raw)); } catch {}
  };
  const h = setInterval(check, interval);
  h.unref?.();
  return { stop() { clearInterval(h); }, check };
}

export function designPrompt({ request, app, ds, handoff }) {
  return `FRIDAY design step (${cap(userName())} asked FRIDAY: "${request}").

Make this design in Claude Design with your Artifact tool (Design type), for ${app.display || app.name}${app.dir ? ` (repo ${app.dir})` : ''}.
${ds?.dir ? `Use the synced design system "${ds.name}" (Claude Design project ${ds.project}) so the design uses the app's real components and tokens. Sync notes: ${path.join(ds.dir, 'NOTES.md')}.`
    : ds ? `Work in the Claude Design project ${ds.project}${ds.link ? ` (${ds.link})` : ''}: read it first and build on its components and tokens.`
    : 'This app has no synced design system; work from the repo\'s CSS and components.'}

Rules:
- Do not change any file in the repo. This step produces a design, not code.
- After you publish, and again after every revision, write this JSON to ${handoff} (outside the repo):
  {"link": "<the design URL>", "revision": <n>, "spec": "<what changed: layout, tokens/CSS variables, components to add or change, states>"}
  FRIDAY reads that file and shows ${userName()} the link.
- Then wait for ${userPossessive()} feedback here and iterate. They approve in FRIDAY with /approve.`;
}

export function implementPrompt({ request, handoff, app }) {
  return `Implement this approved design in ${app.display || app.name}. You are on a fresh branch in a git worktree; work only here.
Request: "${request}"
Design: ${handoff?.link || '(no link recorded)'}
Spec from the design step:
${handoff?.spec || '(none recorded; follow the request)'}

How:
- Look changes go in CSS tokens/variables; structure changes go in components. Match the repo's style.
- Keep behavior the same unless the spec says otherwise. Run the tests and fix what you break.
- Do not commit. End with the files you changed.`;
}

export function reviewPrompt({ request, handoff, base, implementer }) {
  return `Independently review the change ${implementer} just made to implement a design. Do not edit files.
Request: "${request}"
Design: ${handoff?.link || '(none)'}
Spec:
${handoff?.spec || '(none)'}

Read the diff with \`git diff ${base}\` (and \`git status\`). Check it against the spec: layout, tokens, components, states, and anything it breaks.
Report: what matches, what is missing or wrong, and exact fixes.`;
}

export function resyncPrompt({ app, ds, branch }) {
  return `FRIDAY re-sync step. The design for ${app.display || app.name} was implemented on branch ${branch}.
Run /design-sync so the Claude Design system "${ds.name}" (project ${ds.project}) matches the new code, following ${ds.dir ? path.join(ds.dir, 'NOTES.md') : '.design-sync/NOTES.md (create it if missing, with the project id)'} (entry file, previews, known gotchas). Update NOTES.md with anything new you learn.`;
}

export function createDsPrompt({ app }) {
  return `FRIDAY setup step: ${app.display || app.name}${app.dir ? ` (${app.dir})` : ''} has no Claude Design design system yet.
Run /design-sync to create one from this repo's real components and tokens, and keep notes in .design-sync/NOTES.md (include the Claude Design project id).`;
}

// The interactive Claude Code command for a pane. The prompt goes first because
// --disallowedTools takes a list.
export function paneCommand({ prompt, repoDir, handoffDir, blockRepoWrites = true }) {
  const args = ['claude', prompt];
  if (handoffDir) args.push('--add-dir', handoffDir);
  if (blockRepoWrites && repoDir) args.push('--disallowedTools', 'NotebookEdit', `Edit(${denyGlob(repoDir)})`, `Write(${denyGlob(repoDir)})`);
  return args;
}

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }).trim();
}

// A branch + worktree of the app repo for the implementation. The worktree lives
// outside any .claude/ folder, where Claude Code would refuse headless edits.
export function designWorktree(repoDir, request, root) {
  const slug = request.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 5).join('-') || 'design';
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  const branch = `friday-design/${stamp}-${slug}`;
  const dir = path.join(root, `${path.basename(repoDir)}-${stamp}-${slug}`);
  fs.mkdirSync(root, { recursive: true });
  const base = git(repoDir, ['rev-parse', 'HEAD']);
  git(repoDir, ['worktree', 'add', '-q', '-b', branch, dir, base]);
  return { branch, dir, base };
}

export function testCommandFor(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (pkg.scripts?.test) return 'npm test --silent';
  } catch {}
  if (fs.existsSync(path.join(dir, 'pyproject.toml')) || fs.existsSync(path.join(dir, 'pytest.ini'))) return 'python -m pytest -q';
  return null;
}

export function commitAll(dir, message) {
  git(dir, ['add', '-A']);
  if (!git(dir, ['diff', '--cached', '--name-only'])) return null;
  try { git(dir, ['commit', '-q', '-m', message]); } catch {
    git(dir, ['-c', 'user.name=FRIDAY', '-c', 'user.email=friday@localhost', 'commit', '-q', '-m', message]);
  }
  return git(dir, ['rev-parse', 'HEAD']);
}
