import { expect, test } from "bun:test";
import { ActionQueue, CapabilityGate } from "@inixiative/foundry-core";
import { TypeSafeDecisionClient } from "../src/providers/typesafe";
import { TypeSafeShadowRunner, type TypeSafeShadowCatalog } from "../src/providers/typesafe-shadow";

const context = { agentId: "warden", threadId: "thread-ue", meta: { projectId: "ue" } };
const catalog = (): TypeSafeShadowCatalog => ({ revision: "v1", candidates: [{ id: "hydrate-auth", description: "Hydrate relevant login context" }], learnings: [{ id: "callback", text: "Login callback origin must match web origin" }] });
function harness(yes = 0.95, confidence = 0.9, choice = "hydrate-auth") {
  const requests: any[] = [];
  let onCall: (() => void) | undefined;
  const client = new TypeSafeDecisionClient({
    gate: new CapabilityGate({ defaults: "allow", capabilities: {} }, new ActionQueue()),
    environment: { TYPESAFE_API_KEY: "fixture-only" },
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body as string); requests.push(body); onCall?.();
      const answers = body.questions.intervene
        ? { intervene: { type: "noul", noul: yes } }
        : { action: { type: "choice", choice, confidence, probabilities: Object.fromEntries(Object.keys(body.questions.action.criteria).map(id => [id, id === choice ? 1 : 0])) } };
      return Response.json({ model: "jev-fixture-resolved", answers, usage: { input_tokens: 10, output_tokens: 2 } });
    },
  });
  return { client, requests, onCall: (fn: () => void) => { onCall = fn; } };
}

test("yes gate precedes dynamic Choice; reports shadow evidence without executing an action", async () => {
  const h = harness(); let seenContext;
  const runner = new TypeSafeShadowRunner({ client: h.client, catalog: ctx => { seenContext = ctx; return catalog(); } });
  const result = await runner.run({ message: "Callback broke" }, context);
  expect(seenContext).toBe(context);
  expect(h.requests).toHaveLength(2);
  expect(Object.keys(h.requests[0].questions)).toEqual(["intervene"]);
  expect(h.requests[1].questions.action.criteria).toEqual({ "hydrate-auth": "Hydrate relevant login context", __none__: "None of the supplied actions is appropriate; request review" });
  expect(result).toMatchObject({ shadow: true, outcome: "candidate", candidateId: "hydrate-auth", catalogRevision: "v1", learningIds: ["callback"], usage: { input_tokens: 20, output_tokens: 4 } });
  expect(result.stages.map(s => s.model)).toEqual(["jev-fixture-resolved", "jev-fixture-resolved"]);
  expect(result.stages[0].yesProbability).toBe(0.95);
  expect(result.stages[0].confidence).toBeUndefined();
  expect(result.stages[1].confidence).toBe(0.9);
  expect(result.latencyMs).toBeGreaterThanOrEqual(0);
});

for (const [probability, outcome, reason] of [[0.2, "no-intervention", "gate-no"], [0.5, "review", "gate-uncertain"]] as const) {
  test(`${reason} skips the second provider call`, async () => {
    const h = harness(probability);
    const result = await new TypeSafeShadowRunner({ client: h.client, catalog }).run("Observation", context);
    expect(h.requests).toHaveLength(1);
    expect(result).toMatchObject({ outcome, reason });
    expect(result.candidateId).toBeUndefined();
  });
}

test("no candidates requires neither a key nor a provider call", async () => {
  const h = harness();
  const result = await new TypeSafeShadowRunner({ client: h.client, catalog: () => ({ ...catalog(), candidates: [] }) }).run("x", context);
  expect(h.requests).toHaveLength(0);
  expect(result).toMatchObject({ outcome: "no-intervention", reason: "no-candidates", stages: [], usage: { input_tokens: 0, output_tokens: 0 } });
});

for (const [confidence, choice, reason] of [[0.3, "hydrate-auth", "choice-uncertain"], [0.9, "__none__", "none-suitable"]] as const) {
  test(`${reason} produces review without an executable candidate`, async () => {
    const h = harness(0.9, confidence, choice);
    const result = await new TypeSafeShadowRunner({ client: h.client, catalog }).run("x", context);
    expect(result).toMatchObject({ outcome: "review", reason });
    expect(result.candidateId).toBeUndefined();
  });
}

test("catalog is scoped dynamically per run and fixed throughout each two-stage decision", async () => {
  const h = harness(); const original = catalog();
  let revision = "v1";
  const runner = new TypeSafeShadowRunner({ client: h.client, catalog: () => ({ ...original, revision }) });
  h.onCall(() => { original.candidates.push({ id: "new-route", description: "Added during the request" }); original.learnings[0].text = "Changed during request"; });
  const first = await runner.run("x", context);
  expect(first.candidateIds).toEqual(["hydrate-auth"]);
  expect(h.requests[1].questions.action.criteria["new-route"]).toBeUndefined();
  expect(h.requests[1].state.selectedLearnings[0].text).toContain("origin must match");
  h.onCall(() => {});
  original.candidates = [original.candidates[0], { id: "new-route", description: "New trusted candidate" }];
  revision = "v2";
  const second = await runner.run("x", context);
  expect(second.catalogRevision).toBe("v2");
  expect(second.candidateIds).toEqual(["hydrate-auth", "new-route"]);
});

test("observation is bounded and captured before async catalog lookup and remains fixed between stages", async () => {
  const h = harness();
  const observation = { nested: { message: "Original observation" } };
  const runner = new TypeSafeShadowRunner({ client: h.client, catalog: async () => {
    observation.nested.message = "Changed during catalog lookup";
    return catalog();
  } });
  h.onCall(() => { observation.nested.message = "Changed during provider call"; });
  await runner.run(observation, context);
  for (const request of h.requests) expect(request.state.observation.nested.message).toBe("Original observation");
  const sizeCheck = harness();
  await expect(new TypeSafeShadowRunner({ client: sizeCheck.client, catalog }).run("x".repeat(65_536), context)).rejects.toThrow("64 KiB");
  expect(sizeCheck.requests).toHaveLength(0);
});

test("cancellation during async catalog lookup also cancels an empty-catalog run", async () => {
  const h = harness(); const controller = new AbortController();
  const runner = new TypeSafeShadowRunner({ client: h.client, catalog: async () => {
    controller.abort();
    return { ...catalog(), candidates: [] };
  } });
  await expect(runner.run("x", context, controller.signal)).rejects.toThrow();
  expect(h.requests).toHaveLength(0);
});

test("rejects oversized, duplicate, or executable candidate catalogs before contacting provider", async () => {
  const h = harness();
  const invalid = [
    { ...catalog(), candidates: Array.from({ length: 65 }, (_, i) => ({ id: `a${i}`, description: "x" })) },
    { ...catalog(), candidates: [catalog().candidates[0], catalog().candidates[0]] },
    { ...catalog(), learnings: [{ id: "big", text: "x".repeat(2001) }] },
    { ...catalog(), candidates: [{ ...catalog().candidates[0], execute: () => { throw Error("Must never run"); } }] },
  ];
  for (const value of invalid) await expect(new TypeSafeShadowRunner({ client: h.client, catalog: () => value }).run("x", context)).rejects.toThrow("Invalid Jev shadow catalog");
  expect(h.requests).toHaveLength(0);
});

test("unknown action, invalid threshold, and cancellation cannot yield a successful selection", async () => {
  const h = harness(1, 1, "not-allowed");
  await expect(new TypeSafeShadowRunner({ client: h.client, catalog }).run("x", context)).rejects.toThrow();
  expect(() => new TypeSafeShadowRunner({ client: h.client, catalog, noThreshold: 0.9, yesThreshold: 0.8 })).toThrow("thresholds");
  const controller = new AbortController(); controller.abort();
  const noCalls = harness();
  await expect(new TypeSafeShadowRunner({ client: noCalls.client, catalog }).run("x", context, controller.signal)).rejects.toThrow();
  expect(noCalls.requests).toHaveLength(0);
});
