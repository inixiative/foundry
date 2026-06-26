# Xandria

> **Status:** Draft / RFC — design exploration, not yet implemented.
> **Author:** Aron Greenspan
> **Relates to:** `docs/FLOW.md` (the orchestration roles), `@inixiative/json-rules` (the lens primitive), Atlas (semantic tagging of code), `foundry-oracle` (the separate-repo precedent).

Xandria is the **agentic hub**: one place that owns everything you have — your models and subscriptions, your sources of information, your contacts, your live threads, your services and APIs — and lends out **lens-scoped surfaces of itself** to anything that wants to consume them.

The name descends from the great Library of Alexandria, because that is what it is: a single monumental repository that holds the whole collection and hands each reader precisely the view they're entitled to. It pairs with foundry's existing **Librarian** role — the Librarian reconciles what the library *knows*; Xandria is the library itself.

---

## 1. The problem & the key card

Today, bringing agentic reasoning to a thing means wiring it up **per surface**. For every app you want an agent in, you set up the integration *inside that app*, then own its whole lifecycle — keys, context, rotation, teardown. The catalog of "what this agent can see and do" is assembled N times and maintained N times. Most people cope by giving **one agent full access** — which is fine for solo work, but it's all-or-nothing, per-app, and unmanaged.

The four pains this is actually aimed at:

- **Integration sprawl (M×N).** Every app re-integrates every tool. MCP was meant to fix this, but each client still wires its own servers — you pay N times.
- **Context portability.** Your agent's accumulated context and memory are trapped per-tool; you can't bring *your* agent to a new surface.
- **Credential scoping.** Giving an agent access means scattering keys into every app, usually with no boundary finer than "all."
- **Lifecycle.** Setup *and* teardown, rotation, revocation — done per-app, by hand.

The thing Xandria is trying to solve is narrow and concrete:

> **Configure your agent and its context once. Drop it into any surface — your email builder, an IDE, a web app — as a lens-scoped grant, and have it just work.**

The framing that captures it: **a grant is a key card for your agent.** Portable, revocable, and scoped to *definable boundaries*. You don't bring your keys and you don't bring your context — you present a card and use what it opens. Enterprise account, an API key, or your personal subscription: connect it once, and use it anywhere. Everything else in this document is mechanism in service of that one card.

This is the **lens primitive from json-rules, applied to agents.** In json-rules a lens is a composable, enforceable boundary over *data* — it declares what a rule author may see and which rows are in scope, and it can only ever be *narrowed* as it's passed along. Xandria applies the same algebra to an agent's surface: what a given consumer may see and reach, narrowed monotonically per grant. The card's boundaries aren't hand-wavy — the lens enforces them.

---

## 2. Inverted MCP

The clearest way to state the architecture is by contrast with MCP.

**Normal MCP:** the *client* holds the model. Claude Code / Claude Desktop owns the inference and reaches *out* to servers to borrow tools, resources, and prompts. Servers are model-less capability providers. Every client assembles and maintains its own server list — the catalog is per-client.

**Xandria (inverted MCP):** the *catalog* lives in one place. Xandria owns "everything you have" — models, subscriptions, sources, contacts, threads, services — once, and any consumer borrows a **lens-scoped view** of it. Your MCP setup stops being a per-client chore and becomes a property of *you*, projected everywhere.

The inversion that pays rent is not "the model moved server-side." It is:

> **The catalog of everything you have is owned once and projected everywhere, through a lens.**

A consequence worth stating plainly: **through Xandria, talking to another model is just another thing on the surface.** A doc, a contact, a subscription, an API, another model — they are all "things you have," exposed uniformly and lens-scoped. Models are not special; they are entries in the catalog like everything else. (This is exactly why "access to a model" and "access to the library" are just different slices of one lens — see §9.)

"Inverted MCP" is the *concept*, not the implementation. You do **not** realize it by making everyone build MCP servers — that's the heavy path. You realize it by registering capabilities as descriptions and tagging them (§7).

---

## 3. The model: identity + linked devices

The mental model is **WhatsApp's linked devices**, taken seriously.

Xandria is the **identity and source of truth** — the account, the phone. It holds your subscriptions, your sources, your contacts, your lenses. Everything else is a **consumer**: a linked endpoint hanging off that identity that *borrows* capability through a connection, rather than holding its own.

This metaphor is load-bearing, not decorative. It commits us to:

1. **One identity, many endpoints.** A linked surface (the email builder) borrows your capability through its connection. It does not bring its own Claude subscription — it borrows yours.
2. **Connections have IDs, and the ID is the unit of revocation, audit, and last-seen.** You don't revoke "the email builder"; you revoke *connection #7*, exactly like logging out one linked device.
3. **Continuity, not portability, is the default.** A linked device remembers; its session persists and resumes. A connection is stateful by default; clean/stateless portability is the opt-in special case.

There is **one hub, and everything else is a consumer.** This is deliberately *not* arbitrary peer federation. Consumers may themselves be agents — and a hub may be shared by a team (§11) — but they are consumers of a hub, not co-equal hubs-all-the-way-down. (See §14 for what stays parked.)

---

## 4. Nouns

| Noun | What it is | WhatsApp analog | Existing primitive |
|------|------------|-----------------|--------------------|
| **Xandria** | Your identity + source of truth (subscriptions, sources, contacts, lenses, threads, capabilities) | The account / phone | `FoundryConfig` (providers, layers, agents) |
| **Contact** | An agent/model you converse with | A person in your contacts | A provider + agent definition |
| **Contact surface** | An addressable *face* of a contact (a contact may have several) | A person's phone/email/handle | An agent's exposed lens surface (`exposedSurface`) |
| **Source** | A repository, folder, or feed of information | — | `ContextLayer` + `ContextSource` |
| **Capability** | A registered service/API/provider/env — *described*, not wired | An installed app | new — Atlas-style semantic entry (§7) |
| **Secret binding** | A reference (vault + key) Xandria resolves at call time — *never* the plaintext | App permissions | new — resolves against Doppler / Infisical / cloud secret managers (§8) |
| **Integration** | An external host app (email builder, IDE, Slack) | A device | host adapter / MCP client |
| **Connection** | The authorized link, *with an ID* — revocable, audited, live; may be session/agentic or a plain data link | A **linked device** entry | `SessionAdapter` + `ExternalSessionStore` (ID ↔ session map) |
| **Thread** | A live, possibly multi-actor conversation | A chat | `Thread` + `SignalBus` |
| **Tag** | A semantic axis (e.g. `marketing`, `engineering`) that scopes reads and stamps writes | — | json-rules lens `where` + Atlas `@partOf` |
| **Grant** *(a.k.a. key card)* | A connection's lens-scoped (tag-scoped) view of Xandria — including *what kind* of access (§9); portable, revocable, definable | Pairing a device | `Lens` + `LensNarrowing` (json-rules) |
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

## 8. Brokering, not holding

This resolves the describe-vs-broker fork: **Xandria brokers.** A consumer never receives raw credentials. It asks Xandria to make the call, and Xandria executes it on the consumer's behalf — capability borrowed, the consumer holds nothing.

But brokering does **not** make Xandria a vault. It does **not** hold your secrets, env vars, or API keys. That is a separate concern with mature, dedicated homes — **Doppler, Infisical**, your cloud secret manager. Decompose accordingly:

- **Your secret manager holds the secret.** Plaintext lives in Doppler/Infisical, encrypted at rest and rotated *there*.
- **Xandria holds the binding.** For each capability it stores a *reference* — which secret, in which vault, for which capability — not the value. At call time it resolves the binding from the vault, uses it, and never persists the plaintext.

Two properties this preserves:

- **No plaintext honeypot.** Xandria stores bindings, not values. Compromising it spills (revocable) *bindings*, not your keys. (It is still a *capability* concentration point — see §16.)
- **"Identity stays home," sharpened.** The WhatsApp framing (§3) says capability is borrowed and identity stays home. "Home" for a *secret* is your secret manager; Xandria is the switchboard in front of the safe, not the safe.

This is orthogonal to *what's in a grant* (§9): wherever the model executes, secrets resolve through the binding from your vault.

---

## 9. What a grant can include

A grant is not one-size. Because the lens governs *everything* in the catalog — and a runnable model is just another catalog entry (§2) — a grant ranges over two independent dimensions:

**Connection kind.**
- **Session / agentic** — a live, stateful conversation (a thread you talk to).
- **Non-session / non-agentic** — a plain data connection: read the library, query capabilities, list conversations. No live conversation required.

**What's in scope.** Any slice — *all*, *conversations* only, a *model*, the *library* (sources + capabilities) — composable via tags.

The **model-vs-library** distinction is the one that decides *where inference runs*, and it is just the lens at work:

- **Grant includes a model →** the consumer runs it *through* Xandria. Inference is borrowed; you bring nothing. *"Give you access to the model, and you just run the model."*
- **Grant is library-only →** the consumer brings its own model and borrows only the context/capabilities. *"Give you access to the library, and you run your own model."*

Both serve the same everyday purpose, and it is the real value of the thing:

> **Bring your model — or just your library — to anything, without lots of work and setup.**

Not the grand architecture; just *drop it in and go.* This is why "where does inference run" is **not** a global decision — it's per grant, wherever the grant puts the model.

---

## 10. Two consumption modes

A consumer — including an agent — interacts with Xandria in one of two ways:

1. **Switchboard / direct.** "Just talk to another model." Route a message to a specific contact surface. Sub-agents are this: an agent reaches another model *through* Xandria instead of wiring it up itself.
2. **Aggregated surface.** "See, effectively like your MCP, all the things that you have." Xandria exposes its whole catalog — models, sources, contacts, threads, capabilities — scoped by the lens (i.e. by tags).

**Open question (§15):** when a consumer routes through the switchboard to another model, does that conversation become a **thread Xandria manages and shows** (visible in your open-threads view), or a private side-call Xandria merely *permits* but doesn't track? "Xandria manages all open threads" argues for the former — an *observable switchboard*, not a mere permission gate — but it needs to be decided explicitly.

---

## 11. Teams: one shared hub, many workspaces

Solo, most people give one agent full access — fine. But Xandria is **inherently multiplayer**, and that is where it stops being a power-user convenience and becomes infrastructure.

- **One team hub.** A team runs a shared Xandria. Everyone connects their own agents to it (each with their own key card / grant).
- **Conversations happen on the team hub.** Threads on the team's tag axes are shared — multiple people's agents co-participate on the same live sessions (§6: co-participation on an axis).
- **Pull back into your own workspace.** You take results from the team hub into your personal Xandria and keep working — and **traverse that boundary natively.** The lens governs what crosses (you only pull what your card opens); tags stamp what you contribute back.

This is **Herald, productized.** Herald (in `docs/FLOW.md`) watches *all threads* and detects convergence, divergence, and resource conflict across one person's work. The team hub is the cross-**workspace** version of the same job — convergence and sharing across *people*, not just across one person's threads. The boundary traversal is Xandria-native: a team hub simply issues you a grant, and a grant is already everything we need (scoped read in, tag-stamped write back).

Note this is **bounded** personal↔team sharing, not arbitrary recursive federation (§14). One shared hub with many member-consumers, plus a clean personal/team boundary — not hubs-all-the-way-down.

---

## 12. The foundry app: configure and curate your Xandria

Xandria is the library; **foundry is the app you curate it with.** The existing foundry viewer/dashboard (backed by `ConfigStore` over `.foundry/settings.json`) already configures providers, agents, layers, and sources. Xandria extends that same surface: you configure and curate your contacts, capabilities, tags, grants/key-cards, and connections there.

This sharpens the split in §13:

- **foundry** — the primitives *and* the **owner-facing curation app**: where *you* assemble and tend your Xandria.
- **`foundry-xandria`** — the **consumer-facing product**: the drop-in SDK and the key card a surface presents to connect and use what it opens.

Owner curates in foundry; consumers connect via foundry-xandria.

---

## 13. Repo layout

Xandria is **not one thing** — decompose it:

1. **New primitives** — grants, lens-over-agent surface, the catalog projection, semantic tagging, secret-binding resolution, the connection/session registry. These extend foundry (or core) because they are reusable engine concepts. **They belong in foundry.**
2. **The product** — the drop-in SDK, linked-device/connection management, the live graph, the key-card flow. **This belongs in its own repo: `foundry-xandria`.** (The owner-facing curation UI rides the existing foundry viewer — see §12.)

This mirrors the established **oracle precedent**: `foundry-oracle` lives in its own repo and depends on `core` via a `file:` dependency, because it is a distinct concern built *on* the engine, not *part* of it. Xandria is the same shape — except it consumes the *full foundry framework* (viewer, `FlowOrchestrator`, providers, `SessionAdapter`) **and** `@inixiative/json-rules` (the lens). Dependency direction stays clean: `foundry-xandria` → `foundry` + `json-rules` → `core`.

**Incubation note:** during the early high-churn phase the Xandria primitives and foundry primitives will co-evolve tightly. A legitimate path is to incubate in this monorepo (`packages/xandria`) and extract to `foundry-xandria` once the primitive boundary stabilizes.

---

## 14. Enabled, but not the goal

The lens algebra makes several things *possible*. They are real, they work, and they are explicitly **parked** — not what Xandria is trying to solve. Note the **team hub (§11) is *not* parked** — it's a bounded, first-class case. What stays parked is the *arbitrary, recursive* generalization:

- **Hubs-all-the-way-down federation.** A consumer being itself a full hub, with grants flowing through unbounded hub-to-hub chains. The team hub is the bounded version; the unbounded mesh is deferred.
- **Transitive delegation.** Because lenses only attenuate, a consumer could safely re-grant a *narrower* slice onward (the object-capability default). Safe ≠ wanted; deferred.
- **Object-capability chain of custody.** Monotonic narrowing gives delegation a provable "you can never leak more than you were granted" property — the same chain-of-custody guarantee as foundry-oracle's **Steward** role. Available if federation is ever pursued.

These are listed so the periphery is captured without taking over. If any becomes a goal later, it gets its own RFC.

---

## 15. Open questions

1. **Observable switchboard vs. permission gate** (§10) — does a switchboard-routed conversation become a managed, visible thread, or a permitted-but-untracked side-call?
2. **Ride MCP, or build a sibling protocol** — if Xandria literally *is* an MCP server whose resources are your agents, every existing MCP client connects for free. The risk: MCP's request/response shape strains under a stateful, multi-turn, multi-actor agent. Bend MCP to the thread boundary, or define an agent-serving protocol that's MCP-shaped but thread-native?
3. **Incubate in-monorepo or split on day one** (§13).

**Resolved:**
- *Describe vs. broker* → **broker, with secrets delegated to an external manager** (§8).
- *Where inference runs* → **per grant**: a model-in-grant runs through Xandria; a library-only grant runs the consumer's own model (§9).

---

## 16. What this doesn't solve

Honest limits, on the record so the elegant framing doesn't hide them:

- **The integration glue doesn't vanish — it centralizes.** Turning a documented API into a *reliable* call (auth flows, pagination, rate limits, side effects, errors) is exactly the work MCP servers exist to encapsulate. Xandria makes you pay it **once** instead of N times — a real win — but someone still pays it. "No setup" is true for the *consumer*, not for whoever stands up the capability.
- **It is a contested lane.** "Scoped, revocable credential for an agent" is its own emerging category — agent-identity / auth-for-agents vendors, MCP itself, and the model providers' native connectors are all building pieces of this. The differentiation is the *combination* (lens algebra + agnosticism + tag axes + continuity), not the broker alone.
- **The broker is a trust concentration point.** Even without plaintext secrets, Xandria sits in the path of every call — a *capability* honeypot. Compromise binding-resolution and you compromise everything downstream. Key-card *systems* get attacked at the reader and the access server, not the card.
- **Boundaries are only as good as the metadata.** Wrong tags → wrong scoping. Auto-stamp + curate helps, but boundary correctness depends on tag hygiene, and annotation metadata historically rots (Atlas faces the same).

The moat, if there is one: the **json-rules lens algebra** makes the boundaries provably enforced rather than hand-wavy, and the **agnosticism + portability** is what no single provider is incentivized to build. The card is the pitch; the lens is why it holds.

---

## 17. Prior art: Claude Tag

Anthropic shipped **Claude Tag** (public beta, June 23 2026): a persistent AI teammate embedded in enterprise Slack channels — one shared instance per channel, with channel memory, ambient/proactive mode, and pass-the-baton handoff between teammates mid-task.

It **validates** parts of this thesis: shared, multi-actor, persistent agents that carry a thread across people are a real pattern (compare the team hub, §11).

It is also the **opposite lane**, which is useful for positioning:

- **Channel-scoped, not lens-scoped.** Its unit of context is "the channel." Xandria's is a portable, composable tag/lens you author and drop in anywhere.
- **Slack-locked and Anthropic-only.** The antithesis of agent-agnostic. Xandria is hub-as-home-base, model-as-contact.
- **No drop-in-anywhere.** You cannot take "the Claude that learned channel #email-team" and embed it in your email builder. That portability is Xandria's differentiating bet.

Claude Tag is a *vertical* (a persistent teammate inside one host app). Xandria is a *horizontal* (a hub that orchestrates many agents/models/sources and projects them, lens-scoped, into many surfaces). A Claude Tag agent could itself be one **contact** in Xandria.

Sources: [VentureBeat](https://venturebeat.com/technology/anthropic-launches-claude-tag-replacing-its-slack-app-with-a-persistent-ai-teammate-that-learns-monitors-and-works-autonomously), [TechCrunch](https://techcrunch.com/2026/06/23/anthropics-claude-tag-is-learning-your-company-one-slack-message-at-a-time/), [Latent Space](https://www.latent.space/p/ainews-claude-tag-multiplayer-proactive).
