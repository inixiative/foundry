/**
 * @atlas
 * @kind service
 * @partOf primitive:vcr
 */
// Foundry's VCR configuration over @inixiative/vcr: binds FOUNDRY_VCR_* environment variables,
// Foundry's scrubber, volatile signature options, and @inixiative/agent-session version metadata.
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  createVcrRecorder,
  createVcrSession,
  DEFAULT_MAX_LIVE_CALLS,
  type DriftFinding,
  isVcrError,
  type StoreCassetteInput,
  type VcrCassette,
  VcrError,
  type VcrMethodSanitizer,
  type VcrRecorder,
  type VcrRecordingStamp,
  type VcrResponse,
  type VcrSession,
} from '@inixiative/vcr';
import { foundryScrubber } from './scrub';
import { FOUNDRY_SIGNATURE_OPTIONS } from './signature';

export type VcrMode = 'replay' | 'record';
export type { DriftFinding };

/** `bun run test` replays; `bun run test:live` and the launchd smoke record. */
export const vcrMode = (): VcrMode => (process.env.FOUNDRY_VCR === 'record' ? 'record' : 'replay');

export type Recorded = VcrRecordingStamp & {
  /** Legacy top-level @inixiative/agent-session stamp kept for existing committed cassettes. */
  agentSession?: string;
};

export type Fixture<T = unknown> = Omit<VcrCassette<unknown, T>, 'recorded'> & {
  recorded?: Recorded;
};

type Sanitizer = {
  fn?: (data: unknown) => unknown;
  keys?: string[];
  isArray?: boolean;
  binaryExtension?: string;
};

type VersionFn = () => string | Promise<string>;

type VCROptions = {
  // Stable name for the upstream service. Keys the static version cache and the fixture directory.
  service: string;
  version: VersionFn;
  /** The CLI whose version stamps the cassette; freshness compares it with the blessed and installed ones. */
  cli?: string;
  model?: string;
  sanitizers?: Record<string, Sanitizer>;
};

export const agentSessionVersion = (() => {
  try {
    const url = new URL(
      '../../node_modules/@inixiative/agent-session/package.json',
      import.meta.url,
    );
    return (JSON.parse(readFileSync(url, 'utf8')) as { version: string }).version;
  } catch {
    return undefined;
  }
})();

const resolveMaxLiveCalls = (fallback: number): number => {
  const raw = process.env.FOUNDRY_VCR_MAX_LIVE ?? process.env.VCR_MAX_LIVE;
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const baseSession = createVcrSession();
let baselineMaxLiveCalls = DEFAULT_MAX_LIVE_CALLS;

/** Shared Foundry VCR session delegating budget, version cache, written paths, and drift tracking to @inixiative/vcr. */
export const foundryVcrSession: VcrSession = {
  versionCache: baseSession.versionCache,
  drift: baseSession.drift,
  written: baseSession.written,
  inFlightRecordOnce: baseSession.inFlightRecordOnce,
  get liveCalls() {
    return baseSession.liveCalls;
  },
  set liveCalls(value: number) {
    baseSession.liveCalls = value;
  },
  get maxLiveCalls() {
    return resolveMaxLiveCalls(baselineMaxLiveCalls);
  },
  set maxLiveCalls(value: number) {
    baselineMaxLiveCalls = value;
    baseSession.maxLiveCalls = value;
  },
  spendLiveCall(label: string) {
    const previous = baseSession.maxLiveCalls;
    baseSession.maxLiveCalls = resolveMaxLiveCalls(baselineMaxLiveCalls);
    try {
      baseSession.spendLiveCall(label);
    } finally {
      baseSession.maxLiveCalls = previous;
    }
  },
  seedVersion(service: string, version: string) {
    baseSession.seedVersion(service, version);
  },
  clearVersionCache() {
    baseSession.clearVersionCache();
  },
  reset() {
    baselineMaxLiveCalls = DEFAULT_MAX_LIVE_CALLS;
    baseSession.reset();
  },
};

const adaptSanitizers = (
  sanitizers?: Record<string, Sanitizer>,
): Readonly<Record<string, VcrMethodSanitizer>> | undefined => {
  if (!sanitizers) return undefined;
  const out: Record<string, VcrMethodSanitizer> = {};
  for (const [method, rule] of Object.entries(sanitizers)) {
    out[method] = {
      ...(rule.fn ? { transform: rule.fn } : {}),
      ...(rule.keys ? { keys: rule.keys } : {}),
      ...(rule.isArray !== undefined ? { isArray: rule.isArray } : {}),
      ...(rule.binaryExtension ? { binaryExtension: rule.binaryExtension } : {}),
    };
  }
  return out;
};

const relativeFixtureSubdir = (fixturesDir: string, fallback: string): string => {
  const marker = `${join('fixtures', 'vcr')}/`;
  const index = fixturesDir.lastIndexOf(marker);
  if (index === -1) return fallback;
  const suffix = fixturesDir.slice(index + marker.length).replace(/\/+$/, '');
  return suffix && !suffix.includes('/') ? suffix : fallback;
};

const withFoundryMissingHint = (error: unknown): never => {
  if (isVcrError(error, 'cassette_missing')) {
    const file = error.cassette ? basename(error.cassette) : 'cassette';
    throw new VcrError(
      'cassette_missing',
      `VCR: cassette "${file}" is missing; record it with \`bun run test:live\``,
      { cassette: error.cassette, cause: error },
    );
  }
  throw error;
};

export class VCR {
  static readonly versionCache = foundryVcrSession.versionCache;
  static readonly written = foundryVcrSession.written;

  static get drift(): DriftFinding[] {
    return foundryVcrSession.drift;
  }

  static set drift(value: DriftFinding[]) {
    foundryVcrSession.drift.splice(0, foundryVcrSession.drift.length, ...value);
  }

  static get liveCalls(): number {
    return foundryVcrSession.liveCalls;
  }

  static set liveCalls(value: number) {
    foundryVcrSession.liveCalls = value;
  }

  static spendLive(what: string): void {
    foundryVcrSession.spendLiveCall(what);
  }

  static setVersion(service: string, value: string): void {
    foundryVcrSession.seedVersion(service, value);
  }

  static clearVersionCache(): void {
    foundryVcrSession.clearVersionCache();
  }

  readonly recorder: VcrRecorder;
  readonly service: string;
  readonly cli?: string;
  readonly model?: string;

  constructor(fixturesDir: string, opts: VCROptions) {
    this.service = opts.service;
    this.cli = opts.cli;
    this.model = opts.model;
    const outputDir = process.env.FOUNDRY_VCR_OUT || undefined;
    const recorder = createVcrRecorder(fixturesDir, {
      service: opts.service,
      version: opts.version,
      environment: process.env.FOUNDRY_VCR_ENVIRONMENT ?? 'terminal',
      ...(outputDir
        ? { outputDir, outputSubdir: relativeFixtureSubdir(fixturesDir, opts.service) }
        : {}),
      ...(opts.cli ? { cli: opts.cli } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.cli && agentSessionVersion
        ? { metadata: { '@inixiative/agent-session': agentSessionVersion } }
        : {}),
      scrubber: foundryScrubber,
      sanitizers: adaptSanitizers(opts.sanitizers),
      signature: FOUNDRY_SIGNATURE_OPTIONS,
      session: foundryVcrSession,
      onDrift(finding) {
        console.warn(
          `VCR: live drift in "${basename(finding.cassette)}"; kept the committed cassette and wrote ${basename(finding.pending)}\n  ${finding.differences.join('\n  ')}`,
        );
      },
    });
    // Single-source Foundry's strict two-mode policy (`record` | `replay`) on the underlying
    // recorder so `FOUNDRY_VCR=auto` or other values can never silently trigger live calls.
    Object.defineProperty(recorder, 'mode', {
      get: () => vcrMode(),
      enumerable: true,
      configurable: true,
    });
    this.recorder = recorder;
  }

  get mode(): VcrMode {
    return vcrMode();
  }

  queue(method: string, fixture: string): this {
    this.recorder.queue(method, fixture);
    return this;
  }

  async capture<T>(method: string, realFn: () => Promise<T>): Promise<T> {
    try {
      return await this.recorder.capture(method, realFn);
    } catch (error) {
      return withFoundryMissingHint(error);
    }
  }

  async captureResponse<T>(
    method: string,
    realFn: () => Promise<VcrResponse<T>>,
  ): Promise<VcrResponse<T>> {
    try {
      return await this.recorder.captureResponse(method, realFn);
    } catch (error) {
      return withFoundryMissingHint(error);
    }
  }

  /** Records `value` live and returns what live concluded; on replay returns the recorded conclusion. */
  async outcome<T>(method: string, value: T): Promise<T> {
    try {
      return await this.recorder.recordOutcome(method, value);
    } catch (error) {
      return withFoundryMissingHint(error);
    }
  }

  fetchVersion(): Promise<string> {
    return this.recorder.fetchServiceVersion();
  }

  popFixturePath(method: string): string {
    return this.recorder.popCassettePath(method);
  }

  load<T = unknown>(requested: string): Fixture<T> {
    try {
      return this.recorder.fetchCassette<unknown, T>(requested) as Fixture<T>;
    } catch (error) {
      return withFoundryMissingHint(error);
    }
  }

  store<T = unknown>(
    fixturePath: string,
    fixture: StoreCassetteInput<unknown, T>,
    extra: Partial<VcrRecordingStamp> = {},
  ): Promise<string> {
    return this.recorder.storeCassette(fixturePath, fixture, extra);
  }

  track<T>(work: Promise<T>): Promise<T> {
    return this.recorder.trackPendingWrite(work);
  }

  settled(): Promise<void> {
    return this.recorder.waitUntilSettled();
  }

  isEmpty(): boolean {
    return this.recorder.isQueueEmpty();
  }

  clear(): void {
    this.recorder.clearQueues();
  }
}
