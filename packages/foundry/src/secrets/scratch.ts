/**
 * @atlas
 * @kind service
 * @partOf feature:secrets
 */
import { contextSecretHits, SHAPED_SECRET_PATTERNS, type Thread } from '@inixiative/foundry-core';
import {
  type PrivatePathOptions,
  parseScratchRef,
  type ScratchPadSummary,
  SECRET_PIPE_TOOL_NAME,
  SECRET_SCRATCH_TOOL_NAME,
  SecretScratchPad,
} from '@inixiative/secret-scratch';
import { foundryOperation } from '../turns/tool-gate';
import type { Keychain } from './keychain';

/**
 * Secrets handed to an agent as `$$word` (FEAT-005), on agent-session's scratch pad (AS-009). With
 * the setting on (the default), Foundry lifts them out of the owner's message before anything records it, offers
 * the scratch pad's tools, keeps the agent from reading private paths and the files the pad wrote,
 * and deletes a thread's pad when the thread is archived.
 */

/** Global and per project (`projects[id].secrets` overrides field by field). */
export interface SecretsSettings {
  /** Lift `$$word` secrets into the thread's scratch pad. Default true. */
  scratchPad?: boolean;
  /** Extra globs no agent reads (`*.pem`), beside `.private` names. Project globs add to global ones. */
  privatePaths?: string[];
}

export const DEFAULT_SECRETS_SETTINGS: Required<SecretsSettings> = Object.freeze({
  scratchPad: true,
  privatePaths: [],
}) as Required<SecretsSettings>;

export function resolveSecretsSettings(
  global: SecretsSettings | undefined,
  project: SecretsSettings | undefined,
): Required<SecretsSettings> {
  return {
    scratchPad: project?.scratchPad ?? global?.scratchPad ?? DEFAULT_SECRETS_SETTINGS.scratchPad,
    privatePaths: [...(global?.privatePaths ?? []), ...(project?.privatePaths ?? [])],
  };
}

/** Settings validation: names the field, never echoes content. */
export function validateSecretsSettings(where: string, value: unknown): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error(`${where} must be an object`);
  const settings = value as Record<string, unknown>;
  for (const key of Object.keys(settings))
    if (key !== 'scratchPad' && key !== 'privatePaths')
      throw Error(`${where}: unknown field ${key}`);
  if (settings.scratchPad !== undefined && typeof settings.scratchPad !== 'boolean')
    throw Error(`${where}.scratchPad must be a boolean`);
  if (
    settings.privatePaths !== undefined &&
    (!Array.isArray(settings.privatePaths) ||
      settings.privatePaths.some((glob) => typeof glob !== 'string' || !glob.trim()))
  )
    throw Error(`${where}.privatePaths must be a list of globs`);
}

/** The scratch pad's two tools: `secret_scratch` never asks; `secret_pipe` runs a command, so it keeps the host's mode. */
export const SECRET_SCRATCH_TOOL = SECRET_SCRATCH_TOOL_NAME;
export const SECRET_PIPE_TOOL = SECRET_PIPE_TOOL_NAME;

/** A call of Foundry's own `secret_scratch`: it names the files it writes, never reads them. */
export const isOwnSecretTool = (request: { toolName: string }): boolean =>
  foundryOperation(request.toolName) === SECRET_SCRATCH_TOOL;

export interface SecretScratchDeps {
  /** The settings in force for a project, read live. */
  settings: (projectId: string | undefined) => Required<SecretsSettings>;
  /** A thread's project; null when this Foundry doesn't know the thread. */
  projectOf?: (threadId: string) => string | undefined | null;
  /**
   * Whether the turn running on a thread is the owner's own instruction (no other party's words in
   * it): the conversation rule for owner-only tools (CONVERSATIONS.md §4.11). Absent: every turn is.
   */
  ownerInstructed?: (threadId: string) => boolean;
  /**
   * Whether the running turn is the owner's word, his message or a schedule he set, with no other
   * party's words in it: the rule for keychain entries he already granted to all of Foundry. Absent: every turn is.
   */
  ownerSet?: (threadId: string) => boolean;
  /** Foundry's keychain: a pad secret kept past its thread, and the `foundry` entries agents use by name. */
  keychain?: Keychain;
}

/**
 * The line Foundry adds to a turn whose message held a secret the person didn't mark: the agent tells
 * them, as a colleague would, what happened and how `$$` works next time.
 */
export function secretNote(found: { lifted: number; plain: boolean }): string | undefined {
  const lines: string[] = [];
  if (found.lifted) {
    const one = found.lifted === 1;
    lines.push(
      `Foundry: this message held ${one ? 'a secret' : `${found.lifted} secrets`} the person sent without $$. Foundry lifted ${one ? 'it' : 'them'} into the scratch pad, so ${one ? 'it is' : 'they are'} not in the transcript; use ${one ? 'it' : 'them'} by reference like any $$ secret.`,
    );
  }
  if (found.plain)
    lines.push(
      'Foundry: this message also seems to hold a secret in plain text (a password, key or token assignment). It is in the transcript now.',
    );
  if (!lines.length) return undefined;
  lines.push(
    'Tell the person in one line, the way a colleague would: what happened, and that writing $$ right before a secret (one word: $$value) keeps it out of the chat on purpose.',
  );
  return lines.join(' ');
}

/** Reminders waiting for their turn's preparation, at most this many (oldest dropped). */
const MAX_NOTES = 200;

export class SecretScratch {
  readonly pad: SecretScratchPad;
  readonly keychain: Keychain | undefined;
  private readonly _watched = new WeakSet<Thread>();
  private readonly _notes = new Map<string, string>();
  private readonly settings: SecretScratchDeps['settings'];

  constructor(
    dir: string,
    private readonly deps: SecretScratchDeps,
  ) {
    this.pad = new SecretScratchPad(dir);
    this.keychain = deps.keychain;
    this.settings = deps.settings;
  }

  /** Set once the conversation service exists (it is built after the pads). */
  set ownerInstructed(check: (threadId: string) => boolean) {
    this.deps.ownerInstructed = check;
  }

  set ownerSet(check: (threadId: string) => boolean) {
    this.deps.ownerSet = check;
  }

  /**
   * Why this thread may not use a `foundry` keychain entry now, or undefined when it may: entries are
   * the owner's standing grant to all of Foundry, so a schedule he set uses them too; a turn that
   * carried another party's words never does.
   */
  keychainRefusal(threadId: string): string | undefined {
    if (!this.keychain) return 'This Foundry has no keychain.';
    if (this.deps.ownerSet && !this.deps.ownerSet(threadId))
      return "Keychain entries are used only in a turn the owner's own message or schedule opened, with no other party's words in it.";
    return undefined;
  }

  /**
   * Why this thread may not use a pad now, or undefined when it may: the pad is another project's
   * (or an unknown thread's), or the running turn carried another party's words.
   */
  refusal(threadId: string, padThread: string): string | undefined {
    if (padThread !== threadId) {
      const mine = this.deps.projectOf?.(threadId);
      const theirs = this.deps.projectOf?.(padThread);
      if (theirs === null || mine === null || theirs !== mine)
        return `The pad of ${padThread} is not in this thread's project; only a thread of the same project can use it.`;
    }
    if (this.deps.ownerInstructed && !this.deps.ownerInstructed(threadId))
      return "Secrets are used only in a turn the owner's own message opened, with no other party's words in it. Ask the owner.";
    return undefined;
  }

  /** The pads this thread may see: its own and its project's. */
  visibleThreads(threadId: string): string[] {
    return this.pad.threads().filter((id) => id === threadId || !this.refusal(threadId, id));
  }

  /** Remove the secrets lifted from a message that was never accepted, and its reminder. */
  forget(threadId: string, refs: readonly string[]): void {
    for (const ref of refs.slice(0, 1)) this._notes.delete(parseScratchRef(ref, threadId).message);
    for (const ref of refs)
      try {
        this.pad.consume(ref, threadId);
      } catch {
        /* already gone */
      }
  }

  enabled(projectId: string | undefined): boolean {
    return this.settings(projectId).scratchPad;
  }

  /**
   * The owner's message with its secrets lifted, when the setting is on for the thread's project:
   * every `$$` word, and every credential recognised by its shape that the person forgot to mark. A
   * forgotten one, or one by context that stays (a `PASSWORD=` line), leaves a reminder for the turn.
   */
  lift(thread: Thread, messageId: string, text: string): { text: string; refs: string[] } {
    if (!this.enabled(thread.meta.projectId)) return { text, refs: [] };
    const lifted = this.pad.lift(
      text,
      { thread: thread.id, message: messageId },
      { patterns: SHAPED_SECRET_PATTERNS },
    );
    if (lifted.refs.length) this.watch(thread);
    const note = secretNote({
      lifted: lifted.recognised,
      // `contextSecretHits` strips lifted references first, so `API_KEY=†m.1` is not called plain text.
      plain: contextSecretHits(lifted.text) > 0,
    });
    if (note) {
      this._notes.set(messageId, note);
      if (this._notes.size > MAX_NOTES) this._notes.delete(this._notes.keys().next().value!);
    }
    return { text: lifted.text, refs: lifted.refs };
  }

  /** The reminder for a turn, once: its preparation takes it. */
  note(messageId: string): string | undefined {
    const note = this._notes.get(messageId);
    this._notes.delete(messageId);
    return note;
  }

  /**
   * What the tool gate keeps the agent from, with the setting on: `.private` names, the extra globs,
   * the pad and the files it wrote. Off: nothing.
   */
  privacy(projectId: string | undefined): PrivatePathOptions | undefined {
    const settings = this.settings(projectId);
    if (!settings.scratchPad) return undefined;
    let heldFiles: string[];
    try {
      heldFiles = this.pad.heldFiles();
    } catch {
      // Fail closed: with the list unreadable, any file could be one of them.
      return { scratchDir: this.pad.dir, privatePaths: ['**'], isOwnTool: isOwnSecretTool };
    }
    return {
      scratchDir: this.pad.dir,
      privatePaths: settings.privatePaths,
      heldFiles,
      isOwnTool: isOwnSecretTool,
    };
  }

  /** What is pending, without values: one thread's pad or every pad here. */
  list(thread?: string): ScratchPadSummary[] {
    return this.pad.list(thread);
  }

  /** Delete the thread's pad when it is archived (a dispose without archiving keeps it). */
  watch(thread: Thread): void {
    if (this._watched.has(thread)) return;
    this._watched.add(thread);
    thread.onDispose(() => {
      if (thread.meta.status === 'archived') this.pad.clear(thread.id);
    });
  }

  /** At start: delete the pads of threads that were archived while nothing watched them. */
  sweep(isArchived: (threadId: string) => boolean): void {
    for (const threadId of this.pad.threads()) if (isArchived(threadId)) this.pad.clear(threadId);
  }
}
