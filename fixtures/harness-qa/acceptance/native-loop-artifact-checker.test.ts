import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Database } from "bun:sqlite";
import { checkNativeLoopArtifacts } from "../../../scripts/check-native-loop-artifacts";

const reference = process.env.FOUNDRY_M4_ARTIFACT;
test.skipIf(!reference)("artifact checker distinguishes immutable delivery, journal corruption and retained failed attempts", async () => {
  const source = resolve(reference!);
  const saved = await Bun.file(join(source, "report.json")).json();
  expect(saved.mode).toBe("controlled-adapters-production-loop");
  const originalReportHash = new Bun.CryptoHasher("sha256").update(await Bun.file(join(source, "report.json")).bytes()).digest("hex");
  const parent = await mkdtemp(resolve(import.meta.dir, "../../../.foundry/qa/parent-artifact-checker-controls-"));
  const results: unknown[] = [];
  try {
    const control = async (name: string, change?: (report: any, dir: string) => Promise<void>) => {
      const dir = join(parent, name);
      await cp(source, dir, { recursive: true });
      const report = structuredClone(saved);
      report.fixtureControl = name;
      const selected = report.turns.find((turn: any) => turn.id === report.delivery.turn);
      // Positive validator control only: fix the claim in a COPY, never the
      // retained workflow evidence. This does not make the runner itself pass.
      report.delivery.domains = selected.body.meta.injection.decoration.participants.map((p: any) => ({
        domain: p.id, revision: p.provenance.threadKnowledgeRevision,
        hash: p.provenance.threadKnowledgeHash, content: p.segments.threadKnowledge,
      }));
      await change?.(report, dir);
      await writeFile(join(dir, "report.json"), JSON.stringify(report));
      const result = await checkNativeLoopArtifacts(dir);
      results.push({ name, output: result.output, passed: result.report.passed, failures: result.report.checks.filter(check => !check.passed) });
      expect(result.report.sourceUnchanged).toBe(true);
      expect(result.report.copyClosed).toBe(true);
      return result.report;
    };
    expect((await control("matching-selected-message")).passed).toBe(true);
    const revision = await control("same-text-wrong-revision", async report => { report.delivery.domains[0].revision++; });
    expect(revision.passed).toBe(false);
    expect(revision.checks.filter(check => !check.passed).map(check => check.name)).toEqual(["delivered-expert-revisions"]);
    const duplicate = await control("duplicate-domain", async report => { report.delivery.domains[1] = report.delivery.domains[0]; });
    expect(duplicate.passed).toBe(false);
    expect(duplicate.checks.find(check => check.name === "delivered-expert-revisions")?.error).toContain("Duplicate");
    const input = await control("journal-input-corruption", async (report, dir) => {
      const db = new Database(join(dir, "state/sessions.sqlite"));
      try {
        const id = report.delivery.turn;
        const row = db.query("SELECT record FROM session_messages WHERE turn_id=? AND actor='agent'").get(id) as { record: string };
        const message = JSON.parse(row.record);
        message.meta.injection.providerMessages[0].content += " CONTROLLED_CORRUPTION";
        db.query("UPDATE session_messages SET record=? WHERE turn_id=? AND actor='agent'").run(JSON.stringify(message), id);
      } finally { db.close(); }
    });
    expect(input.passed).toBe(false);
    expect(input.checks.some(check => check.name.startsWith("turn:") && !check.passed)).toBe(true);
    const missingFinal = await control("changed-final-source", async (_report, dir) => {
      await writeFile(join(dir, "project-a/contacts.ts"), "// Controlled source corruption for validator test only\n");
    });
    expect(missingFinal.passed).toBe(false);
    expect(missingFinal.checks.find(check => check.name === "final-successful-migration")?.passed).toBe(false);
    const historical = await control("retained-earlier-failed-check", async (report, dir) => {
      const path = "migration-controlled-failure";
      const attempt = { ok: false, checks: [], error: "Controlled earlier failure", sourceHashes: {}, scope: "validator fixture only" };
      await mkdir(join(dir, "project-a/artifacts", path));
      await writeFile(join(dir, "project-a/artifacts", path, "report.json"), JSON.stringify(attempt));
      report.checkerAttempts.push({ path, report: attempt });
    });
    expect(historical.passed).toBe(true);
    expect(new Bun.CryptoHasher("sha256").update(await Bun.file(join(source, "report.json")).bytes()).digest("hex")).toBe(originalReportHash);
  } finally {
    await writeFile(join(parent, "controls.json"), JSON.stringify({ scope: "Mutated copies validate the artifact checker, never a corrected native run", source, results }, null, 2));
    // The compact results and independent reports remain; large controlled copies
    // are temporary. The original workflow directory is never modified.
    for (const name of ["matching-selected-message", "same-text-wrong-revision", "duplicate-domain", "journal-input-corruption", "changed-final-source", "retained-earlier-failed-check"]) {
      await rm(join(parent, name), { recursive: true, force: true });
    }
    console.log(`Artifact checker controls: ${join(parent, "controls.json")}`);
  }
}, 30000);
