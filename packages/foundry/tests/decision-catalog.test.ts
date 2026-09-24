import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDecisionCatalog, decisionDigest, decisionInput, refreshDecisionCatalog, type DecisionManifest } from "../src/decisions/catalog";
import { TypeSafeShadowRunner } from "../src/providers/typesafe-shadow";
import { TypeSafeDecisionClient } from "../src/providers/typesafe";
import { ActionQueue, CapabilityGate } from "@inixiative/foundry-core";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const graph = () => ({ conceptToFiles: { "feature:auth": ["auth.ts"] }, usesConsumers: {}, fileToConcepts: { "auth.ts": { partOf: ["feature:auth"], uses: [] } }, docToConcepts: {} });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "jev-catalog-")); roots.push(root);
  const text = "Framework policy belongs in Foundry.";
  await writeFile(join(root, "policy.md"), text);
  const manifest: DecisionManifest = { schemaVersion: 1, projectId: "test-project", profiles: [{ id: "architecture", procedure: "Compare the actual owners and their contracts.", questions: { gate: "Is architectural advice needed?", choice: "Which ownership level fits?" }, candidates: [
    { id: "framework", description: "Framework policy", enabled: true, requiredConcepts: [] },
    { id: "auth", description: "Auth app", enabled: true, requiredConcepts: ["feature:auth"] },
    { id: "disabled", description: "Unavailable action", enabled: false, requiredConcepts: [] },
  ] }], ideas: [{ id: "boundary", claim: text, status: "accepted", profiles: ["architecture"], evidence: { path: "policy.md", reference: "policy.md", excerpt: text, sha256: decisionDigest(text) } }] };
  return { root, manifest, build: () => buildDecisionCatalog({ manifest, graph: graph(), sourceRoot: root }) };
}

test("stable revisions, scoped Atlas facts and explicit actions; isolated decision snapshots", async () => {
  const f = await fixture();
  const a = await f.build(), b = await f.build();
  expect(a.revision).toBe(b.revision);
  expect(a.profiles[0].catalog.candidates.map(c => c.id)).toEqual(["framework", "auth"]);
  const selected = decisionInput(a, "architecture", "Where should this live?", ["auth.ts", "unknown.ts"]);
  expect(selected.observation.codebaseConcepts.map(c => c.id)).toEqual(["feature:auth"]);
  expect(selected.observation.unmappedFiles).toEqual(["unknown.ts"]);
  selected.catalog.candidates.length = 0;
  expect(a.profiles[0].catalog.candidates).toHaveLength(2);
  const removed = await buildDecisionCatalog({ manifest: f.manifest, graph: { conceptToFiles: {}, usesConsumers: {}, fileToConcepts: {}, docToConcepts: {} }, sourceRoot: f.root });
  expect(removed.revision).not.toBe(a.revision);
  expect(removed.profiles[0].catalog.candidates.map(c => c.id)).toEqual(["framework"]);
  expect(() => decisionInput(a, "missing", "x")).toThrow("Unknown");
});

test("changed, missing, superseded and unsupported evidence is visibly omitted", async () => {
  const f = await fixture();
  const original = await f.build();
  await writeFile(join(f.root, "policy.md"), "The policy has changed.");
  const changed = await f.build();
  expect(changed.revision).not.toBe(original.revision);
  expect(changed.ideas).toEqual([]);
  expect(changed.omittedIdeas[0].reason).toBe("source-changed");
  f.manifest.ideas[0].evidence.sha256 = decisionDigest("The policy has changed.");
  expect((await f.build()).omittedIdeas[0].reason).toBe("excerpt-missing");
  f.manifest.ideas[0].status = "superseded";
  expect((await f.build()).omittedIdeas[0].reason).toBe("superseded");
  f.manifest.ideas[0].status = "proposal";
  await rm(join(f.root, "policy.md"));
  expect((await f.build()).omittedIdeas[0].reason).toBe("source-unavailable");
});

test("evidence cannot follow a symlink outside its authorized source root", async () => {
  const f = await fixture(), other = await fixture();
  await symlink(join(other.root, "policy.md"), join(f.root, "escape.md"));
  f.manifest.ideas[0].evidence.path = "escape.md";
  const result = await f.build();
  expect(result.ideas).toEqual([]);
  expect(result.omittedIdeas[0].reason).toBe("source-unavailable");
});

test("refresh sees source and action updates; failed refresh cannot be used as fresh success", async () => {
  const f = await fixture();
  const manifestPath = join(f.root, "manifest.json"), outputPath = join(f.root, "cache/catalog.json");
  await writeFile(manifestPath, JSON.stringify(f.manifest));
  const options = { manifestPath, outputPath, sourceRoot: f.root, atlasRoot: f.root, loadGraph: async () => graph() };
  const first = await refreshDecisionCatalog(options);
  f.manifest.profiles[0].candidates[0].enabled = false;
  await writeFile(manifestPath, JSON.stringify(f.manifest));
  const second = await refreshDecisionCatalog(options);
  expect(second.revision).not.toBe(first.revision);
  expect(second.profiles[0].catalog.candidates.map(c => c.id)).toEqual(["auth"]);
  await expect(refreshDecisionCatalog({ ...options, loadGraph: async () => { throw Error("offline"); } })).rejects.toThrow("offline");
  expect(JSON.parse(await readFile(outputPath, "utf8")).revision).toBe(second.revision);
});

test("profile questions reach both Jev stages with reviewed evidence", async () => {
  const f = await fixture(), snapshot = await f.build(), input = decisionInput(snapshot, "architecture", "Where?", ["auth.ts"]);
  const requests: any[] = [];
  const client = new TypeSafeDecisionClient({ gate: new CapabilityGate({ defaults: "allow", capabilities: {} }, new ActionQueue()), environment: { TYPESAFE_API_KEY: "fixture" }, fetch: async (_url, init) => {
    const body = JSON.parse(init.body as string); requests.push(body);
    return Response.json({ model: "fixture", usage: { input_tokens: 1, output_tokens: 1 }, answers: body.questions.intervene
      ? { intervene: { type: "noul", noul: 1 } }
      : { action: { type: "choice", choice: "framework", confidence: 1, probabilities: { framework: 1, auth: 0, __none__: 0 } } } });
  } });
  const result = await new TypeSafeShadowRunner({ client, catalog: () => input.catalog }).run(input.observation, { agentId: "architecture", threadId: "test" });
  expect(requests[0].questions.intervene.instructions).toBe("Is architectural advice needed?");
  expect(requests[1].questions.action.instructions).toBe("Which ownership level fits?");
  expect(requests[0].state.selectedLearnings[0].text).toContain("[accepted]");
  expect(result).toMatchObject({ shadow: true, candidateId: "framework", catalogRevision: `${snapshot.revision}:architecture` });
});

test("reject duplicate profiles and unknown idea targets before producing a catalog", async () => {
  const f = await fixture();
  f.manifest.profiles.push(f.manifest.profiles[0]);
  await expect(f.build()).rejects.toThrow("Duplicate");
  f.manifest.profiles.pop(); f.manifest.ideas[0].profiles = ["nonexistent"];
  await expect(f.build()).rejects.toThrow("unknown decision profile");
});
