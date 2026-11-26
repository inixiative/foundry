/**
 * @atlas
 * @kind service
 * @partOf feature:secrets
 */
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MODEL_REGISTRY } from '@inixiative/foundry-core';
import { type AuditActor, AuditLog } from '../audit/audit-log';
import { readPrivateJson, writePrivateJson } from '../client/private-file';
import { contentHash } from '../persistence/journal-content';

/**
 * Foundry's keychain: secrets kept past a thread, in the machine's own store (the macOS Keychain,
 * libsecret, the Windows Credential Manager, through `Bun.secrets`). The native store holds the
 * values; Foundry keeps an index of names beside it (`.private/keychain.json`), since the native
 * store cannot list. Each entry has one holder: `foundry`, readable by all of Foundry (an agent
 * reaches these by name), or one connector (`provider:anthropic`, `mcp:linear`), readable by that
 * connector alone. Storing an entry, or changing who holds it, is the person's one grant, and every
 * change is a row in Foundry's audit log, the entry's metadata and never its value.
 *
 * The holder rule binds Foundry's own paths (the scratch-pad tools, the providers). It is not a
 * boundary against a process running as this user: an agent's shell can ask the native store for
 * an item it can name, as it can read any file this user can. Keeping a secret from the agent's
 * shell needs the item held by another binary, which this does not do.
 */

export const KEYCHAIN_SERVICE = 'inixiative.foundry';
export const FOUNDRY_HOLDER = 'foundry';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const CONNECTOR = /^(provider|memory|mcp|integration):[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** The index is one private file, read at most 64 KiB; this keeps it well under that. */
export const KEYCHAIN_MAX_ENTRIES = 200;

/** `foundry`, or one connector: `provider:<id>`, `memory:<id>`, `mcp:<id>`, `integration:<id>`. */
export type KeychainHolder = string;

/** Where an entry's value came from. */
export type KeychainSource = 'pad' | 'api' | 'cli';

export interface KeychainEntry {
  readonly name: string;
  readonly holder: KeychainHolder;
  readonly from: KeychainSource;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** The machine's secret store. Async because the native one is. */
export interface KeychainBackend {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<boolean>;
}

export class KeychainError extends Error {
  override readonly name = 'KeychainError';
}

export const isKeychainName = (name: string): boolean => NAME.test(name);
export const isKeychainHolder = (holder: string): boolean =>
  holder === FOUNDRY_HOLDER || CONNECTOR.test(holder);

/** Whether `reader` may read an entry: everyone in Foundry reads `foundry` entries, a connector its own. */
export const holderMayRead = (
  entry: Pick<KeychainEntry, 'holder'>,
  reader: KeychainHolder,
): boolean => entry.holder === FOUNDRY_HOLDER || entry.holder === reader;

/**
 * The native store, one Keychain item per entry under `inixiative.foundry`, each name prefixed by its
 * config directory so two Foundries on one machine never share an entry.
 */
export function nativeKeychainBackend(configDir: string): KeychainBackend {
  const scope = contentHash(realPath(configDir)).slice(0, 12);
  const key = (name: string) => ({ service: KEYCHAIN_SERVICE, name: `${scope}/${name}` });
  return {
    get: (name) => Bun.secrets.get(key(name)),
    set: (name, value) => Bun.secrets.set({ ...key(name), value }),
    delete: (name) => Bun.secrets.delete(key(name)),
  };
}

// why: `/tmp` and `/private/tmp`, or a symlinked home, are one directory and must be one scope.
function realPath(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
}

/** A backend in memory, for tests and machines with no native store. */
export function memoryKeychainBackend(): KeychainBackend {
  const values = new Map<string, string>();
  return {
    get: async (name) => values.get(name) ?? null,
    set: async (name, value) => {
      values.set(name, value);
    },
    delete: async (name) => values.delete(name),
  };
}

/**
 * The environment the API providers read their keys from: the process's own, then, for a key it
 * lacks, the provider's keychain entry named after the registry's `envKey` (`ANTHROPIC_API_KEY`),
 * read as `provider:<id>`. A copy: nothing is written to `process.env`, so no child inherits it.
 * `keys` names other entries to read the same way, each with its reader (dev mode's Chorus token).
 */
export async function providerKeyEnvironment(
  keychain: Keychain,
  environment: Record<string, string | undefined> = process.env,
  keys: ReadonlyArray<readonly [key: string, reader: string]> = Object.entries(MODEL_REGISTRY)
    .filter(([, provider]) => provider.envKey)
    .map(([id, provider]) => [provider.envKey!, `provider:${id}`] as const),
): Promise<Record<string, string | undefined>> {
  const merged = { ...environment };
  let entries: Map<string, KeychainEntry>;
  try {
    entries = new Map(keychain.list().map((entry) => [entry.name, entry]));
  } catch (error) {
    // A bad index costs the keychain's keys, never Foundry's start.
    console.warn(`[Keychain] ${(error as Error).message}`);
    return merged;
  }
  for (const [key, reader] of keys) {
    const entry = entries.get(key);
    if (merged[key]?.trim() || !entry || !holderMayRead(entry, reader)) continue;
    try {
      merged[key] = await keychain.read(key, reader);
    } catch (error) {
      console.warn(`[Keychain] ${(error as Error).message}`);
    }
  }
  return merged;
}

export interface KeychainOptions {
  /** Foundry's config directory: the index lives in its `.private/`, changes in its audit log. */
  configDir: string;
  /** Default: the machine's native store. */
  backend?: KeychainBackend;
  now?: () => number;
}

export interface StoreOptions {
  holder?: KeychainHolder;
  from: KeychainSource;
  actor: AuditActor;
  /** Overwrite an entry of the same name. Without it, an existing name is refused. */
  replace?: boolean;
}

export class Keychain {
  private readonly indexPath: string;
  private readonly backend: KeychainBackend;
  private readonly audit: AuditLog;
  private readonly now: () => number;
  /** Changes run one at a time, so two at once never lose an entry from the index. */
  private changes: Promise<unknown> = Promise.resolve();

  constructor(options: KeychainOptions) {
    this.indexPath = join(options.configDir, '.private', 'keychain.json');
    this.backend = options.backend ?? nativeKeychainBackend(options.configDir);
    this.audit = AuditLog.for(options.configDir);
    this.now = options.now ?? Date.now;
  }

  /** Every entry's name and holder, never a value. */
  list(): KeychainEntry[] {
    return [...this.index().values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  entry(name: string): KeychainEntry | undefined {
    return this.index().get(name);
  }

  /** Names `reader` may read. */
  readable(reader: KeychainHolder): KeychainEntry[] {
    return this.list().filter((entry) => holderMayRead(entry, reader));
  }

  store(name: string, value: string, options: StoreOptions): Promise<KeychainEntry> {
    return this.change(() => this.storeNow(name, value, options));
  }

  private async storeNow(
    name: string,
    value: string,
    options: StoreOptions,
  ): Promise<KeychainEntry> {
    if (!isKeychainName(name))
      throw new KeychainError(
        'a keychain name is letters, digits, dot, dash or underscore, at most 100',
      );
    const holder = options.holder ?? FOUNDRY_HOLDER;
    if (!isKeychainHolder(holder))
      throw new KeychainError(
        'a holder is foundry, or provider:<id>, memory:<id>, mcp:<id> or integration:<id>',
      );
    if (!value) throw new KeychainError('the value is empty');
    const index = this.index();
    const before = index.get(name);
    if (before && !options.replace)
      throw new KeychainError(`${name} is already in the keychain; pass replace to overwrite it`);
    if (!before && index.size >= KEYCHAIN_MAX_ENTRIES)
      throw new KeychainError(`the keychain holds at most ${KEYCHAIN_MAX_ENTRIES} entries`);
    await this.backend.set(name, value);
    const at = this.now();
    const after: KeychainEntry = {
      name,
      holder,
      from: options.from,
      createdAt: before?.createdAt ?? at,
      updatedAt: at,
    };
    index.set(name, after);
    try {
      this.save(index);
    } catch (error) {
      // A new value the index can't name would be orphaned: take it back out.
      if (!before) await this.backend.delete(name).catch(() => false);
      throw error;
    }
    this.record(name, before, after, options.actor);
    return after;
  }

  /** The value, for a reader the entry's holder admits. */
  async read(name: string, reader: KeychainHolder): Promise<string> {
    const entry = this.index().get(name);
    if (!entry) throw new KeychainError(`${name} is not in the keychain`);
    if (!holderMayRead(entry, reader))
      throw new KeychainError(`${name} is held by ${entry.holder}; ${reader} cannot read it`);
    const value = await this.backend.get(name);
    if (value === null)
      throw new KeychainError(`${name} is in the index but missing from the machine's keychain`);
    return value;
  }

  /** Hand an entry to another holder: the person's grant. */
  grant(name: string, holder: KeychainHolder, actor: AuditActor): Promise<KeychainEntry> {
    return this.change(async () => this.grantNow(name, holder, actor));
  }

  private grantNow(name: string, holder: KeychainHolder, actor: AuditActor): KeychainEntry {
    if (!isKeychainHolder(holder))
      throw new KeychainError(
        'a holder is foundry, or provider:<id>, memory:<id>, mcp:<id> or integration:<id>',
      );
    const index = this.index();
    const before = index.get(name);
    if (!before) throw new KeychainError(`${name} is not in the keychain`);
    if (before.holder === holder) return before;
    const after: KeychainEntry = { ...before, holder, updatedAt: this.now() };
    index.set(name, after);
    this.save(index);
    this.record(name, before, after, actor);
    return after;
  }

  remove(name: string, actor: AuditActor): Promise<boolean> {
    return this.change(() => this.removeNow(name, actor));
  }

  private async removeNow(name: string, actor: AuditActor): Promise<boolean> {
    const index = this.index();
    const before = index.get(name);
    if (!before) return false;
    await this.backend.delete(name);
    index.delete(name);
    this.save(index);
    this.record(name, before, undefined, actor);
    return true;
  }

  private change<T>(run: () => Promise<T>): Promise<T> {
    const next = this.changes.then(run, run);
    this.changes = next.catch(() => undefined);
    return next;
  }

  private index(): Map<string, KeychainEntry> {
    let raw: Record<string, unknown>;
    try {
      raw = readPrivateJson(this.indexPath, 'the keychain index');
    } catch (error) {
      if (error instanceof Error && /\(ENOENT\)/.test(error.message)) return new Map();
      throw error;
    }
    const entries = Array.isArray(raw.entries) ? (raw.entries as KeychainEntry[]) : [];
    return new Map(entries.map((entry) => [entry.name, entry]));
  }

  private save(index: Map<string, KeychainEntry>): void {
    writePrivateJson(this.indexPath, { entries: [...index.values()] });
  }

  // why: the row hashes metadata, never the value; a short secret's hash is guessable offline.
  private record(
    name: string,
    before: KeychainEntry | undefined,
    after: KeychainEntry | undefined,
    actor: AuditActor,
  ): void {
    const text = (entry: KeychainEntry | undefined) =>
      entry &&
      JSON.stringify({ holder: entry.holder, from: entry.from, updatedAt: entry.updatedAt });
    const beforeText = text(before);
    const afterText = text(after);
    this.audit.append([
      {
        subject: `keychain:${name}`,
        action: !before ? 'create' : !after ? 'delete' : 'update',
        beforeHash: beforeText ? contentHash(beforeText) : null,
        afterHash: afterText ? contentHash(afterText) : null,
        actor,
        cause: {},
        ...(afterText ? { content: afterText } : {}),
      },
    ]);
  }
}
