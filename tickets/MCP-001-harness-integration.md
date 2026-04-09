# MCP-001: MCP Server Harness Integration (Loop 2 Last Mile)

**Status**: 🆕 Not Started
**Assignee**: TBD
**Priority**: High
**Created**: 2026-04-09
**Updated**: 2026-04-09

---

## Overview

The MCP server (`mcp/server.ts`) works standalone via `mcp/cli.ts` — Claude Code spawns it as a subprocess and the 5 tools query warm layer caches. But it doesn't run alongside the live harness. This means:

- **Standalone mode**: MCP server builds its own thread from config, has its own layer caches. It can't see the harness's live thread state, signals, or session manager.
- **Integrated mode (missing)**: MCP server runs inside the viewer process, sharing the harness's thread, signal bus, and session manager. This is the real Loop 2 — mid-session context pull from live state.

## Key Gap

The `McpSettingsConfig` and API routes (`/api/mcp/*`) are built. The missing wiring:

1. **SSE transport in viewer**: When `transport: "sse"`, `startViewer()` should start the MCP server embedded in the Hono app, exposing `/mcp` SSE endpoints. The MCP server gets the harness's live thread, not a standalone one.
2. **Shared state**: Embedded MCP server uses the same `thread`, `signals`, and `sessionManager` as the harness — queries return live state, signals feed directly into the Librarian.
3. **Viewer startup wiring**: `start.ts` or `startViewer()` should check `config.mcp?.enabled && config.mcp?.transport === "sse"` and wire the embedded MCP server.

## Architecture

```
Standalone (stdio — works today):
  Claude Code ──stdin/stdout──→ mcp/cli.ts ──→ own Thread + layers

Integrated (SSE — not wired):
  Claude Code ──HTTP/SSE──→ viewer:4400/mcp ──→ harness Thread + live signals
                                                  │
                                                  ├─ Shares signal bus with Librarian
                                                  ├─ Sees session manager (all threads)
                                                  └─ foundry_signal feeds live guards
```

## Tasks

- [ ] Add `/mcp` SSE route group in viewer server when `mcp.transport === "sse"`
- [ ] Pass harness thread + session manager to `createFoundryMcpServer()` in viewer startup
- [ ] Generate `.mcp.json` pointing to SSE endpoint (not CLI) when transport is SSE
- [ ] Test: `foundry_query` returns live layer content from harness thread
- [ ] Test: `foundry_signal` emits into live signal bus (Librarian receives it)
- [ ] Test: `foundry_threads` shows all active threads from session manager

## Definition of Done

- [ ] With `transport: "sse"`, MCP tools query the live harness thread
- [ ] `foundry_signal` emissions reach the Librarian and update thread-state
- [ ] `foundry_threads` returns live thread summaries from session manager
- [ ] Standalone stdio mode still works unchanged

## Related

- **Depends on**: MCP server (`mcp/server.ts`) — done
- **Depends on**: MCP settings/routes (`/api/mcp/*`) — done
- **Depends on**: Librarian (signal reconciliation) — done
- **Blocks**: Full Loop 2 (mid-session bridge with live state)
- **Reference**: `docs/FLOW.md` Loop 2, Channel 2

---

_High priority. Standalone stdio works for basic context, but the real value is live state sharing._
