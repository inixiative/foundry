import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { FileMemory } from "@inixiative/foundry-core";
import { createSourceResolver } from "../src/agents/thread-factory";
import { ConfigStore, starterConfig } from "../src/viewer/config";

test("saved Markdown knowledge accepts filesystem paths and file URIs without losing the selected directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "foundry-markdown-source-"));
  try {
    const docs = join(dir, "docs with spaces");
    await mkdir(docs);
    await writeFile(join(docs, "compatibility.md"), "# COMPATIBILITY_SOURCE_SENTINEL\n\n## Preserve old readers\n", { flag: "wx" });
    const config = starterConfig("controlled", "controlled");
    config.sources = Object.fromEntries([
      ["absolute", docs],
      ["picker-uri", `file://${docs}`],
      ["encoded-uri", pathToFileURL(docs).href],
    ].map(([id, uri]) => [id!, { id: id!, label: id!, type: "markdown" as const, uri: uri!, enabled: true }]));
    const store = new ConfigStore(join(dir, "config"));
    await store.save(config);
    const saved = await new ConfigStore(join(dir, "config")).load();
    const resolver = createSourceResolver({ memory: new FileMemory(join(dir, "memory")) });
    const baseline = await resolver("absolute", saved)!.load();
    expect(baseline).toContain("COMPATIBILITY_SOURCE_SENTINEL");
    expect(baseline).toContain("Preserve old readers");
    for (const id of ["picker-uri", "encoded-uri"]) {
      const source = resolver(id, saved)!;
      expect(source.id).toBe(id);
      expect(await source.load()).toBe(baseline);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
