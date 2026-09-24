import { describe, expect, test } from "bun:test";
import { buildPlist, DAEMON_LABEL } from "./plist";

const options = {
  repoRoot: "/Users/x/code/foundry",
  bunPath: "/opt/homebrew/bin/bun",
  logDir: "/Users/x/Library/Logs/foundry",
  port: 4400,
  pathEntries: ["/opt/homebrew/bin", "/usr/bin"],
};

describe("buildPlist", () => {
  test("runs the supervisor, not start.ts directly", () => {
    const plist = buildPlist(options);
    expect(plist).toContain("/Users/x/code/foundry/scripts/daemon/supervisor.ts");
    expect(plist).not.toContain("packages/foundry/src/start.ts");
  });

  test("survives logout and restarts on exit", () => {
    const plist = buildPlist(options);
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
  });

  test("throttles relaunch so a broken build cannot spin", () => {
    expect(buildPlist(options)).toContain("<key>ThrottleInterval</key>\n  <integer>10</integer>");
    expect(buildPlist({ ...options, throttleSeconds: 30 })).toContain("<integer>30</integer>");
  });

  test("runs unthrottled, because the operator waits on its viewer and agent work", () => {
    expect(buildPlist(options)).toContain("<key>ProcessType</key>\n  <string>Interactive</string>");
  });

  test("carries PATH so the supervisor can find bun and git", () => {
    expect(buildPlist(options)).toContain("<string>/opt/homebrew/bin:/usr/bin</string>");
  });

  test("escapes XML metacharacters in paths", () => {
    const plist = buildPlist({ ...options, repoRoot: "/Users/x/co<de>&more" });
    expect(plist).toContain("/Users/x/co&lt;de&gt;&amp;more");
    expect(plist).not.toContain("co<de>");
  });

  test("labels the agent consistently", () => {
    expect(buildPlist(options)).toContain(`<string>${DAEMON_LABEL}</string>`);
  });
});
