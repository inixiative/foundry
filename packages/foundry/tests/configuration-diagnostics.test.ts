import { expect, test } from "bun:test";
import { ContextLayer, ContextStack, Thread, type LLMProvider } from "@inixiative/foundry-core";
import { buildAgents, buildLayers, ThreadFactory } from "../src/agents/thread-factory";
import { resolveThreadDomains } from "../src/agents/configured-experts";
import { ThreadRuntimeManager, DEFAULT_THREAD_DOMAINS } from "../src/agents/thread-runtime";
import { starterConfig, type FoundryConfig } from "../src/viewer/config";

function configuration(explicit = false) {
  const c = starterConfig("controlled", "expert-model");
  c.agents = {};
  c.layers = Object.fromEntries(["docs", "conventions"].map(id => [id, {
    id, prompt: "PRIVATE_LAYER_CONTENT_".repeat(500), sourceIds: [], staleness: 0, enabled: true,
  }]));
  if (explicit) {
    c.layers.docs.domain = "docs"; c.layers.docs.writers = ["docs-expert"];
    c.agents["docs-expert"] = { id: "docs-expert", kind: "decider", flowRole: "domain-advising", domain: "docs",
      prompt: "PRIVATE_EXPERT_INSTRUCTIONS", model: "expert-model", provider: "controlled", tools: false,
      visibleLayers: ["docs"], ownedLayers: ["docs"], peers: [], maxDepth: 1, enabled: true };
  }
  return c;
}

function setup(config: FoundryConfig) {
  let calls = 0, loads = 0;
  const warnings: string[] = [];
  const provider = (id: string): LLMProvider => ({ id, complete: async () => { calls++; throw Error("Inspection cannot admit a model"); } });
  const llm = provider("controlled"), phase = provider("phase"), providers = new Map([[llm.id, llm], [phase.id, phase]]);
  const layers = { sourceResolver: () => ({ id: "private", load: async () => { loads++; return "PRIVATE_SOURCE"; } }) };
  const stack = new ContextStack(buildLayers(config, layers));
  const manager = new ThreadRuntimeManager({ config, llm, providers, warn: message => warnings.push(message), log() {} });
  const agents = { provider: llm, providers };
  const factory = new ThreadFactory({ stack, agents: buildAgents(config, stack, agents), runtime: manager,
    configuration: { config, layers, agents } });
  return { factory, manager, warnings, llm, providers, get calls() { return calls; }, get loads() { return loads; } };
}

for (const metadata of ["domain", "writers"] as const) {
  for (const location of ["configuration", "instance"] as const) {
    test(`passive ${metadata} on a legacy ${location} layer reports its suppression without creating an expert`, () => {
      const c = configuration();
      const definition = metadata === "domain" ? { domain: "passive-catalog" } : { writers: ["catalog-editor"] };
      if (location === "configuration") Object.assign(c.layers.docs, definition);
      const original = JSON.stringify(c), f = setup(c);
      const t = location === "configuration" ? f.factory.create("diagnostic")
        : new Thread("diagnostic", new ContextStack([new ContextLayer({ id: "docs", definition: { id: "docs", ...definition } }), new ContextLayer({ id: "conventions" })]));
      try {
        const runtime = f.manager.attach(t);
        expect([...runtime.domainLibrarians.keys()]).toEqual(["conventions"]);
        expect(t.stack.getLayer("thread-knowledge:docs")).toBeUndefined();
        expect(f.warnings).toHaveLength(1);
        expect(f.warnings[0]).toContain("legacy-expert-suppressed");
        expect(f.warnings[0]).toContain('domain="docs" layer="docs"');
        expect(f.warnings[0]).toContain(`metadata=${metadata}`);
        expect(f.warnings[0]).toContain("domain-advising");
        expect(f.warnings[0]).toContain("ownedLayers");
        expect(f.warnings[0].length).toBeLessThan(900);
        expect(f.warnings.join("\n")).not.toContain("PRIVATE_");
        expect(f.warnings.join("\n")).not.toContain("catalog-editor");
        expect(f.manager.attach(t)).toBe(runtime); expect(f.warnings).toHaveLength(1);
        expect(JSON.stringify(c)).toBe(original); expect(f.calls).toBe(0); expect(f.loads).toBe(0);
      } finally { t.dispose(); f.manager.disposeAll(); }
    });
  }
}

for (const mode of ["explicit-enabled", "agent-disabled", "layer-disabled", "generated", "absent"] as const) {
  test(`${mode} does not receive a misleading passive suppression diagnostic`, () => {
    const c = configuration(mode !== "generated" && mode !== "absent");
    if (mode === "agent-disabled") c.agents["docs-expert"].enabled = false;
    if (mode === "layer-disabled") c.layers.docs.enabled = false;
    if (mode === "generated") { c.layers.docs.segment = "thread-knowledge"; c.layers.docs.domain = "docs"; }
    if (mode === "absent") delete c.layers.docs;
    const f = setup(c);
    try {
      const t = f.factory.create(mode), runtime = f.manager.get(t.id)!;
      expect(runtime.domainLibrarians.has("docs")).toBe(mode === "explicit-enabled");
      expect(f.warnings).toHaveLength(0); expect(f.calls).toBe(0); expect(f.loads).toBe(0);
    } finally { f.manager.disposeAll(); }
  });
}

test("contradictory explicit writer mappings still refuse before warnings or partial attachment", () => {
  const c = configuration(true), f = setup(c);
  c.layers.docs.writers = ["foreign-expert"];
  const manager = new ThreadRuntimeManager({ config: c, llm: f.llm, warn: message => f.warnings.push(message) });
  const t = new Thread("invalid", new ContextStack([new ContextLayer({ id: "docs" })]));
  try {
    expect(() => manager.attach(t)).toThrow("Conflicting writers");
    expect(manager.runtimes.size).toBe(0); expect(manager.stacks.size).toBe(0);
    expect(t.stack.layers).toHaveLength(1); expect(f.warnings).toHaveLength(0); expect(f.calls).toBe(0);
  } finally { t.dispose(); manager.disposeAll(); f.manager.disposeAll(); }
});

test("explicit review override is reported while requested phase settings and pre profile remain intact", () => {
  const c = configuration(true);
  c.agents["docs-expert"].thinking = "high";
  c.learning = { review: { provider: "phase", model: "review-model", thinking: "medium", maxTokens: 1700 } };
  const original = JSON.stringify(c), f = setup(c);
  try {
    const t = f.factory.create("override"), lib = f.manager.get(t.id)!.domainLibrarians.get("docs")!;
    expect(lib.reviewProviderId).toBe("phase");
    expect(lib.reviewOptions).toMatchObject({ model: "review-model", thinking: "medium", maxTokens: 1700, tools: false, maxTurns: 1, timeout: 0 });
    const resolved = resolveThreadDomains(c, new Map(buildLayers(c, { sourceResolver: () => null }).map(l => [l.id, l])),
      { legacy: DEFAULT_THREAD_DOMAINS, llm: f.llm, providers: f.providers }).find(d => d.domain === "docs")!;
    expect(resolved.adviseOpts).toMatchObject({ model: "expert-model", thinking: "high", tools: false, maxTurns: 1 });
    expect(f.warnings).toHaveLength(1); expect(f.warnings[0]).toContain("expert-review-profile-override");
    expect(f.warnings[0]).toContain('domain="docs" layer="docs"');
    expect(f.warnings[0]).toContain("learning.review");
    expect(f.warnings[0]).toContain("changed=provider,model,thinking,maxTokens");
    expect(f.warnings[0]).toContain("requested"); expect(f.warnings[0]).not.toContain("PRIVATE_");
    expect(f.manager.attach(t)).toBe(f.manager.get(t.id)!); expect(f.warnings).toHaveLength(1);
    expect(JSON.stringify(c)).toBe(original); expect(f.calls).toBe(0); expect(f.loads).toBe(0);
  } finally { f.manager.disposeAll(); }
});

test("an explicit review profile equal to the expert profile does not claim an override", () => {
  const c = configuration(true);
  c.learning = { review: { provider: "controlled", model: "expert-model", maxTokens: 1600 } };
  const f = setup(c);
  try { f.factory.create("same-profile"); expect(f.warnings).toHaveLength(0); expect(f.calls).toBe(0); }
  finally { f.manager.disposeAll(); }
});

test("a later generated-layer conflict does not publish a successful resolution diagnostic", () => {
  const c = configuration(), f = setup(c);
  c.layers.docs.domain = "passive";
  const manager = new ThreadRuntimeManager({ config: c, llm: f.llm, warn: message => f.warnings.push(message) });
  const t = new Thread("collision", new ContextStack([new ContextLayer({ id: "docs" }), new ContextLayer({ id: "conventions" }), new ContextLayer({ id: "thread-knowledge:conventions" })]));
  try { expect(() => manager.attach(t)).toThrow("Generated expert layer already exists"); expect(f.warnings).toHaveLength(0); expect(manager.runtimes.size).toBe(0); expect(f.calls).toBe(0); }
  finally { t.dispose(); manager.disposeAll(); f.manager.disposeAll(); }
});

test("passive diagnostics bound and escape legacy identities without copying metadata values", () => {
  const c = configuration(), f = setup(c);
  const layerId = `legacy\n${"x".repeat(1000)}`, domain = "docs";
  const layer = new ContextLayer({ id: layerId, definition: { id: layerId, domain: "PRIVATE_METADATA".repeat(1000), writers: ["PRIVATE_WRITER"] } });
  const manager = new ThreadRuntimeManager({ config: c, llm: f.llm, domains: [{ domain, layerId, guardTriggers: [] }],
    warn: message => f.warnings.push(message) });
  const t = new Thread("bounded-diagnostic", new ContextStack([layer]));
  try {
    expect(manager.attach(t).domainLibrarians.size).toBe(0);
    expect(f.warnings).toHaveLength(1); expect(f.warnings[0].length).toBeLessThan(900);
    expect(f.warnings[0]).toContain("metadata=domain,writers");
    expect(f.warnings[0]).toContain("legacy\\n"); expect(f.warnings[0]).not.toContain("\n");
    expect(f.warnings[0]).not.toContain("PRIVATE_"); expect(f.calls).toBe(0);
  } finally { t.dispose(); manager.disposeAll(); f.manager.disposeAll(); }
});
