// Ported from the template's packages/shared/src/vcr/vcr.ts. Differences, all driven by
// Foundry's live-first policy: the mode is explicit (replay never calls live; record always
// does), a recording is stamped with who/what/when, and a recording whose structure drifted
// from the committed cassette is written beside it as pending instead of overwriting it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { signatureOf, compareSignatures, type Signature } from "./signature";

export type VcrMode = "replay" | "record";
/** `bun run test` replays; `bun run test:live` and the launchd smoke record. */
export const vcrMode = (): VcrMode => process.env.FOUNDRY_VCR === "record" ? "record" : "replay";

export type Recorded = {
  service: string;
  cli?: string;
  model?: string;
  recordedAt: string;
  /** @inixiative/agent-session version the recording ran through. */
  agentSession?: string;
  /** Terminal (test:live) or the LaunchAgent environment (test:live:daemon). */
  environment: string;
  durationMs?: number;
};

export type Fixture<T = unknown> = {
  /** Upstream version: the CLI version, or a hash of the service's API description. */
  version?: string;
  status: number;
  body?: T | null;
  bodyFile?: string;
  headers?: Record<string, string>;
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

export type DriftFinding = { cassette: string; pending: string; differences: string[] };

export const agentSessionVersion = (() => {
  try {
    const url = new URL("../../node_modules/@inixiative/agent-session/package.json", import.meta.url);
    return (JSON.parse(readFileSync(url, "utf8")) as { version: string }).version;
  } catch { return undefined; }
})();

export class VCR {
  // Shared across all instances; the live runner pre-seeds it so each VCR never pays the CLI cost.
  static versionCache = new Map<string, string>();
  /** Structural drift found while recording; the live runner reports these. */
  static drift: DriftFinding[] = [];
  /** Where this process last wrote each cassette (pending on drift), so an in-run replay reads the new recording. */
  static written = new Map<string, string>();

  /** Live calls this process has made; recording refuses past FOUNDRY_VCR_MAX_LIVE (default 40). */
  static liveCalls = 0;
  static spendLive(what: string): void {
    const limit = Number(process.env.FOUNDRY_VCR_MAX_LIVE ?? 40);
    if (++VCR.liveCalls > limit) throw Error(`VCR: live call budget of ${limit} spent; refusing ${what}`);
  }

  static setVersion(service: string, value: string): void {
    VCR.versionCache.set(service, value);
  }

  static clearVersionCache(): void {
    VCR.versionCache.clear();
  }

  readonly service: string;
  readonly cli?: string;
  readonly model?: string;
  private readonly fixturesDir: string;
  private readonly sanitizers: Record<string, Sanitizer>;
  private readonly queues = new Map<string, string[]>();
  private readonly versionFn: VersionFn;
  private readonly saving = new Set<Promise<unknown>>();

  constructor(fixturesDir: string, opts: VCROptions) {
    this.fixturesDir = fixturesDir;
    this.sanitizers = opts.sanitizers ?? {};
    this.versionFn = opts.version;
    this.service = opts.service;
    this.cli = opts.cli;
    this.model = opts.model;
  }

  get mode(): VcrMode { return vcrMode(); }

  queue(method: string, fixture: string): this {
    const q = this.queues.get(method) ?? [];
    q.push(fixture);
    this.queues.set(method, q);
    return this;
  }

  async capture<T>(method: string, realFn: () => Promise<T>): Promise<T> {
    const fixturePath = this.popFixturePath(method);
    if (this.mode === "replay") {
      const saved = this.load<T>(fixturePath);
      if (saved.status >= 400) throw new Error(typeof saved.body === "string" ? saved.body : JSON.stringify(saved.body));
      if (saved.bodyFile) return readFileSync(join(dirname(fixturePath), saved.bodyFile)) as unknown as T;
      return saved.body as T;
    }
    VCR.spendLive(`${this.service} ${method}`);
    const started = Date.now();
    try {
      const sanitized = this.sanitize(method, await realFn());
      await this.saveFixture(fixturePath, method, sanitized, 200, undefined, { durationMs: Date.now() - started });
      return sanitized;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store(fixturePath, { status: 500, body: message }, { durationMs: Date.now() - started });
      throw error;
    }
  }

  async captureResponse<T>(method: string, realFn: () => Promise<Fixture<T>>): Promise<Fixture<T>> {
    const fixturePath = this.popFixturePath(method);
    if (this.mode === "replay") {
      const saved = this.load<T>(fixturePath);
      const body = saved.bodyFile
        ? (readFileSync(join(dirname(fixturePath), saved.bodyFile)) as unknown as T)
        : (saved.body as T);
      return { status: saved.status, body, ...(saved.headers && { headers: saved.headers }) };
    }
    VCR.spendLive(`${this.service} ${method}`);
    const started = Date.now();
    const raw = await realFn();
    return this.saveFixture<T>(fixturePath, method, this.sanitize(method, raw.body) as T, raw.status, raw.headers, { durationMs: Date.now() - started });
  }

  /** Records `value` live and returns what live concluded; on replay returns the recorded conclusion.
   * Tests compare their replayed conclusion with it, so every replay proves it matches live. */
  async outcome<T>(method: string, value: T): Promise<T> {
    const fixturePath = this.popFixturePath(method);
    if (this.mode === "replay") return this.load<T>(fixturePath).body as T;
    const body = JSON.parse(JSON.stringify(value)) as T;
    await this.store(fixturePath, { status: 200, body });
    return body;
  }

  // Public: capture/captureResponse resolve through this; the live runner and freshness share it.
  async getVersion(): Promise<string> {
    const cached = VCR.versionCache.get(this.service);
    if (cached !== undefined) return cached;
    const resolved = await this.versionFn();
    if (!resolved) throw new Error(`VCR: version callback resolved to empty string (service=${this.service})`);
    VCR.versionCache.set(this.service, resolved);
    return resolved;
  }

  /** Pops the next queued cassette for `method`. Transports hold the path across a live exchange. */
  popFixturePath(method: string): string {
    const q = this.queues.get(method);
    const fixtureName = q?.shift();
    if (!fixtureName) throw new Error(`VCR: no cassette queued for "${method}"`);
    return join(this.fixturesDir, `${method}.${fixtureName}.json`);
  }

  load<T = unknown>(requested: string): Fixture<T> {
    const fixturePath = VCR.written.get(requested) ?? requested;
    if (!existsSync(fixturePath))
      throw new Error(`VCR: cassette "${basename(fixturePath)}" is missing; record it with \`bun run test:live\``);
    return JSON.parse(readFileSync(fixturePath, "utf-8")) as Fixture<T>;
  }

  /** Stamps and writes a recording. Drift from the committed cassette goes to `<name>.pending.json`. */
  store(fixturePath: string, fixture: Omit<Fixture, "version" | "recorded">, extra: Partial<Recorded> = {}): Promise<string> {
    const saving = (async () => {
      const version = await this.getVersion();
      const recorded: Recorded = {
        service: this.service,
        ...(this.cli ? { cli: this.cli } : {}),
        ...(this.model ? { model: this.model } : {}),
        recordedAt: new Date().toISOString(),
        ...(agentSessionVersion ? { agentSession: agentSessionVersion } : {}),
        environment: process.env.FOUNDRY_VCR_ENVIRONMENT ?? "terminal",
        ...extra,
      };
      const next: Fixture = { version, ...fixture, recorded };
      const target = this.targetPath(fixturePath, next);
      write(target, next);
      VCR.written.set(fixturePath, target);
      return target;
    })();
    this.track(saving);
    return saving;
  }

  /** Holds `settled()` open until a recording that finishes asynchronously is written. */
  track<T>(work: Promise<T>): Promise<T> {
    this.saving.add(work);
    void work.finally(() => this.saving.delete(work)).catch(() => {});
    return work;
  }

  /** Resolves once every recording started so far is on disk. */
  async settled(): Promise<void> {
    while (this.saving.size) await Promise.allSettled([...this.saving]);
  }

  private targetPath(fixturePath: string, next: Fixture): string {
    const out = process.env.FOUNDRY_VCR_OUT ? join(process.env.FOUNDRY_VCR_OUT, relativeFixture(fixturePath)) : fixturePath;
    if (!existsSync(fixturePath)) return out;
    const committed = JSON.parse(readFileSync(fixturePath, "utf-8")) as Fixture;
    const differences = compareSignatures(signature(committed), signature(next));
    if (!differences.length) return out;
    const pending = out.replace(/\.json$/, ".pending.json");
    VCR.drift.push({ cassette: fixturePath, pending, differences });
    console.warn(`VCR: live drift in "${basename(fixturePath)}"; kept the committed cassette and wrote ${basename(pending)}\n  ${differences.join("\n  ")}`);
    return pending;
  }

  private async saveFixture<T>(
    fixturePath: string,
    method: string,
    body: T,
    status: number,
    headers?: Record<string, string>,
    extra?: Partial<Recorded>,
  ): Promise<Fixture<T>> {
    if (body instanceof Uint8Array || body instanceof Buffer) {
      const ext = this.sanitizers[method]?.binaryExtension ?? ".bin";
      const baseName = basename(fixturePath, extname(fixturePath));
      const sidecarName = `${baseName}${ext}`;
      const sidecarPath = join(dirname(fixturePath), sidecarName);
      mkdirSync(dirname(sidecarPath), { recursive: true });
      writeFileSync(sidecarPath, body as Uint8Array);
      await this.store(fixturePath, { status, bodyFile: sidecarName, ...(headers && { headers }) }, extra);
      return { status, body: body as T, ...(headers && { headers }) };
    }
    await this.store(fixturePath, { status, body, ...(headers && { headers }) }, extra);
    return { status, body, ...(headers && { headers }) };
  }

  private sanitize<T>(method: string, data: T): T {
    const rule = this.sanitizers[method];
    if (!rule) return data;
    if (data instanceof Uint8Array || data instanceof Buffer) return data;
    if (rule.isArray && Array.isArray(data)) {
      return data.map((item) => this.applyRule(rule, item)) as unknown as T;
    }
    return this.applyRule(rule, data);
  }

  private applyRule<T>(rule: Sanitizer, data: T): T {
    const transformed = rule.fn ? (rule.fn(data) as T) : data;
    if (rule.keys?.length) return redactKeys(transformed, rule.keys);
    return transformed;
  }

  isEmpty(): boolean {
    for (const q of this.queues.values()) {
      if (q.length > 0) return false;
    }
    return true;
  }

  clear(): void {
    this.queues.clear();
  }
}

const signature = (fixture: Fixture): Signature => signatureOf(fixture.status, fixture.body);

const relativeFixture = (fixturePath: string) => {
  const marker = `${join("fixtures", "vcr")}/`;
  const index = fixturePath.lastIndexOf(marker);
  return index === -1 ? basename(fixturePath) : fixturePath.slice(index + marker.length);
};

const write = (fixturePath: string, data: unknown): void => {
  mkdirSync(dirname(fixturePath), { recursive: true });
  writeFileSync(fixturePath, `${JSON.stringify(data, null, 2)}\n`);
};

const redactKeys = <T>(data: T, keys: string[]): T => {
  if (!keys.length) return data;
  const clone = JSON.parse(JSON.stringify(data)) as T;
  for (const key of keys) redactPath(clone, key.split("."));
  return clone;
};

const redactPath = (obj: unknown, parts: string[]): void => {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) redactPath(item, parts);
    return;
  }
  const record = obj as Record<string, unknown>;
  const [head, ...rest] = parts;
  if (rest.length === 0) {
    if (head in record) {
      const v = record[head];
      record[head] = v === null || v === undefined || typeof v === "object" ? v : "REDACTED";
    }
  } else {
    redactPath(record[head], rest);
  }
};
