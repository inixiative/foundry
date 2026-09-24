export function nativeTextEnvironment(input: Record<string, string | undefined>) {
  const keys = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "SHELL", "LANG", "LC_ALL", "TERM", "CI", "CLAUDE_CONFIG_DIR"];
  return Object.fromEntries(keys.filter(key => input[key] !== undefined).map(key => [key, input[key]!]));
}
