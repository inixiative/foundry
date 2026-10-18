// A classification run is an ordered list of stages (at most three). Each stage names who answers
// (model, effort), what it reads (a region doc), what it may answer (outcomes), whether it gives its
// why (reason), what it does (recognise, or point) and which of its outcomes go on to the next stage.
// Triggers are another axis: every trigger runs the same stages and only frames the input. Foundry
// already says "phase" for advise, guard and review, so these are stages, never phases.

import type { ClassifyOutcome } from '@inixiative/foundry-core';

export type StageOutcomes = 'binary' | 'ternary';
export type StageReason = 'none' | 'inline' | 'followup';
export type StageTask = 'recognise' | 'point';
export type StageEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * The pointer shapes a point stage may answer in. `one` (ranked: the likely one, then less likely
 * fallbacks; a class is a ranked pointer at the class level) and `all` ("A and B": each applies) are
 * always allowed. `any` ("A or B": a choose-one sibling set) is on unless turned off; off, the charter
 * no longer offers it and the parser refuses it.
 */
export interface PointerSettings {
  readonly any: boolean;
}

export interface StageConfig {
  /** Who answers; omitted, the decision model (`subscriptionOnly.model` / `defaults.classifierModel`). */
  readonly model?: string;
  /** Omitted, the decision effort. */
  readonly effort?: StageEffort;
  /** The file it reads from each region folder; every region of the role must have it. */
  readonly doc: string;
  readonly outcomes: StageOutcomes;
  readonly reason: StageReason;
  readonly task: StageTask;
  /** Point stages only. */
  readonly pointer?: PointerSettings;
  /** Every stage but the last: the outcomes that go on to the next stage, carrying their tag and why. */
  readonly escalate?: readonly Exclude<ClassifyOutcome, 'no'>[];
  /** Its share of the trigger's deadline, in (0, 1]. Omitted, an even split of what the others leave. */
  readonly deadline?: number;
}

/** A region's primary doc: the full catalogue a pointing Warden reads. */
export const KNOWLEDGE_DOC = 'knowledge.md';
export const MAX_STAGES = 3;
export const STAGE_EFFORTS: readonly StageEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Today's single-stage Warden: one pointing stage on the region's knowledge, yes or no, no why. */
export const DEFAULT_STAGE: StageConfig = Object.freeze({
  doc: KNOWLEDGE_DOC,
  outcomes: 'binary',
  reason: 'none',
  task: 'point',
  pointer: Object.freeze({ any: true }),
});
export const DEFAULT_STAGES: readonly StageConfig[] = Object.freeze([DEFAULT_STAGE]);

const STAGE_KEYS = [
  'model',
  'effort',
  'doc',
  'outcomes',
  'reason',
  'task',
  'pointer',
  'escalate',
  'deadline',
] as const;
/**
 * Eval-only: a stage of a run config may set its charter's sections (`--classify`, charters/sections.ts).
 * Settings never do: a live project's charters are Foundry's.
 */
export const EVAL_STAGE_KEYS = ['sections'] as const;
const DOC = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\.md$/;

const oneOf = <T extends string>(where: string, value: unknown, allowed: readonly T[]): T => {
  if (typeof value !== 'string' || !allowed.includes(value as T))
    throw Error(`${where} must be one of ${allowed.join(', ')}`);
  return value as T;
};

/**
 * Read a stage list (settings or a run config), filling each stage's omitted fields from the default
 * and checking that the stages fit together. `extraKeys` admits the eval-only keys a run config may
 * carry; settings pass none, so charter sections in settings are refused by name. Errors name the field.
 */
export function validateStages(
  where: string,
  value: unknown,
  extraKeys: readonly string[] = [],
): StageConfig[] {
  if (!Array.isArray(value) || !value.length)
    throw Error(`${where} must be a non-empty list of stages`);
  if (value.length > MAX_STAGES)
    throw Error(`${where} has ${value.length} stages; a run has at most ${MAX_STAGES}`);
  const stages = value.map((raw: unknown, index): StageConfig => {
    const at = `${where}[${index}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw Error(`${at} must be an object`);
    const s = raw as Record<string, unknown>;
    for (const key of Object.keys(s)) {
      if (['charter', 'charterFile', 'sections'].includes(key) && !extraKeys.includes(key))
        throw Error(
          `${at}.${key} is not a setting: charters are fixed per task and role, owned by Foundry (an eval run config may set a stage's sections)`,
        );
      if (!(STAGE_KEYS as readonly string[]).includes(key) && !extraKeys.includes(key))
        throw Error(`${at}.${key} is not a stage setting (${STAGE_KEYS.join(', ')})`);
    }
    const last = index === value.length - 1;
    const task =
      s.task === undefined
        ? DEFAULT_STAGE.task
        : oneOf(`${at}.task`, s.task, ['recognise', 'point']);
    const outcomes =
      s.outcomes === undefined
        ? DEFAULT_STAGE.outcomes
        : oneOf(`${at}.outcomes`, s.outcomes, ['binary', 'ternary']);
    const reason =
      s.reason === undefined
        ? DEFAULT_STAGE.reason
        : oneOf(`${at}.reason`, s.reason, ['none', 'inline', 'followup']);
    if (s.model !== undefined && (typeof s.model !== 'string' || !s.model.trim()))
      throw Error(`${at}.model must be a model id`);
    const effort =
      s.effort === undefined ? undefined : oneOf(`${at}.effort`, s.effort, STAGE_EFFORTS);
    const doc = s.doc === undefined ? DEFAULT_STAGE.doc : s.doc;
    if (typeof doc !== 'string' || !DOC.test(doc))
      throw Error(
        `${at}.doc must be a markdown file name in the region folder, e.g. ${KNOWLEDGE_DOC}`,
      );
    let pointer: PointerSettings | undefined;
    if (s.pointer !== undefined) {
      if (task !== 'point') throw Error(`${at}.pointer is for point stages; this one recognises`);
      const p = s.pointer as Record<string, unknown> | null;
      if (!p || typeof p !== 'object' || Array.isArray(p))
        throw Error(`${at}.pointer must be { any: boolean }`);
      for (const key of Object.keys(p))
        if (key !== 'any')
          throw Error(
            `${at}.pointer.${key} is not a pointer setting: "one" and "all" are always allowed; only "any" is a toggle`,
          );
      if (p.any !== undefined && typeof p.any !== 'boolean')
        throw Error(`${at}.pointer.any must be true or false`);
      pointer = { any: p.any !== false };
    } else if (task === 'point') pointer = DEFAULT_STAGE.pointer;
    let escalate: StageConfig['escalate'];
    if (s.escalate !== undefined) {
      if (last) throw Error(`${at}.escalate: the last stage has no next stage to escalate to`);
      if (!Array.isArray(s.escalate) || !s.escalate.length)
        throw Error(`${at}.escalate must list the outcomes that go on: yes, unsure`);
      const list = s.escalate.map((o: unknown) =>
        oneOf(`${at}.escalate`, o, ['yes', 'unsure'] as const),
      );
      if (new Set(list).size !== list.length) throw Error(`${at}.escalate names an outcome twice`);
      if (list.includes('unsure') && outcomes !== 'ternary')
        throw Error(`${at}.escalate names unsure, which only a ternary stage answers`);
      escalate = list;
    } else if (!last)
      throw Error(`${at}.escalate is required: which outcomes go on to stage ${index + 1}`);
    if (s.deadline !== undefined) {
      if (typeof s.deadline !== 'number' || !(s.deadline > 0 && s.deadline <= 1))
        throw Error(`${at}.deadline must be a share of the trigger's deadline, in (0, 1]`);
    }
    return Object.freeze({
      ...(s.model !== undefined ? { model: (s.model as string).trim() } : {}),
      ...(effort ? { effort } : {}),
      doc,
      outcomes,
      reason,
      task,
      ...(pointer ? { pointer: Object.freeze(pointer) } : {}),
      ...(escalate ? { escalate: Object.freeze([...escalate]) } : {}),
      ...(typeof s.deadline === 'number' ? { deadline: s.deadline } : {}),
    });
  });
  const shared = stages.reduce((sum, s) => sum + (s.deadline ?? 0), 0);
  if (shared > 1 + 1e-9)
    throw Error(
      `${where}: the stages' deadline shares add up to ${Math.round(shared * 1000) / 1000}, more than the whole deadline`,
    );
  const zero = deadlineShares(stages).findIndex((share) => share <= 1e-9);
  if (zero >= 0)
    throw Error(
      `${where}[${zero}] has no share of the deadline left: the other stages' shares take it all`,
    );
  return stages;
}

/** Each stage's share of the trigger's deadline: as set, else an even split of what the set ones leave. */
export function deadlineShares(stages: readonly StageConfig[]): number[] {
  const set = stages.reduce((sum, s) => sum + (s.deadline ?? 0), 0);
  const unset = stages.filter((s) => s.deadline === undefined).length;
  const rest = unset ? Math.max(0, 1 - set) / unset : 0;
  return stages.map((s) => s.deadline ?? rest);
}

/** Whether a stage list is today's single-stage Warden (the default every setting starts from). */
export function isDefaultStages(stages: readonly StageConfig[]): boolean {
  return stages.length === 1 && sameStage(stages[0]!, DEFAULT_STAGE);
}

function sameStage(a: StageConfig, b: StageConfig): boolean {
  return (
    a.model === b.model &&
    a.effort === b.effort &&
    a.doc === b.doc &&
    a.outcomes === b.outcomes &&
    a.reason === b.reason &&
    a.task === b.task &&
    a.pointer?.any === b.pointer?.any &&
    a.deadline === b.deadline
  );
}

/** The distinct docs a stage list reads, in stage order: what every region of the role must hold. */
export function stageDocs(stages: readonly StageConfig[]): string[] {
  return [...new Set(stages.map((s) => s.doc))];
}
