import { ActionQueue, CapabilityGate } from "../packages/core/src";
import { TypeSafeDecisionClient } from "../packages/foundry/src/providers/typesafe";
import { TypeSafeShadowRunner } from "../packages/foundry/src/providers/typesafe-shadow";
import fixtures from "../fixtures/typesafe-shadow.json";

const args = process.argv.slice(2);
if (args.some(arg => arg !== "--live")) throw new Error("Usage: bun scripts/typesafe-shadow.ts [--live]");
const live = args.includes("--live");
const reports = [];
for (const fixture of fixtures) {
  const gate = new CapabilityGate({ defaults: "deny", capabilities: { "net:api": "allow", "llm:call": "allow" } }, new ActionQueue());
  const client = new TypeSafeDecisionClient({
    gate,
    ...(live ? {} : {
      environment: { TYPESAFE_API_KEY: "offline-fixture-only" },
      fetch: async (_url: string, init: RequestInit) => {
        const request = JSON.parse(init.body as string);
        const choice = fixture.mock.choice ?? "__none__";
        const answers = request.questions.intervene
          ? { intervene: { type: "noul", noul: fixture.mock.yesProbability } }
          : { action: { type: "choice", choice, confidence: fixture.mock.confidence ?? 1, probabilities: Object.fromEntries(Object.keys(request.questions.action.criteria).map(id => [id, id === choice ? 1 : 0])) } };
        return Response.json({ model: "offline-fixture", answers, usage: { input_tokens: 0, output_tokens: 0 } });
      },
    }),
  });
  try {
    const runner = new TypeSafeShadowRunner({ client, catalog: () => fixture.catalog });
    const result = await runner.run(fixture.state, { agentId: "jev-shadow-experiment", threadId: `fixture:${fixture.id}` });
    const matchesExpected = Object.entries(fixture.expected).every(([key, value]) => result[key as keyof typeof result] === value);
    reports.push({ fixture: fixture.id, mode: live ? "live" : "offline-fixture", matchesExpected, result });
    if (!matchesExpected && !live) process.exitCode = 1;
  } catch (error) {
    // All client/runner errors are sanitized; never include process.env or request bodies.
    reports.push({ fixture: fixture.id, mode: live ? "live" : "offline-fixture", error: error instanceof Error ? error.message : "Experiment failed" });
    process.exitCode = 1;
  }
}
console.log(JSON.stringify({ shadow: true, actionsExecuted: 0, reports }, null, 2));
