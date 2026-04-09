/**
 * Foundry Demo — run with: bun run src/demo.ts
 *
 * Wires up layers, agents, harness, and viewer.
 * Sends messages through the system so you can watch
 * traces flow in the viewer at http://localhost:4400
 */

import {
  ContextLayer,
  ContextStack,
  Classifier,
  Router,
  Executor,
  Thread,
  Harness,
  EventStream,
  SignalBus,
  InterventionLog,
  type Decision,
  type Classification,
  type Route,
} from "./agents";
import { FileMemory, inlineSource } from "./adapters";
import { startViewer } from "./viewer/server";

// -- 1. Set up memory --

const memory = new FileMemory(".foundry/memory");
await memory.load();

// Seed some initial knowledge if empty
if (memory.all().length === 0) {
  await memory.write({
    id: "conv-1",
    kind: "convention",
    content: "All API endpoints must validate input with Zod schemas",
    timestamp: Date.now(),
  });
  await memory.write({
    id: "conv-2",
    kind: "convention",
    content: "Use snake_case for database columns, camelCase for TypeScript",
    timestamp: Date.now(),
  });
  await memory.write({
    id: "adr-1",
    kind: "adr",
    content: "ADR-001: Use Hono over Express for API framework — lighter, better Bun support",
    timestamp: Date.now(),
  });
  console.log("Seeded initial memory entries");
}

// -- 2. Build context layers --

const docsLayer = new ContextLayer({
  id: "docs",
  trust: 10,
  sources: [
    inlineSource("system", [
      "You are a helpful engineering assistant.",
      "Follow project conventions. Ask clarifying questions when requirements are ambiguous.",
      "Write TypeScript. Use Bun as runtime. Use Hono for APIs.",
    ].join("\n")),
  ],
});

const conventionsLayer = new ContextLayer({
  id: "conventions",
  trust: 8,
  sources: [memory.asSource("conventions-src", "convention")],
});

const memoryLayer = new ContextLayer({
  id: "memory",
  trust: 3,
  staleness: 30_000, // stale after 30s
  sources: [memory.asSource("memory-src")],
});

// -- 3. Build stack --

const stack = new ContextStack([docsLayer, conventionsLayer, memoryLayer]);
await stack.warmAll();

console.log(`Stack warmed: ${stack.layers.length} layers, ~${stack.estimateTokens()} tokens`);

// -- 4. Build agents --

// Classifier — categorizes incoming messages
const classifier = new Classifier<string>({
  id: "classifier",
  stack,
  handler: async (_ctx, payload) => {
    // Simple keyword-based classification (swap for LLM in production)
    const lower = payload.toLowerCase();

    let category = "general";
    let subcategory: string | undefined;

    if (lower.includes("bug") || lower.includes("fix") || lower.includes("error")) {
      category = "bug";
    } else if (lower.includes("feature") || lower.includes("add") || lower.includes("build")) {
      category = "feature";
    } else if (lower.includes("refactor") || lower.includes("clean")) {
      category = "refactor";
    } else if (lower.includes("question") || lower.includes("how") || lower.includes("why")) {
      category = "question";
    } else if (lower.includes("convention") || lower.includes("style") || lower.includes("pattern")) {
      category = "convention";
      subcategory = "style";
    }

    return {
      value: { category, subcategory },
      confidence: 0.8,
      reasoning: `Keyword match: "${category}"`,
    } satisfies Decision<Classification>;
  },
});

// Router — decides where to send based on classification
const router = new Router<{ payload: string; classification: Classification }>({
  id: "router",
  stack,
  handler: async (_ctx, input) => {
    const cat = input.classification.category;

    const routeMap: Record<string, { dest: string; layers: string[] }> = {
      bug: { dest: "executor-fix", layers: ["docs", "conventions", "memory"] },
      feature: { dest: "executor-build", layers: ["docs", "conventions"] },
      refactor: { dest: "executor-build", layers: ["docs", "conventions"] },
      question: { dest: "executor-answer", layers: ["docs", "memory"] },
      convention: { dest: "executor-answer", layers: ["conventions", "memory"] },
      general: { dest: "executor-answer", layers: ["docs"] },
    };

    const route = routeMap[cat] ?? routeMap.general;

    return {
      value: {
        destination: route.dest,
        contextSlice: route.layers,
        priority: cat === "bug" ? 10 : 5,
      },
      confidence: 0.9,
      reasoning: `Category "${cat}" → ${route.dest}`,
    } satisfies Decision<Route>;
  },
});

// Executors — do the actual work
const executorFix = new Executor<string, string>({
  id: "executor-fix",
  stack,
  handler: async (ctx, payload) => {
    // Mock: in production this would call an LLM
    return `[fix] Analyzing bug: "${payload}"\n\nContext used: ${ctx.length} chars\nWould investigate root cause and propose fix.`;
  },
});

const executorBuild = new Executor<string, string>({
  id: "executor-build",
  stack,
  handler: async (ctx, payload) => {
    return `[build] Planning feature: "${payload}"\n\nContext used: ${ctx.length} chars\nWould break down into tasks and implement.`;
  },
});

const executorAnswer = new Executor<string, string>({
  id: "executor-answer",
  stack,
  handler: async (ctx, payload) => {
    return `[answer] Responding to: "${payload}"\n\nContext used: ${ctx.length} chars\nWould provide detailed answer based on docs and memory.`;
  },
});

// -- 5. Build thread --

const thread = new Thread("main", stack, {
  description: "Main conversation thread",
  tags: ["demo"],
});

thread.register(classifier);
thread.register(router);
thread.register(executorFix);
thread.register(executorBuild);
thread.register(executorAnswer);

// -- 6. Wire up middleware --

// Always-on: log every dispatch
thread.middleware.use("logger", async (ctx, next) => {
  const start = performance.now();
  const result = await next();
  const ms = (performance.now() - start).toFixed(1);
  console.log(`  [dispatch] ${ctx.agentId} (${ms}ms)`);
  return result;
});

// Conditional: extra logging for bug-related dispatches
thread.middleware.useWhen(
  "bug-tracker",
  (ctx) => {
    const annotations = ctx.annotations as Record<string, unknown>;
    return annotations.category === "bug";
  },
  async (ctx, next) => {
    console.log(`  [bug-tracker] High priority dispatch to ${ctx.agentId}`);
    const result = await next();
    return result;
  }
);

// -- 7. Signal bus + memory writeback --

const signals = thread.signals;

// Write all signals to file memory
signals.onAny(memory.signalWriter());

// Log signals
signals.onAny(async (signal) => {
  console.log(`  [signal] ${signal.kind}: ${typeof signal.content === "string" ? signal.content.slice(0, 80) : JSON.stringify(signal.content).slice(0, 80)}`);
});

// -- 8. Build harness --

const harness = new Harness(thread);
harness.setClassifier("classifier");
harness.setRouter("router");
harness.setDefaultExecutor("executor-answer");

// -- 9. Event stream --

const eventStream = new EventStream();

// Pipe lifecycle events into the stream
thread.lifecycle.on("layer:warm", async (event) => {
  eventStream.push({ kind: "layer", threadId: thread.id, event });
});
thread.lifecycle.on("layer:stale", async (event) => {
  eventStream.push({ kind: "layer", threadId: thread.id, event });
});

// Pipe signals into the stream
signals.onAny(async (signal) => {
  eventStream.push({ kind: "signal", threadId: thread.id, signal });
});

thread.start();

// -- 10. Interventions --

const interventions = new InterventionLog(signals);

// -- 11. Start viewer --

startViewer({ harness, eventStream, interventions, port: 4400 });

// -- 12. Send demo messages --

const demoMessages = [
  "There's a bug in the auth middleware — tokens aren't being refreshed",
  "Add a new endpoint for user preferences",
  "How do we handle database migrations?",
  "Refactor the payment module to use the new Hono patterns",
  "What conventions do we follow for API validation?",
];

console.log("\n--- Sending demo messages ---\n");

for (const [i, msg] of demoMessages.entries()) {
  console.log(`\nMessage ${i + 1}: "${msg}"`);

  const result = await harness.send({
    id: `msg-${i + 1}`,
    payload: msg,
  });

  const trace = result.trace.summary();
  console.log(`  Classification: ${result.classification?.value.category ?? "none"}`);
  console.log(`  Route: ${result.route?.value.destination ?? "default"}`);
  console.log(`  Stages: ${trace.stages.map((s) => s.name).join(" → ")}`);
  console.log(`  Total: ${trace.totalDurationMs?.toFixed(1)}ms`);
}

console.log("\n--- Demo complete ---");
console.log("Viewer running at http://localhost:4400");
console.log("Try clicking traces to drill in, or override a classification.\n");

// Keep the process alive for the viewer
process.on("SIGINT", () => {
  console.log("\nShutting down...");
  thread.stop();
  process.exit(0);
});
