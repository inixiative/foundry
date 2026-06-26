# Xandria

> **Status:** Draft / RFC — design exploration, not yet implemented.
> **Author:** Aron Greenspan
> **Relates to:** `docs/FLOW.md` (the orchestration roles), `@inixiative/json-rules` (the lens primitive), Atlas (semantic tagging of code), `foundry-oracle` (the separate-repo precedent).

Xandria is the **agentic hub**: one place that owns everything you have — your models and subscriptions, your sources of information, your contacts, your live threads, your services and APIs — and lends out **lens-scoped surfaces of itself** to anything that wants to consume them.

The name descends from the great Library of Alexandria, because that is what it is: a single monumental repository that holds the whole collection and hands each reader precisely the view they're entitled to. It pairs with foundry's existing **Librarian** role — the Librarian reconciles what the library *knows*; Xandria is the library itself.

---

## 1. The problem: define once, drop in anywhere

Today, interacting with an agent means wiring it up **per surface**. You configure a model, its context, and its tools inside Claude Code. Then you do it again in Cursor. Then again in the next app you build. The catalog of "what this agent can see and do" is assembled N times, once per client, and maintained N times.

The thing Xandria is trying to solve is narrow and concrete:

> **Configure your agent and its context once. Drop it into any surface you're building — your email builder, an IDE, a web app — as a lens-scoped grant, and have it just work.**

Everything else in this document is mechanism in service of that one sentence. When a design choice doesn't make "define once, drop in anywhere" more true, it's out of scope (see §10).

This is the **lens primitive from json-rules, applied to agents.** In json-rules a lens is a composable, enforceable boundary over *data* — it declares what a rule author may see and which rows are in scope, and it can only ever be *narrowed* as it's passed along. Xandria applies the same algebra to an agent's surface: what a given consumer may see and reach, narrowed monotonically per grant.

---

## 2. Inverted MCP

The clearest way to state the architecture is by contrast with MCP.

**Normal MCP:** the *client* holds the model. Claude Code / Claude Desktop owns the inference and reaches *out* to servers to borrow tools, resources, and prompts. Servers are model-less capability providers. Every client assembles and maintains its own server list — the catalog is per-client.

**Xandria (inverted MCP):** the *catalog* lives in one place. Xandria owns "everything you have" — models, subscriptions, sources, contacts, threads, services — once, and any consumer borrows a **lens-scoped view** of it. Your MCP setup stops being a per-client chore and becomes a property of *you*, projected everywhere.

The inversion that pays rent is not "the model moved server-side." It is:

> **The catalog of everything you have is owned once and projected everywhere, through a lens.**

A consequence worth stating plainly: **through Xandria, talking to another model is just another thing on the surface.** A doc, a contact, a subscription, an API, another model — they are all "things you have," exposed uniformly and lens-scoped. Models are not special; they are entries in the catalog like everything else.

"Inverted MCP" is the *concept*, not the implementation. You do **not** realize it by making everyone build MCP servers — that's the heavy path. You realize it by registering capabilities as descriptions and tagging them (§7).

---

## 3. The model: identity + linked devices

The mental model is **WhatsApp's linked devices**, taken seriously.

Xandria is the **identity and source of truth** — the account, the phone. It holds your subscriptions, your sources, your contacts, your lenses. Everything else is a **consumer**: a linked endpoint hanging off that identity that *borrows* capability through a connection, rather than holding its own.

This metaphor is load-bearing, not decorative. It commits us to:

1. **One identity, many endpoints.** A linked surface (the email builder) borrows your capability through its connection. It does not bring its own Claude subscription — it borrows yours.
2. **Connections have IDs, and the ID is the unit of revocation, audit, and last-seen.** You don't revoke "the email builder"; you revoke *connection #7*, exactly like logging out one linked device.
3. **Continuity, not portability, is the default.** A linked device remembers; its session persists and resumes. A connection is stateful by default; clean/stateless portability is the opt-in special case.

There is **one hub, and everything else is a consumer.** This is deliberately *not* peer federation. Consumers may themselves be agents, but they are consumers of Xandria — not co-equal hubs. (Federation is possible — see §10 — but it is not the target.)

---

## 4. Nouns

| Noun | What it is | WhatsApp analog | Existing primitive |
|------|------------|-----------------|--------------------|
| **Xandria** | Your identity + source of truth (subscriptions, sources, contacts, lenses, threads, capabilities) | The account / phone | `FoundryConfig` (providers, layers, agents) |
| **Contact** | An agent/model you converse with | A person in your contacts | A provider + agent definition |
| **Contact surface** | An addressable *face* of a contact (a contact may have several) | A person's phone/email/handle | An agent's exposed lens surface (`exposedSurface`) |
| **Source** | A repository, folder, or feed of information | — | `ContextLayer` + `ContextSource` |
| **Capability** | A registered service/API/provider/env — *described*, not wired | An installed app | new — Atlas-style semantic entry (§7) |
| **Integration** | An external host app (email builder, IDE, Slack) | A device | host adapter / MCP client |
| **Connection** | The authorized link, *with an ID* — revocable, audited, live | A **linked device** entry | `SessionAdapter` + `ExternalSessionStore` (ID ↔ session map) |
| **Thread** | A live, possibly multi-actor conversation | A chat | `Thread` + `SignalBus` |
| **Tag** | A semantic axis (e.g. `marketing`, `engineering`) that scopes reads and stamps writes | — | json-rules lens `where` + Atlas `@partOf` |
| **Grant** | A connection's lens-scoped (tag-scoped) view of Xandria | Pairing a device | `Lens` + `LensNarrowing` (json-rules) |
| **Lens** | The boundary: how much of Xandria a grant exposes | — | `@inixiative/json-rules` lens |

---

## 5. The lens is the boundary

A grant shows **as much as you give** — anywhere from a single contact up to the full surface of Xandria, your choice. The lens is the dial, and it is the same monotonic-narrowing algebra json-rules already enforces:

- **Composition is pure intersection.** A grant can only ever *narrow* what it exposes, never widen. `validateNarrowing()` enforces this at construction.
- **Schema narrowing** (`picks`/`omits`/`enumPicks`/`enumOmits`) controls *what entries* a consumer can even see in the catalog.
- **Data narrowing** (`where`) controls *which* threads, contacts, sources, and capabilities are in scope.
- **Revoking = dropping the connection ID.** The loan ends; the lens is gone.

A consumer cannot reach more of Xandria than its grant exposes, by construction. That is why the security questions are not scary.

---

## 6. Tags: the lens, made usable

A raw `LensNarrowing` object is correct but no human wants to author one. **Tags are the concrete UX of the lens.** A consumer isn't handed a narrowing config; it's handed *tags* — "you see `marketing`," "you see `engineering`" — and that is the whole boundary.

A tag does **two jobs at once**:

- **Read filter (the shrunken area).** All sessions live in Xandria, but a consumer only sees threads — and capabilities, and contacts — carrying its tags. Same hub, different windows.
- **Write stamp (stay on the axis).** Everything a consumer creates is *automatically* stamped with its tags, so its output can never wander off its own axis.

That filter-on-read + stamp-on-write pair is exactly the multi-tenant lens pattern (`where tenantId = X` on reads, `set tenantId = X` on inserts), **generalized from one hard-coded tenant dimension to arbitrary axes.**

Two properties fall out:

- **Monotonicity survives.** The grant sets the *ceiling* of tags a consumer could ever touch; "join any number of things" means selecting axes *within* that ceiling, never escalating past it. Joining a tag you weren't granted is simply impossible — yet it still feels like free composition.
- **Shared live sessions = co-participation on an axis.** Everything carrying `marketing` is visible to everyone on the `marketing` axis, so multiple consumers (and you) see the *same* live threads. The axis is the meeting place — that's where the multi-actor behavior comes from.

**Inverse of the wire.** Instead of *wiring* a producer to a consumer (explicit edges, point-to-point, the MCP way), you declare a tag and membership becomes **emergent** — anything carrying or seeking the tag joins the axis automatically, like a pub/sub topic expressed as a filter attribute rather than a connection. Auto-stamp-on-create makes membership *self-propagating*. Topology by attribute, not by edge.

---

## 7. Registering capabilities: documentation over servers

MCP is the wrong weight for a *catalog*. An MCP server is an executable thing you build and host per integration — the per-client wiring tax, relocated. But registering a capability doesn't need an executable server; it needs a **description**.

**Register by documenting, not by building.** A capability enters the library as a described entry — an OpenAPI spec, pasted API docs, a named provider, an env var, "I use Linear / Stripe / Postgres." Xandria collects the descriptions; a call can be *derived* from the doc when needed. The act of documentation **is** the integration.

**This is Atlas, generalized from code to capabilities.** Atlas semantically tags *files* (`@kind` = role, `@partOf` = concept, `@uses` = deps) against a concept registry and lets you query by axis. Xandria tags *capabilities* the same way and lets consumers query by tag — same machinery, different corpus. The authoring story ports directly: just as `atlas stamp` auto-fills derivable tags and you curate the rest, Xandria reads an API's docs, **auto-stamps** proposed tags, and you curate. Registration becomes *drop-in-docs → auto-tag → curate.*

Because tags span sessions *and* capabilities (§6), a consumer scoped to `marketing` sees marketing threads **and** the marketing-relevant APIs. One tagging system over the whole surface, not two.

---

## 8. Two consumption modes

A consumer — including an agent — uses Xandria in one of two ways:

1. **Switchboard / direct.** "Just talk to another model." Route a message to a specific contact surface. Sub-agents are this: an agent reaches another model *through* Xandria instead of wiring it up itself.
2. **Aggregated surface.** "See, effectively like your MCP, all the things that you have." Xandria exposes its whole catalog — models, sources, contacts, threads, capabilities — scoped by the lens (i.e. by tags).

**Open question (§11):** when a consumer routes through the switchboard to another model, does that conversation become a **thread Xandria manages and shows** (visible in your open-threads view), or a private side-call Xandria merely *permits* but doesn't track? "Xandria manages all open threads" argues for the former — an *observable switchboard*, not a mere permission gate — but it needs to be decided explicitly.

---

## 9. Repo layout

Xandria is **not one thing** — decompose it:

1. **New primitives** — grants, lens-over-agent surface, the catalog projection, semantic tagging, the connection/session registry. These extend foundry (or core) because they are reusable engine concepts. **They belong in foundry.**
2. **The product** — the contacts book, linked-device management, the live graph, the drop-in SDK. **This belongs in its own repo: `foundry-xandria`.**

This mirrors the established **oracle precedent**: `foundry-oracle` lives in its own repo and depends on `core` via a `file:` dependency, because it is a distinct concern built *on* the engine, not *part* of it. Xandria is the same shape — except it consumes the *full foundry framework* (viewer, `FlowOrchestrator`, providers, `SessionAdapter`) **and** `@inixiative/json-rules` (the lens). Dependency direction stays clean: `foundry-xandria` → `foundry` + `json-rules` → `core`.

**Incubation note:** during the early high-churn phase the Xandria primitives and foundry primitives will co-evolve tightly. A legitimate path is to incubate in this monorepo (`packages/xandria`) and extract to `foundry-xandria` once the primitive boundary stabilizes.

---

## 10. Enabled, but not the goal

The lens algebra makes several things *possible*. They are real, they work, and they are explicitly **parked** — not what Xandria is trying to solve:

- **Federation / hubs-all-the-way-down.** A consumer could itself be a hub, and grants could flow hub-to-hub. The lens enables it; the target is one-hub-many-consumers.
- **Transitive delegation.** Because lenses only attenuate, a consumer could safely re-grant a *narrower* slice onward (the object-capability default). Safe ≠ wanted; deferred.
- **Object-capability chain of custody.** Monotonic narrowing gives delegation a provable "you can never leak more than you were granted" property — the same chain-of-custody guarantee as foundry-oracle's **Steward** role. Available if federation is ever pursued.

These are listed so the periphery is captured without taking over. If any becomes a goal later, it gets its own RFC.

---

## 11. Open questions

1. **Observable switchboard vs. permission gate** (§8) — does a switchboard-routed conversation become a managed, visible thread, or a permitted-but-untracked side-call?
2. **Where does inference run** — Xandria-side (thin-relay model; compute + identity stay home; strongest privacy story) or consumer-side (Xandria serves config, consumer runs the model with borrowed creds; leaks identity)? The WhatsApp metaphor argues Xandria-side.
3. **Describe vs. broker** (for registered capabilities, §7) — does Xandria just hand the consumer the API description (consumer executes; needs its own creds + network), or broker the call (Xandria holds the creds, executes, returns the result — true to the "capability borrowed, identity stays home" model of §3)? Likely describe-now, broker-eventually — but it is the same execution-location axis as Q2.
4. **Ride MCP, or build a sibling protocol** — if Xandria literally *is* an MCP server whose resources are your agents, every existing MCP client connects for free. The risk: MCP's request/response shape strains under a stateful, multi-turn, multi-actor agent. Bend MCP to the thread boundary, or define an agent-serving protocol that's MCP-shaped but thread-native?
5. **Incubate in-monorepo or split on day one** (§9).

---

## 12. Prior art: Claude Tag

Anthropic shipped **Claude Tag** (public beta, June 23 2026): a persistent AI teammate embedded in enterprise Slack channels — one shared instance per channel, with channel memory, ambient/proactive mode, and pass-the-baton handoff between teammates mid-task.

It **validates** parts of this thesis: shared, multi-actor, persistent agents that carry a thread across people are a real pattern.

It is also the **opposite lane**, which is useful for positioning:

- **Channel-scoped, not lens-scoped.** Its unit of context is "the channel." Xandria's is a portable, composable tag/lens you author and drop in anywhere.
- **Slack-locked and Anthropic-only.** The antithesis of agent-agnostic. Xandria is hub-as-home-base, model-as-contact.
- **No drop-in-anywhere.** You cannot take "the Claude that learned channel #email-team" and embed it in your email builder. That portability is Xandria's differentiating bet.

Claude Tag is a *vertical* (a persistent teammate inside one host app). Xandria is a *horizontal* (a hub that orchestrates many agents/models/sources and projects them, lens-scoped, into many surfaces). A Claude Tag agent could itself be one **contact** in Xandria.

Sources: [VentureBeat](https://venturebeat.com/technology/anthropic-launches-claude-tag-replacing-its-slack-app-with-a-persistent-ai-teammate-that-learns-monitors-and-works-autonomously), [TechCrunch](https://techcrunch.com/2026/06/23/anthropics-claude-tag-is-learning-your-company-one-slack-message-at-a-time/), [Latent Space](https://www.latent.space/p/ainews-claude-tag-multiplayer-proactive).
