# Xandria

> **Status:** Draft / RFC — design exploration, not yet implemented.
> **Author:** Aron Greenspan
> **Relates to:** `docs/FLOW.md` (the orchestration roles), `@inixiative/json-rules` (the lens primitive), `foundry-oracle` (the separate-repo precedent).

Xandria is the **agentic hub**: one place that owns everything you have — your models and subscriptions, your sources of information, your contacts, your live threads — and lends out **lens-scoped surfaces of itself** to anything that wants to consume them.

The name descends from the great Library of Alexandria, because that is what it is: a single monumental repository that holds the whole collection and hands each reader precisely the view they're entitled to. It pairs with foundry's existing **Librarian** role — the Librarian reconciles what the library *knows*; Xandria is the library itself.

---

## 1. The problem: define once, drop in anywhere

Today, interacting with an agent means wiring it up **per surface**. You configure a model, its context, and its tools inside Claude Code. Then you do it again in Cursor. Then again in the next app you build. The catalog of "what this agent can see and do" is assembled N times, once per client, and maintained N times.

The thing Xandria is trying to solve is narrow and concrete:

> **Configure your agent and its context once. Drop it into any surface you're building — your email builder, an IDE, a web app — as a lens-scoped grant, and have it just work.**

Everything else in this document is mechanism in service of that one sentence. When a design choice doesn't make "define once, drop in anywhere" more true, it's out of scope (see §8).

This is the **lens primitive from json-rules, applied to agents.** In json-rules a lens is a composable, enforceable boundary over *data* — it declares what a rule author may see and which rows are in scope, and it can only ever be *narrowed* as it's passed along. Xandria applies the same algebra to an agent's surface: what a given consumer may see and reach, narrowed monotonically per grant.

---

## 2. Inverted MCP

The clearest way to state the architecture is by contrast with MCP.

**Normal MCP:** the *client* holds the model. Claude Code / Claude Desktop owns the inference and reaches *out* to servers to borrow tools, resources, and prompts. Servers are model-less capability providers. Every client assembles and maintains its own server list — the catalog is per-client.

**Xandria (inverted MCP):** the *catalog* lives in one place. Xandria owns "everything you have" — models, subscriptions, sources, contacts, threads — once, and any consumer borrows a **lens-scoped view** of it. Your MCP setup stops being a per-client chore and becomes a property of *you*, projected everywhere.

The inversion that pays rent is not "the model moved server-side." It is:

> **The catalog of everything you have is owned once and projected everywhere, through a lens.**

A consequence worth stating plainly: **through Xandria, talking to another model is just another thing on the surface.** A doc, a contact, a subscription, another model — they are all "things you have," exposed uniformly and lens-scoped. Models are not special; they are entries in the catalog like everything else.

Note that MCP already contains its own inversion primitives — `sampling` (a server asking the client's model to run a completion) and `elicitation` (a server asking the client/user for input mid-call). Inverted MCP leans the whole architecture in that direction and makes the **agent** the served resource. Foundry's existing MCP bridge runs the *classic* direction today (the session is the client, pulling context from a foundry server); Xandria points the same machinery the other way.

---

## 3. The model: identity + linked devices

The mental model is **WhatsApp's linked devices**, taken seriously.

Xandria is the **identity and source of truth** — the account, the phone. It holds your subscriptions, your sources, your contacts, your lenses. Everything else is a **consumer**: a linked endpoint hanging off that identity that *borrows* capability through a connection, rather than holding its own.

This metaphor is load-bearing, not decorative. It commits us to:

1. **One identity, many endpoints.** A linked surface (the email builder) borrows your capability through its connection. It does not bring its own Claude subscription — it borrows yours.
2. **Connections have IDs, and the ID is the unit of revocation, audit, and last-seen.** You don't revoke "the email builder"; you revoke *connection #7*, exactly like logging out one linked device.
3. **Continuity, not portability, is the default.** A linked device remembers; its session persists and resumes. A connection is stateful by default; clean/stateless portability is the opt-in special case.

There is **one hub, and everything else is a consumer.** This is deliberately *not* peer federation. Consumers may themselves be agents, but they are consumers of Xandria — not co-equal hubs. (Federation is possible — see §8 — but it is not the target.)

---

## 4. Nouns

| Noun | What it is | WhatsApp analog | Existing primitive |
|------|------------|-----------------|--------------------|
| **Xandria** | Your identity + source of truth (subscriptions, sources, contacts, lenses, threads) | The account / phone | `FoundryConfig` (providers, layers, agents) |
| **Contact** | An agent/model you converse with | A person in your contacts | A provider + agent definition |
| **Contact surface** | An addressable *face* of a contact (a contact may have several) | A person's phone/email/handle | An agent's exposed lens surface (`exposedSurface`) |
| **Source** | A repository, folder, or feed of information | — | `ContextLayer` + `ContextSource` |
| **Integration** | An external host app (email builder, IDE, Slack) | A device | host adapter / MCP client |
| **Connection** | The authorized link, *with an ID* — revocable, audited, live | A **linked device** entry | `SessionAdapter` + `ExternalSessionStore` (ID ↔ session map) |
| **Thread** | A live, possibly multi-actor conversation | A chat | `Thread` + `SignalBus` |
| **Grant** | A connection's lens-scoped view of Xandria | Pairing a device | `Lens` + `LensNarrowing` (json-rules) |
| **Lens** | The boundary: how much of Xandria a grant exposes | — | `@inixiative/json-rules` lens |

---

## 5. The lens is the boundary

A grant shows **as much as you give** — anywhere from a single contact up to the full surface of Xandria, your choice. The lens is the dial, and it is the same monotonic-narrowing algebra json-rules already enforces:

- **Composition is pure intersection.** A grant can only ever *narrow* what it exposes, never widen. `validateNarrowing()` enforces this at construction.
- **Schema narrowing** (`picks`/`omits`/`enumPicks`/`enumOmits`) controls *what entries* a consumer can even see in the catalog.
- **Data narrowing** (`where`) controls *which* threads, contacts, and sources are in scope.
- **Revoking = dropping the connection ID.** The loan ends; the lens is gone.

This is why the security questions are not scary: the per-connection grant is just a lens, and the lens can only attenuate. A consumer cannot reach more of Xandria than its grant exposes, by construction.

---

## 6. Two consumption modes

A consumer — including an agent — uses Xandria in one of two ways:

1. **Switchboard / direct.** "Just talk to another model." Route a message to a specific contact surface. Sub-agents are this: an agent reaches another model *through* Xandria instead of wiring it up itself.
2. **Aggregated MCP surface.** "See, effectively like your MCP, all the things that you have." Xandria exposes its whole catalog — models, sources, contacts, threads — the way an MCP server exposes resources and tools, scoped by the lens.

**Open question (§9):** when a consumer routes through the switchboard to another model, does that conversation become a **thread Xandria manages and shows** (visible in your open-threads view), or a private side-call Xandria merely *permits* but doesn't track? "Xandria manages all open threads" argues for the former — an *observable switchboard*, not a mere permission gate — but it needs to be decided explicitly.

---

## 7. Repo layout

Xandria is **not one thing** — decompose it:

1. **New primitives** — grants, lens-over-agent surface, the catalog projection, the connection/session registry. These extend foundry (or core) because they are reusable engine concepts. **They belong in foundry.**
2. **The product** — the contacts book, linked-device management, the live graph, the drop-in SDK. **This belongs in its own repo: `foundry-xandria`.**

This mirrors the established **oracle precedent**: `foundry-oracle` lives in its own repo and depends on `core` via a `file:` dependency, because it is a distinct concern built *on* the engine, not *part* of it. Xandria is the same shape — except it consumes the *full foundry framework* (viewer, `FlowOrchestrator`, providers, `SessionAdapter`) **and** `@inixiative/json-rules` (the lens). Dependency direction stays clean: `foundry-xandria` → `foundry` + `json-rules` → `core`.

**Incubation note:** during the early high-churn phase the Xandria primitives and foundry primitives will co-evolve tightly. A legitimate path is to incubate in this monorepo (`packages/xandria`) and extract to `foundry-xandria` once the primitive boundary stabilizes.

---

## 8. Enabled, but not the goal

The lens algebra makes several things *possible*. They are real, they work, and they are explicitly **parked** — not what Xandria is trying to solve:

- **Federation / hubs-all-the-way-down.** A consumer could itself be a hub, and grants could flow hub-to-hub. The lens enables it; the target is one-hub-many-consumers.
- **Transitive delegation.** Because lenses only attenuate, a consumer could safely re-grant a *narrower* slice onward (the object-capability default). Safe ≠ wanted; deferred.
- **Object-capability chain of custody.** Monotonic narrowing gives delegation a provable "you can never leak more than you were granted" property — the same chain-of-custody guarantee as foundry-oracle's **Steward** role. Available if federation is ever pursued.

These are listed so the periphery is captured without taking over. If any becomes a goal later, it gets its own RFC.

---

## 9. Open questions

1. **Observable switchboard vs. permission gate** (§6) — does a switchboard-routed conversation become a managed, visible thread, or a permitted-but-untracked side-call?
2. **Where does inference run** — Xandria-side (thin-relay model; compute + identity stay home; strongest privacy story) or consumer-side (Xandria serves config, consumer runs the model with borrowed creds; leaks identity)? The WhatsApp metaphor argues Xandria-side.
3. **Ride MCP, or build a sibling protocol** — if Xandria literally *is* an MCP server whose resources are your agents, every existing MCP client connects for free. The risk: MCP's request/response shape strains under a stateful, multi-turn, multi-actor agent. Bend MCP to the thread boundary, or define an agent-serving protocol that's MCP-shaped but thread-native?
4. **Incubate in-monorepo or split on day one** (§7).

---

## 10. Prior art: Claude Tag

Anthropic shipped **Claude Tag** (public beta, June 23 2026): a persistent AI teammate embedded in enterprise Slack channels — one shared instance per channel, with channel memory, ambient/proactive mode, and pass-the-baton handoff between teammates mid-task.

It **validates** parts of this thesis: shared, multi-actor, persistent agents that carry a thread across people are a real pattern.

It is also the **opposite lane**, which is useful for positioning:

- **Channel-scoped, not lens-scoped.** Its unit of context is "the channel." Xandria's is a portable, composable lens you author and drop in anywhere.
- **Slack-locked and Anthropic-only.** The antithesis of agent-agnostic. Xandria is hub-as-home-base, model-as-contact.
- **No drop-in-anywhere.** You cannot take "the Claude that learned channel #email-team" and embed it in your email builder. That portability is Xandria's differentiating bet.

Claude Tag is a *vertical* (a persistent teammate inside one host app). Xandria is a *horizontal* (a hub that orchestrates many agents/models/sources and projects them, lens-scoped, into many surfaces). A Claude Tag agent could itself be one **contact** in Xandria.

Sources: [VentureBeat](https://venturebeat.com/technology/anthropic-launches-claude-tag-replacing-its-slack-app-with-a-persistent-ai-teammate-that-learns-monitors-and-works-autonomously), [TechCrunch](https://techcrunch.com/2026/06/23/anthropics-claude-tag-is-learning-your-company-one-slack-message-at-a-time/), [Latent Space](https://www.latent.space/p/ainews-claude-tag-multiplayer-proactive).
