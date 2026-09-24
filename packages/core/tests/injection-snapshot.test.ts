import { expect, test } from "bun:test";
import { ContextLayer, ContextStack, Executor, Harness, Thread, type InjectionArtifact } from "../src";

test("turn evidence survives cache writeback and preserves initial provider input", async () => {
  const docs = new ContextLayer({ id: "docs", prompt: "Follow these rules" });
  docs.set("Before work");
  const excluded = new ContextLayer({ id: "private" });
  excluded.set("Not selected");
  const thread = new Thread("review", new ContextStack([docs, excluded]));
  thread.register(new Executor({
    id: "worker", stack: thread.stack,
    handler: async (context, payload: string, meta) => {
      const messages = [{ role: "system" as const, content: context + "\nProvider instructions" },
        { role: "user" as const, content: payload }];
      meta?.recordProviderInput?.(messages);
      messages[0].content = "Later tool-loop input";
      docs.set("After work", "worker");
      return "done";
    },
  }));
  const result = await thread.dispatch("worker", "Do work", layer => layer.id === "docs");
  const artifact = result.meta?.injection as InjectionArtifact;
  expect(artifact.threadId).toBe("review");
  expect(artifact.layers?.find(layer => layer.id === "docs")?.content).toBe("Before work");
  expect(artifact.layers?.find(layer => layer.id === "private")?.included).toBe(false);
  expect(artifact.executorContext).not.toContain("Not selected");
  expect(artifact.providerMessages?.[0].content).toContain("Provider instructions");
  expect(artifact.providerMessages?.[0].content).not.toContain("Later tool-loop input");
  expect(docs.content).toBe("After work");
});

test("executor snapshot is retained on its trace span", async () => {
  const thread = new Thread("trace-review", new ContextStack());
  thread.register(new Executor({ id: "worker", stack: thread.stack,
    handler: async (_context, payload: string) => payload }));
  const harness = new Harness(thread);
  harness.setDefaultExecutor("worker");
  const result = await harness.send({ id: "turn-review", payload: "Check evidence" });
  const span = result.trace.spans.find(span => span.kind === "execute");
  expect((span?.annotations.injection as InjectionArtifact).userMessage).toBe("Check evidence");
});
