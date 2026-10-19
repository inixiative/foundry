/**
 * @atlas
 * @kind service
 * @partOf feature:auditLog
 */
import { appendFileSync, closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { computeHash, type VersionEntry, type VersionLog } from '@inixiative/foundry-core';
import { contentHash } from '../persistence/journal-content';

/**
 * Foundry's one audit log (docs/THREAD-TREE.md, spec B): every change to something an agent's
 * instructions or domain knowledge are composed from (a settings definition, a ladder file, a
 * configured source, a feedback-written line, the Warden charter), as an append-only line in
 * `<configDir>/audit.jsonl`. A version is a row id (uuidv7, time-ordered), as in the template's
 * AuditLog. Settings edits carry the definition before and after; text subjects carry their text
 * after the change, and the previous row's text is the before.
 */

export type AuditActorKind = 'user' | 'feedback' | 'agent' | 'release' | 'external';

export interface AuditActor {
  readonly kind: AuditActorKind;
  readonly id?: string;
}

/** Why a change happened. A change found by reading (edited outside Foundry) says so. */
export interface AuditCause {
  readonly feedbackItemId?: string;
  readonly changeId?: string;
  readonly settingsRevision?: number;
  readonly gitCommit?: string;
  readonly foundryVersion?: string;
  readonly detected?: 'on-read';
}

export interface SourceVersion {
  readonly id: string;
  /**
   * `agent:<id>` / `layer:<id>` / `source:<id>` / `provider:<id>` / `project:<id>` /
   * `settings:<key>` (settings definitions); `file:<realpath>`, `prompt:agent:<id>[@project:<id>]`,
   * `source-content:<id>`, `prompt:builtin:<role>`, `layer-content:<id>`, `unattributed:<source id>`, `charter`.
   */
  readonly subject: string;
  readonly action: 'create' | 'update' | 'delete';
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  readonly actor: AuditActor;
  readonly cause: AuditCause;
  readonly createdAt: number;
  /** Settings definitions: the settings store revision the edit produced. */
  readonly revision?: number;
  /** Settings definitions: the definition before and after. */
  readonly snapshot?: { readonly before: unknown; readonly after: unknown };
  /** Text subjects: the text after the change. */
  readonly content?: string;
  /** File subjects: the ladder rung and corpus tier it was composed under. */
  readonly node?: string;
  readonly tier?: string;
}

export type SourceVersionInput = Omit<SourceVersion, 'id' | 'createdAt'> & { createdAt?: number };

export interface ObserveOptions {
  /** A reported change: always a new row when the text differs from the latest (an undo is a change). */
  readonly record?: boolean;
  readonly actor?: AuditActor;
  readonly cause?: AuditCause;
  readonly node?: string;
  readonly tier?: string;
}

const FILE = 'audit.jsonl';

const logs = new Map<string, AuditLog>();

export class AuditLog {
  readonly path: string;
  private readonly byId = new Map<string, SourceVersion>();
  private readonly bySubject = new Map<string, SourceVersion[]>();
  private readonly lines = new Map<string, { at: number; length: number }>();
  private offset = 0;
  private pending = Buffer.alloc(0);

  /** The log of a config directory, shared by everything in this process that writes there. */
  static for(dir: string): AuditLog {
    const key = resolve(dir);
    let log = logs.get(key);
    if (!log) {
      log = new AuditLog(key);
      logs.set(key, log);
    }
    return log;
  }

  private constructor(readonly dir: string) {
    this.path = join(dir, FILE);
  }

  /** Every row, oldest first; one subject's when given. */
  rows(subject?: string): SourceVersion[] {
    this.refresh();
    if (subject !== undefined) return [...(this.bySubject.get(subject) ?? [])];
    return [...this.byId.values()];
  }

  get(id: string): SourceVersion | undefined {
    this.refresh();
    return this.byId.get(id);
  }

  latest(subject: string): SourceVersion | undefined {
    this.refresh();
    return this.bySubject.get(subject)?.at(-1);
  }

  /** Append rows (one write), each a new version of its subject. */
  append(inputs: readonly SourceVersionInput[]): SourceVersion[] {
    if (!inputs.length) return [];
    this.refresh();
    const rows = inputs.map(
      (input): SourceVersion => ({
        ...input,
        id: Bun.randomUUIDv7('hex', input.createdAt),
        createdAt: input.createdAt ?? Date.now(),
      }),
    );
    // A writer that died mid-line leaves no newline: start on a fresh line so this row is readable.
    const torn = this.endsTorn();
    appendFileSync(
      this.path,
      (torn ? '\n' : '') + rows.map((row) => `${JSON.stringify(row)}\n`).join(''),
      { mode: 0o600 },
    );
    this.refresh();
    return rows;
  }

  /**
   * The version of `subject` whose text is `text`: the latest one when it already has that text,
   * otherwise a new row. A file subject's path is resolved through symlinks, and a change nobody
   * reported (actor `external`) carries the file's last commit when it matches the file as
   * committed.
   */
  observe(subject: string, text: string, options: ObserveOptions = {}): SourceVersion {
    const key = fileSubject(subject);
    const hash = contentHash(text);
    const latest = this.latest(key);
    if (latest?.afterHash === hash) return latest;
    // A text the subject already had is that version: a snapshot read before a later change (a
    // review admitted before a feedback line, a slower thread) is never logged as a revert. Only a
    // reported change (`record`) appends a row for text the subject had before.
    if (!options.record) {
      const known = this.rows(key).findLast((row) => row.afterHash === hash);
      if (known) return known;
    }
    const actor = options.actor ?? { kind: 'external' };
    const commit =
      actor.kind === 'external' && key.startsWith('file:') ? committedAs(key.slice(5)) : undefined;
    const cause: AuditCause = {
      ...(options.cause ?? (actor.kind === 'external' ? { detected: 'on-read' } : {})),
      ...(commit ? { gitCommit: commit } : {}),
    };
    return this.append([
      {
        subject: key,
        action: latest && latest.afterHash !== null ? 'update' : 'create',
        beforeHash: latest?.afterHash ?? null,
        afterHash: hash,
        actor,
        cause,
        content: text,
        ...(options.node ? { node: options.node } : {}),
        ...(options.tier ? { tier: options.tier } : {}),
      },
    ])[0]!;
  }

  /** The settings definitions' history in the shape `GET /api/settings/history` has always returned. */
  settingsHistory(subject?: string): VersionLog<{ before: unknown; after: unknown }>[] {
    const logs = new Map<string, VersionLog<{ before: unknown; after: unknown }>>();
    for (const row of this.rows(subject)) {
      if (!row.snapshot) continue;
      const log = logs.get(row.subject) ?? {
        subject: row.subject,
        scope: 'definition' as const,
        entries: [],
      };
      const entry: VersionEntry<{ before: unknown; after: unknown }> = {
        hash: row.afterHash ?? computeHash(JSON.stringify(null)),
        timestamp: new Date(row.createdAt).toISOString(),
        trigger: 'settings',
        author: row.actor.kind === 'external' ? 'file' : (row.actor.id ?? row.actor.kind),
        snapshot: { before: row.snapshot.before, after: row.snapshot.after },
      };
      log.entries.push(entry);
      logs.set(row.subject, log);
    }
    return [...logs.values()];
  }

  private endsTorn(): boolean {
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      return false;
    }
    if (!size) return false;
    const fd = openSync(this.path, 'r');
    try {
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, size - 1);
      return last[0] !== 0x0a;
    } finally {
      closeSync(fd);
    }
  }

  /** Read whatever other writers (another Foundry process, a CLI) appended since the last read. */
  private refresh(): void {
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      return;
    }
    if (size < this.offset) {
      // Truncated or replaced: read it again from the start.
      this.offset = 0;
      this.pending = Buffer.alloc(0);
      this.byId.clear();
      this.bySubject.clear();
      this.lines.clear();
    }
    if (size === this.offset) return;
    const fd = openSync(this.path, 'r');
    try {
      const fresh = Buffer.alloc(size - this.offset);
      readSync(fd, fresh, 0, fresh.length, this.offset);
      const buffer = Buffer.concat([this.pending, fresh]);
      let start = this.offset - this.pending.length;
      this.offset = size;
      let from = 0;
      for (let nl = buffer.indexOf(0x0a, from); nl !== -1; nl = buffer.indexOf(0x0a, from)) {
        const line = buffer.subarray(from, nl);
        const at = start;
        start += nl - from + 1;
        from = nl + 1;
        if (!line.length) continue;
        let row: SourceVersion;
        try {
          row = JSON.parse(line.toString('utf8')) as SourceVersion;
        } catch {
          console.warn(`[audit] unreadable line at byte ${at} of ${this.path}`);
          continue;
        }
        if (this.byId.has(row.id)) continue;
        // Text stays on disk: the index keeps where to read it.
        const { content, ...indexed } = row;
        if (content !== undefined) this.lines.set(row.id, { at, length: line.length });
        this.byId.set(row.id, indexed);
        const list = this.bySubject.get(row.subject) ?? [];
        list.push(indexed);
        this.bySubject.set(row.subject, list);
      }
      this.pending = Buffer.from(buffer.subarray(from));
    } finally {
      closeSync(fd);
    }
  }

  /** A text subject's text at a version (read from the log; the index does not hold text). */
  text(id: string): string | undefined {
    this.refresh();
    const where = this.lines.get(id);
    if (!where) return undefined;
    const fd = openSync(this.path, 'r');
    try {
      const line = Buffer.alloc(where.length);
      readSync(fd, line, 0, where.length, where.at);
      return (JSON.parse(line.toString('utf8')) as SourceVersion).content;
    } finally {
      closeSync(fd);
    }
  }
}

/** One settings definition edit as an audit row. `author` is ConfigStore's: `user`, or `file` for an edit made to settings.json on disk. */
export function settingsRow(
  subject: string,
  revision: number,
  before: unknown,
  after: unknown,
  author: string,
  createdAt?: number,
): SourceVersionInput {
  const actor: AuditActor =
    author === 'file'
      ? { kind: 'external' }
      : author === 'user'
        ? { kind: 'user' }
        : { kind: 'agent', id: author };
  return {
    subject,
    action:
      before === undefined || before === null
        ? 'create'
        : after === undefined || after === null
          ? 'delete'
          : 'update',
    beforeHash:
      before === undefined || before === null ? null : computeHash(JSON.stringify(before)),
    afterHash: after === undefined || after === null ? null : computeHash(JSON.stringify(after)),
    actor,
    cause: {
      settingsRevision: revision,
      ...(author === 'file' ? { detected: 'on-read' as const } : {}),
    },
    revision,
    snapshot: { before, after },
    ...(createdAt !== undefined ? { createdAt } : {}),
  };
}

/** A file subject names the file by its real path, so every route to it is one subject. */
function fileSubject(subject: string): string {
  if (!subject.startsWith('file:')) return subject;
  try {
    return `file:${realpathSync(subject.slice(5))}`;
  } catch {
    return subject;
  }
}

/** The file's last commit when the file is unchanged from it (tracked and clean); otherwise none. */
function committedAs(path: string): string | undefined {
  const cwd = dirname(path);
  const name = basename(path);
  const run = (args: string[]) => {
    try {
      const out = Bun.spawnSync(['git', '-C', cwd, ...args], {
        stdout: 'pipe',
        stderr: 'ignore',
        timeout: 500,
      });
      return out.exitCode === 0 ? out.stdout.toString().trim() : undefined;
    } catch {
      return undefined;
    }
  };
  const commit = run(['log', '-1', '--format=%H', '--', name]);
  if (!commit) return undefined;
  return run(['status', '--porcelain', '--', name]) === '' ? commit : undefined;
}
