# Boundary (architecture): Foundry

- **Core vs foundry is strict.** `@inixiative/foundry-core` holds primitives and pure data (ContextLayer, Thread, SignalBus, model registry, hierarchy composer, correction detection), with no opinions, adapters or external services. Anything that decides *how* to use them belongs in `@inixiative/foundry`. [foundry CLAUDE.md]
- **Foundry is the harness.** It speaks ACP upward to any client (Paseo, T3 Code, Zed). Middleware runs in our harness, never in vendor hooks. The viewer doesn't grow runner features the host already has: worktrees, diffs, checkpoints. [org CLAUDE.md 10-11]
- **Run real native sessions** (Claude Code/Codex) through agent-session, never one-shot `claude -p`. Subscription-only by default; paid API only with `apiTokens: true`. [×11 · ↻5 · 2026-04-09→09-24 · REC]
- **All Claude for now:** Haiku 5.5 for decisions (Cartographer, Wardens, classifiers), Opus 5.5 or Fable 5.1 for heavy reasoning. The model is a setting. Configure it per agent, not through global defaults. [×6 · ↻2 · org CLAUDE.md 10-11]
- **Wardens are config-driven** chorus members. They comment, never block; only structural rules block. They're fresh each call. They own no layers: knowledge comes from the composition view. [foundry CLAUDE.md · org CLAUDE.md 10-12]
- Access follows the host: honour the mode the user chose in Claude/Codex/T3/Paseo, full access included. [org CLAUDE.md]
- Oracle machinery stays out of Foundry; Foundry exports artifacts. [org CLAUDE.md]
