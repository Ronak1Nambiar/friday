// Git for a mission's parallel build parts (the Parallel Code / Claude Squad pattern):
// each part gets its own branch and worktree, so agents never write over each other;
// the branches are then merged into the mission folder one by one. No UI here.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { commitAll } from './design.js';

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }).trim();
}
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// The mission folder as its own repo with at least one commit. A folder inside some
// other repo gets a repo of its own, so the parts never branch the parent project.
export function ensureRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  let top = null;
  try { top = git(dir, ['rev-parse', '--show-toplevel']); } catch {}
  if (!top || !same(top, dir)) git(dir, ['init', '-q']);
  let head = true;
  try { git(dir, ['rev-parse', '--verify', 'HEAD']); } catch { head = false; }
  if (!head) {
    git(dir, ['add', '-A']);
    try { git(dir, ['commit', '-q', '--allow-empty', '-m', 'FRIDAY mission: start']); } catch {
      git(dir, ['-c', 'user.name=FRIDAY', '-c', 'user.email=friday@localhost', 'commit', '-q', '--allow-empty', '-m', 'FRIDAY mission: start']);
    }
  } else commitAll(dir, 'FRIDAY mission: before the parallel build');
  return git(dir, ['rev-parse', 'HEAD']);
}

// One worktree per part, on friday-mission/<slug>/<part>, outside the mission folder.
export function partWorktree(dir, slug, partId, root) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  const branch = `friday-mission/${slug}/${partId}-${stamp}`;
  const wt = path.join(root, `${slug}-${partId}-${stamp}`);
  fs.mkdirSync(root, { recursive: true });
  git(dir, ['worktree', 'add', '-q', '-b', branch, wt, 'HEAD']);
  return { branch, dir: wt };
}

// The files a part changed that it does not own (its prompt said not to). Build and
// test artifacts (a test run's __pycache__, say) are not the agent's doing.
const ARTIFACT = /(^|\/)(__pycache__|\.pytest_cache|node_modules|\.mypy_cache|\.ruff_cache)\/|\.py[co]$/;
export function outsideOwned(wtDir, owns, base) {
  const changed = git(wtDir, ['diff', '--name-only', base, 'HEAD']).split('\n').filter(Boolean);
  return changed.filter((f) => !ARTIFACT.test(f) && !owns.some((o) => f === o || f.startsWith(`${o}/`)));
}

// Merge the part branches into the mission folder in order. On a conflict, resolve(files)
// gets one chance (an agent edits the conflict markers away); then the merge is
// committed, or aborted and the rest reported.
export async function mergeParts(dir, branches, resolve = async () => false) {
  const merged = [];
  for (const branch of branches) {
    try {
      git(dir, ['merge', '--no-ff', '-q', '-m', `FRIDAY mission: merge ${branch}`, branch]);
      merged.push(branch);
      continue;
    } catch {}
    const conflicts = git(dir, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
    const fixed = conflicts.length && (await resolve(conflicts, branch));
    const left = fixed ? conflicts.filter((f) => /^(<<<<<<<|>>>>>>>)/m.test(fs.readFileSync(path.join(dir, f), 'utf8'))) : conflicts;
    if (fixed && !left.length) { commitAll(dir, `FRIDAY mission: merge ${branch} (conflicts resolved)`); merged.push(branch); continue; }
    try { git(dir, ['merge', '--abort']); } catch {}
    return { ok: false, merged, failed: branch, conflicts: left.length ? left : conflicts };
  }
  return { ok: true, merged };
}

// Worktrees go; branches stay, so every part's work can still be looked at.
export function removeWorktree(dir, wt) {
  try { git(dir, ['worktree', 'remove', '--force', wt]); } catch { fs.rmSync(wt, { recursive: true, force: true }); try { git(dir, ['worktree', 'prune']); } catch {} }
}

// A mission's build goes on its own branch, friday/<slug>, never on the branch the
// folder was on. A new folder becomes a repo with a first commit. An existing repo
// with uncommitted changes is left alone: the mission pauses until they are committed
// or stashed, so nobody's work ends up in a FRIDAY commit. A resume that is already
// on one of this mission's branches stays there.
export function missionBranch(dir, slug) {
  fs.mkdirSync(dir, { recursive: true });
  let top = null;
  try { top = git(dir, ['rev-parse', '--show-toplevel']); } catch {}
  let head = true;
  if (top && same(top, dir)) {
    try { git(dir, ['rev-parse', '--verify', 'HEAD']); } catch { head = false; }
  }
  if (!top || !same(top, dir) || !head) {
    ensureRepo(dir);
  } else if (git(dir, ['status', '--porcelain'])) {
    return { error: `${dir} has uncommitted changes; commit or stash them, then /mission resume` };
  }
  const name = `friday/${slug}`;
  const current = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (current === name || current.startsWith(`${name}-`)) return { branch: current, base: null };
  const taken = new Set(git(dir, ['branch', '--list', `${name}*`, '--format=%(refname:short)']).split('\n').filter(Boolean));
  let branch = name;
  for (let i = 2; taken.has(branch); i++) branch = `${name}-${i}`;
  git(dir, ['checkout', '-q', '-b', branch]);
  return { branch, base: current };
}

// Somewhere to open a pull request: an `origin` remote and the gh CLI.
export function hasRemote(dir) {
  try { return !!git(dir, ['remote', 'get-url', 'origin']); } catch { return false; }
}

// Push the mission's branch and open a PR with gh. `run(file, args, cwd)` runs a
// program and returns its stdout (injected, so tests never call gh or push).
export function openPr(dir, { branch, title, body }, run) {
  run('git', ['-C', dir, 'push', '-u', 'origin', branch], dir);
  const out = run('gh', ['pr', 'create', '--head', branch, '--title', title, '--body', body], dir);
  return (String(out).match(/https?:\/\/\S+/) || [String(out).trim()])[0];
}
