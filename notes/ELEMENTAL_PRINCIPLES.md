# Elemental Principles over Checklists

*Design note. March 2026.*

---

## The Insight

Elemental principles work because an agent that understands the principle can derive the procedure — and the ten other procedures the checklist didn't mention.

**"Verify before you claim done, with evidence the artifex can review"** produces:
- rubocop
- rspec
- browser QA
- proof of fulfillment in the discharge record

**"Escalate when you can't build evidence for proceeding"** produces better routing than any escalation flowchart.

The understanding generalizes; the checklist doesn't.

---

## Why This Matters for Foundry

Foundry's corpus architecture faces a fundamental choice: do you encode **procedures** (do X, then Y, then Z) or **principles** (understand why X matters, derive the rest)?

Checklists are brittle:
- They enumerate known cases but miss novel ones
- They become stale as tooling and conventions evolve
- They create compliance behavior ("did I check all the boxes?") rather than understanding
- An agent following a checklist can pass every item and still ship broken work

Principles are generative:
- An agent that understands "verify with evidence" will invent verification methods appropriate to the context
- When the tooling changes, the principle still applies — the agent adapts its procedures
- Principles compose: "verify with evidence" + "escalate when you can't build evidence" produces an entire quality workflow from two sentences
- Novel situations are handled by reasoning from the principle, not searching for the right checklist item

---

## Implications for Corpus Design

1. **System prompts should encode principles, not procedures.** The principle fits in fewer tokens and covers more cases.
2. **Skills can encode procedures** — but skills are the *derived* artifacts from principles. The principle is the source of truth; the skill is one instantiation.
3. **Evaluation (Oracle) should test principle adherence**, not checklist completion. "Did the agent verify with evidence?" is a better rubric than "Did the agent run rubocop?"
4. **Corpus compaction** benefits enormously — replacing 20 procedural rules with 3 principles reduces token count while increasing coverage.

---

## The Hierarchy

```
Principle (elemental, few tokens, broad coverage)
  └── derives → Procedure (specific, more tokens, narrow coverage)
       └── instantiates → Checklist Item (concrete, most tokens, single case)
```

Teach at the highest level the agent can reliably reason from. Only drop to procedures/checklists when the agent demonstrably fails to derive correct behavior from the principle.

This is measurable with Foundry's fixture architecture: run the same task with principle-only corpus vs. checklist corpus. If the principle-only version scores the same or better, the checklists are dead weight.

---

## First-Principles Constraint Derivation

The deeper version of "principles over checklists" is this: agents should derive constraints from first principles — not inherit process as cargo cult.

The questions that generate real constraints:

- **What does "done" actually mean?** Not "did I run the tests" but "what evidence would convince someone this is correct?" An agent that understands this will invent verification appropriate to the context — sometimes that's tests, sometimes it's a proof, sometimes it's a demo.
- **How does an agent know it served the intent?** Not "did I follow the instructions" but "did the outcome match what was actually needed?" This is the difference between compliance and fulfillment. A checklist-following agent can pass every item and still miss the point.
- **What does integrity require?** Not "did I follow the style guide" but "would I ship this if I had to maintain it?" This produces craft without enumerating craft rules.

### Why This Matters

Standard agent discipline — code review checklists, PR templates, definition-of-done lists — is cargo cult when applied to agents. The agent follows the form without understanding the substance. It checks the boxes because the boxes are there, not because it understands what the boxes protect against.

By deriving constraints from first principles, agents grasp the substance without inheriting the cargo cult. The goal is not agents that follow a process, but agents that **understand WHY the discipline exists** and can serve the underlying need even when no standard process applies.

This is especially important for novel situations — the cases no checklist anticipated. A principle-reasoning agent handles the novel case by asking "what is this discipline trying to protect?" and deriving appropriate behavior. A checklist-following agent has no entry for the novel case and either skips it or halts.

### The Derivation Test

For any process rule in the corpus, ask: "Can an agent derive this from a more fundamental principle?" If yes, replace the rule with the principle. If no, the rule is genuinely atomic — keep it.

Example derivations:
- "Run tests before committing" derives from "verify with evidence before claiming done"
- "Don't merge without review" derives from "no unobserved work enters the shared artifact"
- "Write descriptive commit messages" derives from "leave enough signal for the next actor to understand your intent"
- "Handle errors gracefully" derives from "the system must be honest about what it knows and doesn't know"

The derived form is shorter, covers more cases, and survives tooling changes. When the test framework changes, "verify with evidence" still works. "Run `pytest`" doesn't.

---

*The corpus should be a small set of load-bearing principles, not an encyclopedia of procedures. Foundry's evaluation engine is how you prove which is which.*
