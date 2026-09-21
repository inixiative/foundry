# Dedicated subscription-native worker proposal

Status: design and cost estimate, 2026-09-21. No VM, account, profile, firewall or paid resource was created. This is the proposed route from controlled fixture tests to a working bounded native benchmark; it is not deployed infrastructure.

## Boundary

Run primary and decision roles in separate dedicated Linux VMs, with an unprivileged native process inside each. Keep Foundry's guardian and the Docker fixture broker outside those untrusted process scopes. The VMs receive no developer home, host checkout, Docker socket, SSH agent, cloud credentials or another role's profile. Fixture contents stay in the broker; the primary reaches only the three fixed broker operations over an authenticated, task-bound transport. Decisions get no fixture tools.

The guardian accepts only typed start/send/cancel/status operations bound to a registered role, installation, generation and admission. It never accepts executable names, arbitrary argv, environment, filesystem paths or replacement endpoint URLs. Pin the worker OS image, verified CLI artifact and policy digest in its descriptor. A version or policy change requires a new reviewed revision and owner approval.

The supervisor must enforce the boundary outside Claude: private filesystem mounts, non-root identity, no privilege escalation, bounded memory/CPU/PIDs/output, and an external network policy. Place each invocation's full descendant process tree in an owned cgroup. Stop, terminate and confirm that tree is empty before releasing capacity. Unknown cleanup quarantines the worker; lost contact never counts as release. A VM rebuild must not silently recreate an approved capacity revision.

A small guardian-side tunnel can carry only the fixed MCP protocol to the existing loopback bridge; it needs mutually authenticated worker identity, request size limits and the same admission capability checks. Do not expose the current loopback endpoint publicly or relax its Host/Origin checks. The transport must not allow shell tunneling or arbitrary TCP forwarding. The VM's model-facing tools cannot invoke guardian control, seal, evaluator, profile or registry APIs.

## Authentication and policies

An operator signs in directly inside each worker's private profile using Claude Code's supported browser login. The session/profile stays there under its sole refresh owner; Kingdom stores only an opaque source reference and owner-approved capacity metadata. Do not copy an existing laptop profile, extract OAuth material, or introduce an API-key fallback. Claude Code documents subscription account access and its browser login flow; VM enrollment still needs to be verified with the selected account and organization's policies. [Claude authentication](https://code.claude.com/docs/en/authentication)

Preserve organizational policies. Managed hooks may execute inside the constrained worker and remain subject to its OS/network limits. This changes the claim from “no managed execution exists” to “managed execution cannot reach resources outside the approved worker boundary.” It does not make hooks trusted, erase their effects, or establish stock-native equivalence. Record effective policy observations and fail a comparison if policy adds incompatible capabilities or changes behavior between arms. A requirement for zero managed hooks needs administrator-approved compatible policy or a vendor pre-startup gate; this design cannot claim to supply that guarantee.

For runtime egress, start from the documented model/authentication endpoints (`api.anthropic.com`, `claude.ai`, `claude.com`, `platform.claude.com`) plus the single approved guardian endpoint. Resolve and enforce policy through an external allowlisting proxy/firewall, not only environment variables that child processes can ignore. Block direct egress, LAN/private metadata services and other workers. Provision/update traffic is a separate operator phase. Preserve required policy endpoints; incompatible mandatory endpoints cause refusal rather than silently disabling policy. [Claude network requirements](https://code.claude.com/docs/en/network-config)

## Resources and cost

Claude documents Linux support and at least 4 GB RAM. Use **2 vCPU / 4 GB RAM per role VM** as an initial pilot allocation, then measure peak resident memory and startup time. CPU count and the need for two VMs are engineering choices, not vendor guarantees. The warm primary and nested decisions may coexist, so one 4 GB allocation is not assumed sufficient for both. [Claude system requirements](https://code.claude.com/docs/en/setup)

On already owned VM-capable hardware, incremental subscription hosting fees can be zero, with roughly 8 GB RAM reserved for both roles and separate capacity for the guardian/broker. As a current hosted benchmark, DigitalOcean lists 2 vCPU / 4 GiB at $24/month: two role VMs total about **$48/month**, or approximately **$0.07142/hour** together. A new similar broker host would add another $24/month; an existing approved broker can be reused. These figures exclude model subscriptions, taxes, storage beyond the plan, backups and operations work. This is a comparison price, not a purchase or resource reservation. [DigitalOcean pricing](https://www.digitalocean.com/pricing/droplets)

## Operator prerequisites and acceptance

Before provisioning: choose approved capacity/region and budget; identify the subscription owner and acceptable organizational policy; approve worker isolation and egress policy; choose verified native artifacts; ensure secure operator console access for direct login; and name the person who approves each Kingdom capacity revision. No customer account or shared pool is inferred from available local credentials.

Implement and test in this order:

1. Provision the worker/supervisor boundary without a model account. Canary child processes must fail host/profile/socket/cross-role/network access and prove full-tree cleanup, restart quarantine and resource caps.
2. Exercise the real bounded session and fixed MCP tunnel using controlled native transport. Retain the actual four-arm harness's advice, post-action guards and arm-private learning; structural broker authorization is identical in every arm.
3. Complete seal-to-evaluator checks using the independent Docker evaluator and exact raw-byte inventory, retaining failed/unavailable results.
4. Let the operator authenticate inside the worker and approve the exact immutable registered descriptor. Recheck model, source, installation, isolation revision and task generation immediately before each write, including after queued decision waits.
5. Run only the separately authorized small subscription-native pilot. Capture actual model acknowledgement, native/tool/cgroup settlement, policy identity, call accounting and evaluator evidence. No retries or model substitution hidden by the transport.

Registry descriptors should bind role, owner, installation, opaque source, runtime/model/expected model, artifact identity, isolation policy version/digest, supported tools and verified readiness. Local configuration or a controlled transport receipt cannot make an unavailable worker eligible. Kingdom owns approval, reservations and per-phase admission; Foundry owns local process/transport proof. Learning after primary exit needs its own explicit bounded phase.

## Verification interface

Use an operator-approved guardian/controller outside the native worker VM as the evidence issuer. Its signing key stays outside the worker; Kingdom registers the issuer public key and allowed worker/boundary IDs through a separate administrator approval. This is explicitly trust in that controller and its hypervisor/network access, not hardware attestation or a guest assertion.

Kingdom issues a single-use random challenge tied to a requested boundary revision. The controller verifies the actual VM/image/configuration through its hypervisor or provider control plane, reads the enforced gateway/firewall policy outside the VM, and runs non-model isolation canaries. A signed evidence envelope binds:

```ts
{
  schema: 1,
  issuerId, verifierId, signingKeyId,
  challengeId, nonceHash, evidenceId,
  workerId, installationId,
  boundary: { id, revision, digest, policyVersion, isolationPolicyDigest, runtimeArtifactDigest },
  issuedAt, expiresAt,
  checks: [{
    specificationId, specificationDigest,
    observer: "hypervisor" | "egress-gateway" | "guardian",
    observationId, evidenceDigest, expectedOutcome, observedOutcome
  }],
  manifestDigest
}
```

The envelope is signed with the registered issuer key over canonical bytes. `checks` are required by a versioned verifier specification, not an arbitrary caller list: VM/image identity; absence of host/shared mounts and privileged devices; role separation; enforced egress policy; host/socket/cross-role/network canary denial; CPU/memory/PID/output limits; and descendant cleanup/quarantine behavior. The evidence manifest retains underlying controller observations and canary results for audit. Guest output alone cannot satisfy an externally observed check. A copied runtime checksum in a guest response is insufficient; the controller must verify the deployed artifact against the approved immutable image or supervisor-owned filesystem.

Kingdom verifies signature/key scope, exact descriptor digest, challenge freshness and one-time use, required check specification/results, manifest binding and current enrollment/revocation. Start with a short evidence lifetime (proposed 60 seconds), renewed through the controller while it rechecks external enforcement. The role and call still require separate task/phase admission; readiness evidence never authorizes spending. If any boundary property changes, evidence becomes unavailable and a new revision is required.

For closure, the controller signs an admission-specific receipt with full logical owner, worker/boundary revision, process-scope ID, observed remaining descendants and cleanup outcome. Normal release needs externally observed scope emptiness. If the supervisor cannot prove cleanup, quarantine and power off the dedicated role VM; hypervisor-confirmed stopped state can then prove process termination, while profile/disk cleanup remains a separate fact. Neither a guest “done” message nor a requested power-off counts as settlement. A lost controller/network leaves capacity unknown and denies new slots.

This protocol is implementable with a trusted local hypervisor controller or a cloud provider control-plane adapter. Neither adapter nor the signed challenge/evidence exchange is implemented by the controlled fixture PR; pending registry rows must remain unavailable until those concrete observations exist.

Tribe/phone acceptance remains separate: owner login, personal phone eligibility/pairing and correlated delivery still need their authorized live checks. A successful controlled Oracle worker test cannot close that checklist.
