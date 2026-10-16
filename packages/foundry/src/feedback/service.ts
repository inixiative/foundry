import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
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
import { REDUCED_PHASE } from '../archives/reduced-middleware';
import type { AuditLog } from '../audit/audit-log';
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
  type FeedbackInbox,
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
  /** The decision calls; without them only explicit feedback is recorded (no detection, no tuning). */
  classify?: ClassifyCorrection;
  match?: MatchFeedback;
  /** Composed role layers re-read from disk on their next prepare (composition view). */
  invalidate: (role: string, threadId: string) => void;
  /** Directories of a thread's rungs. */
  roots: (thread: Thread) => LevelRoots;
  /** A lifecycle item changed. */
  changed?: (item: FeedbackItem) => void;
  /** Foundry's audit log: each written or removed line is a version of its file, caused by the item. */
  audit?: AuditLog;
  log?: (message: string) => void;
}

const QUOTE = 600;
/** The longest explicit feedback accepted. */
export const FEEDBACK_TEXT_MAX = 4_000;

/** Who gave a piece of feedback, and from which surface. */
export type FeedbackAuthor = NonNullable<FeedbackCaptureRecord['author']>;

/** The local operator: this machine's user (Kingdom identity is not required to give feedback). */
export const localOperator = (): string => {
  try {
    return userInfo().username || 'operator';
  } catch {
    return 'operator';
  }
};
const clip = (text: string, max = QUOTE) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const ANSWERS = [
  { id: 'apply', label: 'Apply' },
  { id: 'edit', label: 'Edit, then apply' },
  { id: 'dismiss', label: 'Not a rule' },
  { id: 'later', label: 'Later' },
] as const;

interface OpenPrompt {
  readonly promptId: string;
  readonly controller: AbortController;
  readonly options: readonly string[];
  surface?: string;
}

interface CaptureInput {
  thread: Thread;
  turnId: string | null;
  text: string;
  origin: FeedbackCaptureRecord['origin'];
  author?: FeedbackAuthor;
}

/**
 * The feedback lifecycle (docs/FEEDBACK-LOOP.md, "Lifecycle"): detect → sharpen → route → tune → change,
 * every step an immutable journal row, the item a fold over its rows. Capture never changes behavior;
 * only an answered tuning prompt writes a role file.
 */
export class FeedbackService {
  readonly lifecycle: FeedbackLifecycle;
  private readonly _held = new Map<string, Promise<void>>();
  /** Tuning prompts awaiting an answer, by item: one at a time per item. */
  private readonly _open = new Map<string, OpenPrompt>();
  /** Turns held on tuning, so a stop can withdraw their prompt. */
  private readonly _holds = new Map<string, AbortController>();

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
    if (!settings.capture || !this.deps.classify) return;
    const before = this.previousAgentText(thread.id, turnId);
    const detection = detectCorrection(text, before);
    if (!detection.hit) return;
    const blocking =
      settings.tuning === 'block' ||
      (settings.tuning === 'ask' &&
        !!detection.signal &&
        (settings.blockOn as string[]).includes(detection.signal));
    const hold = blocking ? new AbortController() : undefined;
    const work = this.capture(
      { thread, turnId, text, origin: 'detected' },
      { before, detection, blocking, ...(hold ? { signal: hold.signal } : {}) },
    ).then(
      () => undefined,
      (error) => this.deps.log?.(`[Feedback] capture failed: ${(error as Error).message}`),
    );
    if (!hold) return;
    // The whole hold (classify, match, route, the prompt) is bounded: past it the turn proceeds.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bounded = Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, settings.blockTimeoutMs);
        hold.signal.addEventListener('abort', () => resolve(), { once: true });
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
      hold.abort();
      this._held.delete(turnId);
      this._holds.delete(turnId);
    });
    this._held.set(turnId, bounded);
    this._holds.set(turnId, hold);
  }

  /** A held turn was stopped: withdraw its tuning prompt and release the hold now. */
  release(turnId: string): void {
    this._holds.get(turnId)?.abort();
  }

  /** What a blocking turn waits on before it is sent; resolved immediately otherwise. */
  held(turnId: string): Promise<void> {
    return this._held.get(turnId) ?? Promise.resolve();
  }

  /**
   * `/correction` and the viewer's Correction form: explicit, so `feedback.capture` does not gate it. With
   * a decision provider it is classified into a rule and tuned; without one it is recorded as said.
   */
  async intervention(
    thread: Thread,
    correction: string,
    author: FeedbackAuthor = { name: localOperator(), surface: 'viewer' },
  ): Promise<FeedbackItem[]> {
    if (!this.deps.classify)
      return [this.record(thread, { text: correction, tags: ['correction'], author })];
    const before = this.previousAgentText(thread.id, null);
    return this.capture(
      { thread, turnId: null, text: correction, origin: 'intervention', author },
      { before, blocking: false },
    );
  }

  /**
   * `/feedback <text>`: an explicit item on a thread, pointing at a turn (the thread's last turn unless
   * one is named). Recorded as said: no classifier, no routing, no tuning prompt, no role file written.
   */
  record(
    thread: Pick<Thread, 'id' | 'meta'>,
    input: {
      text: string;
      turnId?: string | null;
      messageId?: string;
      tags?: string[];
      author: FeedbackAuthor;
    },
  ): FeedbackItem {
    const text = scrubSecrets(input.text.trim()).text;
    if (!text) throw Error('feedback text is required');
    if (text.length > FEEDBACK_TEXT_MAX)
      throw Error(`feedback is at most ${FEEDBACK_TEXT_MAX} characters`);
    const recent = this.deps.store.messages(thread.id, 50);
    const turnId =
      input.turnId === undefined ? (recent.at(-1)?.turnId ?? null) : input.turnId || null;
    const referred =
      recent.find((m) => m.id === input.messageId) ??
      recent.filter((m) => m.turnId === turnId && m.actor === 'agent').at(-1);
    const record: FeedbackCaptureRecord = {
      itemId: newFeedbackId(),
      recurred: false,
      origin: 'explicit',
      quote: clip(text),
      before: clip(scrubSecrets(referred?.content ?? '').text),
      statement: text,
      sharp: false,
      tags: [...new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean))].slice(0, 10),
      author: input.author,
      ...(input.messageId ? { messageId: input.messageId } : {}),
      match: null,
      classifier: null,
    };
    const item = this.journal(thread, turnId, { phase: 'feedback-capture', record });
    if (!item) throw Error(`feedback item ${record.itemId} was not recorded`);
    return item;
  }

  /** Archive items, or put them back in the inbox; journalled on each item's own thread. */
  setInbox(itemIds: readonly string[], inbox: FeedbackInbox, by: string): FeedbackItem[] {
    const items = itemIds.map((id) => {
      const item = this.lifecycle.get(id);
      if (!item) throw Error(`feedback item ${id} not found`);
      return item;
    });
    const changed: FeedbackItem[] = [];
    for (const item of items) {
      if (item.inbox === inbox) continue;
      const updated = this.journal(this.journalThread(item), null, {
        phase: 'feedback-status',
        record: { itemId: item.id, inbox, by },
      });
      if (updated) changed.push(updated);
    }
    return changed;
  }

  /** The item's origin thread, live or as journalled (an archived thread still takes its rows). */
  private journalThread(item: FeedbackItem): Pick<Thread, 'id' | 'meta'> {
    const live = this.deps.thread(item.origin.threadId);
    if (live) return live;
    const stored = this.deps.store.threads().find((t) => t.id === item.origin.threadId);
    if (!stored) throw Error('the item’s thread is not available');
    return stored;
  }

  private previousAgentText(threadId: string, turnId: string | null): string {
    const messages = this.deps.store.messages(threadId, 20);
    const agent = messages.filter((m) => m.actor === 'agent' && m.turnId !== turnId).at(-1);
    return clip(agent?.content ?? '', 2_000);
  }

  private journal(
    thread: Pick<Thread, 'id' | 'meta'>,
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
    opts: {
      before: string;
      detection?: CorrectionDetection;
      blocking: boolean;
      signal?: AbortSignal;
    },
  ): Promise<FeedbackItem[]> {
    const priority = opts.blocking ? DECISION_PRIORITY.turn : DECISION_PRIORITY.review;
    const quote = scrubSecrets(input.text).text;
    const before = scrubSecrets(opts.before).text;
    const classify = this.deps.classify;
    if (!classify) return [];
    const classified = await classify({ text: quote, before, priority });
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
      if (opts.signal?.aborted) break;
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
    opts: { detection?: CorrectionDetection; blocking: boolean; signal?: AbortSignal },
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
      .filter((item) => item.sharp)
      .map((item) => ({ id: item.id, statement: item.statement }));
    const matched =
      found.statement && this.deps.match
        ? await this.deps.match(found.statement, candidates, found.priority)
        : { match: null };
    const same =
      matched.match && matched.match.confidence >= SAME_ITEM_CONFIDENCE ? matched.match : null;
    const recurring = same ? this.lifecycle.get(same.itemId) : undefined;
    const itemId = recurring?.id ?? newFeedbackId();
    const record: FeedbackCaptureRecord = {
      itemId,
      recurred: !!recurring,
      ...(recurring
        ? { exposedAtTurn: this.exposedLastTurn(thread.id, input.turnId, recurring) }
        : {}),
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
      ...(input.author ? { author: input.author } : {}),
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
            category: found.category,
            hasProject: !!projectId,
            timeoutMs: opts.blocking ? this.settings(thread).blockTimeoutMs : 30_000,
          })
        : {
            itemId,
            roles: [MAIN_ROLE],
            slot: slotFor(found.category),
            level: defaultLevel(found.category, !!projectId),
            route: { domains: [], source: 'empty-map', confidence: 0 },
          };
      this.journal(thread, input.turnId, { phase: 'feedback-route', record: route });
    }
    if (opts.signal?.aborted) return item;
    await this.tune(thread, input.turnId, item, opts.blocking, opts.signal);
    return item;
  }

  /**
   * Whether the rule was in front of one of its routed Wardens on this thread's last advised turn before
   * `turnId` (the turn the correction reacted to).
   */
  private exposedLastTurn(threadId: string, turnId: string | null, item: FeedbackItem): boolean {
    const since = activeChanges(item)[0]?.appliedAt;
    if (since === undefined) return false;
    const domains = new Set(
      [...wardenRoles(this.deps.config())]
        .filter(([, role]) => item.route?.roles.includes(role))
        .map(([domain]) => domain),
    );
    type Versions = { instructions?: string; domainKnowledge?: string };
    // The last turn's advice: its raw row while retention keeps it, else its reduced rows.
    const rows = this.deps.store
      .phaseHistory(threadId, { limit: 500 })
      .filter(
        (p) =>
          p.turnId !== turnId &&
          (p.phase === 'advice' ||
            (p.phase === REDUCED_PHASE &&
              (p.record as { trigger?: string }).trigger === 'user-message')),
      );
    const lastTurn = rows.at(-1)?.turnId;
    if (!lastTurn) return false;
    const ofTurn = rows.filter((p) => p.turnId === lastTurn);
    const ranAt = Math.max(
      ...ofTurn.map((p) =>
        p.phase === REDUCED_PHASE
          ? Number((p.record as { at?: number }).at ?? p.storedAt)
          : p.storedAt,
      ),
    );
    if (ranAt < since) return false;
    const marker = ruleMarker(item.id);
    // Exposure is read from the versions a call was composed of; segment text where it was recorded.
    const holding = this.deps.store.compositionsHolding(marker);
    const held = (versions?: Versions) =>
      !!versions &&
      [versions.instructions, versions.domainKnowledge].some((id) => !!id && holding.has(id));
    const raw = ofTurn.find((p) => p.phase === 'advice');
    if (raw) {
      const participants =
        (
          raw.record as {
            participants?: Array<{
              domain?: string;
              segments?: unknown;
              request?: { versions?: Versions };
            }>;
          }
        ).participants ?? [];
      return participants.some(
        (p) =>
          !!p.domain &&
          domains.has(p.domain) &&
          (held(p.request?.versions) || JSON.stringify(p.segments ?? '').includes(marker)),
      );
    }
    return ofTurn.some((p) => {
      const reduced = p.record as { role?: string; state?: { versions?: Versions } };
      return !!reduced.role && domains.has(reduced.role) && held(reduced.state?.versions);
    });
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
        ? `Captured rule ${item.id}: "${item.statement}" (${item.category ?? 'unclassified'}). Routed to ${roles} (${slot})${route && route.route.source !== 'model' ? ', weak routing' : ''}.`
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
    signal?: AbortSignal,
  ): Promise<void> {
    const settings = this.settings(thread);
    const queue = this.deps.queue;
    if (!queue || settings.tuning === 'off' || this._open.has(item.id)) return;
    const shown = this.describe(item);
    const controller = new AbortController();
    signal?.addEventListener('abort', () => controller.abort(), { once: true });
    const options = (item.sharp ? ANSWERS : ANSWERS.filter((a) => a.id !== 'apply')).map((a) => ({
      id: a.id,
      label: a.label,
    }));
    const ask = queue.prompt({
      kind: 'choice',
      threadId: thread.id,
      agentId: 'feedback',
      capability: 'feedback',
      message: `${shown.happened}\n${shown.did}\n${shown.intend}`,
      options,
      urgency: item.detection?.kind === 'repeat' || item.recurrences.length ? 'high' : 'normal',
      signal: controller.signal,
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
    // The queue registers a prompt before its first await, so it is findable now.
    const promptId =
      queue.pending().find((p) => (p.meta?.feedback as { itemId?: string })?.itemId === item.id)
        ?.id ?? null;
    const open: OpenPrompt = {
      promptId: promptId ?? '',
      controller,
      options: options.map((o) => o.id),
    };
    if (promptId) this._open.set(item.id, open);
    const settle = ask
      .then((resolution) =>
        this.answer(thread, turnId, item.id, resolution, {
          mode: blocking ? 'block' : 'ask',
          shown,
          promptId,
          ...(open.surface ? { surface: open.surface } : {}),
        }),
      )
      .finally(() => {
        if (this._open.get(item.id) === open) this._open.delete(item.id);
      });
    if (blocking) await settle;
    else
      void settle.catch((error) =>
        this.deps.log?.(`[Feedback] tuning failed: ${(error as Error).message}`),
      );
  }

  /** Raise the tuning prompt again for an item with none open (after later, a timeout or a restart). */
  retune(itemId: string): void {
    const item = this.lifecycle.get(itemId);
    if (!item) throw Error('feedback item not found');
    if (this._open.has(itemId)) throw Error('a tuning prompt for this item is already open');
    const thread = this.deps.thread(item.origin.threadId);
    if (!thread) throw Error('the item’s thread is not available');
    void this.tune(thread, null, item, false).catch((error) =>
      this.deps.log?.(`[Feedback] tuning failed: ${(error as Error).message}`),
    );
  }

  /**
   * Answer an item's open tuning prompt, validated first: an option the prompt offers, and for `edit` a
   * sharp rule, known roles and a writable level. Only a valid answer settles the prompt.
   */
  submit(itemId: string, action: string, input?: string, surface?: string): void {
    const item = this.lifecycle.get(itemId);
    const open = this._open.get(itemId);
    if (!item || !open) throw Error('no open tuning prompt for this item');
    if (!open.options.includes(action))
      throw Error(`${action} is not an answer this prompt offers`);
    if (action === 'edit') this.target(item, this.parseEdit(input));
    if (surface) open.surface = surface;
    if (!this.deps.queue?.resolve(open.promptId, action, { by: 'human', input }))
      throw Error('the tuning prompt was already answered');
  }

  /** The validated edit, or a throw naming what is wrong. */
  private parseEdit(input: string | undefined): NonNullable<FeedbackTuneRecord['edited']> {
    const edited = parseEdit(input);
    if (edited.statement !== undefined) {
      edited.statement = scrubSecrets(edited.statement).text;
      const lint = lintStatement(edited.statement);
      if (!lint.ok) throw Error(`The rule is not sharp: ${lint.reason}`);
    }
    return edited;
  }

  /** Where an answer writes, every role known before anything is written. */
  private target(item: FeedbackItem, edited?: FeedbackTuneRecord['edited']) {
    const roles = edited?.roles ?? item.route?.roles ?? [MAIN_ROLE];
    const known = new Set([MAIN_ROLE, ...wardenRoles(this.deps.config()).values()]);
    const unknown = roles.filter((role) => !known.has(role));
    if (unknown.length) throw Error(`Unknown role ${unknown.join(', ')}`);
    if (!roles.length) throw Error('No role to apply the rule to');
    if (!(edited?.statement ?? (item.sharp ? item.statement : '')))
      throw Error('Write the rule before applying it');
    return {
      roles,
      slot: (edited?.slot ?? item.route?.slot ?? 'instructions') as FeedbackSlot,
      level: (edited?.level ?? item.route?.level ?? 'project-personal') as FeedbackLevel,
    };
  }

  /** Record a prompt's answer and carry it out: apply writes the rule; edit replaces it. */
  private async answer(
    thread: Thread,
    turnId: string | null,
    itemId: string,
    resolution: ActionResolution,
    context: {
      mode: 'ask' | 'block';
      shown: FeedbackTuneRecord['shown'];
      promptId: string | null;
      surface?: string;
    },
  ): Promise<void> {
    const item = this.lifecycle.get(itemId);
    if (!item) return;
    // A timeout is its own answer; a withdrawn prompt (a stopped turn, a released hold) is "later".
    const answer: TuneAnswer =
      resolution.by === 'timeout'
        ? 'timeout'
        : resolution.by === 'policy'
          ? 'later'
          : (resolution.action as TuneAnswer);
    const edited = answer === 'edit' ? this.parseEdit(resolution.input) : undefined;
    const target = answer === 'apply' || answer === 'edit' ? this.target(item, edited) : undefined;
    this.journal(thread, turnId, {
      phase: 'feedback-tune',
      record: {
        itemId,
        promptId: context.promptId,
        mode: context.mode,
        shown: context.shown,
        answer,
        by: resolution.by,
        ...(context.surface ? { surface: context.surface } : {}),
        ...(edited ? { edited } : {}),
      },
    });
    if (!target) return;
    // An edit replaces the rule: its old lines come out before the new one goes in.
    if (answer === 'edit')
      for (const change of activeChanges(item)) this.undo(itemId, change.changeId);
    const roots = this.deps.roots(thread);
    for (const role of target.roles) {
      if (
        activeChanges(item).some(
          (c) => c.role === role && c.slot === target.slot && c.level === target.level,
        )
      )
        continue;
      const applied = applyChange({
        itemId: item.id,
        changeId: newId('chg'),
        statement: item.statement,
        role,
        slot: target.slot,
        level: target.level,
        roots,
      });
      const record = this.audited(applied);
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
    const { found, ...reverted } = revertChange(applied);
    const record = found ? this.audited(reverted) : reverted;
    this.journal(thread, null, { phase: 'feedback-revert', record });
    this.deps.invalidate(change.role, thread.id);
    return item;
  }

  /** The change as a version of its file in the audit log (actor: the feedback item). */
  private audited(record: FeedbackApplyRecord): FeedbackApplyRecord {
    if (!this.deps.audit) return record;
    // The line is written: an audit failure is reported, never left as an unjournalled change.
    try {
      const version = this.deps.audit.observe(
        `file:${record.path}`,
        readFileSync(record.path, 'utf8'),
        {
          record: true,
          actor: { kind: 'feedback', id: record.itemId },
          cause: { feedbackItemId: record.itemId, changeId: record.changeId },
        },
      );
      return { ...record, sourceVersionId: version.id };
    } catch (error) {
      this.deps.log?.(`feedback: audit of ${record.path} not written: ${(error as Error).message}`);
      return record;
    }
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

function parseEdit(input: string | undefined): NonNullable<FeedbackTuneRecord['edited']> {
  const text = (input ?? '').trim();
  if (!text) throw Error('edit needs the rule');
  if (!text.startsWith('{')) return { statement: text };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw Error('edit input is not valid JSON');
  }
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
