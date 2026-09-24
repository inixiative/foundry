import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextStack, Thread } from "@inixiative/foundry-core";
import { SessionManager } from "../src/agents/session";
import { enrollLocalDevice } from "../src/devices/local-inventory";
import { createFoundryMcp } from "../src/mcp/server";
const resolve = createRequire(new URL("../package.json", import.meta.url)).resolve;
const { Client } = await import(resolve("@modelcontextprotocol/sdk/client/index.js"));
const { InMemoryTransport } = await import(resolve("@modelcontextprotocol/sdk/inMemory.js"));

for (const enrolled of [false, true]) test(`native device context is scoped and read-only (enrolled=${enrolled})`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "foundry-mcp-device-")), path = join(dir, "device.json");
  const owner = new Thread("owner", new ContextStack(), { projectId: "own-project", cwd: dir });
  const foreign = new Thread("foreign", new ContextStack(), { projectId: "foreign-project", cwd: "/private/foreign" });
  const manager = new SessionManager(); manager.add(owner); manager.add(foreign);
  const device = enrolled ? enrollLocalDevice("Controlled device", path) : null;
  const mcp = createFoundryMcp({ thread: owner, sessionManager: manager, deviceIdentityPath: path });
  const client = new Client({ name: "controlled-device-client", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await mcp.server.connect(st); await client.connect(ct);
    const result = await client.callTool({ name: "foundry_device", arguments: {} });
    expect(mcp.invocations().at(-1)!.status).toBe(enrolled ? "ok" : "unavailable");
    const content = result.content[0].text;
    expect(content).not.toContain("foreign-project");
    expect(content).not.toContain("/private/foreign");
    if (enrolled) {
      const inventory = JSON.parse(content);
      expect(inventory.device.id).toBe(device!.id);
      expect(inventory.checkouts).toHaveLength(1);
      expect(inventory.checkouts[0].projectId).toBe("own-project");
      owner.meta.cwd = join(dir, "changed");
      await client.callTool({ name: "foundry_device", arguments: {} });
      expect(mcp.invocations().at(-1)!.status).toBe("unavailable");
      owner.meta.cwd = dir;
      owner.meta.projectId = "foreign-project";
      await client.callTool({ name: "foundry_device", arguments: {} });
      expect(mcp.invocations().at(-1)!.status).toBe("refused");
    }
  } finally {
    await client.close(); await mcp.server.close(); owner.dispose(); foreign.dispose(); rmSync(dir, { recursive: true, force: true });
  }
});
