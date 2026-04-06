# Foundry Primitives — API Reference

Foundry is a context management layer for AI agents. It manages what agents know — layered, observable, with feedback flowing back into the system.

Bring your own agents, harness, memory systems, and docs. Foundry provides the context topology underneath.

## Core Concepts

**Context Layers** are independently managed caches. Each has its own sources, staleness, trust level, and lifecycle. Agents don't see raw sources — they see merged, filtered slices of the layer stack.

**Agents** come in two modes:
- **Executors** take context + payload, do work, return full results
- **Deciders** take context + payload, return only a slim decision — the context stays behind

**Classifiers** and **Routers** are Deciders. They have pre-warmed context (taxonomy, topology) and return lightweight decisions without leaking that context to callers.

**Traces** record every message's full journey through the system. Every stage is a span with input, output, timing, and which layers were visible.

**Signals** are typed side-channel information (corrections, conventions, taste) that flow back into context layers via the signal bus.

---

## ContextLayer

A single cache tier. Configure it — don't subclass it.

```ts
import { ContextLayer } from "@foundry/agent-primitives";

const layer = new ContextLayer({
  id: "conventions",
  trust: 8,              // higher = compressed last, relative ordering
  staleness: 60_000,     // ms before layer is considered stale (undefined = never)
  maxTokens: 4000,       // budget hint (undefined = unbounded)
  sources: [source1, source2], // ContextSource[] — loaded in order on warm()
});
```

### Lifecycle

```ts
await layer.warm();      // Load from sources. Re-entrant safe — concurrent calls coalesce.
layer.set("content");    // Replace content directly (e.g. after compression).
layer.invalidate();      // Mark stale — forces re-warm on next access.
layer.clear();           // Reset to cold.
layer.checkStaleness();  // Explicitly check if staleness threshold exceeded.
```

### State: `"cold" | "warming" | "warm" | "stale" | "compressing"`

```ts
layer.state       // Current state (read-only, no side effects)
layer.isWarm      // true if state === "warm"
layer.isStale     // true if stale (checks staleness threshold)
layer.content     // Current content string
layer.hash        // Content hash (16-char hex)
layer.trust       // Trust level
layer.lastWarmed  // Timestamp or null
```

### Observation

```ts
const unsub = layer.onStateChange((state, layer) => {
  console.log(`${layer.id} → ${state}`);
});
unsub(); // cleanup
```

### ContextSource

Anything that returns a string. Used by layers.

```ts
interface ContextSource {
  readonly id: string;
  load(): Promise<string>;
}
```

---

## ContextStack

Ordered composition of layers.

```ts
import { ContextStack } from "@foundry/agent-primitives";

const stack = new ContextStack([docsLayer, memoryLayer], compressor);
```

### Layer Management

```ts
stack.addLayer(layer, position?)   // Add at position (default: end)
stack.removeLayer("id")            // Remove by id
stack.getLayer("id")               // Get by id
stack.reorder(["id1", "id2"])      // Reorder (unmentioned layers appended)
stack.layers                       // ReadonlyArray<ContextLayer>
```

### Warming

```ts
await stack.warmAll()   // Warm all cold/stale layers in parallel
await stack.refresh()   // Re-warm only stale layers
```

### Merging and Slicing

```ts
stack.merge()                           // All warm layers, concatenated
stack.merge(filter)                     // Only layers matching predicate
stack.slice(layer => layer.trust > 5)   // Same as merge(filter)
stack.sliceByIds("docs", "conventions") // By specific layer ids
```

### Compression

```ts
stack.setCompressor(compressor);
await stack.compress(targetTokens, ratio?);    // Compress lowest-trust first
await stack.compressLayer("id", ratio?);       // Compress specific layer
stack.estimateTokens();                        // Rough ~4 chars/token estimate

interface Compressor {
  compress(content: string, targetRatio: number): Promise<string>;
}
```

### Snapshots

```ts
const snap = stack.snapshot();
// { hash, content, layerHashes: Record<id, hash>, timestamp }
```

---

## Agents

### BaseAgent (abstract)

```ts
abstract class BaseAgent<TPayload, TResult> {
  readonly id: string;

  getContext(): string;               // Merged content from visible layers
  getContextHash(): string;           // Hash of current context

  abstract run(
    payload: TPayload,
    filterOverride?: LayerFilter      // Per-dispatch context scoping
  ): Promise<ExecutionResult<TResult>>;

  setLayerFilter(filter: LayerFilter): void;
  setStack(stack: ContextStack): void;
}
```

### ExecutionResult

Every agent run returns this:

```ts
interface ExecutionResult<T> {
  readonly output: T;
  readonly contextHash: string;
  readonly tokens?: { input: number; output: number };
  readonly meta?: Record<string, unknown>;
}
```

### Executor

Context + payload in, full results out.

```ts
import { Executor } from "@foundry/agent-primitives";

const worker = new Executor({
  id: "code-writer",
  stack,
  layerFilter: (l) => l.trust > 5,
  handler: async (context, payload) => {
    // context = merged string from visible layers
    // payload = whatever the caller sent
    return "full results here";
  },
});

const result = await worker.run("write a function");
// result.output = "full results here"
```

### Decider

Context + payload in, slim decision out. Context stays behind.

```ts
import { Decider, type Decision } from "@foundry/agent-primitives";

const decider = new Decider({
  id: "priority-checker",
  stack,
  handler: async (context, payload) => {
    return {
      value: "high",         // The decision
      confidence: 0.9,       // 0-1
      reasoning: "matches P0 pattern",  // Brief, not the full context
    } satisfies Decision<string>;
  },
});
```

### Classifier

Decider that returns a category.

```ts
import { Classifier, type Classification } from "@foundry/agent-primitives";

const classifier = new Classifier({
  id: "signal-classifier",
  stack,  // Pre-warmed with taxonomy
  handler: async (context, payload) => ({
    value: {
      category: "convention",
      subcategory: "naming",
      tags: ["style", "typescript"],
    } satisfies Classification,
    confidence: 0.85,
  }),
});
```

### Router

Decider that returns a destination.

```ts
import { Router, type Route } from "@foundry/agent-primitives";

const router = new Router({
  id: "task-router",
  stack,  // Pre-warmed with topology map
  handler: async (context, payload) => ({
    value: {
      destination: "executor-auth",    // Agent or thread to send to
      priority: 10,
      contextSlice: ["docs", "auth"],  // Which layers the destination should see
    } satisfies Route,
    confidence: 0.9,
  }),
});
```

---

## Middleware

Before/after hooks on every dispatch. Two tiers.

```ts
import { MiddlewareChain } from "@foundry/agent-primitives";

const chain = new MiddlewareChain();

// Always-on: runs on every dispatch
chain.use("logger", async (ctx, next) => {
  console.log(`dispatching to ${ctx.agentId}`);
  const result = await next();
  console.log(`done: ${result.contextHash}`);
  return result;
});

// Conditional: runs only when predicate matches
chain.useWhen(
  "expensive-guard",
  (ctx) => ctx.annotations.category === "security",
  async (ctx, next) => {
    // Heavy validation only for security-related dispatches
    const result = await next();
    return result;
  }
);
```

### DispatchContext

Available in middleware:

```ts
interface DispatchContext<TPayload> {
  readonly agentId: string;
  readonly payload: TPayload;
  readonly timestamp: number;
  annotations: Record<string, unknown>;  // Mutable — middleware can annotate
}
```

---

## Signals

Typed pub/sub for side-channel information.

```ts
import { SignalBus, type Signal } from "@foundry/agent-primitives";

const signals = new SignalBus(maxHistory?);

// Subscribe to specific kinds
signals.on("correction", async (signal) => {
  await memory.write(signal);
});

// Subscribe to everything
signals.onAny(async (signal) => { ... });

// Emit
await signals.emit({
  id: "sig-1",
  kind: "correction",       // "correction" | "convention" | "taste" | "ci_rule" | "adr" | "security" | string
  source: "operator:aron",
  content: { actual: "X", correction: "Y" },
  confidence: 1.0,
  timestamp: Date.now(),
});

// Query history
signals.recent("correction", 20);
```

---

## Traces

Full journey record of a message through the system.

```ts
import { Trace, type Span } from "@foundry/agent-primitives";

const trace = new Trace("msg-1");

// Start spans (nested — child of current)
trace.start("classify", "classify", {
  agentId: "classifier",
  input: payload,
  layerIds: ["docs", "taxonomy"],
});

// End current span
trace.end(output);

// Finish entire trace
trace.finish();

// Inspect
trace.root           // Root span with children
trace.spans          // Flat list, sorted by start time
trace.summary()      // { traceId, messageId, totalDurationMs, spanCount, stages[] }
trace.current        // Currently active span
trace.depth          // Nesting depth
```

### Span

```ts
interface Span {
  readonly id: string;
  readonly parentId?: string;
  readonly name: string;
  readonly kind: SpanKind;  // "ingress" | "classify" | "route" | "dispatch" | "execute" | "decide" | "middleware" | "writeback" | "egress" | "fan" | string
  readonly agentId?: string;
  readonly threadId?: string;
  readonly layerIds?: string[];
  readonly contextHash?: string;
  readonly input?: unknown;
  output?: unknown;
  status: SpanStatus;  // "running" | "ok" | "error"
  error?: unknown;
  annotations: Record<string, unknown>;
  children: Span[];
  readonly startedAt: number;
  endedAt?: number;
  durationMs?: number;
}
```

---

## Hydration

Reference-based context loading. Pass pointers, not content.

```ts
import { HydrationRegistry, RefSource, type ContextRef } from "@foundry/agent-primitives";

const registry = new HydrationRegistry();
registry.register(memory.asAdapter());  // "sqlite" system
registry.register(docs.asAdapter());    // "markdown" system

// Create refs — pointers into your systems
const refs: ContextRef[] = [
  { system: "sqlite", locator: "conv-1" },
  { system: "markdown", locator: "docs/auth.md" },
];

// Hydrate on demand
const content = await registry.hydrateAll(refs);

// Or use as a ContextSource on a layer
const source = new RefSource("auth-context", refs, registry);
layer.addSource(source);
```

---

## Thread

Orchestrator. Owns stack, agents, middleware, signals.

```ts
import { Thread } from "@foundry/agent-primitives";

const thread = new Thread("main", stack, {
  description: "Main conversation",
  tags: ["feature-auth"],
  maxDispatches: 10000,
});

thread.register(classifier);
thread.register(router);
thread.register(executor);

// Dispatch (runs through middleware chain)
const result = await thread.dispatch("classifier", payload, filterOverride?);

// Fan out (allSettled — partial failures don't kill the rest)
const results = await thread.fan(["agent-1", "agent-2"], payload);
// returns FanResult[] with { agentId, status: "fulfilled"|"rejected", result?, error? }

// Metadata
thread.describe("Working on auth refactor");
thread.tag("auth", "security");
thread.archive();

thread.meta  // { description, tags, status, createdAt, lastActiveAt }
```

---

## Harness

Entry point. Classify → route → dispatch, auto-traced.

```ts
import { Harness } from "@foundry/agent-primitives";

const harness = new Harness(thread, { maxTraces: 1000 });
harness.setClassifier("classifier");
harness.setRouter("router");
harness.setDefaultExecutor("executor-answer");

const result = await harness.send({
  id: "msg-1",
  payload: "Fix the auth bug",
});

// result.classification  — what the classifier decided
// result.route           — where the router sent it
// result.result          — the executor's output
// result.trace           — full Trace object, drillable

// Direct dispatch (bypass classify/route)
await harness.dispatch("executor-fix", payload);

// Trace history
harness.traces                           // all traces
harness.getTrace("trace-id")             // by trace id
harness.getTraceForMessage("msg-1")      // by message id
```

---

## Sessions

Lazy thread resolution. Router says "send to X" — if X doesn't exist, it's created.

```ts
import { SessionManager } from "@foundry/agent-primitives";

const sessions = new SessionManager();
sessions.add(mainThread);

// Register blueprints for lazy creation
sessions.addBlueprint({
  match: /^feature-.*/,  // String or RegExp
  async create(destinationId, parent) {
    const childStack = SessionManager.inheritLayers(parent!, {
      share: ["docs"],          // Same layer instance
      copy: ["conventions"],    // Snapshot copy
    });
    const child = new Thread(destinationId, childStack, {
      description: `Feature thread: ${destinationId}`,
    });
    child.register(makeExecutor(destinationId));
    return child;
  },
});

// Resolve — finds existing or spawns from blueprint
const thread = await sessions.resolve("feature-auth", mainThread);

// Dispatch across threads
await sessions.dispatch("feature-auth", payload, {
  sourceThread: mainThread,
  agentId: "executor",
});

// Tree
sessions.parentOf("feature-auth")   // → mainThread
sessions.childrenOf("main")         // → [feature-auth thread]
sessions.active                     // non-archived threads
sessions.archived                   // archived threads
```

---

## Interventions

Manual override → correction signal → system learns.

```ts
import { InterventionLog } from "@foundry/agent-primitives";

const interventions = new InterventionLog(signals);

await interventions.intervene(
  traceId,          // Which trace
  spanId,           // Which span was wrong
  actual,           // What the system did
  correction,       // What it should have done
  "operator-name",
  "reason"          // Optional
);
// Emits a "correction" signal with confidence 1.0

interventions.history          // All interventions, newest first
interventions.forTrace(id)     // Interventions for a specific trace
interventions.recentCorrections(20)  // Recent corrections as content
```

---

## EventStream

Unified observable for UI.

```ts
import { EventStream } from "@foundry/agent-primitives";

const stream = new EventStream(maxHistory?);

// Push events (wire into lifecycle, signals, etc.)
stream.push({ kind: "dispatch", threadId: "main", dispatch: { ... } });

// Subscribe (for WebSocket/SSE to UI)
const unsub = stream.subscribe((event) => {
  ws.send(JSON.stringify(event));
});

// Query
stream.recent({ kind: "signal", threadId: "main", limit: 50 });
```

### StreamEvent kinds

```ts
type StreamEvent =
  | { kind: "layer"; threadId: string; event: LifecycleEvent }
  | { kind: "dispatch"; threadId: string; dispatch: Dispatch }
  | { kind: "signal"; threadId: string; signal: Signal }
  | { kind: "session"; event: SessionEvent }
  | { kind: "middleware"; threadId: string; phase: "before"|"after"; context: DispatchContext }
```
