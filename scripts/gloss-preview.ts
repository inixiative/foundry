import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextStack, EventStream, Harness, InterventionLog, SignalBus, Thread } from "../packages/core/src/index";
import { ConfigStore } from "../packages/foundry/src/viewer/config";
import { startViewer } from "../packages/foundry/src/viewer/server";

/** Isolated, disposable project. No model providers or executing agents. */
export async function createGlossPreview(port = 0) {
  const root = mkdtempSync(join(tmpdir(), "foundry-gloss-preview-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, ".gloss/src"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "gloss-review-sample", private: true }));
  writeFileSync(join(root, "src/review.ts"), [
    "// gloss:file", "", "type Review = { revision: string; approved: boolean };", "",
    "// why: approval must refer to the exact revision being merged.", "// gloss",
    "export const canMerge = (review: Review, revision: string): boolean => {",
    "  return review.approved && review.revision === revision;", "};", "",
    "// gloss", "export const summarizeReview = (review: Review): string => {",
    "  return review.approved ? 'Approved' : 'Needs review';", "};", "",
  ].join("\n"));
  writeFileSync(join(root, ".gloss/src/review.ts.md"), [
    "# src/review.ts", "", "Review decisions are scoped to one source revision.", "",
    "## canMerge", "", "Rejects approvals left on older revisions. A new push requires a new review.", "",
    "## summarizeReview", "", "Display text only. The merge gate still checks revision identity.", "",
  ].join("\n"));
  writeFileSync(join(root, "src/empty.ts"), "export const withoutNotes = true;\n");
  writeFileSync(join(root, "src/legacy.ts"), "// Historical explanation to move into the margin.\nexport const legacy = 1;\n");
  const configStore = new ConfigStore(join(root, ".foundry"));
  await configStore.save({ ...configStore.config, setupComplete: true,
    projects: { "gloss-sample": { id: "gloss-sample", path: root, label: "Gloss review sample", gloss: { enabled: false, display: "margin" } } } });
  const thread = new Thread("preview", new ContextStack());
  const { server } = await startViewer({ harness: new Harness(thread), eventStream: new EventStream(),
    interventions: new InterventionLog(new SignalBus()), configStore, configDir: join(root, ".foundry"), port });
  return { server, root, url: `http://localhost:${server.port}`,
    dispose: () => { server.stop(true); rmSync(root, { recursive: true, force: true }); } };
}

if (import.meta.main) {
  const preview = await createGlossPreview(Number(process.env.PORT ?? 0));
  console.log(`GLOSS_PREVIEW=${preview.url}`);
  process.on("SIGTERM", () => { preview.dispose(); process.exit(0); });
  process.on("SIGINT", () => { preview.dispose(); process.exit(0); });
}
