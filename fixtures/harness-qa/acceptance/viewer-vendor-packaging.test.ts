import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { foundryAllowed } from "../../../scripts/prepare-native-adoption";
import { collect, freezeCopy, sha256 } from "../../../scripts/stage-native-package";

const prefix = "packages/foundry/src/viewer/ui/vendor/";
const licenses = ["LICENSE-preact", "LICENSE-signals", "LICENSE-signals-core", "LICENSE-htm"];
const modules = ["preact.module.js", "hooks.module.js", "signals.module.js", "signals-core.module.js", "htm.module.js"];

test("source adoption includes the pinned UI licenses and provenance without widening private-file access", () => {
  for (const path of [...modules, "licenses.json", "manifest.json"]) expect(foundryAllowed(prefix + path)).toBe(true);
  for (const path of [prefix + ".env", prefix + "account.json.backup", prefix + "LICENSE-private", prefix + "notes.md",
    "packages/foundry/src/credentials.md", ".foundry/settings.json", "native-tapes/session.json"])
    expect(foundryAllowed(path)).toBe(false);
});

test("the production allowlist and copier retain the actual UI modules and licenses byte-for-byte", async () => {
  const source = resolve(import.meta.dir, "../../../", prefix);
  const files = await collect(source, path => foundryAllowed(prefix + path), () => true);
  for (const path of ["licenses.json", "manifest.json", ...modules]) expect(files.some(file => file.path === path)).toBe(true);
  // This is a disposable packaging fixture, not a native candidate or installation.
  const scratch = await mkdtemp(join(tmpdir(), "foundry-vendor-packaging-"));
  try {
    const target = join(scratch, "vendor");
    await freezeCopy(source, target, files);
    for (const file of files) {
      const copy = await readFile(join(target, file.path));
      expect(sha256(copy)).toBe(file.sha256);
      expect(copy.equals(await readFile(join(source, file.path)))).toBe(true);
    }
    const manifest = JSON.parse(await readFile(join(target, "manifest.json"), "utf8"));
    expect(manifest.licenseFile).toBe("licenses.json");
    expect(manifest.files.map((file: { file: string }) => file.file).sort()).toEqual([...modules].sort());
    for (const file of manifest.files) expect(sha256(await readFile(join(target, file.file)))).toBe(file.sha256);
    const notices = JSON.parse(await readFile(join(target, "licenses.json"), "utf8"));
    expect(notices.map((notice: { file: string }) => notice.file).sort()).toEqual([...licenses].sort());
    for (const notice of notices) {
      expect(typeof notice.text).toBe("string");
      expect(notice.text.length).toBeGreaterThan(1000);
      expect(sha256(notice.text)).toBe(notice.sha256);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
