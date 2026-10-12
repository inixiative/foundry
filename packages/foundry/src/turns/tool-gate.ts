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

/** The capability a native tool call exercises, and the path it touches when it names one. */
export function classifyTool(
  request: Pick<ToolRequest, 'toolName' | 'toolInput' | 'blockedPath'>,
): {
  capability: Capability;
  path?: string;
} {
  const { toolName, toolInput } = request;
  const path =
    request.blockedPath ??
    PATH_KEYS.map((key) => toolInput[key]).find(
      (value): value is string => typeof value === 'string',
    );
  if (SHELL.has(toolName)) return { capability: 'exec:shell', ...(path ? { path } : {}) };
  if (WRITE.has(toolName)) return { capability: 'file:write', ...(path ? { path } : {}) };
  if (READ.has(toolName)) return { capability: 'file:read', ...(path ? { path } : {}) };
  if (FETCH.has(toolName)) return { capability: 'net:fetch' };
  if (toolName.startsWith('mcp__')) return { capability: 'net:api' };
  return { capability: `tool:${toolName}` };
}

const RANK: Record<PermissionLevel, number> = { allow: 0, prompt: 1, deny: 2 };

/** The strictest level the rules give this call: its capability, or a rule naming the tool. */
export function structuralLevel(
  rules: ToolRules | undefined,
  request: ToolRequest,
): {
  level: PermissionLevel;
  capability: Capability;
  path?: string;
} {
  const { capability, path } = classifyTool(request);
  if (!rules) return { level: 'allow', capability, ...(path ? { path } : {}) };
  const policy = {
    defaults: 'allow' as const,
    capabilities: rules.capabilities ?? {},
    ...(rules.protectedPaths?.length ? { protectedPaths: rules.protectedPaths } : {}),
  };
  const levels = [
    permissionLevel(policy, capability, { meta: path ? { path } : {} }),
    rules.capabilities?.[`tool:${request.toolName}`] ?? 'allow',
  ];
  const level = levels.reduce((a, b) => (RANK[b] > RANK[a] ? b : a));
  return { level, capability, ...(path ? { path } : {}) };
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
}

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
    if (request.stage === 'permission' && request.callId && approved.has(request.callId))
      return outcome({ behavior: 'allow' }, 'pre-use approval');
    // A pre-use call the rules allow is the runtime's own mode's to decide.
    if (level === 'allow' && request.stage === 'pre-use')
      return outcome({ behavior: 'allow' }, 'mode');
    // Codex asks about file changes in acceptEdits; that mode accepts them.
    if (level === 'allow' && deps.mode() === 'acceptEdits' && capability === 'file:write')
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
      ...(request.signal ? { signal: request.signal } : {}),
      meta: {
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
