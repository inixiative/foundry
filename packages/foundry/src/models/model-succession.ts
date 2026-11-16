/**
 * @atlas
 * @kind service
 * @partOf primitive:modelRegistry
 */

import { nativeModelMissing } from '@inixiative/agent-session';
import {
  type ActionQueue,
  type FoundryProviderInfo,
  MODEL_REGISTRY,
  readModelRetirement,
  resolveModelAliasToModelId,
  type Thread,
  type ThreadModel,
} from '@inixiative/foundry-core';
import type { LocalSessionStore } from '../persistence/local-session-store';
import { changeThreadModel, type ThreadModelDeps } from '../turns/thread-model';
import type { FoundryConfig } from '../viewer/config';
import { choosableThreadModels } from './registry';

/** The audit actor of the settings rewrite (`.foundry/audit.jsonl`). */
export const MODEL_SUCCESSION_AUTHOR = 'foundry:model-succession';

/** A setting that named a retired model, and what it names now (`to` absent: no successor, left as it was). */
export interface SettingSuccession {
  path: string;
  provider: string;
  from: string;
  to?: string;
  reason?: string;
}

export interface ModelSuccessionDeps extends ThreadModelDeps {
  /** Also asked whether a thread has a turn still open, which the boot sweep leaves to that turn. */
  readonly store?: ThreadModelDeps['store'] & Pick<LocalSessionStore, 'openTurn'>;
  /** Where a revived thread on a retired model asks its person for one. Absent: it is refused. */
  readonly queue?: ActionQueue | null;
  readonly registry?: Record<string, FoundryProviderInfo>;
  readonly log?: (line: string) => void;
}

/** The question a revived thread on a retired model asks before its turn runs. */
export const reviveAsk = (model: string, at: string) =>
  `This thread ran on ${model}, which was retired on ${at}. Choose the model it continues on.`;

/**
 * Why a retired model was not used: the one wording, for a turn refused here and for a person's
 * choice refused by the launch route. `why` says what is missing (no successor); absent, the
 * successor or another model is offered.
 */
export const retiredModelRefusal = (
  model: string,
  retirement: { at: string; successor?: string },
  why?: string,
) =>
  why
    ? `${model} was retired on ${retirement.at}: ${why}. Choose another model for this thread, then send again.`
    : `${model} was retired on ${retirement.at}; choose ${retirement.successor ?? 'another model'}.`;

/**
 * Moving off retired models (Aron, 2026-11-15; `docs/rules/subscriptions-and-capacity.md`): only
 * open threads move, each to the newest model of its own family on its own worker
 * (`readModelRetirement`), behind a "Switched to" marker (`changeThreadModel`); the worker never
 * changes. A thread revived from archive on a retired model asks its person instead, with a
 * structural choice prompt, and its turns wait on the answer. Settings naming a retired model move
 * in one audited update. A newer release never moves a model that is still served.
 */
export class ModelSuccession {
  private readonly registry: Record<string, FoundryProviderInfo>;
  /** Open revive prompts, by turn: a stop withdraws them. */
  private readonly asks = new Map<string, AbortController>();

  constructor(private readonly deps: ModelSuccessionDeps) {
    this.registry = deps.registry ?? MODEL_REGISTRY;
  }

  /**
   * A thread just came back from archive: if its model is retired, it holds the ask on its record
   * (`retiredModelChoice`, saved by the caller), so every turn asks until its person chooses, across
   * restarts.
   */
  revived(thread: Pick<Thread, 'id' | 'meta'>): void {
    const model = thread.meta.model?.id;
    const worker = thread.meta.worker;
    if (!model || !worker) return;
    const retirement = readModelRetirement(worker, model, this.registry);
    if (retirement.retired) thread.meta.retiredModelChoice = { model, retiredAt: retirement.at };
  }

  /**
   * At the front of the thread's queue, before its turn starts (nothing else of the thread runs):
   * move the thread off a retired model, or ask for one on a revived thread. Returns why the turn
   * must not run, or null when it may.
   */
  async beforeTurn(thread: Pick<Thread, 'id' | 'meta'>, turnId: string): Promise<string | null> {
    const model = thread.meta.model;
    const worker = thread.meta.worker;
    if (!model || !worker) return null;
    const retirement = readModelRetirement(worker, model.id, this.registry);
    if (!retirement.retired) {
      if (thread.meta.retiredModelChoice) {
        delete thread.meta.retiredModelChoice;
        this.deps.store?.saveThread(thread);
      }
      return null;
    }
    if (thread.meta.retiredModelChoice) return this.ask(thread, worker, model, retirement, turnId);
    if (!retirement.successor)
      return retiredModelRefusal(model.id, retirement, retirement.reason ?? 'it has no successor');
    changeThreadModel(
      this.deps,
      thread,
      this.successorOf(worker, model, retirement.successor),
      'retired',
    );
    return null;
  }

  /**
   * A turn failed because its worker's CLI says the model does not exist (`nativeModelMissing`):
   * the model is retired though the registry does not say so yet. The thread moves now, behind the
   * marker, to the newest model of its family on the same worker that is newer than it, and the
   * turn's error says so and asks to send again; with none, it asks for another model. Returns that error, or undefined when the failure was something else.
   */
  modelMissing(thread: Pick<Thread, 'id' | 'meta'>, error: unknown): string | undefined {
    const missing = nativeModelMissing(error);
    const model = thread.meta.model;
    const worker = thread.meta.worker;
    // Only the thread's own model: another executor's missing model is not this thread's retirement.
    if (!missing || !model || !worker || missing.model !== model.id) return undefined;
    // Up the family only: a model listed above the missing one (each family lists its newest first).
    const listed = this.registry[worker]?.models ?? [];
    const at = listed.findIndex((entry) => entry.id === model.id);
    const family = listed[at]?.family;
    const newer = new Set(listed.slice(0, Math.max(at, 0)).map((entry) => entry.id));
    const next = family
      ? choosableThreadModels(worker, this.registry).find(
          (entry) => entry.family === family && newer.has(entry.id) && entry.id !== missing.model,
        )
      : undefined;
    const gone = `${model.id} is no longer served (the CLI says it does not exist)`;
    if (!next) return `${gone}. Choose another model for this thread, then send again.`;
    changeThreadModel(this.deps, thread, this.successorOf(worker, model, next.id), 'retired');
    return `${gone}. This thread now runs on ${next.id}; send again.`;
  }

  /** A stopped turn: withdraw its revive prompt. */
  release(turnId: string): void {
    this.asks.get(turnId)?.abort();
  }

  /**
   * At boot, an idle open thread on a retired model moves now, so it shows its new model before
   * anyone sends. Archived threads stay, and so does one waiting on its person's choice; one with no
   * successor, or with a turn still open (recovery settles it first), is left for its next turn.
   * Returns whether it moved.
   */
  moveIdle(thread: Pick<Thread, 'id' | 'meta'>): boolean {
    const model = thread.meta.model;
    const worker = thread.meta.worker;
    if (!model || !worker || thread.meta.archivedAt !== undefined) return false;
    if (thread.meta.retiredModelChoice || this.deps.store?.openTurn(thread.id)) return false;
    const retirement = readModelRetirement(worker, model.id, this.registry);
    if (!retirement.retired || !retirement.successor) return false;
    changeThreadModel(
      this.deps,
      thread,
      this.successorOf(worker, model, retirement.successor),
      'retired',
    );
    return true;
  }

  /**
   * Every setting naming a retired model (a `model` key or one ending in `Model`, read against the
   * provider in scope), moved to its successor in one update audited as `foundry:model-succession`.
   * A committed `.foundry/project.json` is the repository's and is not rewritten.
   */
  async succeedSettings(store: {
    config: FoundryConfig;
    update(
      fn: (draft: FoundryConfig) => FoundryConfig | void,
      expectedRevision: undefined,
      author: string,
    ): Promise<unknown>;
  }): Promise<SettingSuccession[]> {
    let changes = settingSuccessions(store.config, this.registry);
    if (changes.some((change) => change.to))
      await store.update(
        (draft) => {
          changes = settingSuccessions(draft, this.registry, true);
        },
        undefined,
        MODEL_SUCCESSION_AUTHOR,
      );
    for (const change of changes)
      this.deps.log?.(
        change.to
          ? `[Models] ${change.path}: ${change.from} was retired, now ${change.to}`
          : `[Models] ${change.path}: ${change.from} was retired and ${change.reason}; left as it is`,
      );
    return changes;
  }

  /** The successor, keeping the thread's alias when the alias now points to it. */
  private successorOf(worker: string, model: ThreadModel, successor: string): ThreadModel {
    return model.alias &&
      resolveModelAliasToModelId(worker, model.alias, this.registry) === successor
      ? { id: successor, alias: model.alias }
      : { id: successor };
  }

  private async ask(
    thread: Pick<Thread, 'id' | 'meta'>,
    worker: string,
    model: ThreadModel,
    retirement: { at: string; successor?: string },
    turnId: string,
  ): Promise<string | null> {
    const refusal = retiredModelRefusal(
      model.id,
      retirement,
      'this thread came back from archive and waits for its model to be chosen (in the Foundry viewer)',
    );
    const queue = this.deps.queue;
    if (!queue) return refusal;
    const choices = choosableThreadModels(worker, this.registry).sort(
      (a, b) => Number(b.id === retirement.successor) - Number(a.id === retirement.successor),
    );
    if (!choices.length) return refusal;
    const abort = new AbortController();
    this.asks.set(turnId, abort);
    try {
      const resolution = await queue.prompt({
        kind: 'choice',
        threadId: thread.id,
        agentId: 'foundry',
        capability: 'model-succession',
        message: reviveAsk(model.id, retirement.at),
        options: choices.map((choice) => ({
          id: choice.id,
          label:
            choice.id === retirement.successor ? `${choice.label} (its successor)` : choice.label,
        })),
        meta: { structural: true, modelSuccession: { from: model.id, worker } },
        signal: abort.signal,
      });
      const chosen = choices.find((choice) => choice.id === resolution.action);
      if (resolution.by !== 'human' || !chosen) return refusal;
      changeThreadModel(this.deps, thread, { id: chosen.id }, 'person');
      return null;
    } finally {
      this.asks.delete(turnId);
    }
  }
}

const isModelKey = (key: string) => key === 'model' || /[a-z]Model$/.test(key);

/** The provider key paired with a model key: `classifierModel` → `classifierProvider`. */
const pairedProviderKey = (key: string) =>
  key === 'model' ? undefined : `${key.slice(0, -'Model'.length)}Provider`;

/**
 * The settings naming a retired model, walked over the whole config: each string under a model key
 * is read against its paired provider key (`classifierModel` against `classifierProvider`), else
 * its object's `provider` (or `worker`), else the nearest one above, else `defaults.provider`. A
 * model that provider does not list is read against the one provider that lists it; listed by
 * several or none, it is left as it is. With `apply`, each one with a successor is replaced in
 * place.
 */
export function settingSuccessions(
  config: FoundryConfig,
  registry: Record<string, FoundryProviderInfo> = MODEL_REGISTRY,
  apply = false,
): SettingSuccession[] {
  const changes: SettingSuccession[] = [];
  const lists = (provider: string, id: string) =>
    registry[provider]?.models.some((model) => model.id === id) ?? false;
  const providerOf = (id: string, scope: string | undefined) => {
    if (scope && lists(scope, id)) return scope;
    const listing = Object.keys(registry).filter((provider) => lists(provider, id));
    return listing.length === 1 ? listing[0] : undefined;
  };
  const scopeOf = (node: Record<string, unknown>, above: string | undefined) => {
    const own = node.provider ?? node.worker;
    return typeof own === 'string' ? own : above;
  };
  const walk = (node: unknown, path: string, above: string | undefined) => {
    if (Array.isArray(node)) {
      for (const [index, item] of node.entries()) walk(item, `${path}[${index}]`, above);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    const scope = scopeOf(record, above);
    for (const [key, value] of Object.entries(record)) {
      const at = path ? `${path}.${key}` : key;
      if (typeof value === 'string' && isModelKey(key)) {
        const paired = pairedProviderKey(key);
        const own = paired ? record[paired] : undefined;
        const provider = providerOf(value, typeof own === 'string' ? own : scope);
        if (!provider) continue;
        const retirement = readModelRetirement(provider, value, registry);
        if (!retirement.retired) continue;
        if (retirement.successor) {
          if (apply) record[key] = retirement.successor;
          changes.push({ path: at, provider, from: value, to: retirement.successor });
        } else
          changes.push({
            path: at,
            provider,
            from: value,
            reason: retirement.reason ?? 'it has no successor',
          });
      } else walk(value, at, scope);
    }
  };
  walk(config, '', config.defaults?.provider);
  return changes;
}
