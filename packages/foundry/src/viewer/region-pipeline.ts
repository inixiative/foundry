/**
 * @atlas
 * @kind service
 * @partOf feature:wardens, feature:viewer
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The Warden region pipeline as the Knowledge page reads it: the last region builds and the last
 * detection tests, and a region build started on request. The pipeline is held in Oracle for now
 * (`pipelines/warden-regions/`, Foundry-specific, to move into Foundry); its data stays in
 * `~/.foundry/evals/warden-regions/`. A build spends model calls (the Opus describer): it runs only
 * when asked, one at a time, never on its own. The detection test is an Oracle experiment with no
 * committed runner yet: its last results are read, never started here.
 */

export interface PipelinePaths {
  /** Where builds land (`build-<date>-<sha>/BUILD.json`). */
  readonly data: string;
  /** The Oracle checkout holding `pipelines/warden-regions/` and `docs/findings/`. */
  readonly oracle: string;
}

export const pipelinePaths = (): PipelinePaths => ({
  data: process.env.WARDEN_REGIONS_DATA ?? join(homedir(), '.foundry', 'evals', 'warden-regions'),
  oracle: process.env.ORACLE_CHECKOUT ?? join(homedir(), 'code', 'inixiative', 'oracle'),
});

export interface RegionBuild {
  readonly dir: string;
  readonly templateCommit: string | null;
  readonly builtAt: string | null;
  readonly regionsHash: string | null;
  readonly regions: number | null;
  readonly maxTokens: number | null;
  readonly over20k: number;
  readonly usage: unknown;
}

export interface DetectionTest {
  readonly id: string;
  readonly date: string | null;
  readonly regions: unknown;
  readonly reading: string | null;
  readonly metrics: unknown;
}

const readJson = (path: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
};
const dirs = (root: string) => {
  try {
    return readdirSync(root);
  } catch {
    return [];
  }
};
const str = (v: unknown) => (typeof v === 'string' ? v : null);
const num = (v: unknown) => (typeof v === 'number' ? v : null);

/** The newest region builds (newest first), from their BUILD.json. */
export function regionBuilds(paths: PipelinePaths, limit = 5): RegionBuild[] {
  return dirs(paths.data)
    .filter((name) => name.startsWith('build-') && existsSync(join(paths.data, name, 'BUILD.json')))
    .map((name) => ({ name, at: statSync(join(paths.data, name, 'BUILD.json')).mtimeMs }))
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
    .map(({ name }) => {
      const b = readJson(join(paths.data, name, 'BUILD.json')) ?? {};
      return {
        dir: join(paths.data, name),
        templateCommit: str(b.templateCommit),
        builtAt: str(b.builtAt),
        regionsHash: str(b.regionsHash),
        regions: Array.isArray(b.regions)
          ? b.regions.length
          : b.regions && typeof b.regions === 'object'
            ? Object.keys(b.regions).length
            : null,
        maxTokens: num(b.maxTokens),
        over20k: Array.isArray(b.over20k) ? b.over20k.length : 0,
        usage: b.usage ?? null,
      };
    });
}

/** The newest stage-one detection findings in Oracle's `docs/findings/`, newest first. */
export function detectionTests(paths: PipelinePaths, limit = 5): DetectionTest[] {
  const root = join(paths.oracle, 'docs', 'findings');
  return dirs(root)
    .filter((name) => name.endsWith('.json') && /stage1/.test(name))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((name) => {
      const f = readJson(join(root, name)) ?? {};
      const metrics =
        f.metrics && typeof f.metrics === 'object' ? (f.metrics as Record<string, unknown>) : {};
      return {
        id: name.replace(/\.json$/, ''),
        date: str(f.date),
        regions: f.regions ?? null,
        reading: str(metrics.reading),
        metrics: f.metrics ?? null,
      };
    });
}

export interface PipelineRun {
  readonly id: string;
  readonly step: 'region-build';
  readonly commit: string;
  readonly out: string;
  readonly startedAt: number;
  state: 'running' | 'done' | 'failed';
  exitCode?: number;
  finishedAt?: number;
  /** The last lines the build printed. */
  log: string;
}

/** Region builds started on request: one at a time, each its own process, logged in memory. */
export class RegionPipelineRuns {
  private readonly runs: PipelineRun[] = [];
  constructor(private readonly paths: PipelinePaths = pipelinePaths()) {}

  list(): readonly PipelineRun[] {
    return [...this.runs].reverse();
  }

  /** Start `build_regions.py <commit> --out <data>/build-<date>-<sha>`; refused while one runs. */
  start(commit: string): PipelineRun | { error: string } {
    if (!/^[0-9a-f]{7,40}$/i.test(commit)) return { error: 'commit must be a git sha' };
    if (this.runs.some((run) => run.state === 'running'))
      return { error: 'a region build is already running' };
    const script = join(this.paths.oracle, 'pipelines', 'warden-regions', 'build_regions.py');
    if (!existsSync(script)) return { error: `no region pipeline at ${script}` };
    const out = join(
      this.paths.data,
      `build-${new Date().toISOString().slice(0, 10)}-${commit.slice(0, 8)}`,
    );
    const run: PipelineRun = {
      id: crypto.randomUUID(),
      step: 'region-build',
      commit,
      out,
      startedAt: Date.now(),
      state: 'running',
      log: '',
    };
    this.runs.push(run);
    const proc = Bun.spawn(['python3', '-I', script, commit, '--out', out], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, WARDEN_REGIONS_DATA: this.paths.data },
    });
    const keep = async (stream: ReadableStream<Uint8Array>) => {
      for await (const chunk of stream)
        run.log = (run.log + new TextDecoder().decode(chunk)).slice(-4_000);
    };
    void Promise.all([keep(proc.stdout), keep(proc.stderr), proc.exited]).then(([, , code]) => {
      run.exitCode = code;
      run.finishedAt = Date.now();
      run.state = code === 0 ? 'done' : 'failed';
    });
    return run;
  }
}
