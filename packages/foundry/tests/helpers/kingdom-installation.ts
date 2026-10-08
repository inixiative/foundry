import { join } from 'node:path';
import {
  collectSignet,
  generateSignetKey,
  type OwnerRef,
  registerInstallation,
  requestRegistration,
  saveCollectedSignet,
  verifySignetProof,
  writePrivateJson,
} from '@inixiative/signet';
import type { ServerWebSocket } from 'bun';

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
export const userOwner = () => `User:${crypto.randomUUID()}::`;
export const organizationOwner = () => `Organization::${crypto.randomUUID()}:`;

const random = (bytes = 32) =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('base64url');

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
  const frames: Record<string, unknown>[] = [];
  const credentials: { integrationId: string; token: string }[] = [];
  let url = '';

  const snapshotOf = (installation: Installation) => ({
    pending: installation.pending,
    declinedAt: installation.declinedAt,
    inquiries: installation.inquiries,
    signets: [...signets.values()]
      .filter(
        (signet) =>
          signet.listed &&
          integrations.get(signet.integrationId)?.thumbprint === installation.thumbprint,
      )
      .map(({ signetId, integrationId, name, owner }) => ({
        signetId,
        integrationId,
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
      enrollmentId = crypto.randomUUID();
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
      integrationId: signet.integrationId,
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
            installationId: crypto.randomUUID(),
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
          return data(installation.pending);
        }
        case 'installationInquiries': {
          const { pending, declinedAt, inquiries } = snapshotOf(installation);
          return data({ pending, declinedAt, inquiries });
        }
        case 'installationSignets':
          return data({ signets: snapshotOf(installation).signets });
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
        case 'setInstallationCredential': {
          if (integrations.get(body.integrationId)?.thumbprint !== thumbprint) return refuse(403);
          credentials.push({ integrationId: body.integrationId, token: body.token });
          return data({ credentialId: crypto.randomUUID() });
        }
        default:
          return refuse(404);
      }
    },
    websocket: {
      open(ws) {
        sockets.set(ws, undefined);
        ws.send(JSON.stringify({ type: 'connected', connectionId: crypto.randomUUID() }));
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
    const integrationId = crypto.randomUUID(),
      signetId = crypto.randomUUID(),
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
      id: crypto.randomUUID(),
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
      const signetId = crypto.randomUUID();
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
    /** Revokes every installation: their sockets hear it and stop for good. */
    revokeInstallations() {
      for (const installation of installations.values()) installation.revoked = true;
      for (const ws of sockets.keys()) ws.send(JSON.stringify({ type: 'installationRevoked' }));
    },
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
  const keyFile = join(directory, `key-${crypto.randomUUID()}.json`);
  await writePrivateJson(keyFile, generateSignetKey());
  await registerInstallation(kingdom.url, keyFile, { kind: 'foundry', name: 'Test Foundry' });
  await requestRegistration(kingdom.url, keyFile, {
    name: 'Test Foundry',
    lifecycle: 'ongoing',
    resources: [],
    expiresAt: null,
    maxRequests: null,
    maxConcurrent: 2,
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
