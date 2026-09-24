import { expect, test } from "bun:test";
import { ActionQueue, CapabilityGate, MiddlewareChain, type DispatchContext } from "@inixiative/foundry-core";
import { TypeSafeDecisionClient, TypeSafeError, type TypeSafeClientOptions } from "../src/providers/typesafe";
import { createTypeSafeMiddleware } from "../src/providers/typesafe-middleware";

const gate = (deny = false) => new CapabilityGate({ defaults: "allow", capabilities: deny ? { "net:api": "deny" } : {} }, new ActionQueue());
const context = { agentId: "router", threadId: "thread-a" };
const questions = {
  route: { type: "choice", instructions: "Which domain applies?", criteria: { auth: "Identity", other: "Other work" } },
  severity: { type: "score", instructions: "How urgent is the issue?", criteria: ["Routine", "Urgent"] },
  changed: { type: "noul", instructions: "Did the topic change?" },
} as const;
// Mutable criteria array satisfies the public wire type.
const request = { ...questions, severity: { ...questions.severity, criteria: [...questions.severity.criteria] } };
const result = () => ({
  model: "jev-1.13.0",
  answers: {
    route: { type: "choice", choice: "auth", probabilities: { auth: 0.9, other: 0.1 }, confidence: 0.7 },
    severity: { type: "score", score: 0.2, probabilities: { "0": 0.8, "1": 0.2 }, legend: { "0": "Routine", "1": "Urgent" }, confidence: 0.6 },
    changed: { type: "noul", noul: 0.95 },
  }, usage: { input_tokens: 100, output_tokens: 20 },
});
const client = (fetcher: NonNullable<TypeSafeClientOptions["fetch"]>, extra: Partial<TypeSafeClientOptions> = {}) => new TypeSafeDecisionClient({
  gate: gate(), environment: { TYPESAFE_API_KEY: "test-secret" }, fetch: fetcher, ...extra,
});

test("batches typed decisions against the documented API and reports resolved model/usage", async () => {
  let count = 0;
  const c = client(async (url, init) => {
    count++;
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.redirect).toBe("error");
    expect(init.headers).toEqual({ Authorization: "Bearer test-secret", "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({ state: { message: "Login broke" }, questions: request, model: "jev-latest" });
    return Response.json(result());
  });
  const response = await c.evaluate({ message: "Login broke" }, request, context);
  const selected: "auth" | "other" = response.answers.route.choice;
  expect(selected).toBe("auth");
  expect(response.answers.changed.noul).toBe(0.95);
  expect(response.model).toBe("jev-1.13.0");
  expect(response.usage.input_tokens).toBe(100);
  expect(count).toBe(1);
});

test("missing credentials, invalid request, and denied capability never contact the provider", async () => {
  let count = 0;
  const send = async () => { count++; return Response.json(result()); };
  await expect(client(send, { environment: {} }).evaluate("x", request, context)).rejects.toThrow("TYPESAFE_API_KEY");
  await expect(client(send).evaluate("x", {}, context)).rejects.toThrow("Invalid TypeSafe decision request");
  await expect(client(send, { gate: gate(true) }).evaluate("x", request, context)).rejects.toThrow("net:api");
  expect(count).toBe(0);
});

test("uses a named per-account environment credential and pinned model", async () => {
  const c = client(async (_url, init) => {
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer ue-key");
    expect(JSON.parse(init.body as string).model).toBe("jev-1.13.0");
    return Response.json(result());
  }, { apiKeyEnv: "UE_TYPESAFE_API_KEY", environment: { UE_TYPESAFE_API_KEY: "ue-key" }, model: "jev-1.13.0" });
  await c.evaluate("x", request, context);
});

test("retries 429/529 with a bound and does not retry authentication failures", async () => {
  let count = 0;
  await client(async () => ++count < 3 ? new Response("overloaded", { status: count === 1 ? 429 : 529, headers: { "retry-after": "0" } }) : Response.json(result())).evaluate("x", request, context);
  expect(count).toBe(3);
  count = 0;
  await expect(client(async () => { count++; return new Response("test-secret", { status: 401 }); }).evaluate("x", request, context)).rejects.toThrow("HTTP 401");
  expect(count).toBe(1);
  count = 0;
  await expect(client(async () => { count++; return new Response("overload", { status: 529 }); }, { maxRetries: 1 }).evaluate("x", request, context)).rejects.toThrow("HTTP 529");
  expect(count).toBe(2);
});

test("cancellation/deadline stops retries; errors never expose upstream bodies or transport secrets", async () => {
  const controller = new AbortController(); controller.abort();
  let called = false;
  await expect(client(async () => { called = true; return Response.json(result()); }).evaluate("x", request, context, controller.signal)).rejects.toThrow("cancelled or timed out");
  expect(called).toBe(false);
  await expect(client(async () => new Response("secret body", { status: 429, headers: { "retry-after": "60" } }), { timeoutMs: 5 }).evaluate("x", request, context)).rejects.toThrow("cancelled or timed out");
  try { await client(async () => { throw new Error("test-secret"); }).evaluate("x", request, context); }
  catch (error) { expect(error).toBeInstanceOf(TypeSafeError); expect(String(error)).not.toContain("test-secret"); }
});

for (const [name, mutate] of Object.entries({
  missing: value => { delete (value.answers as Record<string, unknown>).route; },
  wrongType: value => { (value.answers as Record<string, unknown>).route = { type: "noul", noul: 1 }; },
  unknownChoice: value => { value.answers.route.choice = "invented"; },
  incompleteDistribution: value => { delete (value.answers.route.probabilities as Record<string, number>).other; },
  badDistribution: value => { value.answers.route.probabilities.auth = 0.1; },
  invalidScore: value => { value.answers.severity.score = 7; },
  invalidProbability: value => { value.answers.changed.noul = 2; },
} satisfies Record<string, (value: ReturnType<typeof result>) => void>)) {
  test(`rejects ${name} answer before middleware can route work`, async () => {
    const response = result(); mutate(response);
    await expect(client(async () => Response.json(response)).evaluate("x", request, context)).rejects.toBeInstanceOf(TypeSafeError);
  });
}

test("middleware runs inside the real chain and lets policy handle low confidence before executor", async () => {
  const chain = new MiddlewareChain();
  const ctx: DispatchContext = { ...context, timestamp: Date.now(), payload: "Login broke", annotations: {} };
  chain.use("jev-route", createTypeSafeMiddleware({
    client: client(async () => Response.json(result())), questions: request,
    state: c => ({ message: String(c.payload) }),
    onDecision: (decision, c) => { c.annotations.selectedRoute = decision.answers.route.confidence >= 0.9 ? decision.answers.route.choice : "review"; },
  }));
  const outcome = await chain.execute(ctx, async () => {
    expect(ctx.annotations.selectedRoute).toBe("review");
    expect(ctx.annotations.typesafe).toEqual(result());
    return { output: "done", contextHash: "test" };
  });
  expect(outcome.output).toBe("done");
});

test("middleware does not dispatch after failed decisions or without thread identity", async () => {
  const middleware = createTypeSafeMiddleware({ client: client(async () => new Response("denied", { status: 401 })), questions: request, state: () => "x" });
  let executed = false;
  const next = async () => { executed = true; return { output: "bad", contextHash: "test" }; };
  const ctx: DispatchContext = { ...context, timestamp: Date.now(), payload: "x", annotations: {} };
  await expect(middleware(ctx, next)).rejects.toThrow("HTTP 401");
  await expect(middleware({ ...ctx, threadId: undefined }, next)).rejects.toThrow("threadId");
  expect(executed).toBe(false);
  expect(ctx.annotations).toEqual({});
});
