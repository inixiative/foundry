# M4-A: make the reviewed expert loop launchable without changing live state

Continue in the existing Astra Foundry session after turn8991b702 completed:
native task_complete15:33:33.411Z for01a07c6e-e1e3-7e61-a08e-a01045c8582c,
matching durable final and empty /api/messages/live independently observed.
Parent read the complete M4 preparation and inspected the identified startup
boundaries. Parent independently passed the unchanged four rationale cases/84
assertions and all16 retained scenario journals; this is source evidence only.

Implement the narrow M4-A operational composition now. The user's latest
clarification is unchanged: each domain expert owns instructions, domain knowledge
and its own thread interpretation; Herald distributes explicitly shareable
cross-thread findings later. Do not turn expert memory into a global summary.
Live local-expert verification remains the next dependency before Herald.

Ownership: scripts/start-harness-lead.ts, a small startup composition helper if it
actually enables side-effect-free tests, packages/foundry/src/start.ts only for the
startup self-test policy, and focused tests. Reuse learning-config.ts and existing
adapter lifecycle APIs. Fable owns the inspector/UI and its tests, and the parent
owns acceptance fixtures. Do not modify those files or M0 runtime/helper semantics.

Required behavior:

1. Separate the lead launcher's immutable code location from explicitly selectable
workspace and state roots. Preserve existing default paths when no override is
provided. Use explicit validated options; never silently initialize a different
workspace, replace saved project paths or rebind a native session. Tests must show
a candidate code path can select the existing workspace/state path without writes
to the candidate's own state. Reject inconsistent saved project/binding identity
before work rather than silently migrating it. Do not inspect credentials.
2. Resolve config.learning through resolveLearningSettings with the already
constructed central/auxiliary providers. Preserve current default Haiku background
policy if no review profile is supplied. Explicit Fable remains explicit Fable;
do not relabel Haiku, construct HTTP fallback providers, silently lower effort,
or imply Codex text-only reviewing is supported. Reject unsupported explicit
review launch settings before model admission using established validation and
capability boundaries. Forward all existing adapter lifecycle capabilities.
3. Make the primary startup provider self-test explicitly opt-in, with a clear
startup log when skipped. Starting a server must not unexpectedly spend a model
call. Explicitly opting in keeps the existing auxiliary identity, real provider
call and reported result. Test skipped versus requested behavior without native
processes. This deliberate default change is authorized; document it.
4. Add controlled startup/composition tests proving correct selected paths,
unchanged defaults, stored identity preservation, review-profile resolution,
unsupported settings rejection and no model admission just from inspection or
default startup. Do not claim a pure path helper test exercises full startup;
name evidence scope accurately. Source imports for tests must not launch servers.

First checkpoint the exact implementation boundaries in
docs/M4-A-operational-composition-handoff.md, then implement and run focused tests,
strict types, relevant existing learning-config/owned-adapter tests and scoped
hash/diff checks. Report original failures as well as final results. Include exact
launch options, default behavior and the next executable live-sample dependency.

Do not implement another runtime, journal, native-learning runner or broad shutdown
rewrite in this slice. No install, new candidate, live restart, native capture,
account/configuration/binding change, browser-storage action or commit. Existing
frozen candidates remain untouched. This authorization is for source and controlled
tests only. Installed verification and a separately reviewed disposable native
sample still precede any one-server cutover. Count remains eight; parent acceptance
is independent.
