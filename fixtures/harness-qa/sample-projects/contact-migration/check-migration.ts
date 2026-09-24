import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { addContact, openContacts, readLegacyContacts } from "./contacts";

// This deliberately fails on the starter. It is opt-in, not a baseline test.
// Each attempt retains its own database and report for independent inspection.
export async function checkMigration(projectRoot: string) {
  const parent = join(projectRoot, "artifacts");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "migration-"));
  const path = join(directory, "contacts.sqlite");
  const checks: string[] = [];
  let database: Database | undefined;
  let error: string | undefined;
  const sourceHashes: Record<string, string> = {};
  for (const name of ["contacts.ts", "contacts.test.ts", "check-migration.ts"]) {
    sourceHashes[name] = new Bun.CryptoHasher("sha256").update(await Bun.file(join(projectRoot, name)).bytes()).digest("hex");
  }
  try {
    database = new Database(path);
    database.exec("CREATE TABLE contacts (id INTEGER PRIMARY KEY, display_name TEXT NOT NULL)");
    database.query("INSERT INTO contacts(id, display_name) VALUES (?, ?)").run(7, "Ada");
    database.close(); database = undefined;
    database = openContacts(path);
    const columns = database.query("PRAGMA table_info(contacts)").all() as { name: string }[];
    assert(columns.some(column => column.name === "preferred_name"), "preferred_name storage is missing after opening a legacy database");
    checks.push("legacy database gains preferred_name");
    assert.deepEqual(readLegacyContacts(database), [{ id: 7, display_name: "Ada" }]);
    assert.deepEqual(database.query("SELECT id, preferred_name FROM contacts").all(), [{ id: 7, preferred_name: "Ada" }]);
    checks.push("existing identity and legacy name preserved; preferred name backfilled");
    addContact(database, "Grace");
    assert.deepEqual(database.query("SELECT display_name, preferred_name FROM contacts WHERE id != 7").all(), [
      { display_name: "Grace", preferred_name: "Grace" },
    ]);
    checks.push("new contacts support both old and new SQL readers");
    database.query("UPDATE contacts SET preferred_name = ? WHERE id = 7").run("Countess");
    database.close(); database = undefined;
    database = openContacts(path);
    assert.deepEqual(database.query("SELECT id, display_name, preferred_name FROM contacts WHERE id = 7").all(), [
      { id: 7, display_name: "Ada", preferred_name: "Countess" },
    ]);
    assert.equal(readLegacyContacts(database).length, 2);
    checks.push("reopening neither duplicates data nor overwrites an existing preferred name");
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally { database?.close(); }
  const report = { ok: error === undefined, checks, error: error ?? null, database: path,
    sourceHashes, scope: "local sample code and SQLite only; not Foundry/native learning evidence" };
  await Bun.write(join(directory, "report.json"), JSON.stringify(report, null, 2));
  return { ...report, report: join(directory, "report.json") };
}

if (import.meta.main) {
  const result = await checkMigration(import.meta.dir);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}
