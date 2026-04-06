import { describe, test, expect } from "bun:test";
import {
  HydrationRegistry,
  RefSource,
  type HydrationAdapter,
  type ContextRef,
} from "../src/agents/hydrator";

function makeAdapter(
  system: string,
  data: Record<string, string>
): HydrationAdapter {
  return {
    system,
    async hydrate(ref) {
      return data[ref.locator] ?? "";
    },
    async hydrateBatch(refs) {
      return refs.map((r) => data[r.locator] ?? "");
    },
  };
}

describe("HydrationRegistry", () => {
  test("register and hydrate single ref", async () => {
    const registry = new HydrationRegistry();
    registry.register(makeAdapter("docs", { "auth.md": "Auth documentation" }));

    const content = await registry.hydrate({
      system: "docs",
      locator: "auth.md",
    });
    expect(content).toBe("Auth documentation");
  });

  test("throws for unregistered system", async () => {
    const registry = new HydrationRegistry();
    expect(
      registry.hydrate({ system: "unknown", locator: "test" })
    ).rejects.toThrow("No hydration adapter");
  });

  test("hydrateAll combines multiple refs", async () => {
    const registry = new HydrationRegistry();
    registry.register(
      makeAdapter("docs", { "a.md": "Doc A", "b.md": "Doc B" })
    );
    registry.register(makeAdapter("memory", { "conv-1": "Convention 1" }));

    const refs: ContextRef[] = [
      { system: "docs", locator: "a.md" },
      { system: "memory", locator: "conv-1" },
      { system: "docs", locator: "b.md" },
    ];

    const content = await registry.hydrateAll(refs);
    expect(content).toBe("Doc A\n\nConvention 1\n\nDoc B");
  });

  test("hydrateAll returns empty string for empty refs", async () => {
    const registry = new HydrationRegistry();
    expect(await registry.hydrateAll([])).toBe("");
  });

  test("hydrateAll uses batch when available", async () => {
    let batchCalled = false;
    const registry = new HydrationRegistry();
    registry.register({
      system: "docs",
      async hydrate(ref) {
        return "single";
      },
      async hydrateBatch(refs) {
        batchCalled = true;
        return refs.map(() => "batched");
      },
    });

    const result = await registry.hydrateAll([
      { system: "docs", locator: "a" },
      { system: "docs", locator: "b" },
    ]);
    expect(batchCalled).toBe(true);
    expect(result).toBe("batched\n\nbatched");
  });

  test("hydrateAll falls back to serial for single ref", async () => {
    let batchCalled = false;
    const registry = new HydrationRegistry();
    registry.register({
      system: "docs",
      async hydrate(ref) {
        return "single";
      },
      async hydrateBatch(refs) {
        batchCalled = true;
        return refs.map(() => "batched");
      },
    });

    await registry.hydrateAll([{ system: "docs", locator: "a" }]);
    // Single ref doesn't trigger batch
    expect(batchCalled).toBe(false);
  });

  test("unregister removes adapter", () => {
    const registry = new HydrationRegistry();
    registry.register(makeAdapter("docs", {}));
    expect(registry.getAdapter("docs")).toBeDefined();
    registry.unregister("docs");
    expect(registry.getAdapter("docs")).toBeUndefined();
  });
});

describe("RefSource", () => {
  test("loads content from refs via registry", async () => {
    const registry = new HydrationRegistry();
    registry.register(
      makeAdapter("docs", { "a.md": "Doc A", "b.md": "Doc B" })
    );

    const source = new RefSource(
      "auth-context",
      [
        { system: "docs", locator: "a.md" },
        { system: "docs", locator: "b.md" },
      ],
      registry
    );

    const content = await source.load();
    expect(content).toBe("Doc A\n\nDoc B");
  });

  test("addRef and removeRef", () => {
    const registry = new HydrationRegistry();
    const source = new RefSource("test", [], registry);

    source.addRef({ system: "docs", locator: "a.md" });
    expect(source.refs.length).toBe(1);

    source.addRef({ system: "docs", locator: "b.md" });
    expect(source.refs.length).toBe(2);

    expect(source.removeRef("a.md")).toBe(true);
    expect(source.refs.length).toBe(1);
    expect(source.removeRef("nonexistent")).toBe(false);
  });
});
