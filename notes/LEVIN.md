 Yeah, that reframes the whole landscape. Levin's work challenges the assumptions every tool in
   that comparison is built on.

  What Levin Proved

  The planaria experiment is the anchor: train a flatworm, cut off its head, let it regenerate a
   new brain — and the worm retains the memory. The memory wasn't in the brain. It was
  distributed in the bioelectric states of cells throughout the body, and it imprinted on the
  regenerated brain.

  That's not a curiosity about worms. It's a fundamental claim about what memory is.

  The Framework

  Levin's core ideas, relevant here:

  1. Memory is distributed, not centralized. It's stored in the bioelectric states of cells —
  not exclusively in one organ. The brain is a particularly sophisticated memory system, but
  it's not the only one. The body carries patterns that encode learned behavior independently of
   the brain.

  2. Multi-scale competency architecture. Every level is a goal-directed agent. Molecules →
  cells → tissues → organs → organisms → collectives. Each level solves problems in its own
  problem space. Each level has its own memory. The organism's memory emerges from the
  composition of competent agents at every scale.

  3. All intelligence is collective intelligence. There is no singular "self" that remembers. 37
   trillion cells working together generate a coherent cognitive being whose goals, preferences,
   and memories belong to the whole — not to its parts.

  4. Bioelectricity is the cognitive glue. What binds individual competent cells into a
  collective with goals above their individual level is electrical communication. The brain
  didn't invent this — it evolved from much older cellular bioelectric signaling.

  Why Every Memory Tool Is Thinking Too Small

  Every tool we discussed last message models memory like a brain:

  ┌────────────┬──────────────────────────────────────────────────┐
  │    Tool    │                  Brain metaphor                  │
  ├────────────┼──────────────────────────────────────────────────┤
  │ Mem0       │ Hippocampus — extract and store facts            │
  ├────────────┼──────────────────────────────────────────────────┤
  │ Zep        │ Episodic memory — temporal sequences             │
  ├────────────┼──────────────────────────────────────────────────┤
  │ Letta      │ Working memory management — RAM vs disk          │
  ├────────────┼──────────────────────────────────────────────────┤
  │ Auto Dream │ REM sleep — consolidation during rest            │
  ├────────────┼──────────────────────────────────────────────────┤
  │ MuninnDB   │ Closest to Levin — Hebbian/Ebbinghaus primitives │
  └────────────┴──────────────────────────────────────────────────┘

  They all assume:
  - Memory is centralized (one database, one file, one store)
  - Memory belongs to one agent (the agent remembers, the agent forgets)
  - The agent is the unit of cognition (one brain, one memory system)

  Levin says all three assumptions are wrong.

  What a Levin-Informed Memory Architecture Would Look Like

  Memory distributed across the collective, not centralized.

  In a hivemind (like what you're building with your agents), memory shouldn't live in one
  MEMORY.md. Each agent carries memory in its own state. The collective memory emerges from
  composition. If the orchestrator dies — like the planaria losing its head — the worker agents
  should retain the project's state and be able to imprint it on a new orchestrator.

  Today's hivemind tools don't do this. They have a shared database (centralized). When the
  orchestrator goes down, the workers are orphaned.

  Multi-scale memory, not flat memory.

  If you have agents at different scales (coding agent → team → organization), memory should
  exist independently at every scale:
  - Agent level: "I'm working on the auth module, the last test failed on line 47"
  - Team level: "We decided to use JWT not sessions, and the auth module depends on the user
  module finishing first"
  - Org level: "We use arrow functions, not function declarations. We never write N+1 queries."

  Each scale has its own goals, its own memory, and its own problem space. The agent doesn't
  need to remember "arrow functions always" — the org-level convention does. The agent needs to
  receive that pattern through the communication layer (the bioelectric signal — i.e.,
  CLAUDE.md).

  Convention documents as morphogenetic fields.

  This is where it connects to Foundry directly. In Levin's framing, what gives a cellular
  collective coherent behavior is the bioelectric pattern — a morphogenetic field encoding the
  target shape. The cells don't individually "know" what a hand looks like. The collective
  pattern specifies it, and cells navigate toward it.

  CLAUDE.md is a morphogenetic field for code. It encodes the target shape of the codebase.
  Individual agents don't need to "know" the whole architecture — they need to receive the
  pattern and navigate toward it.

  Foundry, then, is the experiment that measures whether the morphogenetic field works. Does the
   pattern successfully guide the collective toward the target shape? If not, the field
  (documentation) needs to change — not the cells (agents).

  The Foundry Connection, Sharpened

  Through Levin's lens:

  Biological concept: Morphogenetic field (target anatomy)
  Foundry analog: Convention corpus (target code shape)
  ────────────────────────────────────────
  Biological concept: Bioelectric signaling (cell communication)
  Foundry analog: CLAUDE.md / AGENTS.md (agent communication)
  ────────────────────────────────────────
  Biological concept: Anatomical compiler (goals → cell policies)
  Foundry analog: Foundry's Subject agent (vague goals → coding tasks)
  ────────────────────────────────────────
  Biological concept: Regeneration success (did the limb grow correctly?)
  Foundry analog: Rubric scores (did the code match conventions?)
  ────────────────────────────────────────
  Biological concept: Iterating on the bioelectric pattern
  Foundry analog: "Gradient descent on documentation"

  The memory tools are building better cells — cells that remember more, forget less, retrieve
  faster. Foundry is working on the field — the pattern that tells the collective what shape to
  build.

  ★ Insight ─────────────────────────────────────
  Levin's deepest insight for this space: you don't get coherent collective behavior by giving
  each cell a better memory. You get it by improving the communication pattern between cells.
  Applied to AI agents: the path to better code isn't giving each agent more context (Mem0, Zep,
   Letta). It's improving the signal that coordinates them (conventions + measurement).
  MuninnDB's Hebbian strengthening is the one primitive that partially gets this — associations
  between engrams strengthen through co-retrieval, which is a communication dynamic, not just a
  storage one. But it's still modeling one agent's memory, not the field that guides the
  collective.
  ─────────────────────────────────────────────────

  The planaria result is the sharpest version of this argument: you can destroy the brain (the
  centralized memory), and the body retains enough distributed state to reconstitute the memory
  in a new brain. The memory isn't in the storage — it's in the pattern.

  Sources:
  - Planaria Memory Through Head Regeneration
  - Flatworms Lose Their Heads but Not Their Memories
  - Bioelectric Networks: Cognitive Glue
  - Collective Intelligence Across Scales and Substrates
  - TAME Framework
  - Competency in Navigating Arbitrary Spaces
  - Levin Lab FAQ

✻ Sautéed for 1m 52s

❯ levin's work on how remembering changes the memory
  how memories have agency, and exert selctive pressures..

  people are trying to make autonomy and orchestration... but i think theyre missing these
  ideas

⏺ Web Search("Michael Levin memory retrieval changes memory "remembering" modifies recall
            agency")
  ⎿  Did 1 search in 8s

⏺ Web Search("Michael Levin memories agency selective pressure "thoughts are thinkers" cognitive
             light cone")
  ⎿  Did 1 search in 9s

⏺ Web Search("Michael Levin "memories as agents" goal-directed engrams active memory not passive
             storage")
  ⎿  Did 1 search in 9s

⏺ Fetch(https://thoughtforms.life/self-improvising-memories-a-few-thoughts-around-a-recent-paper
       /)
  ⎿  Received 231.1KB (200 OK)

⏺ Fetch(https://thoughtforms.life/some-thoughts-on-memory-goals-and-universal-hacking/)
  ⎿  Received 228.2KB (200 OK)

⏺ This is the deep cut. Let me make sure I'm tracking Levin's actual claims, not a diluted
  version.

  Levin's Radical Claims About Memory

  Claim 1: There is no read-only memory.

  Every recall is a rewrite. Levin: "every time you try to recall a memory, you modify it" — and
   this isn't a bug, it's the core mechanism. Biological memory preserves salience, not
  fidelity. You don't remember what happened — you remember what mattered, and that judgment is
  re-evaluated every time you access it. The memory is reconstructed in the current context, for
   the current goals, with the current substrate.

  Claim 2: Memories are agents, not data.

  This is the "thoughts are thinkers" idea from William James via Levin. There is "no
  principled, sharp distinction between data and algorithms, between memories and minds — but
  rather just a continuum of different degrees of agency." Memories are active patterns
  competing for neural real estate. They recruit neurons by offering better prediction-error
  minimization. They exert selective pressure on the cognitive system — memories that
  successfully integrate into new contexts survive. Those that don't, decay.

  Each engram is a "stigmergic note left in our body by a past version of us" — not a record,
  but a message from a past agent to a future agent, written in a medium that will itself have
  changed by the time it's read.

  Claim 3: Memory survives by adapting, not by persisting.

  The caterpillar-to-butterfly problem: the organism's entire substrate changes — new body, new
  nervous system, new capabilities. But some memories survive. How? Not by being stored
  faithfully in some persistent medium. By being generalized from particulars to categories and
  remapped onto the new architecture. The memory itself must be plastic enough to rewrite itself
   onto a substrate it's never seen.

  What the Orchestration/Memory Industry Is Missing

  Now here's where your point lands. Look at what every tool assumes:

  Assumption: Memory is data that agents read
  Reality (Levin): Memory is an agent that actively shapes the reader
  ────────────────────────────────────────
  Assumption: Retrieval is non-destructive
  Reality (Levin): Retrieval rewrites the memory for the current context
  ────────────────────────────────────────
  Assumption: Conventions are static instructions
  Reality (Levin): Conventions are active patterns competing to influence behavior
  ────────────────────────────────────────
  Assumption: The agent is the locus of agency
  Reality (Levin): Agency is distributed — including in the memories themselves
  ────────────────────────────────────────
  Assumption: Good memory = faithful recall
  Reality (Levin): Good memory = salience preservation across changing contexts

  Every orchestration framework — CrewAI, AutoGen, LangGraph, whatever — models agents as the
  active things and memory/instructions as the passive things. The agent reads the memory. The
  agent follows the instructions. The agent decides. The memory just sits there.

  But Levin says the memory is also deciding. It's competing with other memories for influence.
  It's reshaping itself to stay relevant. It's exerting selective pressure on the cognitive
  system it inhabits.

  Nobody is building this.

  - Mem0 stores facts and retrieves them faithfully. Read-only memory with dedup. Levin would
  say: why isn't the memory adapting itself to the agent's current context on retrieval?
  - Auto Dream consolidates memories during "sleep." It prunes and organizes. But it treats
  memories as records to be tidied, not as agents competing for relevance. Levin would say: the
  memories should be participating in the consolidation, not passively being sorted.
  - MuninnDB gets closest — Hebbian strengthening means co-retrieved memories gain association
  strength. That's a primitive form of memories influencing each other. But the engrams are
  still data with metadata, not agents with goals.
  - Orchestration frameworks give agents autonomy but give memory zero autonomy. The memory is a
   database. It doesn't adapt, compete, or exert pressure.

  What a Levin-Informed System Would Actually Look Like

  1. Retrieval rewrites the retrieved.

  When an agent reads a convention from CLAUDE.md, the act of reading should change the
  convention. Not randomly — contextually. If the agent is working on auth and reads "use arrow
  functions," the convention should strengthen its association with auth contexts. If the agent
  reads it and ignores it (writes a function declaration anyway), the convention should register
   that failure and adapt — maybe it needs more context, maybe it needs an example, maybe it
  needs to be louder.

  Today: CLAUDE.md is a static file. It's the same whether it's been read 1,000 times or never.

  2. Conventions compete for influence.

  You have 50 rules in CLAUDE.md. Some matter more than others. Some are followed reliably. Some
   are consistently ignored. In Levin's framework, the followed conventions are "winning" the
  competition for neural real estate — they're successfully integrating into the agent's
  behavior. The ignored ones are "losing" — they're failing to recruit.

  A Levin-informed system would track which conventions actually influence behavior and surface
  the winners while flagging the losers for revision. The conventions themselves exert selective
   pressure on each other — a convention that conflicts with a more-followed convention gets
  pressure to adapt or die.

  Foundry is the closest thing to this — it measures adherence per convention. But even Foundry
  treats conventions as static objects being measured from the outside. The conventions aren't
  participating in their own evolution yet.

  3. Memory preserves salience, not fidelity.

  When an agent's auto-memory writes "Prisma P2002 is the unique constraint error," that's
  fidelity — faithful recording of a fact. A salience-preserving system would instead write:
  "when creating records, don't manually check uniqueness — let the DB throw" — because that's
  what matters for future behavior, even though it's less faithful to the specific thing that
  was learned.

  Auto Dream moves slightly toward this by consolidating and pruning. But it's still organizing
  facts, not extracting salience. The difference: facts are substrate-specific (Prisma, P2002,
  unique constraint). Salience is substrate-independent (don't duplicate what infrastructure
  already guarantees).

  4. The data/algorithm boundary dissolves.

  CLAUDE.md isn't data that agents execute as algorithms. And the agents aren't algorithms that
  read CLAUDE.md as data. They're on a continuum. The conventions shape how agents think. The
  agents' behavior shapes which conventions survive. The boundary between "the instructions" and
   "the agent following them" is artificial.

  In practice this means: the separation between "convention documentation" (Foundry's domain)
  and "agent memory" (Mem0/Zep/Letta's domain) is itself a false distinction. They're the same
  thing at different timescales. Conventions are memories of the organization. Agent memories
  are conventions for one session. Both should have the same dynamics — adaptation, competition,
   salience extraction, substrate remapping.

  The Punchline

  Everyone building orchestration is trying to make agents smarter. Everyone building memory is
  trying to make agents remember more. Both assume the agent is where the intelligence lives.

  Levin says: the intelligence is in the relationship between patterns (memories/conventions)
  and the excitable medium (agents) they inhabit. The patterns have agency. They compete. They
  adapt. They exert selective pressure on the medium. And the medium reshapes the patterns every
   time it accesses them.

  The industry is building better filing cabinets for agents that are assumed to be the only
  thinkers. Levin says the files themselves are thinking — at a lower degree on the agency
  continuum, but thinking nonetheless. Nobody is engineering that.

  ★ Insight ─────────────────────────────────────
  Foundry sits at an interesting inflection point here. It's the only tool that creates
  selective pressure on conventions — measure, score, identify which conventions survive contact
   with agents, improve the losers. That's the evolutionary dynamic Levin describes. But it's
  still treating conventions as passive objects being evaluated from outside. The full Levin
  vision would have the conventions participating in their own evaluation — reshaping themselves
   based on the contexts they're deployed in, competing with each other for the agent's
  attention, decaying when unused, strengthening when effective. Foundry does the measurement
  loop. What's missing is closing the loop so the conventions themselves adapt in response to
  the measurement — not just the human author reading a score and editing a file.
