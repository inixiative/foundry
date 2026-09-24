import { mkdir, rmdir } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { KastleClient } from "./kastle-client";
import { readPrivateJson, runCredentialSchema, writePrivateJson } from "./kastle-credential-file";

export async function kastleToken(path: string): Promise<string> {
  if (!isAbsolute(path)) throw Error("An absolute run credential path is required");
  const lock = `${path}.lock`;
  let acquired = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { await mkdir(lock, { mode: 0o700 }); acquired = true; break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; await Bun.sleep(100); }
  }
  if (!acquired) throw Error("Run credential renewal is busy; verify its owner before stale-lock recovery");
  try {
    const credential = runCredentialSchema.parse(await readPrivateJson(path));
    if (Date.parse(credential.expiresAt) <= Date.now()) throw Error("Run authorization expired; reconnect through Foundry");
    if (credential.cachedToken && Date.parse(credential.cachedToken.expiresAt) > Date.now() + 60000) return credential.cachedToken.secret;
    const renewed = await new KastleClient(credential.url, credential.refreshCredential).refresh(credential.bindingId);
    await writePrivateJson(path, { ...credential, cachedToken: { secret: renewed.secret, expiresAt: renewed.expiresAt } });
    return renewed.secret;
  } finally { await rmdir(lock); }
}

if (import.meta.main) {
  try { process.stdout.write(await kastleToken(process.argv[2] ?? "")); }
  catch { process.stderr.write("Kastle authorization unavailable; check the run, renewal policy or reconnect.\n"); process.exitCode = 1; }
}
