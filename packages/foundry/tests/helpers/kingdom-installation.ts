import { join } from 'node:path';
import {
  type ConversationPermission,
  collectSignet,
  conversationPermissionSchema,
  generateSignetKey,
  type OwnerRef,
  registerInstallation,
  requestRegistration,
  saveCollectedSignet,
  verifySignetProof,
  writePrivateJson,
} from '@inixiative/signet';
import {
  type HostedSignet,
  type RegistrationRequest,
  requestRegistrationSchema,
  type SignetGrant,
} from '@inixiative/signet/contracts';
import type { ServerWebSocket } from 'bun';
import { conversationRows, rowsPermit } from '../../src/conversations/membership';

/** The calls a member makes by default: post, read and the floor. */
const memberCalls = ['thread.prompt', 'thread.read', 'thread.floor'];

/**
 * A grant on one of a Foundry's conversations as Kingdom lists it to the host (signet 0.18): the
 * thread's `conversation` resource (`externalId` = the thread id), its resolved operation leaves
 * (the calls, then the held permissions) or `full`.
 */
export const conversationGrant = (
  opts: {
    threadId?: string;
    full?: boolean;
    operations?: string[];
    permissions?: ConversationPermission[];
    /** The host Foundry's integration the resource is on. */
    integrationId?: string;
  } = {},
): SignetGrant => ({
  id: Bun.randomUUIDv7(),
  resourceModel: 'IntegrationResource',
  integrationResourceId: Bun.randomUUIDv7(),
  kind: 'conversation',
  externalId: opts.threadId ?? 'main',
  integrationId: opts.integrationId ?? Bun.randomUUIDv7(),
  ...(opts.full
    ? { full: true }
    : {
        full: false,
        operations: [...(opts.operations ?? memberCalls), ...(opts.permissions ?? [])],
      }),
});

/**
 * A row over a scope (signet `resourceModel: 'Integration'`): every `conversation` of the host
 * Foundry's integration, or, with `projectId` or `where`, those Kingdom's condition admits.
 */
export const conversationScope = (
  opts: {
    full?: boolean;
    operations?: string[];
    permissions?: ConversationPermission[];
    integrationId?: string;
    projectId?: string;
    where?: Record<string, unknown>;
  } = {},
): SignetGrant => ({
  id: Bun.randomUUIDv7(),
  resourceModel: 'Integration',
  integrationId: opts.integrationId ?? Bun.randomUUIDv7(),
  kind: 'conversation',
  ...(opts.projectId ? { projectId: opts.projectId } : {}),
  ...(opts.where ? { where: opts.where } : {}),
  ...(opts.full
    ? { full: true }
    : {
        full: false,
        operations: [...(opts.operations ?? memberCalls), ...(opts.permissions ?? [])],
      }),
});

/**
 * What a hosted Signet holds on a thread's conversation, as this mock Kingdom relays it on every
 * frame: every row that reaches the thread, a scope row included (Kingdom decides what it reaches).
 */
export const permissionsOf = (
  signet: HostedSignet,
  threadId = 'main',
): ConversationPermission[] => {
  const { face, scoped } = conversationRows(signet, threadId);
  return conversationPermissionSchema.options.filter((permission) =>
    rowsPermit([...face, ...scoped], [permission]),
  );
};

/** The same Signet revised to hold `permissions` beside its calls on each conversation row. */
export const withPermissions = <S extends HostedSignet>(
  signet: S,
  permissions: ConversationPermission[],
): S => ({
  ...signet,
  resources: signet.resources.map((resource) =>
    resource.resourceModel !== 'Project' && !resource.full
      ? {
          ...resource,
          operations: [
            ...(resource.operations ?? []).filter((operation) => operation.startsWith('thread.')),
            ...permissions,
          ],
        }
      : resource,
  ),
});

/** Kingdom's owner reference for an owner key (`ownerModel:userId:organizationId:spaceId`). */
export const ownerOf = (key: string): OwnerRef => {
  const [ownerModel, userId, organizationId, spaceId] = key.split(':');
  return {
    ownerModel: ownerModel as OwnerRef['ownerModel'],
    userId: userId || null,
    organizationId: organizationId || null,
    spaceId: spaceId || null,
  };
};
export const userOwner = () => `User:${Bun.randomUUIDv7()}::`;
export const organizationOwner = () => `Organization::${Bun.randomUUIDv7()}:`;

const random = (bytes = 32) =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('base64url');

/** Kingdom's web app, where requestRegistration's reviewUrl points (not the API host). */
export const kingdomWebUrl = 'https://kingdom-web.test';
export const reviewUrlFor = (reviewCode: string) =>
  `${kingdomWebUrl}/dashboard?reviewSignet=${reviewCode}`;

type Inquiry = {
  id: string;
  type: string;
  status: 'sent' | 'approved' | 'denied' | 'canceled';
  createdAt: string;
  expiresAt: string | null;
  owner: OwnerRef | null;
  ownerName: string | null;
  integrationId: string | null;
  signetId: string | null;
  deliverBefore: string | null;
};
type Installation = {
  installationId: string;
  thumbprint: string;
  name: string;
  pending: { reviewCode: string; expiresAt: string } | null;
  requested?: RegistrationRequest;
  declinedAt: string | null;
  inquiries: Inquiry[];
  revoked: boolean;
};
type Signet = {
  signetId: string;
  integrationId: string;
  name: string;
  owner: OwnerRef;
  listed: boolean;
};
type Presented = { signetId: string; enrollmentId: string; integrationId: string; owner: OwnerRef };

/**
 * An in-memory Kingdom with the Installation surface Foundry uses: registration and review, the
 * Installation socket (or polling, when `websocket` is false), Signet collection and enrollment,
 * the viewer credential, and Signet-presented calls routed to `onSignet`.
 */
export function mockKingdom(
  options: {
    websocket?: boolean;
    /** Approve every registration request as this owner shortly after it is made. */
    autoApprove?: string;
    onSignet?: (action: string, body: any, presented: Presented) => unknown;
  } = {},
) {
  const nonces = new Set<string>();
  const installations = new Map<string, Installation>();
  const integrations = new Map<
    string,
    { integrationId: string; owner: OwnerRef; thumbprint: string }
  >();
  const signets = new Map<string, Signet>();
  const enrollments = new Map<string, Presented & { thumbprint: string }>();
  const sockets = new Map<ServerWebSocket<{ thumbprint?: string }>, string | undefined>();
  const calls: string[] = [];
  const canceled: string[] = [];
  const frames: Record<string, unknown>[] = [];
  const credentials: { integrationId: string; token: string }[] = [];
  const logins: Record<string, unknown>[] = [];
  let url = '';

  /** Signets reaching the installations' integrations: a conversation's members (signet 0.5). */
  const hosted = new Map<string, HostedSignet>();
  /** The integrations a hosted Signet's rows sit on; a Signet has no integration of its own. */
  const reachedBy = (signet: HostedSignet) =>
    signet.resources.flatMap((grant) =>
      grant.resourceModel === 'Project' ? [] : [grant.integrationId],
    );
  const thumbprintsOf = (signet: HostedSignet) =>
    reachedBy(signet).flatMap((integrationId) => {
      const thumbprint = integrations.get(integrationId)?.thumbprint;
      return thumbprint ? [thumbprint] : [];
    });
  const snapshotOf = (installation: Installation) => ({
    pending: installation.pending,
    declinedAt: installation.declinedAt,
    inquiries: installation.inquiries,
    hostedSignetRequests: [],
    hostedSignets: [...hosted.values()].flatMap((signet) => {
      // Kingdom lists only the rows on the installation's own integrations.
      const resources = signet.resources.filter(
        (grant) =>
          grant.resourceModel !== 'Project' &&
          integrations.get(grant.integrationId)?.thumbprint === installation.thumbprint,
      );
      return resources.length ? [{ ...signet, resources }] : [];
    }),
    signets: [...signets.values()]
      .filter(
        (signet) =>
          signet.listed &&
          integrations.get(signet.integrationId)?.thumbprint === installation.thumbprint,
      )
      .map(({ signetId, name, owner }) => ({
        signetId,
        name,
        enrollmentId:
          [...enrollments.values()].findLast(
            (enrollment) =>
              enrollment.signetId === signetId && enrollment.thumbprint === installation.thumbprint,
          )?.enrollmentId ?? null,
        owner,
      })),
  });
  const push = (installation: Installation) => {
    for (const [ws, thumbprint] of sockets)
      if (thumbprint === installation.thumbprint)
        ws.send(JSON.stringify({ type: 'installation.snapshot', ...snapshotOf(installation) }));
  };
  const latest = () => {
    const pending = [...installations.values()].filter((item) => item.pending);
    if (!pending.length) throw Error('No registration is waiting for review');
    return pending.at(-1)!;
  };
  const issue = (signet: Signet, thumbprint: string) => {
    const accessToken = `kingdom_${random()}`,
      enrollmentId = Bun.randomUUIDv7();
    enrollments.set(accessToken, {
      signetId: signet.signetId,
      enrollmentId,
      integrationId: signet.integrationId,
      owner: signet.owner,
      thumbprint,
    });
    return {
      enrollmentId,
      lifecycle: 'ongoing',
      taskId: null,
      accessToken,
      renewalCredential: `signet_renew_${random()}`,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      renewalExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      idleExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      tokenType: 'DPoP',
      signetId: signet.signetId,
      owner: signet.owner,
    };
  };
  const prove = async (proof: string, action: string, token?: string) => {
    const verified = await verifySignetProof({
      proof,
      url: `${url}/api/v1/access/${action}`,
      method: 'POST',
      now: new Date(),
      ...(token ? { token } : {}),
    });
    if (!nonces.delete(verified.nonce)) throw Error('Unknown nonce');
    return verified.keyThumbprint;
  };
  const refuse = (status: number) => Response.json({ error: { message: 'refused' } }, { status });

  const server = Bun.serve<{ thumbprint?: string }>({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request, srv) {
      if (request.headers.get('upgrade') === 'websocket') {
        if (options.websocket === false) return new Response(null, { status: 426 });
        return srv.upgrade(request, { data: {} }) ? undefined : new Response(null, { status: 426 });
      }
      const action = new URL(request.url).pathname.split('/').at(-1)!;
      calls.push(action);
      const body = (await request.json().catch(() => ({}))) as any;
      const data = (value: unknown) => Response.json({ data: value });
      if (action === 'nonce') {
        const nonce = random();
        nonces.add(nonce);
        return data({ nonce, expiresAt: new Date(Date.now() + 60_000).toISOString() });
      }
      const authorization = request.headers.get('authorization');
      let thumbprint: string;
      try {
        thumbprint = await prove(
          request.headers.get('dpop') ?? '',
          action,
          authorization?.replace(/^DPoP /, ''),
        );
      } catch {
        return refuse(401);
      }
      if (authorization) {
        const presented = enrollments.get(authorization.replace(/^DPoP /, ''));
        if (
          !presented ||
          presented.thumbprint !== thumbprint ||
          !signets.get(presented.signetId)?.listed
        )
          return refuse(401);
        const result = await options.onSignet?.(action, body, presented);
        return result instanceof Response ? result : data(result);
      }
      const installation = installations.get(thumbprint);
      if (action === 'registerInstallation') {
        if (installation?.revoked) return refuse(403);
        if (!installation)
          installations.set(thumbprint, {
            installationId: Bun.randomUUIDv7(),
            thumbprint,
            name: body.name,
            pending: null,
            declinedAt: null,
            inquiries: [],
            revoked: false,
          });
        return data({ installationId: installations.get(thumbprint)!.installationId });
      }
      if (!installation || installation.revoked) return refuse(401);
      switch (action) {
        case 'requestRegistration': {
          installation.requested = requestRegistrationSchema.parse(body).terms;
          installation.pending = {
            reviewCode: random(6)
              .replace(/[^A-Za-z0-9]/g, 'A')
              .toUpperCase()
              .slice(0, 8),
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
          };
          if (options.autoApprove) {
            const owner = options.autoApprove;
            setTimeout(() => approve(owner, { installation }), 20);
          }
          return data({
            ...installation.pending,
            reviewUrl: reviewUrlFor(installation.pending.reviewCode),
          });
        }
        case 'installationInquiries': {
          const { pending, declinedAt, inquiries, hostedSignetRequests } = snapshotOf(installation);
          return data({ pending, declinedAt, inquiries, hostedSignetRequests });
        }
        case 'cancelInstallationInquiry': {
          const inquiry = installation.inquiries.find(
            (item) => item.id === body.inquiryId && item.status === 'sent',
          );
          if (!inquiry) return refuse(404);
          installation.inquiries = installation.inquiries.filter((item) => item !== inquiry);
          canceled.push(inquiry.id);
          push(installation);
          return data({ id: inquiry.id });
        }
        case 'installationSignets': {
          const { signets, hostedSignets } = snapshotOf(installation);
          return data({ signets, hostedSignets });
        }
        case 'collectSignet': {
          const inquiry = installation.inquiries.find((item) => item.id === body.inquiryId);
          if (!inquiry) return refuse(404);
          if (inquiry.status !== 'approved') return refuse(409);
          return data(issue(signets.get(inquiry.signetId!)!, thumbprint));
        }
        case 'enrollInstallationSignet': {
          const signet = signets.get(body.signetId);
          if (!signet?.listed || integrations.get(signet.integrationId)?.thumbprint !== thumbprint)
            return refuse(403);
          return data(issue(signet, thumbprint));
        }
        case 'setSubscriptionLogin': {
          const paired = integrations.get(body.integrationId);
          if (paired?.thumbprint !== thumbprint) return refuse(403);
          logins.push(body);
          return data({
            integrationId: Bun.randomUUIDv7(),
            credentialId: Bun.randomUUIDv7(),
            resourceId: Bun.randomUUIDv7(),
            capacityId: Bun.randomUUIDv7(),
            owner: paired.owner,
          });
        }
        case 'setInstallationCredential': {
          if (integrations.get(body.integrationId)?.thumbprint !== thumbprint) return refuse(403);
          credentials.push({ integrationId: body.integrationId, token: body.token });
          return data({ credentialId: Bun.randomUUIDv7() });
        }
        default:
          return refuse(404);
      }
    },
    websocket: {
      open(ws) {
        sockets.set(ws, undefined);
        ws.send(JSON.stringify({ type: 'connected', connectionId: Bun.randomUUIDv7() }));
      },
      async message(ws, raw) {
        const frame = JSON.parse(String(raw));
        frames.push(frame);
        if (frame.action !== 'authenticateInstallation') return;
        const thumbprint = await prove(frame.proof, 'installationSocket').catch(() => undefined);
        const installation = thumbprint ? installations.get(thumbprint) : undefined;
        if (!installation || installation.revoked) {
          ws.send(JSON.stringify({ type: 'installationRejected' }));
          return;
        }
        sockets.set(ws, thumbprint);
        ws.send(
          JSON.stringify({ type: 'installation', installationId: installation.installationId }),
        );
        ws.send(JSON.stringify({ type: 'installation.snapshot', ...snapshotOf(installation) }));
      },
      close(ws) {
        sockets.delete(ws);
      },
    },
  });
  url = `http://127.0.0.1:${server.port}`;

  /** A person approves the waiting registration as `owner`: Kingdom mints the integration and its Signet. */
  function approve(
    owner: string,
    options: { ownerName?: string; installation?: Installation } = {},
  ) {
    const installation = options.installation ?? latest();
    const integrationId = Bun.randomUUIDv7(),
      signetId = Bun.randomUUIDv7(),
      ref = ownerOf(owner);
    integrations.set(integrationId, {
      integrationId,
      owner: ref,
      thumbprint: installation.thumbprint,
    });
    signets.set(signetId, {
      signetId,
      integrationId,
      name: installation.name,
      owner: ref,
      listed: true,
    });
    installation.pending = null;
    installation.inquiries.unshift({
      id: Bun.randomUUIDv7(),
      type: 'registerIntegration',
      status: 'approved',
      createdAt: new Date().toISOString(),
      expiresAt: null,
      owner: ref,
      ownerName: options.ownerName ?? owner,
      integrationId,
      signetId,
      deliverBefore: new Date(Date.now() + 600_000).toISOString(),
    });
    push(installation);
    return { integrationId, signetId };
  }

  return {
    server,
    url,
    calls,
    frames,
    credentials,
    approve,
    /** Inquiries the installation canceled (Kingdom soft-deletes them). */
    canceled,
    /** A person claims the waiting code for an owner they can't manage: the inquiry awaits approval. */
    claim() {
      const installation = latest();
      const id = Bun.randomUUIDv7();
      installation.pending = null;
      installation.inquiries.unshift({
        id,
        type: 'registerIntegration',
        status: 'sent',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        owner: null,
        ownerName: null,
        integrationId: null,
        signetId: null,
        deliverBefore: null,
      });
      push(installation);
      return id;
    },
    /** What the latest installation asked for when it requested registration. */
    requested: () => [...installations.values()].at(-1)?.requested,
    /** A person declines the waiting registration. */
    decline() {
      const installation = latest();
      installation.pending = null;
      installation.declinedAt = new Date().toISOString();
      push(installation);
    },
    /** Grants an integration a further Signet. */
    grant(integrationId: string) {
      const integration = integrations.get(integrationId)!;
      const signetId = Bun.randomUUIDv7();
      signets.set(signetId, {
        signetId,
        integrationId,
        name: 'Later grant',
        owner: integration.owner,
        listed: true,
      });
      push([...installations.values()].find((item) => item.thumbprint === integration.thumbprint)!);
      return signetId;
    },
    /** Revokes (false) or restores (true) a Signet. */
    list(signetId: string, listed: boolean) {
      const signet = signets.get(signetId)!;
      signet.listed = listed;
      const { thumbprint } = integrations.get(signet.integrationId)!;
      push(installations.get(thumbprint)!);
    },
    /**
     * Issue (or revise) a Signet reaching an installation's conversations: a member of them, as
     * Kingdom lists it in `hostedSignets`. The snapshot is pushed.
     */
    host(signet: HostedSignet) {
      hosted.set(signet.signetId, signet);
      for (const thumbprint of thumbprintsOf(signet)) push(installations.get(thumbprint)!);
    },
    /** Revoke a hosted Signet: the next snapshot no longer lists it. */
    unhost(signetId: string) {
      const signet = hosted.get(signetId);
      if (!signet) return;
      hosted.delete(signetId);
      for (const thumbprint of thumbprintsOf(signet)) push(installations.get(thumbprint)!);
    },
    /**
     * Send a conversation frame (`operation.request`, `thread.unsubscribe`, `thread.lease`) down every authenticated Installation socket, as Kingdom's relay does.
     */
    threadFrame(frame: Record<string, unknown>) {
      for (const [ws, thumbprint] of sockets) if (thumbprint) ws.send(JSON.stringify(frame));
    },
    /** The host's answer to a request or subscribe, once it arrives. */
    async operationResponse(requestId: string, ms = 3_000): Promise<Record<string, any>> {
      const end = performance.now() + ms;
      for (;;) {
        const found = frames.find(
          (frame) => frame.action === 'operation.response' && frame.requestId === requestId,
        );
        if (found) return found;
        if (performance.now() > end) throw Error(`no operation.response for ${requestId}`);
        await Bun.sleep(5);
      }
    },
    /** Every `thread.append` the host pushed for one subscription, in arrival order. */
    appends(subscriptionId: string): Record<string, any>[] {
      return frames.filter(
        (frame) => frame.action === 'thread.append' && frame.subscriptionId === subscriptionId,
      );
    },
    /** Drop every Installation socket (the host reconnects on its own). */
    dropSockets() {
      for (const ws of sockets.keys()) ws.close();
    },
    /** Revokes every installation: their sockets hear it and stop for good. */
    revokeInstallations() {
      for (const installation of installations.values()) installation.revoked = true;
      for (const ws of sockets.keys()) ws.send(JSON.stringify({ type: 'installationRevoked' }));
    },
    logins,
    get installations() {
      return [...installations.values()];
    },
    get openSockets() {
      return [...sockets.values()].filter(Boolean).length;
    },
    stop: () => server.stop(true),
  };
}
export type MockKingdom = ReturnType<typeof mockKingdom>;

/** A Signet credential file a Foundry holds, for tests that start from an already paired Foundry. */
export async function heldSignet(kingdom: MockKingdom, directory: string, owner: string) {
  const keyFile = join(directory, `key-${Bun.randomUUIDv7()}.json`);
  await writePrivateJson(keyFile, generateSignetKey());
  await registerInstallation(kingdom.url, keyFile, { kind: 'foundry', name: 'Test Foundry' });
  await requestRegistration(kingdom.url, keyFile, {
    name: 'Test Foundry',
    lifecycle: 'ongoing',
    resources: [],
    expiresAt: null,
    maxRequests: null,
  });
  const installation = kingdom.installations.at(-1)!;
  const { signetId, integrationId } = kingdom.approve(owner, { installation });
  const collected = await collectSignet(kingdom.url, keyFile, installation.inquiries[0]!.id);
  const credentialFile = join(directory, `signet-${signetId}.json`);
  await saveCollectedSignet(credentialFile, kingdom.url, keyFile, collected!);
  return {
    credentialFile,
    keyFile,
    signetId,
    integrationId,
    enrollmentId: collected!.enrollmentId,
  };
}
