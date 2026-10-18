# Mission benchmark

*No results yet.* Run it with `node scripts/bench-missions.js` (it spends real plan usage:
four tasks, each run once as a FRIDAY mission and once as a single Claude Code turn). This
page is then rewritten with the results, losses included.

The tasks are in `bench/missions/`: a new CLI from a spec, a bug fix and a feature in
seeded repos, and a researched recommendation. Each has a hidden acceptance check that
neither approach sees; `node scripts/bench-missions.js --check` (also part of `npm test`)
proves each check fails on the starting code and passes on a reference solution.
