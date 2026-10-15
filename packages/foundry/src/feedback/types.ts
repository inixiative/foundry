import type { CorrectionCategory, CorrectionSignal } from '@inixiative/foundry-core';

/**
 * The feedback lifecycle's journal records (docs/FEEDBACK-LOOP.md, "Lifecycle"). Every lifecycle fact is
 * an immutable phase row on the thread where it happened; an item's state is a fold over its rows.
 */

export const FEEDBACK_PHASES = [
  'feedback-capture',
  'feedback-route',
  'feedback-tune',
  'feedback-apply',
  'feedback-revert',
] as const;
export type FeedbackPhase = (typeof FEEDBACK_PHASES)[number];
export const isFeedbackPhase = (phase: string): phase is FeedbackPhase =>
  (FEEDBACK_PHASES as readonly string[]).includes(phase);

/** The Prospector's correction categories; `fact` goes to domain knowledge, the rest to instructions. */
export type FeedbackCategory = CorrectionCategory;

export const FEEDBACK_SLOTS = ['instructions', 'domainKnowledge'] as const;
export type FeedbackSlot = (typeof FEEDBACK_SLOTS)[number];

/** Rungs of the composition ladder. Only personal rungs are written directly; committed ones need a PR. */
export const FEEDBACK_LEVELS = [
  'computer',
  'org',
  'org-personal',
  'project',
  'project-personal',
] as const;
export type FeedbackLevel = (typeof FEEDBACK_LEVELS)[number];
export const WRITABLE_LEVELS: readonly FeedbackLevel[] = [
  'computer',
  'org-personal',
  'project-personal',
];

export type DetectionKind = CorrectionSignal;
export type FeedbackOrigin = 'detected' | 'intervention' | 'seed' | 'mined';

export interface FeedbackCaptureRecord {
  /** `fb_…`; a recurrence carries the matched item's id. */
  readonly itemId: string;
  readonly recurred: boolean;
  /** Recurrence only: whether the routed Warden had the rule in its composed segments on the previous turn. */
  readonly exposedAtTurn?: boolean;
  readonly origin: FeedbackOrigin;
  readonly detection?: { kind: DetectionKind; phrase: string; score: number };
  readonly quote: string;
  readonly before: string;
  readonly statement: string;
  readonly sharp: boolean;
  readonly category: FeedbackCategory;
  readonly tags: string[];
  readonly match: { itemId: string; confidence: number } | null;
  readonly candidateDuplicateOf?: string;
  readonly classifier: { providerId: string; requestHash: string } | null;
}

export interface FeedbackRouteRecord {
  readonly itemId: string;
  /** Agent ids (Wardens, subagent roles) or `main`. */
  readonly roles: string[];
  readonly slot: FeedbackSlot;
  readonly level: FeedbackLevel;
  readonly route: {
    domains: string[];
    source: 'model' | 'keyword-fallback' | 'empty-map';
    confidence: number;
  };
}

export type TuneAnswer = 'apply' | 'edit' | 'reroute' | 'dismiss' | 'later' | 'timeout' | 'undo';
export type TuningMode = 'ask' | 'block' | 'off';

export interface FeedbackTuneRecord {
  readonly itemId: string;
  readonly promptId: string | null;
  readonly mode: TuningMode;
  readonly shown: { happened: string; did: string; intend: string };
  readonly answer: TuneAnswer;
  readonly by: 'human' | 'policy' | 'timeout';
  readonly surface?: string;
  readonly edited?: {
    statement?: string;
    roles?: string[];
    slot?: FeedbackSlot;
    level?: FeedbackLevel;
  };
}

export interface FeedbackApplyRecord {
  readonly itemId: string;
  /** A revert names the change it undoes. */
  readonly changeId: string;
  readonly role: string;
  readonly slot: FeedbackSlot;
  readonly level: FeedbackLevel;
  readonly path: string;
  /** The exact line added (apply) or removed (revert). */
  readonly line: string;
  readonly beforeHash: string;
  readonly afterHash: string;
  /** The file's version in the audit log that this change produced. */
  readonly sourceVersionId?: string;
}

export type FeedbackRecord =
  | { phase: 'feedback-capture'; record: FeedbackCaptureRecord }
  | { phase: 'feedback-route'; record: FeedbackRouteRecord }
  | { phase: 'feedback-tune'; record: FeedbackTuneRecord }
  | { phase: 'feedback-apply' | 'feedback-revert'; record: FeedbackApplyRecord };

/** Feedback settings, global and per project (`projects[id].feedback` overrides field by field). */
export interface FeedbackSettings {
  /** Capture runs and the lifecycle view fills. Default true. */
  capture?: boolean;
  /** `ask` (default): prompt, the turn proceeds. `block`: the turn waits for the answer. `off`: no prompts. */
  tuning?: TuningMode;
  /** Detection kinds that make one item block even when `tuning` is `ask`. Default none. */
  blockOn?: Array<'repeat' | 'explicit'>;
  /** How long a blocking prompt holds the turn before it proceeds as `later`. Default 120000. */
  blockTimeoutMs?: number;
}

export const DEFAULT_FEEDBACK_SETTINGS: Required<FeedbackSettings> = Object.freeze({
  capture: true,
  tuning: 'ask',
  blockOn: [],
  blockTimeoutMs: 120_000,
}) as Required<FeedbackSettings>;

export function resolveFeedbackSettings(
  global: FeedbackSettings | undefined,
  project: FeedbackSettings | undefined,
): Required<FeedbackSettings> {
  return { ...DEFAULT_FEEDBACK_SETTINGS, ...global, ...project };
}

const TUNING_MODES: readonly TuningMode[] = ['ask', 'block', 'off'];

/** Settings validation: names the field, never echoes content. */
export function validateFeedbackSettings(where: string, value: unknown): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error(`${where} must be an object`);
  const settings = value as Record<string, unknown>;
  for (const key of Object.keys(settings))
    if (!['capture', 'tuning', 'blockOn', 'blockTimeoutMs'].includes(key))
      throw Error(`${where}: unknown field ${key}`);
  if (settings.capture !== undefined && typeof settings.capture !== 'boolean')
    throw Error(`${where}.capture must be a boolean`);
  if (settings.tuning !== undefined && !TUNING_MODES.includes(settings.tuning as TuningMode))
    throw Error(`${where}.tuning must be one of ${TUNING_MODES.join(', ')}`);
  if (
    settings.blockOn !== undefined &&
    (!Array.isArray(settings.blockOn) ||
      settings.blockOn.some((kind) => kind !== 'repeat' && kind !== 'explicit'))
  )
    throw Error(`${where}.blockOn lists repeat and/or explicit`);
  if (
    settings.blockTimeoutMs !== undefined &&
    (!Number.isInteger(settings.blockTimeoutMs) ||
      (settings.blockTimeoutMs as number) < 1_000 ||
      (settings.blockTimeoutMs as number) > 3_600_000)
  )
    throw Error(`${where}.blockTimeoutMs must be an integer between 1000 and 3600000`);
}
