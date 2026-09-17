import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  checkFile, checkRepo, fileStaleness, fixRepo, glossPathFor, harvestPaths, loadRepoDirectives,
  parseGlossDoc, parseSource, sectionHistory, sectionStaleness, setup,
} from "@inixiative/gloss";
import { auditWriteTree, boundedFile, glossFiles, projectPath, sourcePath } from "./paths";

// One process per request isolates Gloss's module-level repo configuration and
// blocking git/AST work from the viewer and from other projects.
const { root, action, file, symbol, snapshot } = JSON.parse(readFileSync(0, "utf8")) as {
  root: string; action: string; file?: string; symbol?: string; snapshot?: string;
};
try {
  const packagePath = projectPath(root, "package.json", true);
  if (existsSync(packagePath)) boundedFile(packagePath);
  loadRepoDirectives(root);
  let result: unknown;
  if (action === "list") {
    result = { files: glossFiles(root) };
  } else if (action === "read" || action === "detail" || action === "history") {
    if (!file) throw new Error("Source file is required");
    const path = sourcePath(root, file);
    boundedFile(path);
    const marginPath = projectPath(root, glossPathFor(file), true);
    const source = readFileSync(path, "utf8");
    if (existsSync(marginPath)) boundedFile(marginPath);
    const markdown = existsSync(marginPath) ? readFileSync(marginPath, "utf8") : null;
    const fingerprint = (code: string, margin: string | null) => createHash("sha256").update(JSON.stringify([code, margin])).digest("hex");
    const currentSnapshot = fingerprint(source, markdown);
    if (snapshot && snapshot !== currentSnapshot) throw new Error("Source or gloss changed; refresh source before inspecting history");
    const doc = markdown !== null ? parseGlossDoc(markdown) :
      { sourcePath: file, preamble: "", sections: [] };
    const parsed = parseSource(file, source);
    if (symbol !== undefined && !doc.sections.some(s => s.symbol === symbol)) throw new Error("Gloss section not found");
    if (action === "read") {
      result = { file, source, doc, symbols: parsed.symbols, errors: checkFile(root, file),
        pathMismatch: doc.sourcePath !== file, revision: "working-tree", snapshot: currentSnapshot };
    } else if (action === "history") {
      result = { history: sectionHistory(root, file, symbol) };
    } else {
      let dirty: boolean | null = null;
      try {
        dirty = execFileSync("git", ["--no-optional-locks", "status", "--porcelain", "--", file, glossPathFor(file)],
          { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().length > 0;
      } catch { /* No git metadata: do not report a clean file. */ }
      result = { freshness: symbol === undefined ? fileStaleness(root, file) : sectionStaleness(root, file, symbol), dirty };
    }
    if (fingerprint(readFileSync(path, "utf8"), existsSync(marginPath) ? readFileSync(marginPath, "utf8") : null) !== currentSnapshot) {
      throw new Error("Source or gloss changed during inspection; refresh source");
    }
  } else {
    auditWriteTree(root);
    if (file) sourcePath(root, file);
    if (action === "setup") result = setup(root);
    else if (action === "check") result = { violations: checkRepo(root) };
    else if (action === "fix") result = { actions: fixRepo(root) };
    else if (action === "harvest") result = { harvested: harvestPaths(root, file ? [join(root, file)] : undefined) };
    else throw new Error("Unsupported Gloss operation");
  }
  process.stdout.write(JSON.stringify({ result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: (error as Error).message }));
  process.exitCode = 1;
}
