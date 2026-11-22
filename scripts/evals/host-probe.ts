/**
 * @atlas
 * @kind entrypoint
 * @partOf feature:evals
 */
/**
 * Eval-only instrument for one project Warden host (agent-session `ClaudeInSessionDecisions`): which
 * path every Warden call took (a held warm spare, or its own cold member), whether it was delivered,
 * how it ended, and the host's capacity state (spawns the CLI cap refused, orphans, serving) sampled
 * through a batch. It reads the host's private state by name, so it is pinned to the agent-session
 * version the decisions file records; a missing field throws instead of reading as zero.
 */
import type { ProjectWardenHosts } from '../../packages/foundry/src/providers/project-warden-hosts';

/** The live host a project's threads are served by. */
export type ClaudeInSessionDecisions = Exclude<
  ReturnType<ProjectWardenHosts['serving']>,
  'starting' | undefined
>;

interface SpareView {
  readonly token: string;
  readonly name: string;
  readonly direct: boolean;
  held?: unknown;
  orphan?: boolean;
  superseded?: boolean;
  retired?: boolean;
  done: boolean;
}
interface MemberView {
  readonly spec: { key: string };
  readonly started: number;
  readonly deadline: number;
  spare?: SpareView;
  deliveredAt?: number;
  settled: boolean;
  withdrawn?: { reason: 'timeout' | 'aborted' };
}
interface HostInternals {
  readonly _members: Set<MemberView>;
  readonly _spares: Map<string, SpareView>;
  readonly _awaitingSlot: SpareView[];
  readonly _orphanedOut: boolean;
  readonly _config: Record<string, unknown>;
  readonly env: Readonly<Record<string, string>>;
  serving(): boolean;
}

const internals = (host: ClaudeInSessionDecisions): HostInternals => {
  const view = host as unknown as HostInternals;
  for (const field of ['_members', '_spares', '_awaitingSlot', '_config'] as const)
    if (!view[field]) throw Error(`host-probe: agent-session host has no ${field}`);
  return view;
};

/** Held spares per role right now (a spare counts while it is held and not on its way out). */
export function heldSpares(host: ClaudeInSessionDecisions) {
  const perRole = new Map<string, number>();
  for (const s of internals(host)._spares.values())
    if (s.held && !s.done && !s.retired && !s.superseded && !s.direct)
      perRole.set(s.name, (perRole.get(s.name) ?? 0) + 1);
  const counts = [...perRole.values()];
  return {
    roles: perRole.size,
    total: counts.reduce((a, b) => a + b, 0),
    min: counts.length ? Math.min(...counts) : 0,
    histogram: counts.reduce<Record<number, number>>(
      (h, c) => ({ ...h, [c]: (h[c] ?? 0) + 1 }),
      {},
    ),
  };
}

/** The sizing the host was built with, as it holds it (B2: compared with the design's derived bounds). */
export function hostSizing(host: ClaudeInSessionDecisions) {
  const { _config, env } = internals(host);
  return {
    sparesPerRole: _config.sparesPerRole,
    maxSubagents: _config.maxSubagents,
    maxOrphans: _config.maxOrphans,
    setupDeadlineMs: _config.setupDeadlineMs,
    dispatchers: _config.dispatchers,
    timeoutMs: _config.timeoutMs,
    cliSubagentCap: Number(env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS),
    ownCapEnv: process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS ?? null,
  };
}

/** One Warden call as the host ended it. */
export interface CallPath {
  readonly key: string;
  /** warm: served by a held spare; cold: its own member (direct); none: never given a member. */
  readonly path: 'warm' | 'cold' | 'none';
  /** It first waited on a spare that was not yet held, then fell back to its own member. */
  readonly fellBack: boolean;
  readonly deliveredMs: number | null;
  readonly settled: boolean;
  readonly withdrawn: 'timeout' | 'aborted' | null;
}

/**
 * Watches one host through a batch: wraps its member set's `add` so every call made in the batch is
 * kept, and samples capacity every `everyMs`. `stop()` restores the set and returns the record.
 */
export function watchHost(host: ClaudeInSessionDecisions, everyMs = 250) {
  const view = internals(host);
  const members: MemberView[] = [];
  /** Per member, every spare it was attached to, in order (a reservation, then a fallback). */
  const seen = new Map<MemberView, SpareView[]>();
  const note = (m: MemberView) => {
    const list = seen.get(m) ?? [];
    if (m.spare && list.at(-1) !== m.spare) list.push(m.spare);
    seen.set(m, list);
  };
  const add = view._members.add;
  view._members.add = function (this: Set<MemberView>, m: MemberView) {
    members.push(m);
    queueMicrotask(() => note(m));
    return add.call(this, m);
  };
  const awaitingTokens = new Set<string>();
  const samples: Array<{
    at: number;
    members: number;
    awaitingSlot: number;
    orphans: number;
    serving: boolean;
  }> = [];
  const sample = () => {
    for (const m of view._members) note(m);
    for (const s of view._awaitingSlot) awaitingTokens.add(s.token);
    samples.push({
      at: Date.now(),
      members: view._members.size,
      awaitingSlot: view._awaitingSlot.length,
      orphans: [...view._spares.values()].filter((s) => s.orphan && !s.done).length,
      serving: host.serving(),
    });
  };
  sample();
  const timer = setInterval(sample, everyMs);
  return {
    stop() {
      clearInterval(timer);
      sample();
      view._members.add = add;
      const calls: CallPath[] = members.map((m) => {
        note(m);
        const spares = seen.get(m) ?? [];
        const last = spares.at(-1);
        return {
          key: m.spec.key,
          path: !last ? 'none' : last.direct ? 'cold' : 'warm',
          fellBack: spares.some((s) => !s.direct) && !!last?.direct,
          deliveredMs: m.deliveredAt ? m.deliveredAt - m.started : null,
          settled: m.settled,
          withdrawn: m.withdrawn?.reason ?? null,
        };
      });
      const count = (f: (c: CallPath) => boolean) => calls.filter(f).length;
      const first = samples[0];
      const last = samples.at(-1);
      return {
        calls: calls.length,
        warm: count((c) => c.path === 'warm'),
        cold: count((c) => c.path === 'cold'),
        none: count((c) => c.path === 'none'),
        fellBack: count((c) => c.fellBack),
        undelivered: count((c) => c.deliveredMs === null),
        withdrawnTimeout: count((c) => c.withdrawn === 'timeout'),
        coldUndelivered: count((c) => c.path === 'cold' && c.deliveredMs === null),
        awaitingSlotPeak: Math.max(0, ...samples.map((s) => s.awaitingSlot)),
        awaitingSlotSpawns: awaitingTokens.size,
        orphans: { start: first?.orphans ?? null, end: last?.orphans ?? null },
        serving: { start: first?.serving ?? null, end: last?.serving ?? null },
        orphanedOut: view._orphanedOut,
        perCall: calls,
        samples,
      };
    },
  };
}
