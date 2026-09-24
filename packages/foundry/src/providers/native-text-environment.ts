export function nativeTextEnvironment(input: Record<string, string | undefined>) {
  const keys = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "SHELL", "LANG", "LC_ALL", "TERM", "CI", "CLAUDE_CONFIG_DIR", "CODEX_HOME",
    // Native compaction policy set by claude-context-budget; not credentials.
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW", "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"];
  return Object.fromEntries(keys.filter(key => input[key] !== undefined).map(key => [key, input[key]!]));
}
