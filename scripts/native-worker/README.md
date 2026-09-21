# Offline Apple Virtualization canary

This is a bounded, non-model prototype of two separate Linux VMs on existing Apple silicon hardware. It does not install a hypervisor, interact with Docker, copy profiles, authenticate, or issue a worker-readiness assertion. It requires macOS, Xcode command-line tools and supported `Virtualization.framework` hardware.

The Swift controller owns each VM with 1 vCPU, 512 MiB RAM and a ten-second deadline. The configuration has no network, storage, shared-directory or socket devices. The guest receives only a reviewed public Linux kernel and an in-memory canary archive. The paired test consumes 1 GiB and two vCPUs in total. The controller's receipt derives device counts from its actual configuration and confirms the VZ stopped state; guest serial output remains separately labeled canary evidence.

## Reproduce

Use a new private directory outside the repository for all downloaded and generated artifacts. Download `vmlinuz-virt` and `initramfs-virt` from the Alpine v3.22 aarch64 netboot directory named in `build-offline-initramfs.py`. The builder verifies the exact SHA-256 values inspected on 2026-09-21 and refuses changed artifacts. These are public TLS downloads with pinned hashes; this prototype does not claim to have verified an Alpine release signature.

```sh
python3 scripts/native-worker/build-offline-initramfs.py /private/path/probe
python3 scripts/native-worker/build-offline-initramfs.py /private/path/probe --hold
xcrun swiftc scripts/native-worker/offline-probe.swift -framework Virtualization -o /private/path/probe/offline-probe
codesign --force --sign - --entitlements scripts/native-worker/virtualization.entitlements.plist /private/path/probe/offline-probe
python3 scripts/native-worker/verify-offline-pair.py /private/path/probe
python3 scripts/native-worker/test-offline-verification.py
```

The virtualization entitlement is attached only to the newly built temporary executable. No system setting or existing application signature changes. The held canary verifies setup, starts a descendant and repeatedly confirms it is alive; each controller forcibly stops its entire VM at ten seconds. Network checks require an explicit network-unreachable result; missing tools and arbitrary errors cannot count as passes. This probe's local deadline is independent of model/call budgets.

Each invocation invalidates the previous result before checking artifacts or launching a VM, snapshots its inputs into a unique run directory, and atomically publishes its current outcome. Verification binds controller-reported kernel and initramfs hashes to the snapshot and build manifest, requires exact device/resource/deadline settings, and derives resource totals from the validated receipts. The manifest and binary hashes are recorded for local reproduction; they are not signed supply-chain attestations. Run invocations sequentially against a given artifact directory.

If a controller never completes its stop callback, the runner's 25-second outer wait bounds that attempt and terminates the controller. Controller termination alone is recorded as cleanup unproved. A failed or interrupted run cannot reuse a previous success; abrupt termination of the runner leaves a `running` result with `passed: false`. Three negative verification tests cover altered configuration/artifacts, inapplicable canaries or absent child liveness, and stale success after a failed rerun.

## Observed 2026-09-21

Host: macOS 15.7.3, ARM64, 64 GiB RAM, ten logical CPUs. The SDK reported `VZVirtualMachine.isSupported == true`. Existing Docker Desktop services were inventoried read-only and left untouched.

- A single guest completed eight checks and powered off in 0.57 seconds; the controller observed stopped state.
- After the review fixes, two held guests ran concurrently and were stopped by their independent controllers in 10.58 seconds total (run `9238c4b5-e24e-493e-bad9-21acf83d3955`). Both reported the host-home, Docker-socket, native-profile, fixture-share, no-NIC, metadata-egress, public-egress and shared-mount checks passing, with repeated descendant liveness observations before stop.
- Neither guest had a network or host-shared device configured. A child process inside each guest cannot survive a confirmed stop of that VM.

The latest paired receipt was retained at `/tmp/foundry-vz-probe/pair-receipt.json`; historical receipts, controller output and console logs live under `/tmp/foundry-vz-probe/runs/<runId>/`. These are reproducible local experiment artifacts, not committed production evidence.

## Remaining boundary

This proves an offline VM can be created and stopped on the owned machine. It does not prove kernel exploit resistance, a live model runtime, an approved immutable runtime image, authenticated profile handling, cgroup isolation, output saturation behavior, a selective network allowlist, fixed MCP tunneling, cross-role network rejection in an online topology, or signed registry freshness. It must not satisfy all checks in `oracleWorkerCheckSpecification`.

The proposed model pilot still needs two independently authenticated role workers with an initial 4 GiB each, plus an external guardian/broker. The 512 MiB offline canary allocation is not a model runtime sizing claim. No operator login is needed until that runnable boundary is implemented and its non-model controls pass. See [the dedicated worker design](../../docs/dedicated-native-worker.md).
