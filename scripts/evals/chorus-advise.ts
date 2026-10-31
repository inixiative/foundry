#!/usr/bin/env bun
/**
 * @atlas
 * @kind entrypoint
 * @partOf feature:evals
 */
/**
 * What a live thread's chorus delivers for one user message, for Oracle's `chorus` replay arm.
 *
 *   bun scripts/evals/chorus-advise.ts --project <id | name> --message-file <path> --out <dir> \
 *     [--foundry-dir ~/code/inixiative/foundry/.foundry] [--regions <dir>] [--cwd <dir>] \
 *     [--session <key>] [--pause-at <percent>] [--experiment <design.md>]
 *
 * The thread is built as the daemon builds one for the project (`feedback/chorus-advise.ts`): the
 * daemon's settings read (never written), resolved under the subscription policy, the daemon's
 * decision hosts (`liveDecisionHosts`: the decision host and a host per stage model and effort), the
 * project's region Wardens, the FlowOrchestrator's deadline and budget, the harness. The message is
 * sent once; the executor's model call is captured, never made. Every Warden's decision, the notes the
 * message carries, the chorus's standing context and the exact first prompt are written to
 * `<out>/chorus.json`; the route and advice phase records to `<out>/journal.jsonl`.
 *
 * --regions <dir> runs the project's chorus from that regions directory instead of its own (e.g.
 * regions rebuilt at a fixture's base commit); everything else about the chorus is the project's.
 * --cwd is where the thread works (default the project's path): the instruction ladder composes from
 * there. --session names the thread, so a later run with the same key reuses its Wardens' primed
 * sessions. --pause-at waits while the Claude login's five-hour window is at or above that percent.
 * --experiment records a reviewed design (foundry-core's experiment gate); one message is never wide.
 * --prime warms every Warden first (its caches, then one decision on a priming message on its own
 * session keys), so the message is advised on primed keys as a later live turn is; a first live turn
 * primes as it decides. Priming's calls are recorded apart (`phase: prime`).
 *
 * Besides chorus.json, `<out>/requests.jsonl` holds every Warden call's exact input (one row per
 * Warden and stage); chorus.json carries their hashes and each composed part's subject and sha256.
 *
 * Usage: every decision call's tokens (role `warden` or `cartographer`) and a window reading before
 * and after, through foundry-core's TokenTracker, land in chorus.json's `usage`.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  type CompletionOpts,
  type LLMProvider,
  type ParticipantRequest,
  requireExperiment,
  type SourceSegment,
  segmentsText,
  TokenTracker,
} from '../../packages/core/src';
import { FileMemory } from '../../packages/core/src/adapters/file-memory';
import { CHORUS_RECEPTION_VERSION } from '../../packages/foundry/src/agents/chorus-reception';
import {
  atlasRootOf,
  createSourceResolver,
} from '../../packages/foundry/src/agents/thread-factory';
import type { StageEffort } from '../../packages/foundry/src/classify';
import {
  charterFor,
  charterVersion,
  WARDEN_CHARTER,
  WARDEN_CHARTER_VERSION,
} from '../../packages/foundry/src/classify';
import { markEvalRun } from '../../packages/foundry/src/feedback/charter-eval';
import { adviseOnce } from '../../packages/foundry/src/feedback/chorus-advise';
import {
  claudeLimits,
  liveDecisionHosts,
  privateDirectory,
} from '../../packages/foundry/src/providers/decision-host';
import { isDefaultProfile } from '../../packages/foundry/src/providers/default-profiles';
import { resolveSubscriptionPolicy } from '../../packages/foundry/src/providers/subscription-policy';
import { resolvePrefilterSettings } from '../../packages/foundry/src/providers/warden-prefilter';
import { ConfigStore } from '../../packages/foundry/src/viewer/config';
import { resolveProjectView } from '../../packages/foundry/src/viewer/config-resolve';

const { values } = parseArgs({
  options: {
    project: { type: 'string' },
    'foundry-dir': { type: 'string' },
    regions: { type: 'string' },
    cwd: { type: 'string' },
    'message-file': { type: 'string' },
    out: { type: 'string' },
    session: { type: 'string' },
    'pause-at': { type: 'string' },
    experiment: { type: 'string' },
    prime: { type: 'boolean' },
  },
  strict: true,
});
if (!values.project || !values['message-file'] || !values.out) {
  console.error(
    'usage: chorus-advise.ts --project <id | name> --message-file <path> --out <dir> [--regions <dir>] [--cwd <dir>] [--session <key>] [--pause-at <percent>] [--experiment <design.md>] [--foundry-dir <dir>]',
  );
  process.exit(2);
}
const pauseAt = values['pause-at'] === undefined ? undefined : Number(values['pause-at']);
if (pauseAt !== undefined && (!Number.isFinite(pauseAt) || pauseAt <= 0 || pauseAt > 100))
  throw Error('--pause-at must be a percent in (0, 100]');
const out = resolve(values.out);
if (out.startsWith(`${resolve(import.meta.dir, '..', '..')}/`)) {
  console.error('--out must be outside the repository: chorus.json holds the task text');
  process.exit(2);
}
privateDirectory(out);
const message = readFileSync(values['message-file'], 'utf8');
// One message is never a wide run; a named design is checked and recorded.
const experiment = requireExperiment(values.experiment, false);

const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
/** sha256 over every file of a regions directory, sorted by path (Oracle's `regionsHash`). */
function regionsSha256(dir: string): string {
  const files: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.isDirectory()) walk(join(d, entry.name), `${rel}${entry.name}/`);
      else files.push(`${rel}${entry.name}`);
    }
  };
  walk(dir, '');
  const h = createHash('sha256');
  for (const f of files)
    h.update(f)
      .update('\0')
      .update(readFileSync(join(dir, f)))
      .update('\0');
  return h.digest('hex');
}

// The daemon's settings, read only, resolved under the subscription policy as the daemon resolves them.
const foundryDir = resolve(
  values['foundry-dir'] ?? join(homedir(), 'code', 'inixiative', 'foundry', '.foundry'),
);
const saved = structuredClone(await new ConfigStore(foundryDir).load());
const entry = Object.entries(saved.projects ?? {}).find(
  ([id, p]) =>
    id === values.project ||
    p.label === values.project ||
    basename(p.path ?? '') === values.project,
);
if (!entry) throw Error(`--project ${values.project} is not registered in ${foundryDir}`);
const [projectId, project] = entry;
if (!project.path) throw Error(`project ${projectId} has no path`);
// The pre-filter (off by default) is a local model server the daemon starts; a headless run has none.
if (resolvePrefilterSettings(saved.prefilter).enabled)
  throw Error('the Warden pre-filter is on in these settings; chorus-advise runs without it');
// In memory only: the project's chorus reads its regions from --regions, everything else as set.
if (values.regions) {
  const { layers: _layers, ...chorus } = project.chorus ?? {};
  project.chorus = { ...chorus, regions: resolve(values.regions) };
}
const state = privateDirectory(join(homedir(), '.foundry', 'evals'));
// An eval run, not work: Archive and the repeat report leave its sessions out.
markEvalRun(state);
const subscription = resolveSubscriptionPolicy(saved, { startup: true, cwd: state });
if (!subscription) throw Error('chorus-advise runs on subscription decisions only');
const config = subscription.config;
const view = resolveProjectView(config, projectId);
if (!view?.chorus.on)
  throw Error(`project ${projectId} runs no chorus: ${view?.chorus.reason ?? 'not resolved'}`);
const cwd = resolve(values.cwd ?? project.path);

// Usage, through foundry-core: every decision call, standby turns and the window before and after.
const tracker = new TokenTracker();
const INTEGRATION = 'local';
let phase: 'prime' | 'advice' = values.prime ? 'prime' : 'advice';
const roleOf = (threadId: string | undefined): Record<string, string> => {
  const aux = threadId?.split(':aux:')[1] ?? '';
  const domain = /^domain:(.+?)(?::stage:(\d+))?$/.exec(aux);
  if (domain)
    return {
      role: 'warden',
      domain: domain[1]!,
      stage: String(domain[2] ? Number(domain[2]) : 0),
    };
  return { role: aux === 'cartographer' ? 'cartographer' : aux || 'decision' };
};
const recordWindows = async (phase: 'before' | 'after') => {
  const snapshot = await claudeLimits(state);
  if (!snapshot?.windows.length) return undefined;
  return tracker.recordWindows({
    provider: 'subscription-decisions',
    integrationId: INTEGRATION,
    phase,
    source: 'probe',
    windows: Object.fromEntries(
      snapshot.windows.map((w) => [
        w.id,
        {
          usedPercent: w.usedPercent,
          ...(w.resetsAt !== undefined ? { resetsAt: w.resetsAt } : {}),
          ...(w.windowMinutes !== undefined ? { windowMinutes: w.windowMinutes } : {}),
        },
      ]),
    ),
    ...(snapshot.plan ? { plan: snapshot.plan } : {}),
    attribution: { role: 'warden' },
  });
};
const live = liveDecisionHosts(config, subscription, {
  events: {
    onPrimedEvent: (event) => {
      if (event.type !== 'standby') return;
      tracker.record({
        provider: 'subscription-decisions',
        model: subscription.policy.model,
        integrationId: INTEGRATION,
        attribution: { role: 'warden', phase: 'standby', key: event.key },
        tokens: {
          input: event.input,
          output: event.output,
          cacheRead: event.cacheRead,
          cacheWrite: event.cacheWrite,
        },
      });
    },
  },
  log: (line) => console.error(line),
});
/** A decision provider whose settled calls are recorded; every other property is the host's own. */
const observed = (provider: LLMProvider, effort: string | undefined): LLMProvider => ({
  ...provider,
  complete: async (messages, opts?: CompletionOpts) => {
    const result = await provider.complete(messages, opts);
    if (result.tokens)
      tracker.record({
        provider: provider.id,
        model: result.model,
        ...(effort ? { effort } : {}),
        ...(opts?.threadId ? { threadId: opts.threadId } : {}),
        integrationId: INTEGRATION,
        attribution: { ...roleOf(opts?.threadId), phase },
        tokens: result.tokens,
      });
    return result;
  },
});
const decisions = observed(live.decisions.provider, subscription.policy.effort);
const stageProviders = new Map<string, LLMProvider | null>();
const stageHost = (model: string | undefined, effort: StageEffort | undefined) => {
  const key = `${model ?? ''}|${effort ?? ''}`;
  if (!stageProviders.has(key)) {
    const host = live.stageHost(model, effort);
    stageProviders.set(key, host ? observed(host, effort ?? subscription.policy.effort) : host);
  }
  return stageProviders.get(key)!;
};

const quota = async () => {
  if (pauseAt === undefined) return;
  for (;;) {
    const snapshot = await claudeLimits(state);
    const used = snapshot?.windows.find((w) => w.id === 'five_hour')?.usedPercent;
    if (used === undefined || used < pauseAt) return;
    console.error(`${new Date().toISOString()} five-hour window at ${used}%: pausing 10 min`);
    await Bun.sleep(600_000);
  }
};

const journalFile = join(out, 'journal.jsonl');
writeFileSync(journalFile, '', { mode: 0o600 });
const memory = new FileMemory(join(foundryDir, 'memory'));
await memory.load();
await quota();
const before = await recordWindows('before');
const startedAt = new Date().toISOString();
let advice: Awaited<ReturnType<typeof adviseOnce>>;
try {
  advice = await adviseOnce({
    config,
    projectId,
    cwd,
    message,
    decisions,
    stageHost,
    resolveSource: createSourceResolver({ memory }),
    atlasRoot: atlasRootOf(config),
    ...(values.session ? { threadId: values.session } : {}),
    ...(values.prime ? { prime: true } : {}),
    onPrimed: () => {
      phase = 'advice';
    },
    journal: (record) => appendFileSync(journalFile, `${JSON.stringify(record)}\n`),
    warn: (line) => console.error(line),
  });
} finally {
  await live.shutdown();
}
const after = await recordWindows('after');

const stages = view.chorus.roles.warden.stages.map((s, index) => ({
  index,
  model: s.model ?? subscription.policy.model,
  effort: s.effort ?? subscription.policy.effort ?? 'default',
  task: s.task,
  doc: s.doc,
  charterVersion: charterVersion(charterFor(s.task, 'warden', s.pointer).text),
}));
const usage = tracker.usageRecord();

/** JSON with every object's keys sorted: the canonical form a settings hash is taken over. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
// The chorus settings as this thread used them, after the machine's settings over the repository's.
const settings = {
  enabled: view.chorus.enabled,
  enabledBy: view.chorus.enabledBy,
  directoriesFrom: view.chorus.directoriesFrom,
  reception: view.chorus.reception,
  consumed: view.chorus.consumed,
  stages: { from: view.chorus.roles.warden.from, resolved: stages },
  prefilter: false,
  guard: config.guard ?? 'per-turn',
  flow: advice.timing,
  decisionHost: {
    runtime: subscription.decision.runtime,
    model: subscription.policy.model,
    effort: subscription.policy.effort ?? 'default',
    callTimeoutMs: subscription.policy.callTimeoutMs,
    wardens: subscription.policy.wardens,
  },
};

/** One composed slot as parts: each attributed part's subject, ladder rung and sha256, and the glue's. */
const slotParts = (segments: readonly SourceSegment[]) => ({
  sha256: sha256(segmentsText(segments)),
  parts: segments.flatMap((segment) =>
    typeof segment === 'string'
      ? []
      : [
          {
            subject: segment.subject,
            ...(segment.node ? { node: segment.node } : {}),
            ...(segment.tier ? { tier: segment.tier } : {}),
            sha256: sha256(segment.text),
            chars: segment.text.length,
          },
        ],
  ),
  glueSha256: sha256(segments.filter((segment) => typeof segment === 'string').join('')),
});
/** A call's input by hash: each message, and what its charter, instructions and knowledge were composed of. */
const requestHashes = (request: ParticipantRequest) =>
  request.status !== 'supplied'
    ? { status: request.status, reason: request.reason }
    : {
        status: request.status,
        ...(request.stage !== undefined ? { stage: request.stage } : {}),
        messages: request.messages.map((m) => ({
          role: m.role,
          sha256: sha256(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)),
        })),
        ...(request.composition
          ? {
              composition: {
                role: request.composition.role ?? null,
                charter: request.composition.charter
                  ? {
                      subject: request.composition.charter.subject,
                      sha256: sha256(request.composition.charter.text),
                    }
                  : { subject: WARDEN_CHARTER_VERSION, sha256: sha256(WARDEN_CHARTER) },
                instructions: slotParts(request.composition.instructions),
                domainKnowledge: slotParts(request.composition.domainKnowledge),
                ...(request.composition.omitted ? { omitted: request.composition.omitted } : {}),
              },
            }
          : {}),
      };
// Every call's exact input, by Warden and stage, beside chorus.json (it holds every region's knowledge).
const requestsFile = join(out, 'requests.jsonl');
writeFileSync(
  requestsFile,
  advice.decisions
    .flatMap((d) =>
      [d.request, ...(d.stageRequests ?? [])].map(
        (request) => `${JSON.stringify({ domain: d.domain, request })}\n`,
      ),
    )
    .join(''),
  { mode: 0o600 },
);
/** A Warden's advice tokens, per model (priming apart). */
const wardenTokens = (domain: string, ofPhase: 'advice' | 'prime') => {
  const byModel = new Map<string, Record<string, number>>();
  for (const entry of usage.entries) {
    if (entry.attribution?.domain !== domain || entry.attribution.phase !== ofPhase) continue;
    const sum = byModel.get(entry.model) ?? {
      calls: 0,
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      thinking: 0,
    };
    sum.calls! += 1;
    sum.input! += entry.tokens.input;
    sum.cacheRead! += entry.tokens.cacheRead ?? 0;
    sum.cacheWrite! += entry.tokens.cacheWrite ?? 0;
    sum.output! += entry.tokens.output;
    sum.thinking! += entry.tokens.thinking ?? 0;
    byModel.set(entry.model, sum);
  }
  return Object.fromEntries(byModel);
};
// Regions the directories hold that the thread did not compose (a herald, a region another layer replaced).
const held = view.chorus.layers.flatMap((layer) =>
  readdirSync(layer.regionsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(layer.regionsDir, e.name, 'region.json')))
    .map((e) => e.name),
);
const notComposed = [...new Set(held)].filter((id) => !advice.composed.includes(id)).sort();

/** The Claude login the Warden calls ran on: its profile and integration, and a hash of its account. */
const login = (() => {
  const source = subscription.decision;
  const status = Bun.spawnSync(['claude', 'auth', 'status', '--json'], {
    env: isDefaultProfile(source.profileDirectory, source.runtime)
      ? process.env
      : { ...process.env, CLAUDE_CONFIG_DIR: source.profileDirectory },
    stdout: 'pipe',
    stderr: 'ignore',
  });
  let account: Record<string, unknown> = {};
  try {
    account = JSON.parse(status.stdout.toString()) as Record<string, unknown>;
  } catch {}
  const email = [account.email, account.emailAddress].find(
    (v): v is string => typeof v === 'string',
  );
  return {
    runtime: source.runtime,
    integrationId: source.integrationId ?? null,
    profileDirectory: source.profileDirectory,
    accountSha256: email ? sha256(email.trim().toLowerCase()).slice(0, 16) : null,
    subscriptionType:
      typeof account.subscriptionType === 'string' ? account.subscriptionType : null,
  };
})();

const chorus = {
  schema: 'foundry-chorus-advise/1',
  project: { id: projectId, label: project.label ?? null, path: project.path },
  cwd,
  session: values.session ?? null,
  startedAt,
  endedAt: new Date().toISOString(),
  elapsedMs: advice.elapsedMs,
  foundry: {
    dir: foundryDir,
    commit: Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: import.meta.dir })
      .stdout.toString()
      .trim(),
  },
  experiment: experiment ?? null,
  login,
  regions: view.chorus.layers.map((layer) => ({
    label: layer.label,
    dir: layer.regionsDir,
    sha256: regionsSha256(layer.regionsDir),
    regions: layer.regions.map((r) => r.id),
  })),
  regionsOverride: values.regions ? resolve(values.regions) : null,
  composed: advice.composed,
  notComposed,
  reception: {
    on: view.chorus.reception.on,
    version: CHORUS_RECEPTION_VERSION,
  },
  stages,
  settings,
  settingsSha256: sha256(canonical(settings)),
  prime: values.prime === true,
  primed: advice.primed ?? null,
  payload: advice.payload,
  payloadSha256: sha256(advice.payload),
  systemAppend: advice.systemAppend,
  systemAppendSha256: sha256(advice.systemAppend),
  turnText: advice.turnText,
  notes: advice.notes,
  message: advice.message,
  messageSha256: sha256(advice.message),
  firstMessage: advice.nativePrompt,
  firstMessageSha256: sha256(advice.nativePrompt),
  live: {
    systemPromptSha256: sha256(advice.liveSystemPrompt),
    standing: advice.standing,
  },
  routing: advice.routing,
  omissions: advice.omissions,
  requestsFile: 'requests.jsonl',
  wardens: advice.decisions.map(({ request, stageRequests, ...decision }) => ({
    ...decision,
    deadlineMs: advice.timing.adviseTimeoutMs,
    requests: [request, ...(stageRequests ?? [])].map(requestHashes),
    tokens: wardenTokens(decision.domain, 'advice'),
    ...(values.prime ? { primeTokens: wardenTokens(decision.domain, 'prime') } : {}),
  })),
  usage: {
    ...usage,
    windows: {
      before: before ?? null,
      after: after ?? null,
    },
  },
};
writeFileSync(join(out, 'chorus.json'), JSON.stringify(chorus, null, 1), { mode: 0o600 });
const spoke = advice.decisions.filter((d) => d.decision === 'contribute').map((d) => d.domain);
console.error(
  `chorus: ${advice.decisions.length} Wardens, ${spoke.length} chimed in${spoke.length ? ` (${spoke.join(', ')})` : ''}; ${usage.calls} calls, ${usage.totals.total} tokens`,
);
console.log(join(out, 'chorus.json'));
