import type { ToolDecision, ToolGate, ToolRequest } from '@inixiative/agent-session';
import {
  type ActionQueue,
  type Capability,
  newId,
  type PermissionLevel,
  permissionLevel,
} from '@inixiative/foundry-core';
import type { PermissionMode } from '../providers/thread-launch';

/**
 * The user's structural tool rules: the only thing in Foundry that can deny a tool call. They
 * hold in every permission mode, full access included, because they are the user's own
 * configured structure rather than a mode. `deny` is final; `prompt` asks the user (in the
 * viewer and the ACP host, first answer wins) in every mode; `allow` leaves the call to the
 * runtime's own mode. Wardens never decide here: their review is a comment (the post-action
 * guard chorus), never a block.
 */
export interface ToolRules {
  /** Capability (e.g. `exec:shell`, `file:write`, `net:api`, or `tool:<Name>`) → level. */
  capabilities?: Partial<Record<Capability, PermissionLevel>>;
  /** Writes and deletes under paths containing one of these fragments ask. */
  protectedPaths?: string[];
}

const SHELL = new Set(['Bash', 'BashOutput', 'KillShell', 'shell', 'exec_command']);
const WRITE = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch']);
const READ = new Set(['Read', 'NotebookRead', 'LS', 'Glob', 'Grep']);
const FETCH = new Set(['WebFetch', 'WebSearch']);
const PATH_KEYS = ['file_path', 'path', 'notebook_path'] as const;

/** Every path a call names: its own path keys, Claude's blocked path, Codex file changes. */
function toolPaths(request: Pick<ToolRequest, 'toolInput' | 'blockedPath'>): string[] {
  const { toolInput } = request;
  const changes = Array.isArray(toolInput.changes) ? toolInput.changes : [];
  return [
    request.blockedPath,
    ...PATH_KEYS.map((key) => toolInput[key]),
    ...changes.flatMap((change) => {
      const c = change as { path?: unknown; movePath?: unknown } | null;
      return [c?.path, c?.movePath];
    }),
  ].filter(
    (value, index, all): value is string =>
      typeof value === 'string' && !!value && all.indexOf(value) === index,
  );
}

/** The capability a native tool call exercises, and the paths it touches. */
export function classifyTool(
  request: Pick<ToolRequest, 'toolName' | 'toolInput' | 'blockedPath'>,
): {
  capability: Capability;
  paths: string[];
} {
  const { toolName } = request;
  const paths = toolPaths(request);
  if (SHELL.has(toolName)) return { capability: 'exec:shell', paths };
  if (WRITE.has(toolName)) return { capability: 'file:write', paths };
  if (READ.has(toolName)) return { capability: 'file:read', paths };
  if (FETCH.has(toolName)) return { capability: 'net:fetch', paths: [] };
  if (toolName.startsWith('mcp__')) return { capability: 'net:api', paths: [] };
  return { capability: `tool:${toolName}`, paths };
}

const RANK: Record<PermissionLevel, number> = { allow: 0, prompt: 1, deny: 2 };
/** A level the rules name; anything else is a misconfiguration and fails closed. */
const level = (value: unknown): PermissionLevel =>
  value === 'allow' || value === 'prompt' || value === 'deny' ? value : 'deny';

/** The strictest level the rules give this call: its capability on each path, or a rule naming the tool. */
export function structuralLevel(
  rules: ToolRules | undefined,
  request: ToolRequest,
): {
  level: PermissionLevel;
  capability: Capability;
  path?: string;
} {
  const { capability, paths } = classifyTool(request);
  const path = paths[0];
  if (!rules) return { level: 'allow', capability, ...(path ? { path } : {}) };
  const policy = {
    defaults: 'allow' as const,
    capabilities: Object.fromEntries(
      Object.entries(rules.capabilities ?? {}).map(([key, value]) => [key, level(value)]),
    ),
    ...(rules.protectedPaths?.length ? { protectedPaths: rules.protectedPaths } : {}),
  };
  const levels = [
    ...(paths.length ? paths : [undefined]).map((p) =>
      permissionLevel(policy, capability, { meta: p ? { path: p } : {} }),
    ),
    policy.capabilities[`tool:${request.toolName}`] ?? 'allow',
  ];
  const strictest = levels.reduce((a, b) => (RANK[b] > RANK[a] ? b : a));
  const hit =
    paths.find((p) => permissionLevel(policy, capability, { meta: { path: p } }) === strictest) ??
    path;
  return { level: strictest, capability, ...(hit ? { path: hit } : {}) };
}

export interface ToolGateDeps {
  threadId: string;
  /** The rules in force now (settings apply live). */
  rules: () => ToolRules | undefined;
  /** The host's mode for this thread. */
  mode: () => PermissionMode | undefined;
  queue?: ActionQueue | null;
  /** The thread's turn in flight, for journal correlation. */
  turnId: () => string | null;
  /** Append one phase row (by its id) to the thread's journal; never throws. */
  journal: (
    id: string,
    phase: 'gate-request' | 'gate-outcome',
    turnId: string | null,
    record: Record<string, unknown>,
  ) => void;
  /** How long an ask waits for an answer before it is rejected; default ASK_TIMEOUT_MS. */
  askTimeoutMs?: number;
}

/** An unanswered ask is rejected after this long, so a thread never waits on no one forever. */
export const ASK_TIMEOUT_MS = 15 * 60_000;

const bounded = (input: Readonly<Record<string, unknown>>) => {
  const text = JSON.stringify(input);
  return text.length <= 4096 ? structuredClone(input) : { omitted: `${text.length} chars` };
};

/** A thread's tool gate: structural rules first (no model call), then asks to the user. */
export function createToolGate(deps: ToolGateDeps): ToolGate {
  // A call the user already approved at `pre-use` is not asked about again by the native mode.
  const approved = new Set<string>();
  return async (request: ToolRequest): Promise<ToolDecision> => {
    const started = performance.now();
    const turnId = deps.turnId();
    const { level, capability, path } = structuralLevel(deps.rules(), request);
    const requestId = newId('phase');
    deps.journal(requestId, 'gate-request', turnId, {
      stage: request.stage,
      toolName: request.toolName,
      ...(request.callId ? { callId: request.callId } : {}),
      ...(request.admissionId ? { admissionId: request.admissionId } : {}),
      capability,
      ...(path ? { path } : {}),
      level,
      mode: deps.mode() ?? null,
    });
    const outcome = (decision: ToolDecision, by: string, extra: Record<string, unknown> = {}) => {
      deps.journal(newId('phase'), 'gate-outcome', turnId, {
        request: requestId,
        decision: decision.behavior,
        by,
        ...(decision.behavior === 'deny' ? { reason: decision.message } : {}),
        elapsedMs: Math.round(performance.now() - started),
        ...extra,
      });
      return decision;
    };

    if (level === 'deny')
      return outcome(
        {
          behavior: 'deny',
          message: `Foundry structural rule denies ${capability}${path ? ` on ${path}` : ''} for ${request.toolName}. This holds in every mode; do not retry it another way.`,
        },
        'structure',
      );
    // The native ask for a call approved at pre-use comes once; the approval is used up by it.
    if (request.stage === 'permission' && request.callId && approved.delete(request.callId))
      return outcome({ behavior: 'allow' }, 'pre-use approval');
    // A pre-use call the rules allow is the runtime's own mode's to decide. A native ask goes to the
    // user: Codex never asks about edits inside the workspace, so in acceptEdits the file changes it
    // does ask about are escalations (outside it, a grant root), which Claude's acceptEdits asks too.
    if (level === 'allow' && request.stage === 'pre-use')
      return outcome({ behavior: 'allow' }, 'mode');
    if (!deps.queue)
      return outcome(
        { behavior: 'deny', message: 'No one can answer this permission request in Foundry.' },
        'no-queue',
      );
    const resolution = await deps.queue.prompt({
      kind: 'approval',
      message: `${request.toolName}${path ? ` on ${path}` : ''}${request.description ? `: ${request.description}` : ''}`,
      agentId: 'artificer',
      threadId: deps.threadId,
      capability,
      urgency: capability === 'exec:shell' ? 'high' : 'normal',
      timeoutMs: deps.askTimeoutMs ?? ASK_TIMEOUT_MS,
      ...(request.signal ? { signal: request.signal } : {}),
      meta: {
        // A structural ask is the user's own rule: never answered by an "always" policy.
        structural: level === 'prompt',
        stage: request.stage,
        toolName: request.toolName,
        toolInput: bounded(request.toolInput),
        ...(request.callId ? { callId: request.callId } : {}),
        ...(turnId ? { turnId } : {}),
        ...(path ? { path } : {}),
      },
    });
    if (resolution.action === 'approved') {
      if (request.callId) approved.add(request.callId);
      return outcome({ behavior: 'allow' }, resolution.by);
    }
    return outcome(
      {
        behavior: 'deny',
        message:
          resolution.by === 'human'
            ? `The user rejected ${request.toolName}.`
            : resolution.by === 'timeout'
              ? `No one answered the permission request for ${request.toolName} within ${Math.round((deps.askTimeoutMs ?? ASK_TIMEOUT_MS) / 1000)}s, so it did not run.`
              : `${request.toolName} was not approved (${resolution.by}).`,
      },
      resolution.by,
    );
  };
}

/** A project's rules over the global ones: its capabilities win, protected paths add up. */
export function rulesFor(
  global: ToolRules | undefined,
  project: ToolRules | undefined,
): ToolRules | undefined {
  if (!global && !project) return undefined;
  const protectedPaths = [...(global?.protectedPaths ?? []), ...(project?.protectedPaths ?? [])];
  return {
    capabilities: { ...global?.capabilities, ...project?.capabilities },
    ...(protectedPaths.length ? { protectedPaths } : {}),
  };
}

/** A thread's gate as the provider holds it: the gate, and whether its rules can deny or ask. */
export interface ThreadToolGate {
  readonly gate: ToolGate;
  /** The thread has structural rules (a deny, a prompt or protected paths) to enforce. */
  hasRules(): boolean;
}

/** Rules that can deny or ask (allow-only rules change nothing). */
export function enforces(rules: ToolRules | undefined): boolean {
  return (
    !!rules?.protectedPaths?.length ||
    Object.values(rules?.capabilities ?? {}).some((level) => level !== 'allow')
  );
}

/** Before a thread's gate can be built (daemon starting, thread unknown): fail closed. */
export const UNBOUND_GATE: ToolGate = () => ({
  behavior: 'deny',
  message:
    "Foundry cannot check this tool call yet (the thread's tool gate is not bound); it did not run.",
});

/**
 * A provider's view of the threads' gates before the viewer exists: each call resolves the
 * thread's one gate at call time, and fails closed until it can.
 */
export function lateBoundToolGate(
  resolve: () => ((threadId: string) => ThreadToolGate) | undefined,
): (threadId: string) => ThreadToolGate {
  return (threadId) => ({
    gate: (request) => (resolve()?.(threadId).gate ?? UNBOUND_GATE)(request),
    hasRules: () => resolve()?.(threadId).hasRules() ?? true,
  });
}
