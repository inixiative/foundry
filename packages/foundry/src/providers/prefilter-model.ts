// The pre-filter's local model: install (setup), serve (the daemon), and whether it is installed
// (doctor). Kev (Jared Palmer, Apache-2.0): a LoRA and pointer head on Qwen3.5-4B-Base that answers
// TypeSafe's System One API, run through MLX on Apple Silicon. Everything lives under
// ~/.foundry/models (FOUNDRY_MODELS overrides): its source, its uv environment and the Hugging Face
// cache with its weights. Nothing goes into a repository, and Foundry runs without it (every Warden
// is then asked).

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PrefilterSettings } from './warden-prefilter';

/** Pinned so a setup reproduces the measured model: the server's source, its adapter and its base. */
export const PREFILTER_SOURCE = {
  repository: 'https://github.com/jaredpalmer/kev',
  commit: 'dd375f27fd61486c52204205e10a0d2e10f3b34a',
} as const;
export const PREFILTER_WEIGHTS = [
  { repo: 'jaredpalmer/kev-4b', revision: '6cfce5c2fa4b4bd64026336ab649c5ca78857d52' },
  { repo: 'Qwen/Qwen3.5-4B-Base', revision: '1001bb4d826a52d1f399e183466143f4da7b741b' },
] as const;

export function prefilterModelsDir(environment: Record<string, string | undefined> = process.env) {
  return environment.FOUNDRY_MODELS ?? join(homedir(), '.foundry', 'models');
}

function paths(dir: string) {
  const source = join(dir, 'src', 'kev');
  const hfHome = join(dir, 'hf');
  return {
    source,
    python: join(source, '.venv', 'bin', 'python'),
    hf: join(source, '.venv', 'bin', 'hf'),
    hfHome,
    weights: PREFILTER_WEIGHTS.map(({ repo, revision }) =>
      join(hfHome, 'hub', `models--${repo.replace('/', '--')}`, 'snapshots', revision),
    ),
  };
}

/** Installed: the server's environment and the pinned weights are on disk. */
export function prefilterInstalled(dir = prefilterModelsDir()): boolean {
  const p = paths(dir);
  return existsSync(p.python) && p.weights.every((w) => existsSync(w));
}

/**
 * Install the server and its weights (idempotent; about 9 GB). Needs `git` and `uv` on PATH. Returns
 * a reason on failure and never throws, so setup goes on without it.
 */
export async function installPrefilterModel(
  log: (line: string) => void,
  dir = prefilterModelsDir(),
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const uv = Bun.which('uv');
  const git = Bun.which('git');
  if (!uv) return { ok: false, reason: 'uv is not on PATH (brew install uv)' };
  if (!git) return { ok: false, reason: 'git is not on PATH' };
  const p = paths(dir);
  const env = { ...process.env, HF_HOME: p.hfHome, UV_CACHE_DIR: join(dir, 'uv-cache') };
  const run = async (cmd: string[], what: string, cwd?: string) => {
    const proc = Bun.spawn(cmd, { env, cwd, stdout: 'ignore', stderr: 'ignore' });
    const code = await proc.exited;
    if (code !== 0) throw Error(`${what} failed (exit ${code})`);
  };
  try {
    if (!existsSync(join(p.source, '.git'))) {
      log(`fetching the Kev server into ${p.source}`);
      await run([git, 'clone', '--quiet', PREFILTER_SOURCE.repository, p.source], 'git clone');
    }
    await run([git, 'fetch', '--quiet', 'origin', PREFILTER_SOURCE.commit], 'git fetch', p.source);
    await run([git, 'checkout', '--quiet', PREFILTER_SOURCE.commit], 'git checkout', p.source);
    log('installing its environment (uv)');
    await run([uv, 'sync', '--extra', 'serve'], 'uv sync', p.source);
    await run([uv, 'pip', 'install', '--python', p.python, 'huggingface_hub'], 'uv pip install');
    for (const { repo, revision } of PREFILTER_WEIGHTS) {
      log(`downloading ${repo} into ${p.hfHome}`);
      await run([p.hf, 'download', repo, '--revision', revision], `${repo} download`);
    }
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
 * Start the model server on the settings' port when it is installed and nothing answers there yet.
 * A server already running (another Foundry, a manual start) is used as is and never stopped.
 */
export async function startPrefilterServer(
  settings: Required<PrefilterSettings>,
  dir = prefilterModelsDir(),
): Promise<PrefilterServer> {
  const none = () => {};
  // Not installed: no request at all (a fresh install starts without touching the network).
  if (!prefilterInstalled(dir)) return { status: 'not-installed', stop: none };
  try {
    const models = await fetch(`${settings.baseUrl}/v1/models`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (models.ok) return { status: 'running', stop: none };
  } catch {}
  const p = paths(dir);
  const url = new URL(settings.baseUrl);
  const [adapter] = PREFILTER_WEIGHTS;
  const proc = Bun.spawn(
    [
      p.python,
      '-m',
      'kev.serve',
      '--run',
      `${adapter.repo}@${adapter.revision}`,
      '--host',
      url.hostname,
      '--port',
      url.port || '80',
    ],
    {
      cwd: p.source,
      env: { ...process.env, HF_HOME: p.hfHome, HF_HUB_OFFLINE: '1' },
      stdout: 'ignore',
      stderr: 'ignore',
    },
  );
  return { status: 'started', stop: () => proc.kill() };
}
