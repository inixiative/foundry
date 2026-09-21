# Isolated fixture transport: controlled source, live boundary unresolved

The fixture bridge exposes exactly `fixture_read`, `fixture_write` and `fixture_command`. Each call gets an invocation UUID and retains the SDK request identity, original admission owner and truthful dispatch status on success or refusal. Unknown tools, extra arguments, invalid paths, missing/stale admissions, replayed authorization and expired grants execute nothing. The owner wires `fixtureBridgeSource(...).authorize` into the Lab broker's structural guard; no model-based guard runs there. Only the trusted Lab owner can seal or close the broker.

The immutable policy digest binds version, arm, thread/project/generation, fixture inventory, pinned image, bounds, deadline and operation surface. A source can acquire one native process. It creates an empty private working directory and owns the transport lifetime. Pending tool work prevents successor admission; late results cannot become successor data. A local deadline or uncertain cleanup retains ownership and closes admission. Native terminal evidence and broker invocation records remain distinct; a registered admission window is not a fabricated native tool-call correlation.

The Claude adapter has an explicitly named `controlledFixtureSpawn` test seam. It uses the real session protocol with a controlled process, checks exact restricted argv, labels completion evidence `controlled-fixture`, and refuses persisted fixture resumes. Its binding namespace contains the policy digest and lease ID. Warm reuse compares immutable policy identity and the actual bridge source. Auxiliary text-only sessions, Codex sessions and the generic native bridge path refuse fixture leases.

**There is no live fixture spawn path in this slice.** A normal adapter refuses a fixture lease before authentication or process construction. `withIsolatedFixture` is argv validation, not containment proof. It uses restricted mode, no built-in tools, strict owned MCP, disabled skills/browser, no session persistence and explicit settings, but does not claim those settings eliminate managed execution. Existing interactive and text-only launch behavior is otherwise unchanged. This intermediate guard must remain until a stronger runtime boundary is implemented and tested.

## Installed CLI investigation

Read-only inspection on 2026-09-21 covered `claude --version`, `--help`, installed source embedded in the binary, and targeted managed-policy existence/content-shape checks. No model, auth status, settings probe, doctor session or credential read was run.

Installed version: `2.1.260`; binary SHA-256: `3c269f66801028823e24a63ced9fdd3988cb86cf85fccd9f03f87e463b9d3e3c`.

- Safe and restricted modes retain managed settings. Empty setting sources still load flag and policy settings.
- `disableAllHooks` in ordinary flag settings retains policy hooks; managed plugin hooks can remain. This also affects the existing safe-mode native-text paths used by Oracle, medical execution and subscription decisions. It does not prove any such hook is configured or executed here.
- Strict MCP refuses conflicting enterprise MCP configuration rather than silently replacing it. Bare mode excludes subscription OAuth; it is not a substitute.
- The SDK `get_settings` request is processed after startup hooks. Remote policy may be fetched asynchronously and later refreshed; a digest does not freeze effective policy.
- The parent managed-settings input is subordinate and restrictive-filtered. It cannot provide an overriding no-hooks guarantee. Doctor shares common initialization and is not pre-execution attestation.

Targeted current-machine checks found no local managed settings/drop-ins, managed MCP, managed CLAUDE.md or macOS managed preference plists. The default remote settings cache was empty JSON. That describes disk state at inspection, not a selected authenticated profile's effective launch policy. No global or user policy was changed.

All affected live confinement acceptance remains pending. Controlled source tests remain valid for ownership, transport, launch composition and refusal behavior. They do not establish live subscription/model or containment success. See [dedicated worker proposal](dedicated-native-worker.md) for the concrete next boundary.
