import type { ServerWebSocket } from "bun";

type Connection = { installationId?: string };
import type { RuntimeOwner } from "../../src/providers/runtime-job-handler";
export type FakeKingdomIdentity = { installationId: string; userId?: string | null; owner?: RuntimeOwner; expiresAt?: string };
const defaultOwner: RuntimeOwner = { ownerModel: "Organization", organizationId: "11111111-1111-4111-8111-111111111111" };

/** Kingdom's runtime socket protocol plus an optional HTTP surface, for Foundry-side tests. */
export const startFakeKingdom = (options: {
  identify: (token: string) => FakeKingdomIdentity | undefined;
  http?: (request: Request) => Response | Promise<Response>;
}) => {
  const sockets = new Set<ServerWebSocket<Connection>>();
  const statuses: { installationId: string; frame: Record<string, unknown> }[] = [];
  const closes: { installationId?: string; code: number; reason: string }[] = [];
  let pings = 0, answerPings = true;
  const server = Bun.serve<Connection>({
    port: 0, hostname: "127.0.0.1",
    fetch(request, server) {
      if (request.headers.get("upgrade") === "websocket")
        return server.upgrade(request, { data: {} }) ? undefined : new Response("upgrade failed", { status: 426 });
      return options.http?.(request) ?? new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) { sockets.add(ws); ws.send(JSON.stringify({ type: "connected", connectionId: crypto.randomUUID() })); },
      close(ws, code, reason) { sockets.delete(ws); closes.push({ installationId: ws.data.installationId, code, reason }); },
      message(ws, raw) {
        const frame = JSON.parse(String(raw)) as Record<string, unknown>;
        if (frame.action === "authenticateRuntime") {
          const token = String((frame.headers as Record<string, string>)?.authorization ?? "").replace(/^Bearer /, "");
          const identity = options.identify(token);
          if (!identity) {
            ws.send(JSON.stringify({ type: "runtimeRejected", status: 401, message: "Runtime installation unavailable" }));
            ws.close(4401, "Runtime installation unavailable");
            return;
          }
          ws.data.installationId = identity.installationId;
          ws.send(JSON.stringify({ type: "runtimeIdentity", installationId: identity.installationId, userId: identity.userId ?? null, owner: identity.owner ?? defaultOwner, expiresAt: identity.expiresAt ?? new Date(Date.now() + 60000).toISOString() }));
          return;
        }
        if (frame.action === "runtimeStatus" && ws.data.installationId) statuses.push({ installationId: ws.data.installationId, frame });
        if (frame.action === "ping") { pings++; if (answerPings) ws.send(JSON.stringify({ type: "pong" })); }
      },
    },
  });
  const connected = (installationId: string) => [...sockets].filter(ws => ws.data.installationId === installationId);
  return {
    url: `http://127.0.0.1:${server.port}`,
    statuses, closes,
    get pings() { return pings; },
    set answerPings(value: boolean) { answerPings = value; },
    connections: (installationId: string) => connected(installationId).length,
    push: (installationId: string) => { for (const ws of connected(installationId)) ws.send(JSON.stringify({ type: "runtimeJobAvailable", jobId: crypto.randomUUID() })); },
    revoke: (installationId: string) => {
      for (const ws of connected(installationId)) {
        ws.send(JSON.stringify({ type: "runtimeRejected", status: 401, message: "Runtime installation revoked" }));
        ws.close(4401, "Runtime installation revoked");
      }
    },
    drop: (installationId: string) => { for (const ws of connected(installationId)) ws.close(1001, "Server shutting down"); },
    stop: () => server.stop(true),
  };
};

export const waitFor = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 3000) => {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw Error("waitFor timed out");
    await Bun.sleep(10);
  }
};
