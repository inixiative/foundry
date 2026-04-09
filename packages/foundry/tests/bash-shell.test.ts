import { describe, test, expect } from "bun:test";
import { BashShell } from "../src/tools/bash-shell";

const shell = new BashShell({ cwd: "/tmp" });

describe("BashShell", () => {
  test("has correct metadata", () => {
    expect(shell.id).toBe("bash");
    expect(shell.kind).toBe("shell");
    expect(shell.capability).toBe("exec:shell");
  });

  test("executes simple command", async () => {
    const result = await shell.exec("echo hello");
    expect(result.ok).toBe(true);
    expect(result.data?.stdout.trim()).toBe("hello");
    expect(result.data?.exitCode).toBe(0);
    expect(result.data?.durationMs).toBeGreaterThan(0);
  });

  test("returns exit code for failed commands", async () => {
    const result = await shell.exec("exit 42");
    expect(result.ok).toBe(false);
    expect(result.data?.exitCode).toBe(42);
  });

  test("captures stderr", async () => {
    const result = await shell.exec("echo err >&2 && exit 1");
    expect(result.ok).toBe(false);
    expect(result.data?.stderr).toContain("err");
  });

  test("reads real files", async () => {
    const result = await shell.exec("cat /etc/hostname 2>/dev/null || echo ok");
    expect(result.ok).toBe(true);
    expect(result.data?.stdout.trim().length).toBeGreaterThan(0);
  });

  test("respects cwd", async () => {
    const result = await shell.exec("pwd");
    expect(result.ok).toBe(true);
    // macOS symlinks /tmp → /private/tmp
    expect(result.data?.stdout.trim()).toMatch(/\/?tmp$/);
  });

  test("can override cwd per call", async () => {
    const result = await shell.exec("pwd", { cwd: "/" });
    expect(result.ok).toBe(true);
    expect(result.data?.stdout.trim()).toBe("/");
  });

  test("applies output filter", async () => {
    const filter = (stdout: string) => stdout.toUpperCase();
    const filtered = new BashShell({ outputFilter: filter });
    const result = await filtered.exec("echo hello");
    expect(result.ok).toBe(true);
    expect(result.data?.stdout.trim()).toBe("HELLO");
  });

  test("run() returns stdout directly", async () => {
    const output = await shell.run("echo world");
    expect(output.trim()).toBe("world");
  });

  test("run() throws on failure", async () => {
    expect(shell.run("exit 1")).rejects.toThrow();
  });

  test("which() finds real commands", async () => {
    const path = await shell.which("ls");
    expect(path).not.toBeNull();
    expect(path).toContain("ls");
  });

  test("which() returns null for missing commands", async () => {
    const path = await shell.which("definitely_not_a_command_12345");
    expect(path).toBeNull();
  });

  test("handles git commands", async () => {
    const projectShell = new BashShell({ cwd: process.cwd() });
    const result = await projectShell.exec("git rev-parse --short HEAD");
    expect(result.ok).toBe(true);
    expect(result.data?.stdout.trim().length).toBeGreaterThan(0);
  });

  test("custom id", () => {
    const custom = new BashShell({ id: "project-shell" });
    expect(custom.id).toBe("project-shell");
  });

  test("summary includes command and timing", async () => {
    const result = await shell.exec("echo test");
    expect(result.summary).toContain("echo test");
    expect(result.summary).toContain("ms");
  });
});
