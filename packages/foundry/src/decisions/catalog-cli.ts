import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { ActionQueue, CapabilityGate } from "@inixiative/foundry-core";
import { refreshDecisionCatalog, decisionInput } from "./catalog";
import { TypeSafeDecisionClient } from "../providers/typesafe";
import { TypeSafeShadowRunner } from "../providers/typesafe-shadow";
import { z } from "zod";

const { values } = parseArgs({ args: process.argv.slice(2), options: {
  "atlas-root": { type: "string" }, "source-root": { type: "string" }, manifest: { type: "string" },
  out: { type: "string" }, watch: { type: "boolean", default: false }, cases: { type: "string" },
  live: { type: "boolean", default: false }, "key-env": { type: "string", default: "TYPESAFE_API_KEY" },
}, strict: true });
if (!values["atlas-root"] || !values["source-root"] || !values.manifest || !values.out || (values.watch && values.cases) || (values.live && !values.cases)) {
  throw Error("Usage: bun scripts/jev-catalog.ts --atlas-root DIR --source-root DIR --manifest FILE --out FILE [--watch | --cases FILE [--live] [--key-env NAME]]");
}
const options = { atlasRoot: resolve(values["atlas-root"]), sourceRoot: resolve(values["source-root"]), manifestPath: resolve(values.manifest), outputPath: resolve(values.out) };
const casesSchema = z.array(z.object({
  id: z.string().min(1), profile: z.string().min(1), message: z.string().min(1), files: z.array(z.string()).max(100),
  mock: z.object({ yesProbability: z.number().min(0).max(1), choice: z.string().optional() }),
  expected: z.object({ outcome: z.enum(["candidate", "review", "no-intervention"]), candidateId: z.string().optional() }),
})).min(1).max(32);

async function run() {
  const snapshot = await refreshDecisionCatalog(options);
  const summary = { revision: snapshot.revision, checkedAt: snapshot.checkedAt, concepts: snapshot.atlas.concepts.length,
    profiles: snapshot.profiles.map(p => ({ id: p.id, candidates: p.catalog.candidates.length, ideas: p.catalog.learnings.length })), omittedIdeas: snapshot.omittedIdeas };
  if (!values.cases) { console.log(JSON.stringify(summary)); return; }
  const cases = casesSchema.parse(await Bun.file(values.cases).json());
  const reports = [];
  for (const sample of cases) {
    const input = decisionInput(snapshot, sample.profile, sample.message, sample.files);
    const client = new TypeSafeDecisionClient({
      apiKeyEnv: values["key-env"],
      gate: new CapabilityGate({ defaults: "deny", capabilities: { "net:api": "allow", "llm:call": "allow" } }, new ActionQueue()),
      ...(values.live ? {} : { environment: { [values["key-env"]!]: "offline-fixture-only" }, fetch: async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string), choice = sample.mock.choice ?? "__none__";
        const answers = body.questions.intervene ? { intervene: { type: "noul", noul: sample.mock.yesProbability } }
          : { action: { type: "choice", choice, confidence: 1,
            probabilities: Object.fromEntries(Object.keys(body.questions.action.criteria).map(id => [id, id === choice ? 1 : 0])) } };
        return Response.json({ model: "offline-fixture", answers, usage: { input_tokens: 0, output_tokens: 0 } });
      } }),
    });
    const runner = new TypeSafeShadowRunner({ client, catalog: () => input.catalog });
    const result = await runner.run(input.observation, { agentId: sample.profile, threadId: `experiment:${snapshot.projectId}:${sample.id}` });
    const matchesExpected = result.outcome === sample.expected.outcome && result.candidateId === sample.expected.candidateId;
    if (!matchesExpected) process.exitCode = 1;
    reports.push({ id: sample.id, profile: sample.profile, matchesExpected, result,
      ...(result.candidateId ? { proposedReview: { procedure: input.procedure, focus: result.candidateId } } : {}),
    });
  }
  console.log(JSON.stringify({ mode: values.live ? "live" : "offline-fixture", actionsExecuted: 0, catalog: summary, reports }, null, 2));
}

// Sequential reconciliation also notices additions, deletions and missed filesystem events.
// Watch never sends model requests. Decision runs always refresh before using a snapshot.
if (values.watch) {
  let stopped = false;
  process.on("SIGINT", () => { stopped = true; });
  process.on("SIGTERM", () => { stopped = true; });
  while (!stopped) {
    try { await run(); }
    catch { console.error(JSON.stringify({ status: "refresh-failed", usableForNewDecisions: false })); }
    if (!stopped) await Bun.sleep(5000);
  }
} else await run();
