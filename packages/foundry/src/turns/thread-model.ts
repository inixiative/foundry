/**
 * @atlas
 * @kind service
 * @partOf feature:threads
 */
import { newId, type Thread, type ThreadModel } from '@inixiative/foundry-core';
import { workerName } from '../models/registry';
import type { LocalSessionStore } from '../persistence/local-session-store';
import type { ThreadLaunchSettings } from '../providers/thread-launch';
import { WORKER_SWITCH_PHASE, type WorkerSwitchRecord } from './journal-history';

export interface ThreadModelDeps {
  readonly store?: Pick<LocalSessionStore, 'appendPhase' | 'saveThread' | 'recentTurnIds'>;
  readonly launch: Pick<ThreadLaunchSettings, 'modelChanged'>;
}

/**
 * Change a thread's model on its own worker: the one writer of `ThreadMeta.model` after creation
 * (a person's choice, a revival's answer, or succession from a retired model). A thread that has
 * run gets its marker first ("Switched to <model> from here", `WORKER_SWITCH_PHASE` with
 * `from === to`), then the record is saved behind it (the store refuses a model change after the
 * first turn without one), then its launch revision is bumped so the warm session relaunches on
 * the new model, resuming the same native binding. A worker switch writes its own marker naming
 * both changes (`viewer/routes/runtime.ts`). Returns the marker written, if any.
 */
export function changeThreadModel(
  deps: ThreadModelDeps,
  thread: Pick<Thread, 'id' | 'meta'>,
  next: ThreadModel,
  cause: NonNullable<WorkerSwitchRecord['cause']>,
  worker = thread.meta.worker,
): WorkerSwitchRecord | undefined {
  const from = thread.meta.model;
  if (from?.id === next.id && from?.alias === next.alias) return undefined;
  delete thread.meta.retiredModelChoice;
  const moved = from?.id !== next.id;
  let marker: WorkerSwitchRecord | undefined;
  if (moved && from && worker && (deps.store?.recentTurnIds(thread.id, 1).length ?? 0) > 0) {
    marker = {
      from: worker,
      to: worker,
      fromLabel: workerName(worker),
      toLabel: workerName(worker),
      fromSession: null,
      fromModel: from.id,
      toModel: next.id,
      cause,
    };
    deps.store?.appendPhase(
      { id: thread.id, meta: structuredClone(thread.meta) },
      {
        id: newId('phase'),
        phase: WORKER_SWITCH_PHASE,
        turnId: null,
        dispatchId: null,
        record: { ...marker },
      },
    );
  }
  thread.meta.model = next.alias ? { id: next.id, alias: next.alias } : { id: next.id };
  deps.store?.saveThread(thread);
  if (moved) deps.launch.modelChanged(thread.id);
  return marker;
}
