#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { atlasSection, developmentTeam, type DevelopmentDomain, type TeamSnapshot } from "./development-team";

export async function createDevelopmentTeam(repo: string, destination: string) {
  const projectPath = resolve(repo), directory = resolve(destination);
  const snapshots: Partial<Record<DevelopmentDomain, TeamSnapshot>> = {};
  let map: string | undefined;
  try { map = await readFile(join(projectPath, "MAP.md"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (map) for (const [domain, kind] of [["features", "feature"], ["primitives", "primitive"]] as const) {
    const content = atlasSection(map, kind);
    if (content) snapshots[domain] = { content, reference: join(projectPath, "MAP.md"), capturedAt: new Date().toISOString() };
  }
  const config = developmentTeam({ projectId: crypto.randomUUID(), projectPath,
    worker: { provider: "claude-code", model: "fable" }, decision: { provider: "openai", model: "gpt-6-luna" }, snapshots });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "settings.json"), JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return { directory, projectId: Object.keys(config.projects)[0], enabledDomains: Object.values(config.agents).filter(a => a.enabled && a.domain).map(a => a.domain), modelCalls: 0 };
}
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2) throw Error("Usage: bun run team <repository-directory> <new-configuration-directory>");
  console.log(JSON.stringify(await createDevelopmentTeam(args[0]!, args[1]!), null, 2));
}
