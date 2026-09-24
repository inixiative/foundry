import { Database } from "bun:sqlite";
import { lstat, open } from "node:fs/promises";

export async function lockRuntimeJob(path: string): Promise<(() => void) | null> {
  try { const file = await open(path, "wx", 0o600); await file.close(); }
  catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error; }
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw Error("Job lock must be private");
  const database = new Database(path);
  try { database.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE"); }
  catch (error) {
    database.close();
    if (error && typeof error === "object" && "code" in error && error.code === "SQLITE_BUSY") return null;
    throw error;
  }
  return () => { try { database.exec("ROLLBACK"); } finally { database.close(); } };
}
