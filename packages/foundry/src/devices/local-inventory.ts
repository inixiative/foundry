import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, linkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ProjectSettingsConfig } from "../viewer/config";

export interface LocalDevice { version: 1; id: string; name: string }
export const localDevicePath = () => join(homedir(), ".foundry", "device.json");

export function readLocalDevice(path = localDevicePath()): LocalDevice | null {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Local device identity could not be read");
  }
  try {
    const value = JSON.parse(raw);
    if (value.version !== 1 || typeof value.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.id) ||
      typeof value.name !== "string" || !value.name.trim() || value.name.length > 120) throw Error();
    return { version: 1, id: value.id, name: value.name };
  } catch { throw new Error("Local device identity is invalid; existing identity was preserved"); }
}

/** Explicit local enrollment, shared by this user's Foundry installations. No hardware identifiers. */
export function enrollLocalDevice(name: string, path = localDevicePath()): LocalDevice {
  if (typeof name !== "string" || !name.trim() || name.length > 120) throw new Error("Device name must contain 1–120 characters");
  const existing = readLocalDevice(path);
  if (existing) return existing;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const device: LocalDevice = { version: 1, id: randomUUID(), name: name.trim() };
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(device), { flag: "wx", mode: 0o600 });
  try {
    // Publish a complete file without replacing another process's enrollment.
    try { linkSync(temporary, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally { unlinkSync(temporary); }
  const saved = readLocalDevice(path);
  if (!saved) throw new Error("Local device enrollment was not retained");
  return saved;
}

/** Only explicitly registered projects are exposed. Matching paths/remotes never merge IDs. */
export function localInventory(projects: Record<string, ProjectSettingsConfig>, path = localDevicePath()) {
  const device = readLocalDevice(path);
  return {
    scope: "local" as const,
    device,
    checkouts: device ? Object.values(projects).filter(project => project.enabled !== false).map(project => ({
      id: createHash("sha256").update(JSON.stringify([device.id, project.id, resolve(project.path)])).digest("hex"),
      deviceId: device.id,
      projectId: project.id,
      label: project.label ?? project.id,
      path: resolve(project.path),
      observation: "registered" as const,
    })) : [],
  };
}
