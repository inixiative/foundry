# Hivemind V2 — Requirements

*Draft. March 2026.*

Hivemind v1 proved the coordination concept. V2 is a ground-up rebuild with the lessons from v1 and the requirements of Foundry's multi-agent architecture.

---

## Why V2

V1 is SQLite-backed and local-only. That works for a single developer running a few agents. It breaks under:

- **Concurrent writes** — multiple implementer agents writing simultaneously causes lock contention
- **Network agents** — v1 is stdio/PID-based; agents on different machines or in containers can't participate
- **Team coordination** — no hosted mode means each developer has their own isolated Hivemind, defeating the purpose
- **Foundry's per-run isolation** — Foundry spins up multiple agents per run; v1 handles this but not gracefully

V2 must be a proper service, not a local file.

---

## Core Requirements

### 1. Storage Backend
V1 uses SQLite. V2 needs a storage layer that handles concurrent writes, network access, and — critically — the right primitives for what Hivemind actually stores.

**What Hivemind stores:**
- Agent registration and lifecycle (structured, relational)
- Events (append-only log, high write volume)
- Plans and tasks (structured, relational, queried frequently)
- Interaction signals for the Librarian (semi-structured, needs classification metadata)
- Corpus knowledge (the thing that makes Hivemind useful long-term — needs semantic retrieval)

**The storage question is open.** Options under consideration:

| Option | Strengths | Weaknesses |
|--------|-----------|------------|
| **Postgres** | Reliable, concurrent, relational — good for agents/events/plans/tasks | Poor semantic retrieval without pgvector; still needs a memory layer |
| **Redis** | Fast, pub/sub for real-time coordination, good for ephemeral state | Not a good primary store for durable knowledge |
| **Neo4j / graph DB** | Natural fit for knowledge graphs — corpus relationships, decision chains, concept links | Operational overhead; may be overkill for v2 |
| **Vector DB (Qdrant, Weaviate, pgvector)** | Semantic retrieval for corpus knowledge | Not a coordination primitive; needs a relational layer alongside it |
| **Hybrid** | Right tool for each layer — e.g. Postgres for coordination + vector for knowledge | More moving parts, more to operate |

**Decision: research before committing.** The storage choice shapes the entire architecture. Key questions to answer before deciding:

- Does the Librarian need semantic similarity search over captured signals? (If yes, vector is load-bearing)
- How graph-like is the knowledge structure? (Decisions link to evidence, conventions link to corrections, skills link to fixtures — this is a graph)
- What's the operational burden for a small team? (Neo4j in production is non-trivial)
- Does MuninnDB already solve the knowledge layer? (If so, Hivemind v2 might only need Postgres + Redis)

See the **Research** section below.

### 2. Docker Compose First
V2 ships with a `docker-compose.yml` that spins up the full coordination stack locally. No manual setup. `docker compose up` and it works.

```yaml
# Target shape (not final — depends on storage decision)
services:
  hivemind:       # coordination API
  storage:        # primary store (TBD)
  vector:         # optional semantic layer (TBD)
```

### 3. Hosting Helpers for Teams
V2 needs a path from local to hosted that a small team can follow without DevOps expertise.

- Railway one-click deploy (like the template's init script pattern)
- Environment variable provisioning (connection strings auto-injected)
- Multi-tenant from the start — projects are isolated, agents are scoped

### 4. Lower Friction Setup
V1 setup requires `claude mcp add` and manual config. V2 should work like the template's `bun run setup`:

- Single command initializes everything
- MCP registration happens automatically
- Sensible defaults, minimal required config

### 5. Better Base Skillsets
V1 has minimal built-in skills. V2 ships with a baseline corpus that works out of the box:

- Coordination skills (how to emit, query, claim tasks)
- Librarian integration (how to submit signals for classification)
- Cartographer integration (how to request context slices)

### 6. Repo-Aware Context
V1 is generic — it knows agents exist but nothing about what they're working on. V2 needs repository awareness:

- Which files are in play for a given agent
- What conventions apply to this repo
- What decisions have been made about this codebase

This is where Hivemind v2 connects to Foundry's corpus layer.

### 7. Native MuninnDB Integration
V1 is standalone. V2 treats MuninnDB as its memory backend:

- Ephemeral coordination state lives in Hivemind (who's doing what right now)
- Durable knowledge lives in MuninnDB (what we've learned, what we've decided)
- Hivemind writes to MuninnDB when signals should persist beyond the session
- MuninnDB is queryable by agents without going through Hivemind

### 8. Foundry Integration
V2 is the coordination layer Foundry's evaluation runs depend on:

- Per-run agent isolation with role-scoped channels
- Implementer / Subject / Oracle can communicate without seeing each other's context
- Run telemetry flows back into Foundry's scoring pipeline
- Fixture signals captured during runs feed the Librarian automatically

---

## What Stays from V1

- **PID-based lifecycle** for local agents — no heartbeats needed when you can check if a process is alive
- **Event-based communication** — agents emit, others query; no direct messaging
- **Plans as living docs** — plans don't auto-complete, they persist as context
- **ID format** — `{prefix}_{hex}[_{label}]` is clean, keep it
- **MCP interface** — agents talk to Hivemind through MCP tools; this stays

---

## Research Required

Before committing to the storage architecture, investigate:

### Graph DBs
- **Neo4j** — mature, powerful, expensive to operate. Cypher query language. Good for knowledge graphs with complex relationship traversal. Overkill if the graph structure is shallow.
- **Memgraph** — Neo4j-compatible, faster, more operationally friendly. Worth evaluating as an alternative.
- **FalkorDB** — Redis-compatible graph DB. Could combine the Redis pub/sub primitives with graph storage in one service.

### Vector DBs
- **pgvector** — Postgres extension. Keeps the stack simple if Postgres is already the primary store. Good enough for most semantic retrieval use cases.
- **Qdrant** — Purpose-built, fast, good Bun/TS client. Worth evaluating if semantic retrieval is a first-class requirement.
- **Weaviate** — Combines vector + keyword + graph. Potentially the right unified layer if the knowledge structure is complex enough.

### Hybrid Approaches
- **Postgres + pgvector** — relational coordination + semantic retrieval in one service. Lowest operational overhead.
- **Postgres + Redis + pgvector** — adds pub/sub and caching. More parts, but each is proven.
- **Postgres + Qdrant** — relational coordination + dedicated vector store. Clean separation of concerns.

### Key Questions for Research
1. Is the corpus knowledge structure fundamentally a graph? (Decisions → evidence → corrections → fixtures — trace this and see how deep the relationships go)
2. Does semantic similarity search over captured signals actually improve Librarian classification? Or is keyword search good enough?
3. What's the minimum storage stack that handles Foundry's evaluation runs at scale? (How many concurrent agents, how many events per run?)
4. Does MuninnDB's existing storage (it already has vector + BM25 + Hebbian associations) make a separate vector layer redundant?

---

## Build Sequence (tentative, pending research)

1. Storage decision — research and commit
2. Docker Compose with chosen stack
3. Postgres schema for coordination (agents, events, plans, tasks)
4. MCP tools migrated from v1
5. MuninnDB integration layer
6. Railway hosting scripts
7. Base skillset
8. Foundry integration hooks
9. Repo-aware context layer
10. Cartographer / Librarian integration

---

*Storage architecture is the critical path decision. Everything else follows from it. Do the research first.*
