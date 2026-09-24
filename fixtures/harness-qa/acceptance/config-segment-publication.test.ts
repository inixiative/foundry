import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore, starterConfig } from "../../../packages/foundry/src/viewer/config";

const invalidValues = [null, "instructions", { kind: "thread-knowledge" }, 1];

for (const owner of ["global", "project"] as const) {
  for (const [index, value] of invalidValues.entries()) {
    for (const boundary of ["save", "reload"] as const) {
      test(`${owner} invalid segment ${index} at ${boundary} preserves the last working configuration`, async () => {
        const dir = await mkdtemp(join(tmpdir(), "foundry-parent-config-publication-"));
        try {
          const store = new ConfigStore(dir);
          const valid = starterConfig("controlled", "controlled");
          valid.layers = { custom: { id: "custom", prompt: "Keep provider text", sourceIds: [],
            staleness: 0, enabled: true, segment: "domain-knowledge" } };
          valid.projects = { p: { id: "p", path: dir, label: "Controlled", enabled: true,
            layers: { custom: { segment: "thread-knowledge" } } } };
          await store.save(valid);
          await store.load();
          const working = store.config;
          const snapshot = JSON.stringify(working);
          const candidate = structuredClone(working);
          const target = owner === "global" ? candidate.layers.custom : candidate.projects.p.layers!.custom;
          Object.assign(target, { segment: value });
          const path = join(dir, "settings.json");
          if (boundary === "reload") await writeFile(path, JSON.stringify(candidate));
          const priorFile = await readFile(path, "utf8");
          await expect(boundary === "save" ? store.save(candidate) : store.load()).rejects.toThrow("segment");
          expect(store.config).toBe(working);
          expect(JSON.stringify(store.config)).toBe(snapshot);
          expect(await readFile(path, "utf8")).toBe(priorFile);
          expect(store.config.layers.custom.segment).toBe("domain-knowledge");
          expect(store.config.projects.p.layers!.custom.segment).toBe("thread-knowledge");
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      });
    }
  }
}
