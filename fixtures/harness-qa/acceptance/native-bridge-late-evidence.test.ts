import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextLayer, ContextStack, Thread, ToolRegistry, FileMemory } from "../../../packages/core/src/index";
import { createFoundryMcp, type ToolInvocationRecord } from "../../../packages/foundry/src/mcp/server";
import { createLiveBridge } from "../../../packages/foundry/src/mcp/transport";
import { readLaunchFile } from "../../../packages/foundry/src/mcp/proxy";
import { MemoryToolAdapter, type MemoryBackend } from "../../../packages/foundry/src/tools/memory-adapter";

const resolve = createRequire(new URL("../../../packages/foundry/package.json", import.meta.url)).resolve;
const { Client } = await import(resolve("@modelcontextprotocol/sdk/client/index.js"));
const { StreamableHTTPClientTransport } = await import(resolve("@modelcontextprotocol/sdk/client/streamableHttp.js"));

for (const boundary of ["sdk-termination", "bridge-close"] as const) {
  test(`owned tool evidence settling after ${boundary} remains inspectable`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "foundry-late-tool-"));
    let release!: () => void, enter!: () => void, record!: (value: ToolInvocationRecord) => void;
    const held = new Promise<void>(r => { release = r; });
    const entered = new Promise<void>(r => { enter = r; });
    const recorded = new Promise<ToolInvocationRecord>(r => { record = r; });
    const owner = new Thread("late-owner", new ContextStack([new ContextLayer({ id: "domain" })]));
    owner.meta.projectId = "late-project";
    const memory = new FileMemory(join(dir, "memory"));
    await memory.write({ id: "controlled", kind: "observation", content: "CONTROLLED_LATE_FACT", timestamp: 1, owner: { threadId: owner.id, projectId: "late-project" }, visibility: "thread" });
    const gate = (backend: MemoryBackend): MemoryBackend => ({
      write: entry => backend.write(entry), search: (query, limit) => backend.search(query, limit),
      get: async id => { enter(); await held; return backend.get(id); },
      ...(backend.view ? { view: scope => gate(backend.view!(scope)) } : {}),
    });
    const tools = new ToolRegistry(); tools.register(MemoryToolAdapter.from("file", gate(memory)), "Memory");
    const bridge = await createLiveBridge({ createMcp: () => createFoundryMcp({ thread: owner, tools, onInvocation: record }), launchRoot: dir });
    const client = new Client({ name: "independent-late-evidence", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(bridge.endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${readLaunchFile(bridge.launchFile).capability}` } },
    });
    let call: Promise<unknown> | undefined;
    try {
      await client.connect(transport);
      call = client.callTool({ name: "foundry_memory", arguments: { id: "controlled" } }).catch(() => undefined);
      await entered;
      const before = bridge.invocations();
      if (boundary === "sdk-termination") await transport.terminateSession();
      else await bridge.close();
      release();
      // The callback is authoritative completion evidence, not a timed guess.
      const actual = await Promise.race([recorded, Bun.sleep(1500).then(() => { throw Error("Owned tool did not settle"); })]);
      expect(before).toHaveLength(0);
      expect(bridge.invocations()).toEqual([actual]);
      expect(actual.owner.threadId).toBe(owner.id);
      expect(actual.nativeCorrelation).toBe("unknown");
    } finally {
      release();
      await client.close();
      await call;
      await bridge.close();
      owner.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
