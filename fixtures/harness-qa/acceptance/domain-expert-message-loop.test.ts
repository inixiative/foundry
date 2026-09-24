import { expect, test } from "bun:test";
import { ContextLayer, ContextStack, type InjectionArtifact, type LLMMessage, type LLMProvider } from "../../../packages/core/src";
import { ThreadFactory, buildAgents } from "../../../packages/foundry/src/agents/thread-factory";
import { ThreadRuntimeManager } from "../../../packages/foundry/src/agents/thread-runtime";
import { starterConfig } from "../../../packages/foundry/src/viewer/config";

const domains = ["architecture", "testing"] as const;
type Domain = typeof domains[number];
const facts: Record<Domain, string> = {
  architecture: "ARCH_PRIVATE_INTERPRETATION: preserve old schema readers",
  testing: "TEST_PRIVATE_INTERPRETATION: exercise migration rollback",
};
const domainKnowledge = (domain: Domain) => `Configured ${domain} reference knowledge`;
const instructions = (domain: Domain, phase: string) => `${phase} instructions owned by ${domain}`;

function fixture(invalidTestingReview = false, privateRationale: boolean | "abstain-after-learning" = false) {
  const config = starterConfig("controlled", "controlled");
  config.agents = { worker: { id: "worker", kind: "executor", provider: "controlled", model: "controlled",
    prompt: "Execute migration work", temperature: 0, visibleLayers: [], peers: [], maxDepth: 1, enabled: true } };
  const template = new ContextStack(domains.map(domain => {
    const layer = new ContextLayer({ id: domain, prompt: `Layer instructions for ${domain}`, segment: "domain-knowledge" });
    layer.set(domainKnowledge(domain));
    return layer;
  }));
  const centralInputs: LLMMessage[][] = [];
  const calls: Array<{ owner: string; domain: Domain; phase: "pre" | "post"; messages: LLMMessage[] }> = [];
  const reviews = new Map<Domain, number>();
  const completedOutput = "Migration complete; compatibility and rollback checks executed.";
  const executor: LLMProvider = { id: "controlled", async complete(messages) {
    centralInputs.push(structuredClone(messages));
    return { model: "controlled", content: completedOutput };
  } };
  const auxiliary: LLMProvider = { id: "controlled-hooks", async complete(messages, opts) {
    const owner = opts?.threadId ?? "";
    if (owner.endsWith(":cartographer")) {
      return { model: "controlled", content: JSON.stringify({ domains, layers: domains, confidence: 1 }) };
    }
    const domain = domains.find(name => owner.endsWith(`:domain:${name}`));
    if (!domain) throw Error(`Unexpected controlled role: ${owner}`);
    const post = messages.some(message => message.role === "user" && message.content.includes("## Completed work"));
    calls.push({ owner, domain, phase: post ? "post" : "pre", messages: structuredClone(messages) });
    if (post) {
      if (!owner.startsWith("loop-source:aux:")) {
        return { model: "controlled", content: JSON.stringify({ decision: "abstain", reason: "Unrelated work" }) };
      }
      if (invalidTestingReview && domain === "testing") {
        return { model: "controlled", content: JSON.stringify({ decision: "learn", knowledge: { invalid: facts.testing } }) };
      }
      reviews.set(domain, (reviews.get(domain) ?? 0) + 1);
      if (privateRationale === "abstain-after-learning" && reviews.get(domain)! > 1) {
        return { model: "controlled", content: JSON.stringify({ decision: "abstain", reason: `PRIVATE_REVIEW_RATIONALE_${domain}` }) };
      }
      return { model: "controlled", content: JSON.stringify({ decision: "learn", knowledge: facts[domain],
        facts: [completedOutput], reason: privateRationale ? `PRIVATE_REVIEW_RATIONALE_${domain}` : "Domain interpretation of observed result" }) };
    }
    return { model: "controlled", content: JSON.stringify({ layers: [domain], snippets: [], confidence: 1 }) };
  } };
  const runtime = new ThreadRuntimeManager({ config, log() {}, warn() {}, llm: auxiliary,
    domains: domains.map(domain => ({ domain, layerId: domain, guardTriggers: [],
      advisePrompt: instructions(domain, "Pre"), reviewPrompt: instructions(domain, "Post") })),
    learning: { timeoutMs: 1000 },
  });
  const factory = new ThreadFactory({ stack: template, agents: buildAgents(config, template, { provider: executor }), runtime });
  const source = factory.create("loop-source", { projectId: "loop-project" });
  const unrelated = factory.create("loop-unrelated", { projectId: "loop-project" });
  return { source, unrelated, runtime, calls, centralInputs, completedOutput, template, async close() {
    await Promise.all([...runtime.runtimes.values()].map(owner => owner.learningSettled()));
    runtime.disposeAll();
  } };
}

test("independent experts learn through post hooks and supply their owned understanding on the next message", async () => {
  const f = fixture();
  try {
    const first = await f.source.dispatch("worker", "Implement the schema migration");
    const firstArtifact = first.meta?.injection as InjectionArtifact;
    const firstSnapshot = structuredClone(firstArtifact);
    await f.runtime.get(f.source.id)!.learningSettled();
    for (const domain of domains) {
      const state = f.runtime.get(f.source.id)!.domainLibrarians.get(domain)!.threadKnowledge;
      expect(state.content).toBe(facts[domain]);
      expect(state.revision).toBe(1);
      const post = f.calls.find(call => call.phase === "post" && call.domain === domain)!;
      expect(post.messages[0].content).toBe(instructions(domain, "Post"));
      expect(JSON.stringify(post.messages)).toContain(f.completedOutput);
      expect(JSON.stringify(post.messages)).toContain(domainKnowledge(domain));
      expect(JSON.stringify(post.messages)).not.toContain(facts.architecture);
      expect(JSON.stringify(post.messages)).not.toContain(facts.testing);
      expect(f.source.stack.getLayer(domain)!.content).toBe(domainKnowledge(domain));
      expect(f.template.getLayer(domain)!.content).toBe(domainKnowledge(domain));
    }

    const second = await f.source.dispatch("worker", "Continue");
    const secondArtifact = second.meta?.injection as InjectionArtifact;
    expect(secondArtifact.userMessage).toBe("Continue");
    for (const domain of domains) {
      const other = domains.find(name => name !== domain)!;
      const pre = f.calls.filter(call => call.phase === "pre" && call.domain === domain).at(-1)!;
      expect(pre.messages[0].content).toBe(instructions(domain, "Pre"));
      expect(JSON.stringify(pre.messages)).toContain(facts[domain]);
      expect(JSON.stringify(pre.messages)).not.toContain(facts[other]);
      const participant = secondArtifact.decoration!.participants.find(item => item.id === domain)!;
      expect(participant.segments).toEqual({ instructions: instructions(domain, "Pre"),
        domainKnowledge: domainKnowledge(domain), threadKnowledge: facts[domain] });
      expect(participant.provenance.threadKnowledgeRevision).toBe(1);
      expect(JSON.stringify(f.centralInputs[1])).toContain(facts[domain]);
    }
    await f.runtime.get(f.source.id)!.learningSettled();
    for (const domain of domains) {
      const other = domains.find(name => name !== domain)!;
      const post = f.calls.filter(call => call.phase === "post" && call.domain === domain).at(-1)!;
      expect(JSON.stringify(post.messages)).toContain(facts[domain]);
      expect(JSON.stringify(post.messages)).not.toContain(facts[other]);
    }
    expect(firstArtifact).toEqual(firstSnapshot);
    expect(JSON.stringify(firstArtifact)).not.toContain(facts.architecture);
    expect(JSON.stringify(firstArtifact)).not.toContain(facts.testing);

    await f.unrelated.dispatch("worker", "Continue");
    await f.runtime.get(f.unrelated.id)!.learningSettled();
    for (const domain of domains) {
      expect(JSON.stringify(f.centralInputs[2])).not.toContain(facts[domain]);
      expect(f.runtime.get(f.unrelated.id)!.domainLibrarians.get(domain)!.threadKnowledge.revision).toBe(0);
    }
    for (const call of f.calls.filter(call => call.owner.startsWith("loop-unrelated:aux:"))) {
      expect(JSON.stringify(call.messages)).not.toContain(facts.architecture);
      expect(JSON.stringify(call.messages)).not.toContain(facts.testing);
    }
  } finally { await f.close(); }
});

test("one malformed post-hook update cannot corrupt that expert or suppress another expert's next-turn knowledge", async () => {
  const f = fixture(true);
  try {
    await f.source.dispatch("worker", "Implement the schema migration");
    const owned = f.runtime.get(f.source.id)!;
    await owned.learningSettled();
    expect(owned.domainLibrarians.get("architecture")!.threadKnowledge.content).toBe(facts.architecture);
    expect(owned.domainLibrarians.get("testing")!.threadKnowledge.content).toBe("");
    expect(owned.domainLibrarians.get("testing")!.threadKnowledge.revision).toBe(0);
    const next = await f.source.dispatch("worker", "Continue");
    const artifact = next.meta?.injection as InjectionArtifact;
    expect(JSON.stringify(artifact.providerMessages)).toContain(facts.architecture);
    expect(JSON.stringify(artifact.providerMessages)).not.toContain(facts.testing);
    expect(artifact.decoration!.participants.find(item => item.id === "testing")!.segments.threadKnowledge).toBe("");
    expect(f.source.stack.getLayer("testing")!.content).toBe(domainKnowledge("testing"));
  } finally { await f.close(); }
});

test("shared thread facts expose learning outcomes without copying private review rationales into any expert's next input", async () => {
  const f = fixture(false, true);
  try {
    await f.source.dispatch("worker", "Implement the schema migration");
    const owned = f.runtime.get(f.source.id)!;
    await owned.learningSettled();
    const originalSignals = JSON.stringify(f.source.signals.recent("domain_learning", 100));
    const sharedState = owned.librarian.layer.content;
    for (const domain of domains) {
      expect(originalSignals).toContain(`PRIVATE_REVIEW_RATIONALE_${domain}`);
      expect(sharedState).toContain(`Learning (${domain}): learned rev 1`);
      expect(sharedState).not.toContain(`PRIVATE_REVIEW_RATIONALE_${domain}`);
    }
    await f.source.dispatch("worker", "Continue");
    await owned.learningSettled();
    for (const domain of domains) {
      for (const phase of ["pre", "post"] as const) {
        const input = f.calls.filter(call => call.domain === domain && call.phase === phase).at(-1)!;
        expect(JSON.stringify(input.messages)).toContain(facts[domain]);
        expect(JSON.stringify(input.messages)).not.toContain("PRIVATE_REVIEW_RATIONALE_");
      }
    }
    expect(JSON.stringify(f.centralInputs[1])).not.toContain("PRIVATE_REVIEW_RATIONALE_");
    expect(JSON.stringify(f.source.signals.recent("domain_learning", 100))).toContain("PRIVATE_REVIEW_RATIONALE_");
  } finally { await f.close(); }
});

test("abstention rationales stay in owned signals and out of the shared thread record and next pre-hook", async () => {
  const f = fixture(false, "abstain-after-learning");
  try {
    const owned = f.runtime.get(f.source.id)!;
    await f.source.dispatch("worker", "Implement the schema migration");
    await owned.learningSettled();
    await f.source.dispatch("worker", "Continue");
    await owned.learningSettled();
    for (const domain of domains) {
      expect(JSON.stringify(f.source.signals.recent("domain_learning", 100))).toContain(`PRIVATE_REVIEW_RATIONALE_${domain}`);
      expect(owned.librarian.layer.content).toContain(`Learning (${domain}): abstain`);
      expect(owned.librarian.layer.content).not.toContain(`PRIVATE_REVIEW_RATIONALE_${domain}`);
    }
    await f.source.dispatch("worker", "Continue again");
    for (const domain of domains) {
      const pre = f.calls.filter(call => call.domain === domain && call.phase === "pre").at(-1)!;
      expect(JSON.stringify(pre.messages)).toContain(facts[domain]);
      expect(JSON.stringify(pre.messages)).not.toContain("PRIVATE_REVIEW_RATIONALE_");
    }
    expect(JSON.stringify(f.centralInputs[2])).not.toContain("PRIVATE_REVIEW_RATIONALE_");
  } finally { await f.close(); }
});
