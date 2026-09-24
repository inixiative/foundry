import { expect, test } from "bun:test";
import { ContextStack, FileMemory } from "@inixiative/foundry-core";
import { developmentTeam, atlasSection } from "../src/development-team";
import { configuredExperts } from "../src/agents/configured-experts";
import { buildLayers, createSourceResolver } from "../src/agents/thread-factory";
import { resolveProjectView } from "../src/viewer/config-resolve";

test("development team resolves ordinary UUID-owned experts and warms attributed source snapshots", async () => {
  const id = crypto.randomUUID(), config = developmentTeam({ projectId: id, projectPath: "/tmp/isolated-project", worker: { provider: "claude-code", model: "fable" },
    decision: { provider: "gemini", model: "gemini-3.1-flash-lite-preview" }, snapshots: {
      features: { content: "## feature\n### feature:logs\n- logger.ts", reference: "base-sha:MAP.md", capturedAt: "2026-09-10T00:00:00Z" },
      primitives: { content: "## primitive\n### primitive:scope\n- scope.ts", reference: "base-sha:MAP.md", capturedAt: "2026-09-10T00:00:00Z" },
    } });
  const effective = resolveProjectView(config, id)!.config;
  expect(configuredExperts(effective).experts.map(e => e.domain).sort()).toEqual(["architecture", "features", "primitives", "testing"]);
  for (const entries of [config.agents, config.layers, config.sources]) for (const [key, entry] of Object.entries(entries)) {
    expect(key).toMatch(/^[a-f0-9-]{36}$/); expect(entry.id).toBe(key);
  }
  const stack = new ContextStack(buildLayers(effective, { sourceResolver: createSourceResolver({ memory: new FileMemory("/tmp/unused-team-memory") }) }));
  await stack.warmAll();
  expect(stack.assemble().text).toContain("base-sha:MAP.md"); expect(stack.assemble().text).toContain("SHA-256:");
  expect(stack.assemble().text).not.toContain("Source not connected");
  const router = Object.values(config.agents).find(a => a.kind === "router")!;
  expect(router.prompt).toContain(Object.values(config.agents).find(a => a.kind === "executor")!.id);
  const tester = Object.values(config.agents).find(a => a.domain === "testing")!;
  expect(tester.guardTriggers).toContain("Bash");
  config.projects[id]!.agents = { [tester.id]: { guardTriggers: { replace: [] } } };
  expect(resolveProjectView(config, id)!.config.agents[tester.id]!.guardTriggers).toEqual([]);
  tester.guardTriggers = ["Bash", "Bash"];
  expect(() => configuredExperts(config)).toThrow("guard triggers");
});

test("Atlas feature and primitive sections remain distinct; missing sections stay unavailable", () => {
  const map = "# MAP\n\n## feature\n### feature:a\n- a.ts\n\n## primitive\n### primitive:b\n- b.ts\n";
  expect(atlasSection(map, "feature")).not.toContain("b.ts"); expect(atlasSection(map, "primitive")).not.toContain("a.ts");
  expect(atlasSection("# MAP\n", "primitive")).toBeUndefined();
});
