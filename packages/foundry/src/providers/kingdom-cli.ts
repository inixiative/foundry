import { hostname } from 'node:os';
import { parseArgs } from 'node:util';
import { createTerminalPrompts } from '../setup/prompts';
import { ConfigStore } from '../viewer/config';
import {
  kingdomIntegrationId,
  listedSignets,
  overallStatus,
  selectKingdomIntegration,
} from './kingdom-installation-connection';
import {
  disconnectKingdom,
  HOSTED_KINGDOM_URL,
  kingdomPairInputSchema,
  pairKingdomIntegration,
  viewerRunning,
} from './kingdom-pairing';

export const defaultInstallationName = () => `Foundry on ${hostname()}`.slice(0, 120);
const restartHint =
  'A Foundry viewer is running; restart it (bun run daemon:start restarts the daemon) so it loads the changed Kingdom pairing.';

export interface PairKingdomOptions {
  configDir: string;
  /** Required unless `replace` selects the paired Kingdom. */
  url?: string;
  name?: string;
  /** Open the review page (macOS `open`). */
  open?: boolean;
  /** Re-pair an already paired Kingdom (selected by `kingdom`, else by `url`) instead of adding one. */
  replace?: boolean;
  /** Paired Kingdom id or API origin that `replace` targets. */
  kingdom?: string;
  log?: (line: string) => void;
  launch?: (url: string) => void;
  socketOptions?: { pollMs?: number; retryBaseMs?: number; authTimeoutMs?: number };
}

/** Installation pairing for terminals: same flow and persistence as Settings → Kingdom. */
export async function pairKingdom(options: PairKingdomOptions) {
  const { configDir, log = console.error } = options;
  const store = new ConfigStore(configDir);
  const integrations = (await store.load()).kingdomIntegrations ?? [];
  const replaced = options.replace
    ? selectKingdomIntegration(integrations, options.kingdom ?? options.url)
    : undefined;
  const input = (() => {
    try {
      return kingdomPairInputSchema.parse({
        url: replaced?.url ?? options.url,
        name: options.name ?? defaultInstallationName(),
      });
    } catch {
      throw Error(
        'Enter a Kingdom API origin (HTTPS; HTTP only on localhost) and a Foundry name of at most 120 characters.',
      );
    }
  })();
  const paired = integrations.filter((integration) => integration.url === input.url);
  if (!replaced && paired.length)
    log(
      `Already paired with ${input.url} as ${paired.map((integration) => integration.owner).join(', ')}. Approve as a different owner to add it, or pass --replace to pair that one again.`,
    );
  const { id, settings } = await pairKingdomIntegration(store, configDir, {
    ...input,
    ...(replaced ? { replace: kingdomIntegrationId(replaced) } : {}),
    ...(options.socketOptions ? { socketOptions: options.socketOptions } : {}),
    onReview: (review) => {
      log(`Approve this Foundry in Kingdom: ${review.review}`);
      log(
        `Confirm the review code matches: ${review.reviewCode} (expires ${new Date(review.expiresAt).toLocaleTimeString()})`,
      );
      if (options.open !== false && (options.launch || process.platform === 'darwin')) {
        try {
          (
            options.launch ??
            ((url) => {
              Bun.spawn(['open', url], { stdout: 'ignore', stderr: 'ignore' });
            })
          )(review.review);
        } catch {}
      }
      log('Waiting for approval…');
    },
    onWaiting: (message) => log(`Still waiting: ${message}`),
  });
  const restartViewer = await viewerRunning();
  if (restartViewer) log(restartHint);
  return {
    status: 'connected' as const,
    id,
    url: settings.url,
    owner: settings.owner,
    integrationId: settings.integrationId,
    signetId: settings.signetId,
    restartViewer,
  };
}

export type KingdomIntegrationStatus = {
  id: string;
  url: string;
  owner: string;
  integrationId: string;
  signetId: string;
  status: 'connected' | 'unavailable';
};

/** Every paired Kingdom, connected while it still lists the Signet this Foundry was paired with. */
export async function kingdomStatus(configDir: string) {
  const integrations = (await new ConfigStore(configDir).load()).kingdomIntegrations ?? [];
  const listed = await listedSignets(
    configDir,
    integrations.map((integration) => integration.url),
  );
  const statuses: KingdomIntegrationStatus[] = integrations.map((integration) => ({
    id: kingdomIntegrationId(integration),
    url: integration.url,
    owner: integration.owner,
    integrationId: integration.integrationId,
    signetId: integration.signetId,
    status: listed.get(integration.url)?.has(integration.signetId) ? 'connected' : 'unavailable',
  }));
  return { status: overallStatus(statuses), integrations: statuses };
}

/** KINGDOM_URL, then hosted production. */
export const defaultKingdomUrl = () => process.env.KINGDOM_URL ?? HOSTED_KINGDOM_URL;

const usage =
  'Usage: bun run kingdom <pair|status|disconnect> [--url KINGDOM_API_ORIGIN] [--name NAME] [--replace] [--kingdom ID|URL] [--no-open] [--config-dir DIR]';

async function main() {
  const { values: v, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: {
      url: { type: 'string' },
      name: { type: 'string' },
      kingdom: { type: 'string' },
      'config-dir': { type: 'string' },
      replace: { type: 'boolean' },
      'no-open': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  const command = positionals[0];
  if (v.help || !command || !['pair', 'status', 'disconnect'].includes(command)) {
    console.log(usage);
    if (!v.help) process.exitCode = 1;
    return;
  }
  const configDir = v['config-dir'] ?? process.env.FOUNDRY_CONFIG_DIR ?? '.foundry';
  const output = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  if (command === 'status') {
    const status = await kingdomStatus(configDir);
    output(status);
    if (status.status === 'unavailable') process.exitCode = 1;
    return;
  }
  if (command === 'disconnect') {
    const removed = await disconnectKingdom(new ConfigStore(configDir), configDir, v.kingdom);
    const restartViewer = !!removed && (await viewerRunning());
    if (removed)
      console.error(
        `Removed this machine's Signet for ${removed.url} (${removed.owner}). Revoke the Foundry integration in Kingdom too.`,
      );
    if (restartViewer) console.error(restartHint);
    const remaining = ((await new ConfigStore(configDir).load()).kingdomIntegrations ?? []).map(
      (integration) => ({
        id: kingdomIntegrationId(integration),
        url: integration.url,
        owner: integration.owner,
      }),
    );
    output({
      status: 'disconnected',
      ...(removed
        ? {
            removed: { id: removed.id, url: removed.url, integrationId: removed.integrationId },
            restartViewer,
          }
        : {}),
      ...(remaining.length ? { remaining } : {}),
    });
    return;
  }
  let url = v.url;
  if (!url && !v.replace) {
    const fallback = defaultKingdomUrl();
    if (!process.stdin.isTTY) url = fallback;
    else {
      const prompts = createTerminalPrompts();
      try {
        url = await prompts.ask('Kingdom API address', fallback);
      } finally {
        prompts.close();
      }
    }
  }
  output(
    await pairKingdom({
      configDir,
      url,
      name: v.name,
      open: !v['no-open'],
      replace: v.replace,
      kingdom: v.kingdom,
    }),
  );
}

if (import.meta.main)
  main().catch((error) => {
    console.error(
      error instanceof Error && error.name === 'Error'
        ? error.message
        : 'Kingdom command failed; check the address and private configuration directory.',
    );
    process.exitCode = 1;
  });
