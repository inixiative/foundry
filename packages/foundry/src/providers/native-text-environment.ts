/**
 * @atlas
 * @kind service
 * @partOf primitive:nativeSessions
 */
/** The environment after a launch bound it: the allowlist plus the subscription token the binding itself set. */
export function boundLaunchEnvironment(input: Record<string, string | undefined>) {
  return {
    ...nativeTextEnvironment(input),
    ...(input.CLAUDE_CODE_OAUTH_TOKEN
      ? { CLAUDE_CODE_OAUTH_TOKEN: input.CLAUDE_CODE_OAUTH_TOKEN }
      : {}),
  };
}

export function nativeTextEnvironment(input: Record<string, string | undefined>) {
  const keys = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'TMPDIR',
    'SHELL',
    'LANG',
    'LC_ALL',
    'TERM',
    'CI',
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
    // Native compaction policy set by claude-context-budget; not credentials.
    'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
    'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
    // Foundry composes instruction files itself (prompts/instruction-stack.ts); not credentials.
    'CLAUDE_CODE_DISABLE_CLAUDE_MDS',
    // In-session Wardens raise the main session's subagent cap (agent-session ClaudeInSessionDecisions).
    'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS',
    // The CLI's thinking budget, set by an eval that measures Wardens with more thinking; not credentials.
    'MAX_THINKING_TOKENS',
  ];
  return Object.fromEntries(
    keys.filter((key) => input[key] !== undefined).map((key) => [key, input[key]!]),
  );
}
