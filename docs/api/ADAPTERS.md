# Foundry Adapters — Connecting Your Systems

Adapters bridge Foundry's context layers to your data sources. Each adapter implements one or more of:

- **`ContextSource`** — loads content for a layer's `warm()`
- **`HydrationAdapter`** — hydrates `ContextRef` pointers on demand
- **`signalWriter()`** — persists signals back to the system

## Built-in Adapters (zero deps)

### FileMemory

JSON files on disk. Good for local dev.

```ts
import { FileMemory } from "@foundry/agent-primitives";

const memory = new FileMemory(".foundry/memory");
await memory.load();

// Write
await memory.write({
  id: "conv-1", kind: "convention",
  content: "Use Zod for validation",
  timestamp: Date.now(),
});

// Read
memory.get("conv-1");
memory.all("convention");          // All entries of a kind
memory.search("validation");       // Substring search

// Wire to layers
layer.addSource(memory.asSource("mem-src", "convention"));

// Wire to hydration
registry.register(memory.asAdapter());  // system: "file-memory"

// Wire signals → auto-persist
signals.onAny(memory.signalWriter());
```

### SqliteMemory

SQLite with FTS5 full-text search. Uses `bun:sqlite` — zero external deps.

```ts
import { SqliteMemory } from "@foundry/agent-primitives";

const db = new SqliteMemory(".foundry/memory.db");  // or ":memory:"

// Write
db.write({
  id: "adr-1", kind: "adr",
  content: "Use Hono over Express",
  timestamp: Date.now(),
});

// Full-text search
db.search("authentication pattern");

// Structured queries
db.recent(50, "convention");
db.count("correction");

// Wire to layers
layer.addSource(db.asSource("db-src", "convention", 100));

// Wire to hydration
registry.register(db.asAdapter());  // system: "sqlite"

// Wire signals
signals.onAny(db.signalWriter());

// Cleanup
db.close();
```

### MarkdownDocs

Reads a directory of `.md` files. Caches by mtime.

```ts
import { MarkdownDocs, claudemdSource } from "@foundry/agent-primitives";

// Scan a docs directory
const docs = new MarkdownDocs("./docs", "**/*.md");

// Load all as one source (each file prefixed with path header)
layer.addSource(docs.asSource("project-docs"));

// Load a single file
layer.addSource(docs.fileSource("arch", "architecture.md"));

// Or just a CLAUDE.md
layer.addSource(claudemdSource("claude", "./CLAUDE.md"));

// Wire to hydration (locator = relative path)
registry.register(docs.asAdapter());  // system: "markdown"
// ref: { system: "markdown", locator: "docs/auth.md" }

// List available files
const files = await docs.list();
```

### HttpMemory

Generic REST adapter. Talks to any API.

```ts
import { HttpMemory } from "@foundry/agent-primitives";

// Connect to any HTTP service
const notion = new HttpMemory("https://api.notion.com/v1", {
  headers: { "Authorization": "Bearer secret_...", "Notion-Version": "2022-06-28" },
  timeout: 10_000,
});

// Use as a source — fetches on warm()
layer.addSource(notion.asSource("notion-pages", "/databases/abc/query"));

// Wire to hydration (locator = path)
registry.register(notion.asAdapter("notion"));
// ref: { system: "notion", locator: "/pages/abc123" }

// Forward signals to an external system
signals.onAny(notion.signalWriter("/api/signals"));

// Works with anything: Qdrant, Pinecone, Weaviate, MCP servers, internal tools
const vectorDb = new HttpMemory("http://localhost:6333", {
  headers: { "api-key": "..." },
});
```

### Inline and File Sources

Convenience helpers:

```ts
import { inlineSource, fileSource } from "@foundry/agent-primitives";

// Static string (testing, system prompts)
layer.addSource(inlineSource("system-prompt", "You are a helpful assistant."));

// Single file
layer.addSource(fileSource("config", "./config.yaml"));
```

---

## Optional Adapters (peer deps)

### RedisMemory

Requires: `bun add ioredis`

```ts
import Redis from "ioredis";
import { RedisMemory } from "@foundry/agent-primitives";

const redis = new Redis();
const memory = new RedisMemory(redis, "foundry:");

// Write with TTL
await memory.write({
  id: "session-1", kind: "session",
  content: "User is working on auth",
  timestamp: Date.now(),
  ttl: 3600,  // Expires in 1 hour
});

// Read
await memory.get("session-1");
await memory.recent(50, "convention");

// Wire to layers
layer.addSource(memory.asSource("redis-src", "convention"));

// Wire to hydration
registry.register(memory.asAdapter());  // system: "redis"

// Wire signals — persist to Redis
signals.onAny(memory.signalWriter(3600));  // TTL on signal entries

// Wire signals — publish to Redis pub/sub (cross-process)
signals.onAny(memory.signalPublisher("foundry:signals"));
```

---

## Writing Custom Adapters

Implement the interfaces your system needs:

### ContextSource (for layers)

```ts
const mySource: ContextSource = {
  id: "my-source",
  async load() {
    // Fetch from your system, return as string
    const data = await mySystem.fetch();
    return data.toString();
  },
};
```

### HydrationAdapter (for refs)

```ts
const myAdapter: HydrationAdapter = {
  system: "my-system",

  async hydrate(ref: ContextRef): Promise<string> {
    return mySystem.get(ref.locator);
  },

  // Optional: batch optimization
  async hydrateBatch(refs: ContextRef[]): Promise<string[]> {
    return mySystem.getMany(refs.map(r => r.locator));
  },
};
```

### Signal Writer (for writeback)

```ts
function mySignalWriter() {
  return async (signal: Signal): Promise<void> => {
    await mySystem.write({
      id: signal.id,
      type: signal.kind,
      data: signal.content,
    });
  };
}
```

---

## Wiring It Together

```ts
// 1. Create your memory systems
const sqlite = new SqliteMemory(".foundry/db.sqlite");
const docs = new MarkdownDocs("./docs");
const api = new HttpMemory("https://api.example.com");

// 2. Create hydration registry
const registry = new HydrationRegistry();
registry.register(sqlite.asAdapter());
registry.register(docs.asAdapter());
registry.register(api.asAdapter("my-api"));

// 3. Build layers with sources from different systems
const stableLayer = new ContextLayer({
  id: "stable", trust: 10,
  sources: [docs.asSource("project-docs"), claudemdSource("claude", "./CLAUDE.md")],
});

const knowledgeLayer = new ContextLayer({
  id: "knowledge", trust: 6, staleness: 300_000,
  sources: [sqlite.asSource("knowledge", "convention")],
});

const freshLayer = new ContextLayer({
  id: "fresh", trust: 2, staleness: 30_000,
  sources: [sqlite.asSource("recent", undefined, 20)],
});

// 4. Stack and warm
const stack = new ContextStack([stableLayer, knowledgeLayer, freshLayer]);
await stack.warmAll();

// 5. Wire signals back to memory
const signals = new SignalBus();
signals.on("correction", sqlite.signalWriter());
signals.on("convention", sqlite.signalWriter());

// Now agents read from layers, produce signals, and those signals
// flow back into the memory systems that feed the layers.
```
