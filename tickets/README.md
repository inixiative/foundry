# Tickets

Foundry task tracking using Mermaid kanban boards and markdown tickets.

## Structure

```
tickets/
├── README.md                              # This file
├── kanban-backlog.md                      # Backlog kanban board
├── {CATEGORY}-{NUM}-{slug}.md             # Individual ticket files
```

## Kanban Boards

- [Backlog Board](./kanban-backlog.md) - Future work (unassigned)

## Ticket Format

Tickets use the naming convention: `{CATEGORY}-{NUM}-{slug}.md`

### Categories

- **AGENT** - Agent architecture, orchestration, signals
- **MCP** - MCP server, tools, transport
- **VIEWER** - Viewer UI, routes, WebSocket
- **CORE** - Core primitives (thread, harness, layers, signals)
- **INFRA** - Infrastructure, deployment, CI/CD
- **BUG** - Bug fixes
- **FEAT** - New features
