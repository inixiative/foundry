# Tests: Foundry

- Tests replay real recordings (`packages/foundry/src/vcr`). `bun run test:live` is the truth. Run it whenever a CLI, `@inixiative/agent-session` or a transport changes, and treat drift as a bug. [foundry CLAUDE.md]
- Cassettes go stale on every Claude CLI auto-update, which turns `vcr-freshness` red. Re-record them (nightly `vcr:refresh`); don't skip the check. [COORDINATION follow-up]
- Run `test:browser` alongside the full check for viewer changes.
- Live tests need the lid open or AC power.
