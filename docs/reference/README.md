# Reference runners

Outside agent runners we study and may run in front of. Read-only clones live next to the repos: `~/code/paseo`, `~/code/t3`. Pull before comparing.

| Doc | What |
|---|---|
| [PASEO.md](PASEO.md) | getpaseo/paseo @1939ee79e (Apache-2.0): architecture map, features A–M, integration seams |
| [T3CODE.md](T3CODE.md) | pingdotgg/t3code @f23d0084b6 (MIT): same structure, plus changes since 2026-09-23 |
| [INIXIATIVE.md](INIXIATIVE.md) | Our stack (agent-session, Foundry, foundry-core, Kingdom pairing, Oracle, Archive) on the same A–M axes, as of 2026-10-11 — predates ACP slices 1 and 2; read its "Updated since" section first |
| [COMPARISON.md](COMPARISON.md) | Side-by-side matrix, adopt list, use-instead verdicts, what is uniquely ours (2026-10-11 snapshot; predates ACP slices 1 and 2) |
| [FOUNDRY-ACP.md](FOUNDRY-ACP.md) | Accepted spec: headless Foundry over ACP, so Paseo, T3 and Zed drive Foundry as an agent (supersedes the rejected hook-based middleware adapter) |
| [SUBAGENTS.md](SUBAGENTS.md) | **Proposal, needs Aron's yes:** subagents wrapped (Foundry-owned `foundry_delegate` child threads with their own composition, middleware and journal) and inspectable (handoff rows, live tree, Archive/Oracle queries for handoff sufficiency) |

Snapshots dated 2026-10-11; code moves, so re-verify a claim before building on it.
