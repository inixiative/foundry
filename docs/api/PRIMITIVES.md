# Foundry Primitives — API Reference

Foundry is a context management layer for AI agents. It manages what agents know — layered, observable, with feedback flowing back into the system.

Bring your own agents, harness, memory systems, and docs. Foundry provides the context topology underneath.

## Core Concepts

**Context Layers** are independently managed caches. Each has its own sources, staleness, and lifecycle. Agents don't see raw sources — they see merged, filtered slices of the layer stack.

**Agents** are **Executors**: they take context + payload, do work, return full results.

**Traces** record every message's full journey through the system. Every stage is a span with input, output, timing, and which layers were visible.

**Signals** are typed side-channel information (corrections, conventions, taste) that flow back into context layers via the signal bus.

---

## ContextLayer

A single cache tier. Configure it — don't subclass it.

```ts
import { ContextLayer } from "@foundry/agent-primitives";

const layer = new ContextLayer({
  id: "conventions",
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
stack.slice(layer => layer.id === "docs") // Same as merge(filter)
stack.sliceByIds("docs", "conventions") // By specific layer ids
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
  layerFilter: (l) => l.id === "docs",
  handler: async (context, payload) => {
    // context = merged string from visible layers
    // payload = whatever the caller sent
    return "full results here";
  },
});

const result = await worker.run("write a function");
// result.output = "full results here"
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
trace.start("execute", "execute", {
  agentId: "code-writer",
  input: payload,
  layerIds: ["docs"],
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
  readonly kind: SpanKind;  // "ingress" | "dispatch" | "execute" | "decide" | "middleware" | "writeback" | "egress" | "fan" | string
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
import type { ContextRef, HydrationAdapter } from "@foundry/agent-primitives";

// Refs — pointers into your systems
const ref: ContextRef = { system: "sqlite", locator: "conv-1" };

// An adapter hydrates refs for one system (memory adapters expose one)
const adapter: HydrationAdapter = memory.asAdapter();  // adapter.system === "sqlite"
const content = await adapter.hydrate(ref);
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

thread.register(executor);

// Dispatch (runs through middleware chain)
const result = await thread.dispatch("executor", payload, filterOverride?);

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

Entry point. Dispatches each message to the executor, auto-traced.

```ts
import { Harness } from "@foundry/agent-primitives";

const harness = new Harness(thread, { maxTraces: 1000 });
harness.setDefaultExecutor("executor-answer");

const result = await harness.send({
  id: "msg-1",
  payload: "Fix the auth bug",
});

// result.result          — the executor's output
// result.trace           — full Trace object, drillable

// Direct dispatch to a named agent
await harness.dispatch("executor-fix", payload);

// Trace history
harness.traces                           // all traces
harness.getTrace("trace-id")             // by trace id
harness.getTraceForMessage("msg-1")      // by message id
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
stream.push({ kind: "signal", threadId: "main", signal });

// Subscribe (for WebSocket/SSE to UI)
const unsub = stream.subscribe((event) => {
  ws.send(JSON.stringify(event));
});

// Query: newest matches, oldest first
stream.recent({ kind: "signal", threadId: "main", where: (e) => ..., limit: 50 });
```

What the stream keeps, and hands to listeners, is `boundedPlainCopy(event)`: a JSON-safe copy cut
to `EVENT_BOUNDS` (per string, per list, depth, and a total node and character budget). A cycle,
a value that throws when read, or a cut becomes a placeholder, and `push` warns once per site with
its path, so the emitter can be found. `push` never throws.

### StreamEvent kinds

```ts
type StreamEvent =
  | { kind: "journal"; threadId: string; turnId: string | null; timestamp: number; ... }
  | { kind: "layer"; threadId: string; event: LifecycleEvent }
  | { kind: "signal"; threadId: string; signal: Signal }
  | { kind: "prompt"; threadId: string; prompt: ActionPrompt } // as it was when raised
  | { kind: "session"; event: SessionEvent }
  | { kind: "error"; source: string; message: string; severity: "error" | "warn"; ... }
  | { kind: "activity"; key: string; state: ...; summary: string; ... }
```
