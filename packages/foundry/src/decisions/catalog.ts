import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { TypeSafeShadowCatalog } from "../providers/typesafe-shadow";

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,79}$/);
const strings = z.array(z.string().min(1));
export const decisionManifestSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: id,
  profiles: z.array(z.object({
    id,
    procedure: z.string().min(1).max(8000),
    questions: z.object({ gate: z.string().min(1).max(2000), choice: z.string().min(1).max(2000) }).strict(),
    candidates: z.array(z.object({
      id, description: z.string().min(1).max(1000), enabled: z.boolean(),
      requiredConcepts: strings.max(32),
    }).strict()).max(64),
  }).strict()).min(1).max(16),
  ideas: z.array(z.object({
    id, claim: z.string().min(1).max(1200),
    status: z.enum(["proposal", "accepted", "superseded"]),
    profiles: strings.min(1).max(16),
    evidence: z.object({
      path: z.string().min(1).max(300),
      reference: z.string().min(1).max(1000),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      excerpt: z.string().min(1).max(2000),
    }).strict(),
  }).strict()).max(64),
}).strict();
export type DecisionManifest = z.infer<typeof decisionManifestSchema>;
const atlasSchema = z.object({
  conceptToFiles: z.record(z.string(), strings),
  usesConsumers: z.record(z.string(), strings),
  fileToConcepts: z.record(z.string(), z.object({ partOf: strings, uses: strings })),
  docToConcepts: z.record(z.string(), strings),
});

/** Canonical hashing excludes capture time; unchanged inputs retain their revision. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export const decisionDigest = (value: string) => createHash("sha256").update(value).digest("hex");

export interface DecisionCatalog {
  schemaVersion: 1;
  projectId: string;
  revision: string;
  checkedAt: string;
  atlas: { revision: string; concepts: Array<{ id: string; files: number; consumers: number }>; fileToConcepts: Record<string, { partOf: string[]; uses: string[] }> };
  profiles: Array<{ id: string; procedure: string; catalog: TypeSafeShadowCatalog }>;
  ideas: Array<{ id: string; claim: string; status: "proposal" | "accepted"; profiles: string[]; evidence: { path: string; reference: string; sha256: string } }>;
  omittedIdeas: Array<{ id: string; reason: "superseded" | "source-changed" | "source-unavailable" | "excerpt-missing" }>;
}

/** Read only explicitly selected regular files within the configured source root. */
async function evidenceText(root: string, path: string): Promise<string> {
  if (isAbsolute(path)) throw Error("Evidence paths must be relative to the source root");
  const resolvedRoot = await realpath(root);
  const target = await realpath(resolve(resolvedRoot, path));
  const rel = relative(resolvedRoot, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw Error("Evidence path escapes source root");
  const info = await stat(target);
  if (!info.isFile() || info.size > 1_048_576) throw Error("Evidence must be a regular file of at most 1 MiB");
  const text = await readFile(target, "utf8");
  if (Buffer.byteLength(text) > 1_048_576) throw Error("Evidence too large");
  return text;
}

/** Opinionated projection belongs in Foundry. Atlas facts never create actions. */
export async function buildDecisionCatalog(input: {
  manifest: unknown; graph: unknown; sourceRoot: string;
}): Promise<DecisionCatalog> {
  const manifest = decisionManifestSchema.parse(input.manifest);
  const graph = atlasSchema.parse(input.graph);
  const unique = (values: string[]) => new Set(values).size === values.length;
  if (!unique(manifest.profiles.map(p => p.id)) || !unique(manifest.ideas.map(i => i.id)) ||
      manifest.profiles.some(p => !unique(p.candidates.map(c => c.id)))) throw Error("Duplicate decision catalog IDs");
  const profileIds = new Set(manifest.profiles.map(p => p.id));
  if (manifest.ideas.some(i => i.profiles.some(p => !profileIds.has(p)))) throw Error("Idea refers to an unknown decision profile");
  const concepts = [...new Set([...Object.keys(graph.conceptToFiles), ...Object.keys(graph.usesConsumers)])].sort().map(id => ({
    id, files: graph.conceptToFiles[id]?.length ?? 0, consumers: graph.usesConsumers[id]?.length ?? 0,
  }));
  const conceptIds = new Set(concepts.map(c => c.id));
  const ideas: DecisionCatalog["ideas"] = [], omittedIdeas: DecisionCatalog["omittedIdeas"] = [];
  for (const idea of manifest.ideas) {
    if (idea.status === "superseded") { omittedIdeas.push({ id: idea.id, reason: "superseded" }); continue; }
    let content: string;
    try { content = await evidenceText(input.sourceRoot, idea.evidence.path); }
    catch { omittedIdeas.push({ id: idea.id, reason: "source-unavailable" }); continue; }
    if (decisionDigest(content) !== idea.evidence.sha256) { omittedIdeas.push({ id: idea.id, reason: "source-changed" }); continue; }
    if (!content.includes(idea.evidence.excerpt)) { omittedIdeas.push({ id: idea.id, reason: "excerpt-missing" }); continue; }
    ideas.push({ id: idea.id, claim: idea.claim, status: idea.status, profiles: idea.profiles,
      evidence: { path: idea.evidence.path, reference: idea.evidence.reference, sha256: idea.evidence.sha256 } });
  }
  const atlas = { revision: decisionDigest(canonical(graph)), concepts, fileToConcepts: graph.fileToConcepts };
  const profiles = manifest.profiles.map(profile => {
    const learnings = ideas.filter(i => i.profiles.includes(profile.id)).map(i => ({
      id: i.id, text: `[${i.status}] ${i.claim}\nSource: ${i.evidence.reference}\nEvidence: ${i.evidence.path}#sha256=${i.evidence.sha256}`,
    }));
    if (learnings.length > 16) throw Error("Profile exceeds 16 selected ideas; scope the selection explicitly");
    if (learnings.some(i => i.text.length > 2000)) throw Error("Selected idea exceeds the decision text budget");
    return { id: profile.id, procedure: profile.procedure, catalog: {
      revision: "pending", questions: profile.questions,
      candidates: profile.candidates.filter(c => c.enabled && c.requiredConcepts.every(id => conceptIds.has(id))).map(({ id, description }) => ({ id, description })),
      learnings,
    } };
  });
  const revision = decisionDigest(canonical({ manifest, atlas, ideas, omittedIdeas }));
  for (const profile of profiles) profile.catalog.revision = `${revision}:${profile.id}`;
  return { schemaVersion: 1, projectId: manifest.projectId, revision, checkedAt: new Date().toISOString(), atlas, profiles, ideas, omittedIdeas };
}

/** Supply only concepts associated with the caller's selected files, not a full repository dump. */
export function decisionInput(snapshot: DecisionCatalog, profileId: string, message: string, files: string[] = []) {
  const profile = snapshot.profiles.find(p => p.id === profileId);
  if (!profile) throw Error("Unknown decision profile");
  if (!message.trim() || message.length > 16_000 || files.length > 100) throw Error("Decision input exceeds bounds or has no message");
  const selected = new Set(files.flatMap(file => {
    const entry = snapshot.atlas.fileToConcepts[file];
    return entry ? [...entry.partOf, ...entry.uses] : [];
  }));
  if (selected.size > 32) throw Error("Too many task concepts; narrow selected files explicitly");
  return { catalog: structuredClone(profile.catalog), procedure: profile.procedure, observation: {
    message, selectedFiles: [...files],
    codebaseConcepts: snapshot.atlas.concepts.filter(c => selected.has(c.id)),
    unmappedFiles: files.filter(file => !snapshot.atlas.fileToConcepts[file]),
  } };
}

/** Consumers get a fresh in-memory snapshot; a previous disk projection is never a fallback. */
export async function refreshDecisionCatalog(options: {
  manifestPath: string; sourceRoot: string; atlasRoot: string; outputPath: string;
  loadGraph?: () => Promise<unknown>;
}): Promise<DecisionCatalog> {
  const manifestText = await readFile(options.manifestPath, "utf8");
  if (Buffer.byteLength(manifestText) > 1_048_576) throw Error("Decision manifest exceeds 1 MiB");
  const graph = options.loadGraph ? await options.loadGraph() : await loadAtlasGraph(options.atlasRoot);
  const snapshot = await buildDecisionCatalog({ manifest: JSON.parse(manifestText), graph, sourceRoot: options.sourceRoot });
  await mkdir(dirname(options.outputPath), { recursive: true, mode: 0o700 });
  const temporary = `${options.outputPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(snapshot, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, options.outputPath);
  } finally { await rm(temporary, { force: true }); }
  return snapshot;
}

async function loadAtlasGraph(root: string): Promise<unknown> {
  const process = Bun.spawn(["bunx", "--no-install", "atlas", "graph", "--json"], { cwd: root, stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => process.kill(), 15_000);
  try {
    const stdout = await new Response(process.stdout).text();
    if (await process.exited !== 0) throw Error("Atlas graph generation failed; no fresh decision catalog published");
    if (Buffer.byteLength(stdout) > 20_000_000) throw Error("Atlas graph exceeds 20 MB");
    return JSON.parse(stdout);
  } finally { clearTimeout(timer); }
}
