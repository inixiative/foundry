// The pre-filter's local model: install (setup), serve (the daemon), and whether it is installed
// (doctor). Everything lives under ~/.foundry/models (FOUNDRY_MODELS overrides): a uv virtual
// environment with the Laya runtime and the Hugging Face cache with its weights. Nothing goes into
// a repository, and Foundry runs without it (every Warden is then asked).

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PrefilterSettings } from './warden-prefilter';

/** The runtime and its weights, pinned so a setup reproduces the measured model. */
export const PREFILTER_RUNTIME = 'laya[serve]==0.4.7';
export const PREFILTER_WEIGHTS = 'convaiinnovations/laya';
export const PREFILTER_REVISION = '7b928d828b7b0e022f929d9bd2e44165aa270148';

export function prefilterModelsDir(environment: Record<string, string | undefined> = process.env) {
  return environment.FOUNDRY_MODELS ?? join(homedir(), '.foundry', 'models');
}

function paths(dir: string) {
  const venv = join(dir, 'venvs', 'laya');
  return {
    venv,
    python: join(venv, 'bin', 'python'),
    serve: join(venv, 'bin', 'laya-serve'),
    hf: join(venv, 'bin', 'hf'),
    hfHome: join(dir, 'hf'),
    weights: join(
      dir,
      'hf',
      'hub',
      `models--${PREFILTER_WEIGHTS.replace('/', '--')}`,
      'snapshots',
      PREFILTER_REVISION,
    ),
  };
}

/** Installed: the runtime's server and the pinned weights are on disk. */
export function prefilterInstalled(dir = prefilterModelsDir()): boolean {
  const p = paths(dir);
  return existsSync(p.serve) && existsSync(p.weights);
}

/**
 * Install the runtime and weights (idempotent). Needs `uv` on PATH. Returns false with a reason on
 * failure; it never throws, so setup goes on without it.
 */
export async function installPrefilterModel(
  log: (line: string) => void,
  dir = prefilterModelsDir(),
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const uv = Bun.which('uv');
  if (!uv) return { ok: false, reason: 'uv is not on PATH (brew install uv)' };
  const p = paths(dir);
  const env = { ...process.env, HF_HOME: p.hfHome, UV_CACHE_DIR: join(dir, 'uv-cache') };
  const run = async (cmd: string[], what: string) => {
    const proc = Bun.spawn(cmd, { env, stdout: 'ignore', stderr: 'pipe' });
    const code = await proc.exited;
    if (code !== 0) throw Error(`${what} failed (exit ${code})`);
  };
  try {
    if (!existsSync(p.python)) await run([uv, 'venv', '--python', '3.12', p.venv], 'uv venv');
    log(`installing ${PREFILTER_RUNTIME} into ${p.venv}`);
    await run(
      [uv, 'pip', 'install', '--python', p.python, PREFILTER_RUNTIME, 'huggingface_hub'],
      'uv pip install',
    );
    log(`downloading ${PREFILTER_WEIGHTS} (about 2.4 GB) into ${p.hfHome}`);
    await run(
      [p.hf, 'download', PREFILTER_WEIGHTS, '--revision', PREFILTER_REVISION],
      'weights download',
    );
    return prefilterInstalled(dir)
      ? { ok: true }
      : { ok: false, reason: 'installed, but the pinned weights are missing' };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}

export type PrefilterServer =
  | { readonly status: 'started'; stop(): void }
  | { readonly status: 'running' | 'not-installed'; stop(): void };

/**
 * Start the model server for the settings' port when it is installed and nothing answers there yet.
 * A server already running (another Foundry, a manual start) is used as is and never stopped.
 */
export async function startPrefilterServer(
  settings: Required<PrefilterSettings>,
  dir = prefilterModelsDir(),
): Promise<PrefilterServer> {
  const none = () => {};
  try {
    const health = await fetch(`${settings.baseUrl}/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (health.ok) return { status: 'running', stop: none };
  } catch {}
  if (!prefilterInstalled(dir)) return { status: 'not-installed', stop: none };
  const p = paths(dir);
  const url = new URL(settings.baseUrl);
  const proc = Bun.spawn([p.serve], {
    env: {
      ...process.env,
      HF_HOME: p.hfHome,
      HF_HUB_OFFLINE: '1',
      LAYA_HOST: url.hostname,
      LAYA_PORT: url.port || '80',
      LAYA_DEVICE: process.platform === 'darwin' ? 'mps' : 'cpu',
      LAYA_PRELOAD: '1',
      LAYA_MODELS: settings.model,
      LAYA_LOG_LEVEL: 'warning',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  return { status: 'started', stop: () => proc.kill() };
}
