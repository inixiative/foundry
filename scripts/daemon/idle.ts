/**
 * Whether the runtime is safe to restart.
 *
 * The job worker holds a SQLite write lock at
 * <runtimeDirectory>/runtime-jobs/<jobId>/active.sqlite for the life of a job.
 * Acquiring it is therefore the same question as "is that job still running",
 * and reuses the worker's own primitive rather than inventing a second signal.
 */
import { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const heldByAnotherProcess = (path: string): boolean => {
  let database: Database | undefined;
  try {
    database = new Database(path, { readwrite: true });
    database.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    database.exec("ROLLBACK");
    return false;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "SQLITE_BUSY");
  } finally {
    database?.close();
  }
};

/** A missing or unreadable jobs directory means nothing is running, not that we should guess. */
export const runtimeJobsInFlight = async (runtimeDirectory: string | undefined): Promise<boolean> => {
  if (!runtimeDirectory) return false;
  const root = join(runtimeDirectory, "runtime-jobs");
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return false;
  }
  return entries.some((entry) => heldByAnotherProcess(join(root, entry, "active.sqlite")));
};
