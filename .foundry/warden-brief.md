# Foundry, for its Wardens

Foundry is a local harness around native coding agents. A person works in a thread; the thread's
worker is a real Claude Code, Codex or Muse Code session on their own subscription (the Artificer).
Foundry wraps it with context, memory and a chorus of Wardens, and keeps a journal of every turn.
It runs as a daemon on the person's machine with a web viewer (port 4500 on this machine), and
hosts reach it over ACP.

## Shape of the repository

- `packages/core` (`@inixiative/foundry-core`): primitives only, no opinions: context layers and
  stacks, threads, the harness, the signal bus, middleware, token tracking, the model registry.
- `packages/foundry` (`@inixiative/foundry`): everything opinionated: agents (Cartographer, region
  Wardens, Librarian), providers over `@inixiative/agent-session`, turns, the tool gate,
  conversations, Kingdom and Archive clients, the viewer, settings.
- `packages/acp` (`@inixiative/foundry-acp`): the ACP agent hosts drive; it only calls the daemon.
- `scripts/evals`: eval runners for the chorus; Oracle (a separate repo) owns scoring and fixtures.

## Words used here

- **Thread**: a conversation with one worker; subagents are child threads under it. **Turn**: one
  message and the work it causes, journalled in SQLite.
- **Chorus**: a project's Wardens, one per concept region of its docs (`.foundry/regions/<id>/`).
  Layer 1 (Haiku) detects, Layer 2 (Sonnet) confirms and picks.
- **Composition view**: the ladder that composes instructions and knowledge for each role.
- **Kingdom**: the hosted identity and permission hub. A **Signet** is the grant to use an
  integration. **Archive**: where sessions are captured.
- **Settings**: `.foundry/settings.json` per install, `.foundry/project.json` per repository.

## What a moment here usually is

Someone is changing how a thread runs, how context reaches a native session, how Wardens are
composed or called, a provider or login path, the viewer, or settings. Most of these already have
one owning module and one documented setting; new behaviour is usually a setting or an extension of
that module, not a new system.
