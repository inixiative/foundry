import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readPrivateJson, writePrivateJson } from './private-file';

/**
 * How a local ACP proxy finds the daemon. The daemon writes it at startup; the capability is the
 * bearer the viewer accepts while a tunnel is active (loopback needs no auth otherwise). The
 * capability appears nowhere else.
 */
export interface AcpLaunch {
  readonly version: 1;
  /** `http://127.0.0.1:<port>`: the daemon's own viewer origin. */
  readonly endpoint: string;
  readonly capability: string;
  readonly pid: number;
  readonly createdAt: number;
}

const CAPABILITY = /^[A-Za-z0-9_-]{32,256}$/;
const LABEL = 'ACP launch file';

/** Where the launchd daemon publishes its launch file: `~/.foundry/acp-launch.json`, beside the device identity. */
export const defaultAcpLaunchPath = () => join(homedir(), '.foundry', 'acp-launch.json');

/** `FOUNDRY_ACP_LAUNCH` (tests, a second Foundry), else the daemon's default path. */
export function acpLaunchPath(env: Record<string, string | undefined> = process.env): string {
  return env.FOUNDRY_ACP_LAUNCH || defaultAcpLaunchPath();
}

export function newAcpCapability(): string {
  return randomBytes(32).toString('base64url');
}

export function writeAcpLaunch(
  path: string,
  launch: { port: number; capability: string; pid?: number },
): AcpLaunch {
  if (!CAPABILITY.test(launch.capability)) throw Error('ACP capability has an invalid shape');
  const record: AcpLaunch = {
    version: 1,
    endpoint: `http://127.0.0.1:${launch.port}`,
    capability: launch.capability,
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
  if (typeof record.capability !== 'string' || !CAPABILITY.test(record.capability))
    throw Error(`${LABEL} capability has an invalid shape`);
  return {
    version: 1,
    endpoint: url.origin,
    capability: record.capability,
    pid: typeof record.pid === 'number' ? record.pid : 0,
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
  };
}
