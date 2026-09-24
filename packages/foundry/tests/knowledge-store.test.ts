import { afterEach, expect, test } from "bun:test";
import { ContextLayer, ContextStack, Thread, type Signal } from "@inixiative/foundry-core";
import { ThreadKnowledge } from "../src/agents/domain-librarian";
import type { ThreadKnowledgeBundle } from "../src/agents/thread-runtime";
import { LocalSessionStore } from "../src/persistence/local-session-store";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });

function setup() {
  const store = new LocalSessionStore(":memory:"); cleanup.push(() => store.close());
  const thread = new Thread("a", new ContextStack(), { projectId: "P" });
  cleanup.push(() => thread.dispose());
  const states = ["security", "docs"].map(name => new ThreadKnowledge(name, new ContextLayer({ id: name })));
  for (const state of states) state.learn(`PRIVATE-${state.domain}`, { kind: "dispatch", id: `evidence-${state.domain}`, timestamp: 1 }, "reviewer");
  const bundle = (): ThreadKnowledgeBundle => ({ threadId: "a", projectId: "P", capturedAt: Date.now(),
    domains: Object.fromEntries(states.map(state => [state.domain, state.snapshot({ threadId: "a", projectId: "P" })])) });
  const signal = (domain: string, id = `signal-${domain}`, revision = 1): Signal => ({ id, kind: "domain_learning", source: "reviewer", timestamp: 1,
    content: { domain, decision: "learned", revision, evidence: { id: `evidence-${domain}`, kind: "dispatch", timestamp: 1 } } });
  return { store, thread, states, bundle, signal };
}

test("knowledge and learning event commit per domain without capturing another domain's unjournaled update", () => {
  const { store, thread, bundle, signal } = setup();
  store.saveKnowledge(thread, bundle(), signal("security"));
  expect(Object.keys(store.knowledge("a")!.domains)).toEqual(["security"]);
  store.saveKnowledge(thread, bundle(), signal("docs"));
  expect(Object.keys(store.knowledge("a")!.domains)).toEqual(["security", "docs"]);
  expect(store.learningHistory("a")).toHaveLength(2);
  const snapshot = store.knowledge("a")!; snapshot.domains.security.evidence[0].id = "mutation";
  expect(store.knowledge("a")!.domains.security.evidence[0].id).toBe("evidence-security");
});

test("duplicate event is idempotent and revision conflict rolls back both records", () => {
  const { store, thread, states, bundle, signal } = setup();
  store.saveKnowledge(thread, bundle(), signal("security"));
  store.saveKnowledge(thread, bundle(), signal("security"));
  expect(store.learningHistory("a")).toHaveLength(1);
  const old = bundle();
  states[0].learn("Revision two", { kind: "dispatch", id: "next", timestamp: 2 }, "reviewer");
  store.saveKnowledge(thread, bundle(), signal("security", "second", 2));
  expect(() => store.saveKnowledge(thread, old, signal("security", "late-old"))).toThrow("revision");
  expect(store.learningHistory("a")).toHaveLength(2);
  expect(store.knowledge("a")!.domains.security.content).toBe("Revision two");
});

test("rejected learning is journaled without promoting a concurrent uncommitted revision", () => {
  const { store, thread, bundle, signal } = setup();
  const rejected = signal("security"); rejected.content = { domain: "security", decision: "rejected" };
  store.saveKnowledge(thread, bundle(), rejected);
  expect(store.knowledge("a")).toBeUndefined();
  expect(store.learningHistory("a")).toHaveLength(1);
});

test("thread IDs cannot transfer an existing journal to another project", () => {
  const { store, thread, bundle, signal } = setup();
  store.saveKnowledge(thread, bundle(), signal("security"));
  expect(() => store.saveThread({ id: "a", meta: { ...thread.meta, projectId: "Q" } })).toThrow("owner");
  expect(store.threads()[0].meta.projectId).toBe("P");
  const foreign = bundle(); foreign.domains.security.projectId = "Q";
  expect(() => store.saveKnowledge(thread, foreign, signal("security", "foreign-child"))).toThrow("owner");
  expect(store.learningHistory("a")).toHaveLength(1);
});
