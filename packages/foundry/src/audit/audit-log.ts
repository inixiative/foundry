import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
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
  readonly actor?: AuditActor;
  readonly cause?: AuditCause;
  readonly node?: string;
  readonly tier?: string;
}

const FILE = 'audit.jsonl';
const LEGACY_SETTINGS_HISTORY = 'settings-history.jsonl';

const logs = new Map<string, AuditLog>();

export class AuditLog {
  readonly path: string;
  private readonly byId = new Map<string, SourceVersion>();
  private readonly bySubject = new Map<string, SourceVersion[]>();
  private offset = 0;
  private pending = '';

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
    this.importSettingsHistory();
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
    appendFileSync(this.path, rows.map((row) => `${JSON.stringify(row)}\n`).join(''), {
      mode: 0o600,
    });
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
        hash: row.afterHash ?? computeHash('null'),
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
      this.pending = '';
      this.byId.clear();
      this.bySubject.clear();
    }
    if (size === this.offset) return;
    const fd = openSync(this.path, 'r');
    try {
      const buffer = Buffer.alloc(size - this.offset);
      readSync(fd, buffer, 0, buffer.length, this.offset);
      this.offset = size;
      const text = this.pending + buffer.toString('utf8');
      const lines = text.split('\n');
      this.pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let row: SourceVersion;
        try {
          row = JSON.parse(line) as SourceVersion;
        } catch {
          continue; // a torn line from an interrupted append
        }
        if (this.byId.has(row.id)) continue;
        this.byId.set(row.id, row);
        const list = this.bySubject.get(row.subject) ?? [];
        list.push(row);
        this.bySubject.set(row.subject, list);
      }
    } finally {
      closeSync(fd);
    }
  }

  /**
   * The settings history Foundry kept before this log: its lines become settings rows here and the
   * old file is removed, so there is one audit log. One process does it (the rename is the claim).
   */
  private importSettingsHistory(): void {
    const legacy = join(this.dir, LEGACY_SETTINGS_HISTORY);
    if (!existsSync(legacy)) return;
    const claimed = `${legacy}.importing-${process.pid}`;
    try {
      renameSync(legacy, claimed);
    } catch {
      return;
    }
    const rows: SourceVersionInput[] = [];
    for (const line of readFileSync(claimed, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let edit: {
        subject: string;
        revision: number;
        entry: {
          hash: string;
          timestamp: string;
          author: string;
          snapshot: { before: unknown; after: unknown };
        };
      };
      try {
        edit = JSON.parse(line);
      } catch {
        continue;
      }
      const { before, after } = edit.entry.snapshot;
      rows.push(
        settingsRow(
          edit.subject,
          edit.revision,
          before,
          after,
          edit.entry.author,
          Date.parse(edit.entry.timestamp) || Date.now(),
        ),
      );
    }
    this.append(rows);
    unlinkSync(claimed);
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
    beforeHash: before === undefined ? null : computeHash(JSON.stringify(before ?? null)),
    afterHash: computeHash(JSON.stringify(after ?? null)),
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
        timeout: 2_000,
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
