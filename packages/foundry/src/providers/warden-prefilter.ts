/**
 * @atlas
 * @kind service
 * @partOf feature:wardens
 */
// The Warden pre-filter: before a trigger fans out to the Wardens, one local decision-model call
// asks, per Warden, "is this moment about your domain?" A Warden is skipped only on a confident no
// (its score below `skipBelow`); an unsure score, a failed call or a missing model asks every
// Warden, as without the pre-filter. The model (providers/prefilter-model.ts) runs locally and
// answers TypeSafe's System One API, so the call goes through TypeSafeDecisionClient.

import {
  ActionQueue,
  CapabilityGate,
  type PrefilterTrigger,
  prefilterDescription,
  prefilterQuestion,
  prefilterSkips,
  prefilterState,
} from '@inixiative/foundry-core';
import { TypeSafeDecisionClient } from './typesafe';

/**
 * `prefilter` in settings. Off by default (no local model clears the bar yet; Aron, 2026-10-15): off
 * asks every Warden on every trigger and starts no model server. `enabled: true` opts in.
 */
export interface PrefilterSettings {
  enabled?: boolean;
  /** The local System One server. Loopback only: the moment never leaves the machine. */
  baseUrl?: string;
  /** The server's checkpoint name. */
  model?: string;
  /** Skip a Warden when its score is below this. */
  skipBelow?: number;
  /** One call per trigger; past this the trigger asks every Warden. */
  timeoutMs?: number;
}

/** The port registry's `decisions` service (default 8180) in Foundry's block (5). */
export const PREFILTER_PORT = 8680;

export const DEFAULT_PREFILTER: Required<PrefilterSettings> = Object.freeze({
  enabled: false,
  baseUrl: `http://127.0.0.1:${PREFILTER_PORT}`,
  model: 'kev-latest',
  skipBelow: 0.26,
  timeoutMs: 3_000,
});

export function resolvePrefilterSettings(
  settings: PrefilterSettings | undefined,
): Required<PrefilterSettings> {
  return { ...DEFAULT_PREFILTER, ...settings };
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Settings validation: names the field, never echoes content. */
export function validatePrefilterSettings(where: string, value: unknown): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error(`${where} must be an object`);
  const settings = value as Record<string, unknown>;
  for (const key of Object.keys(settings))
    if (!['enabled', 'baseUrl', 'model', 'skipBelow', 'timeoutMs'].includes(key))
      throw Error(`${where}: unknown field ${key}`);
  if (settings.enabled !== undefined && typeof settings.enabled !== 'boolean')
    throw Error(`${where}.enabled must be a boolean`);
  if (settings.baseUrl !== undefined) {
    let url: URL;
    try {
      url = new URL(String(settings.baseUrl));
    } catch {
      throw Error(`${where}.baseUrl must be a URL`);
    }
    if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname))
      throw Error(
        `${where}.baseUrl must be a loopback http URL: the moment never leaves the machine`,
      );
  }
  if (settings.model !== undefined && (typeof settings.model !== 'string' || !settings.model))
    throw Error(`${where}.model must be a non-empty string`);
  if (
    settings.skipBelow !== undefined &&
    (typeof settings.skipBelow !== 'number' || !(settings.skipBelow >= 0 && settings.skipBelow < 1))
  )
    throw Error(`${where}.skipBelow must be a number from 0 to below 1`);
  if (
    settings.timeoutMs !== undefined &&
    (!Number.isInteger(settings.timeoutMs) ||
      (settings.timeoutMs as number) < 100 ||
      (settings.timeoutMs as number) > 30_000)
  )
    throw Error(`${where}.timeoutMs must be an integer from 100 to 30000`);
}

/** A Warden as the pre-filter sees it: its domain and its own composed instructions. */
export interface PrefilterWarden {
  readonly domain: string;
  readonly instructions: string;
}

/** One trigger's pre-filter outcome. `unavailable` asks every Warden. */
export type PrefilterOutcome =
  | {
      readonly status: 'scored';
      readonly scores: ReadonlyMap<string, number>;
      readonly skipBelow: number;
      readonly elapsedMs: number;
    }
  | { readonly status: 'unavailable'; readonly reason: string; readonly elapsedMs: number };

/** What a Warden skipped by the pre-filter carries into the journal. */
export interface PrefilterSkip {
  readonly score: number;
  readonly skipBelow: number;
}

/** The skip for one domain, or undefined when it is asked. */
export function prefilterSkip(
  outcome: PrefilterOutcome | undefined,
  domain: string,
): PrefilterSkip | undefined {
  if (outcome?.status !== 'scored') return undefined;
  const score = outcome.scores.get(domain);
  return prefilterSkips(score, outcome.skipBelow)
    ? { score: score as number, skipBelow: outcome.skipBelow }
    : undefined;
}

export interface PrefilterHealth {
  readonly ok: boolean;
  readonly reason?: string;
}

export class WardenPrefilter {
  readonly settings: Required<PrefilterSettings>;
  private readonly client: TypeSafeDecisionClient;
  private readonly send: (url: string, init: RequestInit) => Promise<Response>;
  /** Called when availability changes (available → unavailable and back), for the viewer and logs. */
  private readonly onHealth?: (health: PrefilterHealth) => void;
  private lastOk: boolean | undefined;

  constructor(
    settings: PrefilterSettings | undefined,
    deps: {
      fetch?: (url: string, init: RequestInit) => Promise<Response>;
      onHealth?: (health: PrefilterHealth) => void;
    } = {},
  ) {
    validatePrefilterSettings('prefilter', settings);
    this.settings = resolvePrefilterSettings(settings);
    this.send = deps.fetch ?? globalThis.fetch;
    this.onHealth = deps.onHealth;
    this.client = new TypeSafeDecisionClient({
      // The local server is the whole boundary: a loopback URL, no credential.
      gate: new CapabilityGate(
        { defaults: 'deny', capabilities: { 'net:api': 'allow', 'llm:call': 'allow' } },
        new ActionQueue(),
      ),
      baseUrl: this.settings.baseUrl,
      model: this.settings.model,
      apiKeyEnv: 'FOUNDRY_PREFILTER_KEY',
      environment: { FOUNDRY_PREFILTER_KEY: 'local' },
      timeoutMs: this.settings.timeoutMs,
      maxRetries: 0,
      fetch: this.send,
    });
  }

  /** One call for the trigger: a score per Warden, or `unavailable` (every Warden is asked). */
  async score(
    trigger: PrefilterTrigger,
    text: string,
    context: string | undefined,
    wardens: readonly PrefilterWarden[],
    threadId: string,
  ): Promise<PrefilterOutcome> {
    const started = Date.now();
    const asked = wardens.filter((w) => w.instructions.trim());
    if (!asked.length) return { status: 'scored', scores: new Map(), skipBelow: 0, elapsedMs: 0 };
    const questions = Object.fromEntries(
      asked.map((w, i) => [`w${i}`, prefilterQuestion(prefilterDescription(w.instructions))]),
    );
    try {
      const result = await this.client.evaluate(prefilterState(trigger, text, context), questions, {
        agentId: 'warden-prefilter',
        threadId,
      });
      const scores = new Map(
        asked.map((w, i) => [w.domain, (result.answers[`w${i}`] as { noul: number }).noul]),
      );
      this.health({ ok: true });
      return {
        status: 'scored',
        scores,
        skipBelow: this.settings.skipBelow,
        elapsedMs: Date.now() - started,
      };
    } catch (error) {
      const reason = (error as Error)?.message ?? String(error);
      this.health({ ok: false, reason });
      return { status: 'unavailable', reason, elapsedMs: Date.now() - started };
    }
  }

  /** Whether the model server answers its health check now (setup, doctor). */
  async check(timeoutMs = 2_000): Promise<PrefilterHealth> {
    const health = await this.probe(timeoutMs);
    this.health(health);
    return health;
  }

  /** Poll until the server answers or `withinMs` passes (it loads its model at start); reports once. */
  async waitReady(withinMs: number): Promise<PrefilterHealth> {
    const deadline = Date.now() + withinMs;
    let health = await this.probe(2_000);
    while (!health.ok && Date.now() < deadline) {
      await Bun.sleep(1_000);
      health = await this.probe(2_000);
    }
    this.health(health);
    return health;
  }

  private async probe(timeoutMs: number): Promise<PrefilterHealth> {
    const get = (path: string) =>
      this.send(`${this.settings.baseUrl}${path}`, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    try {
      // `/health` where the server has one; System One servers without it list `/v1/models`.
      const health = await get('/health');
      const response = health.status === 404 ? await get('/v1/models') : health;
      const body = (await response.json().catch(() => ({}))) as { status?: unknown };
      return response.ok && (response !== health || body.status === 'ok')
        ? { ok: true }
        : { ok: false, reason: `model server answered HTTP ${response.status}` };
    } catch {
      return {
        ok: false,
        reason: `no model server at ${this.settings.baseUrl}; run \`foundry-acp setup\``,
      };
    }
  }

  private health(health: PrefilterHealth): void {
    if (this.lastOk === health.ok) return;
    this.lastOk = health.ok;
    this.onHealth?.(health);
  }
}
