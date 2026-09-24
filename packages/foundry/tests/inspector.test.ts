import { expect, test } from "bun:test";
import { Hono } from "hono";
import { ContextLayer, ContextStack, EventStream, Harness, InterventionLog, Thread } from "@inixiative/foundry-core";
import { registerRuntimeRoutes } from "../src/viewer/routes/runtime";
import { ConfigStore } from "../src/viewer/config";
import { threadToJSON } from "../src/viewer/http-helpers";
import { eventsForThread, traceInjection, traceSpans } from "../src/viewer/ui/inspector-data.js";

test("layer inspection returns contents without touching cache access time and rejects another thread", async () => {
  const layer = new ContextLayer({ id: "docs", prompt: "Read the domain" });
  layer.set("Domain evidence");
  const thread = new Thread("selected", new ContextStack([layer]));
  const app = new Hono();
  registerRuntimeRoutes(app, {
    harness: new Harness(thread), eventStream: new EventStream(),
    interventions: new InterventionLog(thread.signals), db: null,
    configStore: new ConfigStore("/tmp/foundry-inspector-unused-settings.json"),
  });
  const before = layer.lastAccessed;
  threadToJSON(thread);
  const response = await app.request("/api/threads/selected/layers/docs");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ threadId: "selected", prompt: "Read the domain", content: "Domain evidence" });
  expect(layer.lastAccessed).toBe(before);
  expect((await app.request("/api/threads/other/layers/docs")).status).toBe(404);
});

test("activity excludes other threads and unscoped runtime signals", () => {
  const events = [{ kind: "layer", threadId: "a" }, { kind: "layer", threadId: "b" }, { kind: "runtime" }];
  expect(eventsForThread(events, "a")).toEqual([events[0]]);
  expect(eventsForThread(events, null)).toEqual(events);
  const session = { kind: "session", event: { threadId: "a", type: "thread:spawned" } };
  expect(eventsForThread([session], "a")).toEqual([session]);
});

test("trace inspector walks stages in summary order and finds the executor evidence", () => {
  const injection = { userMessage: "Original turn" };
  const root = { id: "root", children: [{ id: "classify" }, { id: "execute", annotations: { injection } }] };
  expect(traceSpans(root).map(span => span.id)).toEqual(["root", "classify", "execute"]);
  expect(traceInjection({ root })).toEqual(injection);
  expect(traceInjection({})).toBeUndefined();
});
