/**
 * @atlas
 * @kind helper
 * @partOf feature:daemon
 */
import { unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readPrivateJson, writePrivateJson } from './private-file';

/**
 * How a local ACP proxy finds the daemon. The daemon writes it at startup. A direct loopback
 * request needs no credential, tunnelled or not.
 */
export interface AcpLaunch {
  readonly version: 1;
  /** `http://127.0.0.1:<port>`: the daemon's own viewer origin. */
  readonly endpoint: string;
  readonly pid: number;
  readonly createdAt: number;
}

const LABEL = 'ACP launch file';

/** Where the launchd daemon publishes its launch file: `~/.foundry/acp-launch.json`, beside the device identity. */
export const defaultAcpLaunchPath = () => join(homedir(), '.foundry', 'acp-launch.json');

/** `FOUNDRY_ACP_LAUNCH` (tests, a second Foundry), else the daemon's default path. */
export function acpLaunchPath(env: Record<string, string | undefined> = process.env): string {
  return env.FOUNDRY_ACP_LAUNCH || defaultAcpLaunchPath();
}

export function writeAcpLaunch(path: string, launch: { port: number; pid?: number }): AcpLaunch {
  const record: AcpLaunch = {
    version: 1,
    endpoint: `http://127.0.0.1:${launch.port}`,
    pid: launch.pid ?? process.pid,
    createdAt: Date.now(),
  };
  writePrivateJson(path, { ...record });
  return record;
}

/** A private launch file naming a plain loopback origin. Errors never include its contents. */
export function readAcpLaunch(path: string): AcpLaunch {
  const record = readPrivateJson(path, LABEL);
  if (record.version !== 1) throw Error(`unsupported ${LABEL} version`);
  if (typeof record.endpoint !== 'string') throw Error(`${LABEL} endpoint missing`);
  let url: URL;
  try {
    url = new URL(record.endpoint);
  } catch {
    throw Error(`${LABEL} endpoint is not a URL`);
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw Error(`${LABEL} endpoint must be a plain loopback http://127.0.0.1:<port> origin`);
  return {
    version: 1,
    endpoint: url.origin,
    pid: typeof record.pid === 'number' ? record.pid : 0,
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
  };
}

/** Remove the launch file at shutdown, only while it is still this daemon's (a newer one keeps its own). */
export function removeAcpLaunch(path: string, pid: number): void {
  try {
    if (readAcpLaunch(path).pid !== pid) return;
    unlinkSync(path);
  } catch {
    // Already gone or unreadable: nothing of ours to remove.
  }
}
