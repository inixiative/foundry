import { uuidv7 } from "uuidv7";

/**
 * Mint a new UUID v7 identifier, optionally prefixed.
 *
 * UUID v7 encodes a millisecond Unix timestamp in its first 48 bits, so IDs are
 * lexicographically sortable by creation time. That's why the system stores no
 * `created_at` columns — the ID itself carries the timestamp.
 *
 * Prefixes are cosmetic (for log readability). Sort order is preserved because
 * the prefix is constant within a given table.
 */
export function newId(prefix?: string): string {
  const id = uuidv7();
  return prefix ? `${prefix}_${id}` : id;
}

/**
 * Synthesize a UUID v7 at the given point in time, for range queries.
 *
 * Used to translate `createdAt < cutoff` into `id < idAtTime(prefix, cutoff)`
 * when cleaning up stale rows by age.
 */
export function idAtTime(prefix: string | undefined, date: Date): string {
  const ms = date.getTime();
  if (ms < 0 || ms > 0xffffffffffff) {
    throw new RangeError(`timestamp ${ms} out of UUID v7 range`);
  }
  const hex = ms.toString(16).padStart(12, "0");
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-000000000000`;
  return prefix ? `${prefix}_${uuid}` : uuid;
}

/** Extract the millisecond timestamp encoded in a UUID v7 id (with or without prefix). */
export function timeFromId(id: string): number {
  const uuid = id.includes("_") ? id.slice(id.lastIndexOf("_") + 1) : id;
  const hex = uuid.slice(0, 8) + uuid.slice(9, 13);
  return parseInt(hex, 16);
}
