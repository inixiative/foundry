import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  type HeldSignet,
  holdInstallationSignets,
  type InstallationSnapshot,
  InstallationSocket,
  type InstallationSocketOptions,
  installationDirectory,
  installationSignets,
  kingdomUrl,
  setInstallationCredential,
  signetCredentialFile,
} from '@inixiative/signet';
import { z } from 'zod';
import { ownerKeySchema } from './kingdom-client';

/** One Kingdom integration this Foundry was paired as: the owner it belongs to and the Signet it was granted. */
export const kingdomIntegrationSchema = z
  .object({
    url: z.string().transform(kingdomUrl),
    integrationId: z.string().uuid(),
    owner: ownerKeySchema,
    signetId: z.string().uuid(),
  })
  .strict();
export type KingdomIntegration = z.input<typeof kingdomIntegrationSchema>;

/** Stable id of a paired Kingdom, derived from its natural key (API origin + owner); survives re-pairing. */
export const kingdomIntegrationId = (integration: { url: string; owner: string }) =>
  createHash('sha256')
    .update(`${kingdomUrl(integration.url)} ${integration.owner}`)
    .digest('hex')
    .slice(0, 12);

/** Every paired Kingdom, at most once per Kingdom + owner, integration and Signet. */
export const kingdomIntegrationsSchema = z
  .array(kingdomIntegrationSchema)
  .superRefine((integrations, context) => {
    const unique = (values: string[]) => new Set(values).size === values.length;
    if (!unique(integrations.map(kingdomIntegrationId)))
      context.addIssue({
        code: 'custom',
        message:
          'Each Kingdom owner may be paired once; pair again with --replace instead of adding a second integration',
      });
    if (!unique(integrations.map((integration) => integration.integrationId)))
      context.addIssue({ code: 'custom', message: 'Each Kingdom integration may be paired once' });
    if (!unique(integrations.map((integration) => integration.signetId)))
      context.addIssue({ code: 'custom', message: 'Each Kingdom Signet may be paired once' });
  });

/** Operator-facing: names the paired Kingdoms to choose from; safe to print. */
export class KingdomSelectionError extends Error {}

/** The paired Kingdom a selector names: its id or its API origin; without a selector, the only one paired. */
export function selectKingdomIntegration<T extends { url: string; owner: string }>(
  integrations: readonly T[] | undefined,
  selector?: string,
): T {
  const origin = (() => {
    try {
      return selector ? kingdomUrl(selector) : undefined;
    } catch {
      return undefined;
    }
  })();
  const candidates = (integrations ?? []).filter(
    (integration) =>
      !selector ||
      kingdomIntegrationId(integration) === selector ||
      kingdomUrl(integration.url) === origin,
  );
  if (candidates.length === 1) return candidates[0]!;
  if (!candidates.length)
    throw new KingdomSelectionError(
      selector
        ? `No paired Kingdom matches ${selector}. Run bun run kingdom status to list them.`
        : 'Pair this Foundry with Kingdom first: bun run kingdom pair',
    );
  throw new KingdomSelectionError(
    `Several Kingdoms are paired${selector ? ` at ${selector}` : ''}; choose one with --kingdom ID (bun run kingdom status lists them).`,
  );
}

/** Where this Foundry keeps its Installation keys and Signets: one directory per Kingdom under it. */
export const kingdomInstallationRoot = (configDir: string) => resolve(configDir, 'kingdom');

/** The Installation directory and key for one Kingdom, created on first use. */
export const kingdomInstallation = (configDir: string, url: string) =>
  installationDirectory(kingdomInstallationRoot(configDir), url);

/** Where the Installation for one Kingdom lives, without creating anything. Mirrors `installationDirectory`. */
export function kingdomInstallationPaths(configDir: string, url: string) {
  const directory = join(kingdomInstallationRoot(configDir), new URL(kingdomUrl(url)).host);
  return { directory, keyFile: join(directory, 'installation-key.json') };
}

/** `connected` when every paired Kingdom is, `unavailable` when any is not, `disconnected` when none is paired. */
export const overallStatus = (integrations: readonly { status: string }[]) =>
  !integrations.length
    ? ('disconnected' as const)
    : integrations.every((integration) => integration.status === 'connected')
      ? ('connected' as const)
      : ('unavailable' as const);

/** Which Signets each Kingdom lists for this Installation: one read per Kingdom; null when it refused or is unreachable. */
export async function listedSignets(configDir: string, urls: readonly string[]) {
  const listed = new Map<string, Set<string> | null>();
  await Promise.all(
    [...new Set(urls)].map(async (url) => {
      const { keyFile } = kingdomInstallationPaths(configDir, url);
      try {
        if (!existsSync(keyFile)) throw Error('No Installation key');
        const { signets } = await installationSignets(url, keyFile, { timeoutMs: 5000 });
        listed.set(url, new Set(signets.map((signet) => signet.signetId)));
      } catch {
        listed.set(url, null);
      }
    }),
  );
  return listed;
}

/**
 * Gives every paired integration the credential Kingdom uses to reach this Foundry's viewer (its tunnel
 * token, presented to `POST /api/handoff`). Failures are logged; Kingdom keeps the last one it was given.
 */
export async function shareViewerCredential(
  configDir: string,
  integrations: readonly KingdomIntegration[],
  token: string,
  warn: (message: string) => void = console.warn,
) {
  await Promise.all(
    integrations.map(async (integration) => {
      try {
        const { keyFile } = await kingdomInstallation(configDir, integration.url);
        await setInstallationCredential(integration.url, keyFile, integration.integrationId, token);
      } catch (error) {
        warn(
          `[Kingdom] ${integration.url} did not take the viewer credential for integration ${integration.integrationId}: ${(error as Error).message}`,
        );
      }
    }),
  );
}

type SocketOptions = Pick<
  InstallationSocketOptions,
  'pingMs' | 'pollMs' | 'retryBaseMs' | 'retryMaxMs' | 'authTimeoutMs'
>;
export interface KingdomInstallationOptions {
  configDir: string;
  sessionCount: () => number;
  /** Fired whenever what this connection authorizes may have changed. */
  onChange?: () => void;
  socket?: SocketOptions;
  /** How long a polled snapshot (the socket down) still counts as current. */
  staleAfterMs?: number;
  /** How long `start` waits for the first snapshot. */
  firstContactMs?: number;
  warn?: (message: string) => void;
}

/**
 * This Foundry's live line to one Kingdom, as its Installation. Kingdom pushes a snapshot of the
 * Signets the Foundry's integrations hold; each one keeps the local Signet files in step (later
 * grants enrolled, revoked ones dropped). The Kingdom authorizes this Foundry while its snapshot is
 * current and still lists the Signet of at least one integration paired here.
 */
export class KingdomInstallationConnection {
  readonly url: string;
  private integrations = new Map<string, z.output<typeof kingdomIntegrationSchema>>();
  private socket: InstallationSocket | null = null;
  private snapshot: { at: number; signetIds: Set<string> } | null = null;
  private latest: InstallationSnapshot | null = null;
  private held: HeldSignet[] = [];
  private holding: Promise<void> = Promise.resolve();
  private pairing = 0;
  private revoked = false;
  private viewerUrl: string | null = null;
  private firstContact: PromiseWithResolvers<void> = Promise.withResolvers<void>();
  constructor(
    url: string,
    integrations: readonly KingdomIntegration[],
    private options: KingdomInstallationOptions,
  ) {
    this.url = kingdomUrl(url);
    for (const integration of integrations) this.setIntegration(integration);
  }
  /** Whether Kingdom currently authorizes this Foundry through any integration paired here. */
  get connected() {
    return [...this.integrations.values()].some((integration) => this.holds(integration.signetId));
  }
  /** Whether Kingdom currently lists this Signet for this Installation. */
  holds(signetId: string) {
    return this.current() && !!this.snapshot?.signetIds.has(signetId);
  }
  get isRevoked() {
    return this.revoked;
  }
  /** The Signets this Foundry holds an enrollment for at this Kingdom, as of the last snapshot. */
  get signets(): readonly HeldSignet[] {
    return this.held;
  }
  all() {
    return [...this.integrations.values()];
  }
  setIntegration(integration: KingdomIntegration) {
    const parsed = kingdomIntegrationSchema.parse(integration);
    if (parsed.url !== this.url) throw Error('Integration belongs to another Kingdom');
    this.integrations.set(kingdomIntegrationId(parsed), parsed);
    this.rehold();
  }
  removeIntegration(id: string) {
    this.integrations.delete(id);
    this.rehold();
  }
  check(): Promise<void> {
    return this.connected
      ? Promise.resolve()
      : Promise.reject(Error(`Kingdom ${this.url} does not currently authorize this Foundry`));
  }
  /** Opens the socket; resolves once the first snapshot authorizes this Foundry, rejects if it does not in time. */
  async start(): Promise<void> {
    if (!this.socket && !this.revoked) {
      const { keyFile } = await kingdomInstallation(this.options.configDir, this.url);
      this.socket = new InstallationSocket({
        url: this.url,
        keyFile,
        viewerUrl: this.viewerUrl,
        sessionCount: this.options.sessionCount,
        ...this.options.socket,
        onSnapshot: (snapshot) => this.receive(snapshot),
        onRevoked: () => {
          this.revoked = true;
          this.socket = null;
          this.firstContact.resolve();
          this.changed();
        },
        onError: (error) => this.warn(`[Kingdom] ${this.url}: ${(error as Error).message}`),
      });
      this.socket.start();
    }
    const timeout = Bun.sleep(this.options.firstContactMs ?? 5_000);
    await Promise.race([this.firstContact.promise, timeout]);
    await this.check();
  }
  stop(): void {
    this.socket?.close();
    this.socket = null;
    this.snapshot = null;
  }
  /** Where Kingdom can reach this Foundry's viewer; null when the tunnel stops. Re-sent on every reconnect. */
  advertise(viewerUrl: string | null) {
    this.viewerUrl = viewerUrl;
    this.socket?.advertise(viewerUrl);
  }
  /** Holds off dropping Signet files while a pairing collects one this connection does not know yet. */
  async whilePairing<T>(pair: () => Promise<T>): Promise<T> {
    this.pairing++;
    try {
      return await pair();
    } finally {
      this.pairing--;
    }
  }
  private current() {
    if (!this.snapshot || this.revoked) return false;
    return (
      !!this.socket?.connected ||
      Date.now() - this.snapshot.at <= (this.options.staleAfterMs ?? 150_000)
    );
  }
  private async receive(snapshot: InstallationSnapshot) {
    this.latest = snapshot;
    this.snapshot = {
      at: Date.now(),
      signetIds: new Set(snapshot.signets.map((signet) => signet.signetId)),
    };
    await this.hold();
    this.firstContact.resolve();
    this.changed();
  }
  private rehold() {
    if (this.latest) void this.hold().then(() => this.changed());
  }
  /**
   * Holds every Signet Kingdom lists on an integration paired here (enrolling when this key has no
   * current enrollment). A listed Signet on an integration not paired here is held only if a file
   * already exists (a pairing in another process may have just collected it).
   */
  private hold(): Promise<void> {
    this.holding = this.holding.then(async () => {
      const snapshot = this.latest;
      if (!snapshot || this.pairing || !this.socket) return;
      const integrationIds = new Set(this.all().map((integration) => integration.integrationId));
      try {
        const { keyFile, directory } = await kingdomInstallation(this.options.configDir, this.url);
        this.held = await holdInstallationSignets(
          this.url,
          keyFile,
          directory,
          snapshot.signets.filter(
            (signet) =>
              integrationIds.has(signet.integrationId) ||
              existsSync(signetCredentialFile(directory, signet.signetId)),
          ),
        );
      } catch (error) {
        this.warn(`[Kingdom] ${this.url} Signets not refreshed: ${(error as Error).message}`);
      }
    });
    return this.holding;
  }
  private changed() {
    this.options.onChange?.();
  }
  private warn(message: string) {
    (this.options.warn ?? console.warn)(message);
  }
}

/**
 * Every paired Kingdom, one Installation connection per Kingdom URL. Each keeps its own socket, so
 * one Kingdom refusing or unreachable never stops another. Ids are paired-Kingdom ids (URL + owner).
 */
export class KingdomInstallationConnections {
  private connections = new Map<string, KingdomInstallationConnection>();
  private viewerUrl: string | null = null;
  constructor(
    integrations: readonly KingdomIntegration[],
    private options: KingdomInstallationOptions,
  ) {
    for (const integration of kingdomIntegrationsSchema.parse(integrations))
      this.connectionFor(integration.url).setIntegration(integration);
  }
  /** Number of paired Kingdom integrations. */
  get size() {
    return this.all().reduce((count, connection) => count + connection.all().length, 0);
  }
  all(): KingdomInstallationConnection[] {
    return [...this.connections.values()];
  }
  /** The connection that carries the paired Kingdom with this id. */
  get(id: string): KingdomInstallationConnection | undefined {
    return this.all().find((connection) =>
      connection.all().some((integration) => kingdomIntegrationId(integration) === id),
    );
  }
  /** Whether Kingdom currently lists the Signet of the paired Kingdom with this id. */
  connected(id: string) {
    const connection = this.get(id);
    const integration = connection
      ?.all()
      .find((candidate) => kingdomIntegrationId(candidate) === id);
    return !!integration && !!connection?.holds(integration.signetId);
  }
  /** True while no Kingdom is paired, or at least one paired Kingdom authorizes this Foundry. */
  get authorized() {
    return !this.size || this.all().some((connection) => connection.connected);
  }
  async check(): Promise<void> {
    if (!this.authorized) throw Error('No paired Kingdom authorizes this Foundry');
  }
  /** Starts every connection concurrently. Resolves to the paired-Kingdom ids that failed first contact. */
  async start(): Promise<string[]> {
    const connections = this.all();
    const results = await Promise.allSettled(connections.map((connection) => connection.start()));
    return connections
      .filter((_, index) => results[index]!.status === 'rejected')
      .flatMap((connection) => connection.all().map(kingdomIntegrationId));
  }
  /** Connects a newly saved integration, replacing the paired Kingdom with the same id. */
  async set(integration: KingdomIntegration): Promise<KingdomInstallationConnection> {
    const id = kingdomIntegrationId(integration);
    const previous = this.get(id);
    if (previous && previous.url !== kingdomUrl(integration.url)) this.remove(id);
    const connection = this.connectionFor(integration.url);
    connection.setIntegration(integration);
    await connection.start().catch(() => {});
    return connection;
  }
  remove(id: string): void {
    const connection = this.get(id);
    if (!connection) return;
    connection.removeIntegration(id);
    if (!connection.all().length) {
      connection.stop();
      this.connections.delete(connection.url);
    }
    this.options.onChange?.();
  }
  /** Runs a pairing against `url` without the live connection dropping the Signet it collects. */
  whilePairing<T>(url: string, pair: () => Promise<T>): Promise<T> {
    const connection = this.connections.get(kingdomUrl(url));
    return connection ? connection.whilePairing(pair) : pair();
  }
  advertise(viewerUrl: string | null) {
    this.viewerUrl = viewerUrl;
    for (const connection of this.all()) connection.advertise(viewerUrl);
  }
  stop(): void {
    for (const connection of this.all()) connection.stop();
  }
  private connectionFor(url: string) {
    const origin = kingdomUrl(url);
    let connection = this.connections.get(origin);
    if (!connection) {
      connection = new KingdomInstallationConnection(origin, [], this.options);
      connection.advertise(this.viewerUrl);
      this.connections.set(origin, connection);
    }
    return connection;
  }
}
