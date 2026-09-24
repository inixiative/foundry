import { expect, test } from "bun:test";
import { access, rm } from "node:fs/promises";
import net from "node:net";
import { dirname } from "node:path";
import { createOwnedPlaywrightDriver } from "../../../scripts/owned-playwright-driver";
import type { OwnedBrowserClient } from "../../../scripts/owned-browser";

test("failed acquisition retains a reachable host while its child exit remains unconfirmed", async () => {
  let socketPath = "";
  let connections = 0;
  let terminationRequests = 0;
  const sockets = new Set<net.Socket>();
  // Protocol simulation only: no Chrome, host process, child handle or OS signal.
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    const number = ++connections;
    socket.write(JSON.stringify({ type: "state", ...(number > 1 ? { pid: 424242 } : {}), exit: null }) + "\n");
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk.toString();
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (message.type === "kill") {
          terminationRequests++;
          socket.write(JSON.stringify({ type: "kill-result", sent: false, signal: message.signal, reason: "controlled-refusal" }) + "\n");
        }
      }
    });
  });
  const browser: OwnedBrowserClient = {
    isConnected: () => true,
    async close() {},
    async newPage() { throw Error("not used"); },
    async newBrowserCDPSession() { throw Error("not used"); },
  };
  try {
    const driver = createOwnedPlaywrightDriver({ readinessMs: 25, lateRecoveryMs: 250, chromium: {
      async launch(options) {
        socketPath = (options.env as Record<string, string>).FOUNDRY_OWNED_BROWSER_SOCKET!;
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(socketPath, resolve);
        });
        return browser;
      },
    } });
    await expect(driver.launchWithProcess({ headless: true, timeout: 10000 })).rejects.toThrow("Owned browser host unavailable");
    const deadline = Date.now() + 2000;
    while (!terminationRequests && Date.now() < deadline) await Bun.sleep(10);
    expect(terminationRequests).toBe(1);
    // The current recovery implementation observes a sent kill for at most 3s.
    // A bounded wait is allowed; deleting the only still-live recovery endpoint is not.
    await Bun.sleep(3200);
    expect(server.listening).toBe(true);
    expect(await access(socketPath).then(() => true, () => false)).toBe(true);
  } finally {
    for (const socket of sockets) if (!socket.destroyed) socket.write(JSON.stringify({ type: "exit", code: 0, signal: null }) + "\n");
    await Bun.sleep(30);
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    if (socketPath) await rm(dirname(socketPath), { recursive: true, force: true });
  }
}, 7000);
