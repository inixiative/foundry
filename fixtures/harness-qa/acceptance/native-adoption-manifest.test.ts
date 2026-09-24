import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkNative } from "../../../scripts/check-native-adoption";
import { collect, nativeAllowed, sha256 } from "../../../scripts/stage-native-package";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "foundry-independent-manifest-"));
  const pkgRoot = join(root, "node_modules/@inixiative/agent-session");
  await mkdir(join(root, "packages/foundry"), { recursive: true });
  await mkdir(join(pkgRoot, "src"), { recursive: true });
  await writeFile(join(root, "packages/foundry/package.json"), "{}");
  const pkg = { name: "@inixiative/agent-session", version: "0.1.0", main: "src/index.ts", exports: { ".": "./src/index.ts" } };
  await writeFile(join(pkgRoot, "package.json"), JSON.stringify(pkg));
  // Controlled inert constructors: no native CLI, credentials or model calls.
  await writeFile(join(pkgRoot, "src/index.ts"), 'export class ClaudeCodeSession { admissionProtocol = "prewrite-v1"; }\nexport class CodexMcpSession extends ClaudeCodeSession {}\nexport class CodexSession {}\nexport class SessionTurnError extends Error {}\n');
  const files = await collect(pkgRoot, nativeAllowed, p => p === "src" || p.startsWith("src/"));
  const manifest = { schema: 1, sourceDigest: sha256(JSON.stringify(files)), files, package: pkg };
  const path = join(root, "manifest.json");
  return { root, pkgRoot, manifest, async check() { await writeFile(path, JSON.stringify(manifest)); return checkNative(root, path); }, close: () => rm(root, { recursive: true, force: true }) };
}

test("an installed source hash mismatch is refused", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.pkgRoot, "src/index.ts"), "export {};\n");
    await expect(f.check()).rejects.toThrow();
  } finally { await f.close(); }
});

test("an empty manifest cannot attest an installed native package", async () => {
  const f = await fixture();
  try {
    f.manifest.files = [];
    f.manifest.sourceDigest = sha256(JSON.stringify([]));
    await expect(f.check()).rejects.toThrow();
  } finally { await f.close(); }
});

test("omitting the imported entry cannot bypass installed source verification", async () => {
  const f = await fixture();
  try {
    f.manifest.files = f.manifest.files.filter(file => file.path !== "src/index.ts");
    f.manifest.sourceDigest = sha256(JSON.stringify(f.manifest.files));
    await expect(f.check()).rejects.toThrow();
  } finally { await f.close(); }
});

test("reported source digest must match the supplied complete file manifest", async () => {
  const f = await fixture();
  try {
    f.manifest.sourceDigest = "0".repeat(64);
    await expect(f.check()).rejects.toThrow();
  } finally { await f.close(); }
});

test("unlisted installed native source is not treated as reviewed", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.pkgRoot, "src/unreviewed.ts"), "export const marker = 1;\n");
    await expect(f.check()).rejects.toThrow();
  } finally { await f.close(); }
});
