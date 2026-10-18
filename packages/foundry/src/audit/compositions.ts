import {
  type CompositionSnapshot,
  type OmittedSource,
  type SourceSegment,
  segmentsText,
} from '@inixiative/foundry-core';
import { regionDocOfSubject } from '../agents/region-roster';
import { KNOWLEDGE_DOC, WARDEN_CHARTER } from '../classify';
import { contentHash } from '../persistence/journal-content';
import type { LocalSessionStore } from '../persistence/local-session-store';
import type { AuditLog } from './audit-log';

/**
 * One piece of a composition version, in order (docs/THREAD-TREE.md, spec B):
 * - `glue`: headings and separators the composer put around the parts, verbatim;
 * - `sv` + `text`: the source version the text came from, and the hash of the text it contributed
 *   (the composed form: comments stripped, duplicate sections removed);
 * - `retrieved`: text chosen per message (archive context, file memory), stored with each call.
 * Concatenated in order, with each call's retrieved text, they are exactly what the agent received.
 */
export type CompositionPart =
  | { readonly glue: string }
  | { readonly sv: string; readonly text: string }
  | { readonly retrieved: string };

export type CompositionSlotName = 'instructions' | 'domainKnowledge';

/** A composition version's content: its parts in order, and what the composer left out and why. */
export interface CompositionBody {
  readonly parts: readonly CompositionPart[];
  readonly omitted: readonly OmittedSource[];
}

/** What one call was composed from: the version ids that replace its composed text in the journal. */
export interface CallVersions {
  /** The charter's source version (`charter` subject), when the auditor has seen it. */
  readonly charter?: string;
  readonly instructions: string;
  readonly domainKnowledge: string;
  /** sha256 of each slot's exact text as the call received it (retrieved text included). */
  readonly composedHash: { readonly instructions: string; readonly domainKnowledge: string };
  /** Per-message text, stored raw: the slot and subject it filled, and its content hash. */
  readonly retrieved?: ReadonlyArray<{
    readonly slot: CompositionSlotName;
    readonly subject: string;
    readonly hash: string;
  }>;
  /**
   * A region Warden: its region and the region's warm-cache key, the content hash of the region
   * knowledge this call composed (`regionKey`). Equal across projects whose region text is equal,
   * whatever layer it came from; the key a shared primed prefix would be looked up by.
   */
  readonly chorus?: { readonly region: string; readonly key: string; readonly doc?: string };
}

export interface CompositionAuditorOptions {
  /** The settings store revision a composed settings prompt or source was read under. */
  readonly settingsRevision?: () => number;
  /** This Foundry's version, recorded as the cause of a new charter. */
  readonly foundryVersion?: string;
}

/**
 * Turns a call's composition snapshot into version ids: each attributed part becomes (or reuses) a
 * source version in the audit log, and the slot's ordered parts become (or reuse) a composition
 * version in the journal. Unchanged sources write nothing.
 */
export class CompositionAuditor {
  private charterVersion?: string;

  constructor(
    readonly audit: AuditLog,
    readonly store: LocalSessionStore,
    private readonly options: CompositionAuditorOptions = {},
  ) {}

  /** The Warden charter's source version: a new charter text is a release's change. */
  charter(): string {
    this.charterVersion ??= this.audit.observe('charter', WARDEN_CHARTER, {
      actor: { kind: 'release' },
      cause: {
        ...(this.options.foundryVersion ? { foundryVersion: this.options.foundryVersion } : {}),
      },
    }).id;
    return this.charterVersion;
  }

  /** A classify stage's own charter (recognise, or a pointer set other than the default): its version. */
  stageCharter(charter: { subject: string; text: string }): string {
    return this.audit.observe(charter.subject, charter.text, {
      actor: { kind: 'release' },
      cause: {
        ...(this.options.foundryVersion ? { foundryVersion: this.options.foundryVersion } : {}),
      },
    }).id;
  }

  versions(role: string, snapshot: CompositionSnapshot): CallVersions {
    const retrieved: Array<{ slot: CompositionSlotName; subject: string; hash: string }> = [];
    const slot = (name: CompositionSlotName) =>
      this.record(role, name, snapshot[name], snapshot.omitted?.[name] ?? [], (subject, hash) =>
        retrieved.push({ slot: name, subject, hash }),
      );
    const chorus = regionPart(snapshot.domainKnowledge);
    return {
      charter: snapshot.charter ? this.stageCharter(snapshot.charter) : this.charter(),
      instructions: slot('instructions'),
      domainKnowledge: slot('domainKnowledge'),
      composedHash: {
        instructions: contentHash(segmentsText(snapshot.instructions)),
        domainKnowledge: contentHash(segmentsText(snapshot.domainKnowledge)),
      },
      ...(retrieved.length ? { retrieved } : {}),
      ...(chorus ? { chorus } : {}),
    };
  }

  /** A slot's composition version id. */
  record(
    role: string,
    slot: CompositionSlotName,
    segments: readonly SourceSegment[],
    omitted: readonly OmittedSource[] = [],
    onRetrieved: (subject: string, hash: string) => void = () => {},
  ): string {
    const parts: CompositionPart[] = [];
    for (const segment of segments) {
      if (typeof segment === 'string') {
        if (!segment) continue;
        const last = parts.at(-1);
        if (last && 'glue' in last) parts[parts.length - 1] = { glue: last.glue + segment };
        else parts.push({ glue: segment });
        continue;
      }
      if (segment.retrieved) {
        onRetrieved(segment.subject, this.store.putContent(segment.text));
        parts.push({ retrieved: segment.subject });
        continue;
      }
      const settings =
        segment.subject.startsWith('prompt:agent:') ||
        segment.subject.startsWith('source-content:');
      const revision = settings ? this.options.settingsRevision?.() : undefined;
      const version = this.audit.observe(segment.subject, segment.raw ?? segment.text, {
        ...(segment.node ? { node: segment.node } : {}),
        ...(segment.tier ? { tier: segment.tier } : {}),
        ...(revision !== undefined
          ? { cause: { detected: 'on-read' as const, settingsRevision: revision } }
          : {}),
      });
      parts.push({ sv: version.id, text: this.store.putContent(segment.text) });
    }
    return this.store.compositionVersion(role, slot, { parts, omitted });
  }

  /**
   * The exact text a composition version composes, with the call's retrieved text filled in
   * (`retrieved` by subject, in order of appearance).
   */
  recompose(
    id: string,
    retrieved: ReadonlyArray<{ slot?: CompositionSlotName; subject: string; hash: string }> = [],
  ): string {
    const version = this.store.getCompositionVersion(id);
    if (!version) throw Error(`composition version ${id} not found`);
    // A call's retrieved text covers both slots: only this version's slot fills its placeholders.
    const queue = retrieved.filter((r) => !r.slot || r.slot === version.slot);
    return version.parts
      .map((part) => {
        if ('glue' in part) return part.glue;
        if ('text' in part) return this.store.contentText(part.text);
        const index = queue.findIndex((r) => r.subject === part.retrieved);
        if (index === -1) throw Error(`retrieved text for ${part.retrieved} not given`);
        return this.store.contentText(queue.splice(index, 1)[0]!.hash);
      })
      .join('');
  }

  /**
   * A journal record with every composition snapshot (`composition` on a request) replaced by the
   * version ids it was made of (`versions`). The snapshot's text never reaches the journal.
   */
  versionRecord<T>(record: T): T {
    return replaceCompositions(record, (role, snapshot) => this.versions(role, snapshot));
  }
}

/**
 * The region doc part of a domain-knowledge slot, as the region, its key (`regionKey`) and, for a doc
 * other than knowledge.md (a classify stage's), the doc.
 */
function regionPart(
  segments: readonly SourceSegment[],
): { region: string; key: string; doc?: string } | undefined {
  for (const segment of segments) {
    if (typeof segment === 'string') continue;
    const part = regionDocOfSubject(segment.subject);
    if (part)
      return {
        region: part.region,
        key: contentHash(segment.text),
        ...(part.doc !== KNOWLEDGE_DOC ? { doc: part.doc } : {}),
      };
  }
  return undefined;
}

/** The same record without composition snapshots (no auditor configured). */
export function stripCompositions<T>(record: T): T {
  return replaceCompositions(record, () => undefined);
}

function isSnapshot(value: unknown): value is CompositionSnapshot {
  return (
    !!value &&
    typeof value === 'object' &&
    Array.isArray((value as CompositionSnapshot).instructions) &&
    Array.isArray((value as CompositionSnapshot).domainKnowledge)
  );
}

function replaceCompositions<T>(
  record: T,
  versions: (role: string, snapshot: CompositionSnapshot) => CallVersions | undefined,
  role = 'unknown',
): T {
  if (Array.isArray(record))
    return record.map((item) => replaceCompositions(item, versions, role)) as T;
  if (!record || typeof record !== 'object') return record;
  const source = record as Record<string, unknown>;
  const owner = typeof source.domain === 'string' ? source.domain : role;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === 'composition' && isSnapshot(value)) {
      const ids = versions(value.role ?? owner, value);
      if (ids) out.versions = ids;
      continue;
    }
    out[key] = replaceCompositions(value, versions, owner);
  }
  return out as T;
}
