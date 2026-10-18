// What FRIDAY can do, shown at startup and by /abilities. Each ability says what it
// needs; one that cannot run right now is shown dimmed with the reason.

export const ABILITIES = [
  { name: 'Just ask', what: 'the brain sends it to the right AI', try: 'why do the tests fail?', needs: { agents: 1 } },
  { name: 'Missions', what: 'research → build → test → fix, you approve', try: '/mission build a CLI that …', needs: { agents: 1, brain: true } },
  { name: 'Council', what: 'every AI answers; /relay gets a check', try: '/all which database fits?', needs: { agents: 2 } },
  { name: 'Projects', what: 'agents move there; the HUD maps the repo', try: "how's my-app going", needs: {} },
  { name: 'Second brain', what: 'every AI works from your vault', try: 'what did I decide on pricing?', needs: { vault: true } },
  { name: 'Change FRIDAY', what: 'it edits itself live; /undo-self reverts', try: 'tell codex to be terse from now on', needs: { agents: 1 } },
  { name: 'Private', what: 'sealed projects never reach a cloud AI', try: '@ollama …', needs: {} },
  { name: 'Pick up later', what: 'past chats and paused missions', try: '/resume · /mission resume', needs: {} },
];

// Why an ability cannot run now, or null.
export function unavailable(ability, { agents = 0, ollama = false, brain = ollama, vault = false } = {}) {
  const n = ability.needs;
  if (n.agents && agents < n.agents) return n.agents > 1 ? `needs ${n.agents} AIs ready` : 'no AI ready';
  if (n.ollama && !ollama) return 'start Ollama';
  if (n.brain && !brain) return 'friday login, or start Ollama';
  if (n.vault && !vault) return 'no vault configured';
  return null;
}

// Three columns (name, what, example or why not), fitted to the terminal width; the
// example column is dropped when it does not fit. style: { name, dim, warn } painters.
export function abilityLines(state, { width = 100, style = {} } = {}) {
  const name = style.name || ((s) => s);
  const dim = style.dim || ((s) => s);
  const warn = style.warn || ((s) => s);
  const fit = (s, n) => (n < 2 ? '' : s.length > n ? s.slice(0, n - 1) + '…' : s);
  const W = Math.max(40, width) - 1;
  const c1 = Math.max(...ABILITIES.map((a) => a.name.length)) + 2;
  const c2 = Math.max(...ABILITIES.map((a) => a.what.length)) + 2;
  const room = W - 2 - c1 - c2;
  return ABILITIES.map((a) => {
    const off = unavailable(a, state) && `(${unavailable(a, state)})`;
    // The reason something is off always shows, even when the description must shrink.
    if (room < Math.max(12, off ? off.length : 0)) {
      if (!off) return `  ${name(a.name.padEnd(c1))}${fit(a.what, W - 2 - c1)}`;
      return `  ${dim(a.name.padEnd(c1))}${dim(fit(a.what, W - 3 - c1 - off.length))} ${warn(off)}`;
    }
    if (off) return `  ${dim(a.name.padEnd(c1))}${dim(a.what.padEnd(c2))}${warn(off)}`;
    return `  ${name(a.name.padEnd(c1))}${a.what.padEnd(c2)}${dim(fit(a.try, room))}`;
  });
}
