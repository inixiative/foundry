# Ecosystem libraries

**The @inixiative libraries Foundry builds on: what each does, where its docs live as Warden knowledge, and which region holds its use inside Foundry.**

<!-- Generated with the region Warden docs (v1) by ~/.foundry/evals/warden-regions/foundry/assemble.py. Library docs are read at each package's origin/main at the commit shown. The primitives-lane tools Foundry also uses (@inixiative/atlas, @inixiative/gloss, @inixiative/config) have their library regions in template (.foundry/regions/lib-atlas, lib-gloss, lib-config). -->

| Library | Lane | Foundry dependency | What it is | Library docs (region) | Used in Foundry (region) | Sources |
|---|---|---|---|---|---|---|
| `@inixiative/agent-session` | agentic | yes | @inixiative/agent-session: HarnessSession, transports and capabilities, subagent events, subscription pools, routing and leases | [Native sessions and agent-session](native-sessions/knowledge.md) | [Native sessions and agent-session](native-sessions/knowledge.md), [decision-roles](decision-roles/knowledge.md), [Logins, profiles and secrets](logins-secrets/knowledge.md) | `@inixiative/agent-session/README.md`; `@inixiative/agent-session/docs/transports-pools-routing.md` @ `cb4691c` |
| `@inixiative/signet` | agentic | yes | The Signet protocol and SignetClient (@inixiative/signet): DPoP presentation, renewal, cancellation, task settlement | [Kingdom pairing, access and Signets](kingdom/knowledge.md) | [Kingdom pairing, access and Signets](kingdom/knowledge.md) | `@inixiative/signet/README.md` @ `3607e85` |
| `@inixiative/archive` | agentic | yes | The Archive itself (@inixiative/archive): deployment, collectors, routing, tags/references/retention, HTTP API | [Local Archive and session capture](archive/knowledge.md) | [Local Archive and session capture](archive/knowledge.md), [threads-journal](threads-journal/knowledge.md) | `@inixiative/archive/README.md` @ `d8ee0d6` |
