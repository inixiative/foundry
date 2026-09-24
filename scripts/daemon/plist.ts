/**
 * LaunchAgent plist generation — pure, so it can be tested without touching disk.
 */

export const DAEMON_LABEL = "com.inixiative.foundry";

export interface PlistOptions {
  repoRoot: string;
  bunPath: string;
  logDir: string;
  port: number;
  /** Prepended to PATH so the supervisor can find bun, git and the agent CLIs. */
  pathEntries: string[];
  /** Seconds launchd waits before relaunching; also caps crash-loop rate. */
  throttleSeconds?: number;
  /** A one-shot job in the daemon's exact environment (the launchd smoke): its own label and
   * program, not kept alive, logging where it is told. Everything else is the daemon's. */
  job?: { label: string; programArguments: string[]; environment?: Record<string, string>; stdoutPath: string; stderrPath: string };
}

const escape = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

export const buildPlist = (options: PlistOptions): string => {
  const { repoRoot, bunPath, logDir, port, pathEntries, job } = options;
  const throttle = options.throttleSeconds ?? 10;
  const supervisor = `${repoRoot}/scripts/daemon/supervisor.ts`;
  const program = job?.programArguments ?? [bunPath, "run", supervisor];
  const extra = Object.entries(job?.environment ?? {})
    .map(([key, value]) => `\n    <key>${escape(key)}</key>\n    <string>${escape(value)}</string>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escape(job?.label ?? DAEMON_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${program.map(arg => `    <string>${escape(arg)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${escape(repoRoot)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <${job ? "false" : "true"}/>
  <key>ThrottleInterval</key>
  <integer>${throttle}</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${escape(job?.stdoutPath ?? `${logDir}/foundry.out.log`)}</string>
  <key>StandardErrorPath</key>
  <string>${escape(job?.stderrPath ?? `${logDir}/foundry.err.log`)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escape(pathEntries.join(":"))}</string>
    <key>VIEWER_PORT</key>
    <string>${port}</string>
    <key>FOUNDRY_DAEMON</key>
    <string>1</string>${extra}
  </dict>
</dict>
</plist>
`;
};
