import {
  type ActionQueue,
  type ActionResolution,
  type CorrectionClassification,
  type CorrectionDetection,
  detectCorrection,
  newId,
  scrubSecrets,
  type Thread,
} from '@inixiative/foundry-core';
import type { Cartographer } from '../agents/cartographer';
import type { LocalSessionStore } from '../persistence/local-session-store';
import { DECISION_PRIORITY } from '../providers/decision-priority';
import type { FoundryConfig } from '../viewer/config';
import { applyChange, type LevelRoots, revertChange } from './apply';
import { activeChanges, type FeedbackItem, FeedbackLifecycle } from './lifecycle';
import { defaultLevel, MAIN_ROLE, routeFeedback, slotFor, wardenRoles } from './routing';
import {
  lintStatement,
  type MatchResult,
  newFeedbackId,
  ruleMarker,
  SAME_ITEM_CONFIDENCE,
} from './sharpen';
import {
  FEEDBACK_LEVELS,
  type FeedbackApplyRecord,
  type FeedbackCaptureRecord,
  type FeedbackCategory,
  type FeedbackLevel,
  type FeedbackRecord,
  type FeedbackRouteRecord,
  type FeedbackSlot,
  type FeedbackTuneRecord,
  resolveFeedbackSettings,
  type TuneAnswer,
  WRITABLE_LEVELS,
} from './types';

/** The Prospector's classify call (foundry-core's contract), with the request identity it was made under. */
export type ClassifyCorrection = (input: {
  text: string;
  before: string;
  priority: number;
}) => Promise<(CorrectionClassification & { requestHash: string; providerId: string }) | undefined>;

export type MatchFeedback = (
  statement: string,
  candidates: ReadonlyArray<{ id: string; statement: string }>,
  priority: number,
) => Promise<MatchResult>;

export interface FeedbackServiceDeps {
  store: LocalSessionStore;
  config: () => FoundryConfig;
  queue: ActionQueue | null;
  thread: (threadId: string) => Thread | undefined;
  cartographer: (threadId: string) => Pick<Cartographer, 'route'> | undefined;
  classify: ClassifyCorrection;
  match: MatchFeedback;
  /** Composed role layers re-read from disk on their next prepare (composition view). */
  invalidate: (role: string, threadId: string) => void;
  /** Directories of a thread's rungs. */
  roots: (thread: Thread) => LevelRoots;
  /** A lifecycle item changed. */
  changed?: (item: FeedbackItem) => void;
  log?: (message: string) => void;
}

const QUOTE = 600;
const clip = (text: string, max = QUOTE) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const ANSWERS = [
  { id: 'apply', label: 'Apply' },
  { id: 'edit', label: 'Edit, then apply' },
  { id: 'dismiss', label: 'Not a rule' },
  { id: 'later', label: 'Later' },
] as const;

interface CaptureInput {
  thread: Thread;
  turnId: string | null;
  text: string;
  origin: FeedbackCaptureRecord['origin'];
}

/**
 * The feedback lifecycle (docs/FEEDBACK-LOOP.md, "Lifecycle"): detect → sharpen → route → tune → change,
 * every step an immutable journal row, the item a fold over its rows. Capture never changes behavior;
 * only an answered tuning prompt writes a role file.
 */
export class FeedbackService {
  readonly lifecycle: FeedbackLifecycle;
  private readonly _held = new Map<string, Promise<void>>();

  constructor(private readonly deps: FeedbackServiceDeps) {
    this.lifecycle = new FeedbackLifecycle(deps.store.feedbackPhases());
  }

  private settings(thread: Thread) {
    const config = this.deps.config();
    const projectId = thread.meta.projectId;
    return resolveFeedbackSettings(
      config.feedback,
      projectId ? config.projects[projectId]?.feedback : undefined,
    );
  }

  /**
   * A typed turn was accepted. Detection is synchronous; the rest runs off the turn path unless this
   * turn blocks on tuning, in which case `held(turnId)` resolves once the prompt is answered.
   */
  turnAccepted(thread: Thread, turnId: string, text: string): void {
    const settings = this.settings(thread);
    if (!settings.capture) return;
    const before = this.previousAgentText(thread.id, turnId);
    const detection = detectCorrection(text, before);
    if (!detection.hit) return;
    const blocking =
      settings.tuning === 'block' ||
      (settings.tuning === 'ask' &&
        !!detection.signal &&
        (settings.blockOn as string[]).includes(detection.signal));
    const work = this.capture(
      { thread, turnId, text, origin: 'detected' },
      { before, detection, blocking },
    ).then(
      () => undefined,
      (error) => this.deps.log?.(`[Feedback] capture failed: ${(error as Error).message}`),
    );
    if (blocking) {
      this._held.set(turnId, work);
      void work.finally(() => this._held.delete(turnId));
    }
  }

  /** What a blocking turn waits on before it is sent; resolved immediately otherwise. */
  held(turnId: string): Promise<void> {
    return this._held.get(turnId) ?? Promise.resolve();
  }

  /** `/correction` and the viewer's Correction form: explicit feedback, no detector. */
  async intervention(thread: Thread, correction: string): Promise<FeedbackItem[]> {
    if (!this.settings(thread).capture) return [];
    const before = this.previousAgentText(thread.id, null);
    return this.capture(
      { thread, turnId: null, text: correction, origin: 'intervention' },
      { before, blocking: false },
    );
  }

  private previousAgentText(threadId: string, turnId: string | null): string {
    const messages = this.deps.store.messages(threadId, 20);
    const agent = messages.filter((m) => m.actor === 'agent' && m.turnId !== turnId).at(-1);
    return clip(agent?.content ?? '', 2_000);
  }

  private journal(
    thread: Thread,
    turnId: string | null,
    entry: FeedbackRecord,
  ): FeedbackItem | undefined {
    const row = {
      id: newId('phase'),
      turnId,
      dispatchId: null,
      phase: entry.phase,
      record: entry.record as unknown as Record<string, unknown>,
    };
    const storedAt = this.deps.store.appendPhase(thread, row);
    const item = this.lifecycle.apply({
      threadId: thread.id,
      turnId,
      phase: entry.phase,
      record: row.record,
      storedAt,
      projectId: thread.meta.projectId ?? null,
    });
    if (item) this.deps.changed?.(item);
    return item;
  }

  private async capture(
    input: CaptureInput,
    opts: { before: string; detection?: CorrectionDetection; blocking: boolean },
  ): Promise<FeedbackItem[]> {
    const priority = opts.blocking ? DECISION_PRIORITY.turn : DECISION_PRIORITY.review;
    const quote = scrubSecrets(input.text).text;
    const before = scrubSecrets(opts.before).text;
    const classified = await this.deps.classify({ text: quote, before, priority });
    if (!classified) {
      this.deps.log?.('[Feedback] classifier answer was not the contract; nothing captured');
      return [];
    }
    if (!classified.isCorrection && input.origin !== 'intervention') return [];
    const sharp = classified.statements.filter((statement) => lintStatement(statement).ok);
    // One item per rule the message carries; a correction with no crisp rule is one unsharp item.
    const statements = sharp.length ? sharp : [null];
    const items: FeedbackItem[] = [];
    for (const statement of statements) {
      const item = await this.captureOne(input, opts, {
        quote,
        before,
        statement,
        category: classified.category,
        classifier: { providerId: classified.providerId, requestHash: classified.requestHash },
        priority,
      });
      if (item) items.push(item);
    }
    return items;
  }

  private async captureOne(
    input: CaptureInput,
    opts: { detection?: CorrectionDetection; blocking: boolean },
    found: {
      quote: string;
      before: string;
      statement: string | null;
      category: FeedbackCategory;
      classifier: { providerId: string; requestHash: string };
      priority: number;
    },
  ): Promise<FeedbackItem | undefined> {
    const { thread } = input;
    const projectId = thread.meta.projectId ?? null;
    const candidates = this.lifecycle
      .forProject(projectId)
      .filter((item) => item.status !== 'dismissed' && item.sharp)
      .map((item) => ({ id: item.id, statement: item.statement }));
    const matched = found.statement
      ? await this.deps.match(found.statement, candidates, found.priority)
      : { match: null };
    const same =
      matched.match && matched.match.confidence >= SAME_ITEM_CONFIDENCE ? matched.match : null;
    const recurring = same ? this.lifecycle.get(same.itemId) : undefined;
    const itemId = recurring?.id ?? newFeedbackId();
    const record: FeedbackCaptureRecord = {
      itemId,
      recurred: !!recurring,
      ...(recurring ? { exposedAtTurn: this.exposedLastTurn(thread.id, recurring) } : {}),
      origin: input.origin,
      ...(opts.detection?.signal
        ? {
            detection: {
              kind: opts.detection.signal,
              phrase: opts.detection.phrase ?? '',
              score: opts.detection.score,
            },
          }
        : {}),
      quote: clip(found.quote),
      before: clip(found.before),
      statement: found.statement ?? clip(found.quote, 160),
      sharp: found.statement !== null,
      category: found.category,
      tags: [],
      match: matched.match,
      ...(!same && matched.match ? { candidateDuplicateOf: matched.match.itemId } : {}),
      classifier: found.classifier,
    };
    const item = this.journal(thread, input.turnId, { phase: 'feedback-capture', record });
    if (!item) throw Error(`feedback item ${itemId} was not recorded`);
    // A recurrence of a rule that is not applied counts; only an applied rule that came back is re-tuned.
    if (recurring && !activeChanges(recurring).length) return item;
    if (!recurring) {
      const cartographer = this.deps.cartographer(thread.id);
      const route: FeedbackRouteRecord = cartographer
        ? await routeFeedback({
            cartographer,
            config: this.deps.config(),
            itemId,
            statement: record.statement,
            category: record.category,
            hasProject: !!projectId,
          })
        : {
            itemId,
            roles: [MAIN_ROLE],
            slot: slotFor(record.category),
            level: defaultLevel(record.category, !!projectId),
            route: { domains: [], source: 'empty-map', confidence: 0 },
          };
      this.journal(thread, input.turnId, { phase: 'feedback-route', record: route });
    }
    await this.tune(thread, input.turnId, item, opts.blocking);
    return item;
  }

  /** Whether the item's rule was in the routed Warden's composed input on this thread's last advised turn. */
  private exposedLastTurn(threadId: string, item: FeedbackItem): boolean {
    const since = activeChanges(item)[0]?.appliedAt;
    if (since === undefined) return false;
    const last = this.deps.store
      .phaseHistory(threadId, { limit: 50 })
      .filter((p) => p.phase === 'advice')
      .at(-1);
    return (
      !!last && JSON.stringify(last.record).includes(ruleMarker(item.id)) && last.storedAt >= since
    );
  }

  /** The three lines a tuning prompt shows: what happened, what we did, what we intend. */
  describe(item: FeedbackItem): FeedbackTuneRecord['shown'] {
    const route = item.route;
    const roles = route?.roles.join(', ') ?? MAIN_ROLE;
    const slot = route?.slot === 'domainKnowledge' ? 'domain knowledge' : 'instructions';
    const happened = item.before
      ? `You said "${clip(item.quote, 200)}" after: "${clip(item.before, 200)}"`
      : `You said "${clip(item.quote, 200)}"`;
    const recurred = item.recurrences.at(-1);
    if (recurred && activeChanges(item).length)
      return {
        happened,
        did: `This repeats rule ${item.id} ("${item.statement}"), already applied${recurred.exposedAtTurn ? ' and in front of the Warden on that turn' : ''}.`,
        intend: 'Sharpen the rule (edit), or leave it and keep counting.',
      };
    return {
      happened,
      did: item.sharp
        ? `Captured rule ${item.id}: "${item.statement}" (${item.category}). Routed to ${roles} (${slot})${route && route.route.source !== 'model' ? ', weak routing' : ''}.`
        : `Captured feedback ${item.id}, but it is not yet a crisp rule: "${item.statement}".`,
      intend: item.sharp
        ? `Add it to ${roles}'s ${slot} at ${route?.level ?? 'project-personal'}.`
        : 'Write the rule in one line (edit), and it will be added.',
    };
  }

  private async tune(
    thread: Thread,
    turnId: string | null,
    item: FeedbackItem,
    blocking: boolean,
  ): Promise<void> {
    const settings = this.settings(thread);
    const queue = this.deps.queue;
    if (!queue || settings.tuning === 'off') return;
    const shown = this.describe(item);
    const ask = queue.prompt({
      kind: 'choice',
      threadId: thread.id,
      agentId: 'feedback',
      capability: 'feedback',
      message: `${shown.happened}\n${shown.did}\n${shown.intend}`,
      options: (item.sharp ? ANSWERS : ANSWERS.filter((a) => a.id !== 'apply')).map((a) => ({
        id: a.id,
        label: a.label,
      })),
      urgency: item.detection?.kind === 'repeat' || item.recurrences.length ? 'high' : 'normal',
      ...(blocking ? { timeoutMs: settings.blockTimeoutMs } : {}),
      meta: {
        feedback: {
          itemId: item.id,
          blocking,
          shown,
          statement: item.statement,
          route: item.route ?? null,
        },
      },
    });
    const settle = ask.then((resolution) =>
      this.answer(thread, turnId, item.id, resolution, {
        mode: blocking ? 'block' : 'ask',
        shown,
      }),
    );
    if (blocking) await settle;
    else
      void settle.catch((error) =>
        this.deps.log?.(`[Feedback] tuning failed: ${(error as Error).message}`),
      );
  }

  /** Apply a prompt's answer. `edit` carries the new statement (and optionally roles/level) as input. */
  async answer(
    thread: Thread,
    turnId: string | null,
    itemId: string,
    resolution: ActionResolution,
    context: { mode: 'ask' | 'block'; shown: FeedbackTuneRecord['shown']; promptId?: string },
  ): Promise<void> {
    const item = this.lifecycle.get(itemId);
    if (!item) return;
    const answer: TuneAnswer =
      resolution.by === 'timeout'
        ? 'timeout'
        : resolution.action === 'approved'
          ? 'apply'
          : resolution.action === 'rejected'
            ? 'dismiss'
            : (resolution.action as TuneAnswer);
    const edited = answer === 'edit' ? parseEdit(resolution.input) : undefined;
    if (edited?.statement) {
      const lint = lintStatement(edited.statement);
      if (!lint.ok) throw Error(`Rule is not sharp: ${lint.reason}`);
    }
    this.journal(thread, turnId, {
      phase: 'feedback-tune',
      record: {
        itemId,
        promptId: context.promptId ?? null,
        mode: context.mode,
        shown: context.shown,
        answer,
        by: resolution.by,
        ...(edited ? { edited } : {}),
      },
    });
    if ((answer === 'apply' && item.sharp) || (answer === 'edit' && item.sharp)) {
      const route = item.route;
      const roles = edited?.roles ?? route?.roles ?? [MAIN_ROLE];
      const slot: FeedbackSlot = edited?.slot ?? route?.slot ?? 'instructions';
      const level: FeedbackLevel = edited?.level ?? route?.level ?? 'project-personal';
      this.apply(thread, turnId, item, roles, slot, level);
    }
  }

  private apply(
    thread: Thread,
    turnId: string | null,
    item: FeedbackItem,
    roles: string[],
    slot: FeedbackSlot,
    level: FeedbackLevel,
  ): void {
    const known = new Set([MAIN_ROLE, ...wardenRoles(this.deps.config()).values()]);
    const roots = this.deps.roots(thread);
    for (const role of roles) {
      if (!known.has(role)) throw Error(`Unknown role ${role}`);
      if (activeChanges(item).some((c) => c.role === role && c.slot === slot && c.level === level))
        continue;
      const record = applyChange({
        itemId: item.id,
        changeId: newId('chg'),
        statement: item.statement,
        role,
        slot,
        level,
        roots,
      });
      this.journal(thread, turnId, { phase: 'feedback-apply', record });
      this.deps.invalidate(role, thread.id);
    }
  }

  /** Undo one change: remove its line and journal the revert on the item's origin thread. */
  undo(itemId: string, changeId: string): FeedbackItem {
    const item = this.lifecycle.get(itemId);
    if (!item) throw Error('feedback item not found');
    const change = item.changes.find((c) => c.changeId === changeId && c.revertedAt === undefined);
    if (!change) throw Error('change not found or already reverted');
    const thread = this.deps.thread(item.origin.threadId);
    if (!thread) throw Error('the item’s thread is not available');
    const applied: FeedbackApplyRecord = {
      itemId,
      changeId,
      role: change.role,
      slot: change.slot,
      level: change.level,
      path: change.path,
      line: change.line,
      beforeHash: '',
      afterHash: '',
    };
    const { found: _found, ...record } = revertChange(applied);
    this.journal(thread, null, { phase: 'feedback-revert', record });
    this.deps.invalidate(change.role, thread.id);
    return item;
  }

  /** Calls since each active change that had the rule in front of a Warden (exposure), newest last. */
  uses(itemId: string): Array<{
    threadId: string;
    turnId: string | null;
    phase: string;
    roles: string[];
    at: number;
  }> {
    const item = this.lifecycle.get(itemId);
    const since = item ? Math.min(...activeChanges(item).map((c) => c.appliedAt)) : Infinity;
    if (!item || !Number.isFinite(since)) return [];
    const byDomain = wardenRoles(this.deps.config());
    return this.deps.store.phasesContaining(ruleMarker(itemId), since).map((row) => ({
      threadId: row.threadId,
      turnId: row.turnId,
      phase: row.phase,
      roles: row.roles.map((domain) => byDomain.get(domain) ?? domain),
      at: row.storedAt,
    }));
  }
}

function parseEdit(input: string | undefined): FeedbackTuneRecord['edited'] {
  const text = (input ?? '').trim();
  if (!text) throw Error('edit needs the rule');
  if (!text.startsWith('{')) return { statement: text };
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const edited: NonNullable<FeedbackTuneRecord['edited']> = {};
  if (typeof parsed.statement === 'string') edited.statement = parsed.statement.trim();
  if (Array.isArray(parsed.roles) && parsed.roles.every((r) => typeof r === 'string'))
    edited.roles = parsed.roles as string[];
  if (parsed.slot === 'instructions' || parsed.slot === 'domainKnowledge')
    edited.slot = parsed.slot;
  if (
    typeof parsed.level === 'string' &&
    (FEEDBACK_LEVELS as readonly string[]).includes(parsed.level)
  ) {
    if (!WRITABLE_LEVELS.includes(parsed.level as FeedbackLevel))
      throw Error(`${parsed.level} changes through a pull request`);
    edited.level = parsed.level as FeedbackLevel;
  }
  return edited;
}
