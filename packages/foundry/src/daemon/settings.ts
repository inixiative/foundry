/**
 * @atlas
 * @kind definition
 * @partOf feature:daemon
 */
/** The daemon's settings (`settings.json` `daemon`), read by the checkout's supervisor before any release boots. */
export interface DaemonSettings {
  /** `apply` builds origin/main as the candidate and restarts onto it; `check` only logs that it moved. Default off. */
  autoUpdate?: 'off' | 'check' | 'apply';
  /** Seconds between update checks; default 300, at least 30. */
  updateCheckSeconds?: number;
  /** Seconds a spin-down waits for running turns before restarting anyway; default 3600. */
  drainTimeoutSeconds?: number;
  /** Seconds a boot may take before it counts as failed; default 3600, 0 for no deadline. */
  bootTimeoutSeconds?: number;
  /** Upgrade the agent CLIs (Claude Code, Codex, Muse Code) at each daemon start, before the release boots. Default off. */
  updateAgentClis?: boolean;
}

const SECONDS = ['updateCheckSeconds', 'drainTimeoutSeconds', 'bootTimeoutSeconds'] as const;
const FIELDS = new Set(['autoUpdate', 'updateAgentClis', ...SECONDS]);

/** Settings validation: names the field, never echoes content. */
export function validateDaemonSettings(where: string, value: unknown): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error(`${where} must be an object`);
  const settings = value as Record<string, unknown>;
  for (const key of Object.keys(settings))
    if (!FIELDS.has(key)) throw Error(`${where}: unknown field ${key}`);
  if (
    settings.autoUpdate !== undefined &&
    !['off', 'check', 'apply'].includes(settings.autoUpdate as string)
  )
    throw Error(`${where}.autoUpdate must be off, check or apply`);
  for (const key of SECONDS)
    if (
      settings[key] !== undefined &&
      (!Number.isSafeInteger(settings[key]) || (settings[key] as number) < 0)
    )
      throw Error(`${where}.${key} must be a whole number of seconds`);
  if (settings.updateAgentClis !== undefined && typeof settings.updateAgentClis !== 'boolean')
    throw Error(`${where}.updateAgentClis must be a boolean`);
}
