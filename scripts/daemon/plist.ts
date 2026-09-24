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
}

const escape = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

export const buildPlist = (options: PlistOptions): string => {
  const { repoRoot, bunPath, logDir, port, pathEntries } = options;
  const throttle = options.throttleSeconds ?? 10;
  const supervisor = `${repoRoot}/scripts/daemon/supervisor.ts`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DAEMON_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escape(bunPath)}</string>
    <string>run</string>
    <string>${escape(supervisor)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escape(repoRoot)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>${throttle}</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${escape(logDir)}/foundry.out.log</string>
  <key>StandardErrorPath</key>
  <string>${escape(logDir)}/foundry.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escape(pathEntries.join(":"))}</string>
    <key>VIEWER_PORT</key>
    <string>${port}</string>
    <key>FOUNDRY_DAEMON</key>
    <string>1</string>
  </dict>
</dict>
</plist>
`;
};
