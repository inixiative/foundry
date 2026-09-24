import { expect, test, spyOn } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectReadiness } from "../src/readiness";
import { defaultConfig, ConfigStore } from "../src/viewer/config";
import { resolveProjectView } from "../src/viewer/config-resolve";

function team() {
  const config = defaultConfig();
  config.apiTokens = true; // OpenAI experts
  config.layers.docs = { id: "docs", domain: "docs", segment: "domain-knowledge", prompt: "PRIVATE_CORPUS", writers: ["expert"], sourceIds: [], staleness: 0, enabled: true };
  config.agents.worker = { id: "worker", kind: "executor", prompt: "PRIVATE_WORKER", visibleLayers: [], peers: [], maxDepth: 1, enabled: true };
  config.agents.expert = { id: "expert", kind: "decider", flowRole: "domain-advising", domain: "docs", prompt: "PRIVATE_EXPERT", provider: "openai", model: "configured-model", tools: false, visibleLayers: ["docs"], ownedLayers: ["docs"], peers: [], maxDepth: 1, enabled: true };
  config.projects.P = { id: "P", path: "/tmp/example" };
  return config;
}
const local = { environment: { OPENAI_API_KEY: "PRIVATE_KEY" }, which: () => "/controlled/cli" };
test("the team example loads through production configuration with four separately owned experts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "foundry-team-example-")), home = process.env.HOME;
  // Hermetic default login locations; readiness checks ~/.claude and ~/.codex in subscription mode.
  process.env.HOME = directory;
  for (const profile of [".claude", ".codex"]) await mkdir(join(directory, profile), { mode: 0o700 });
  try {
    await writeFile(join(directory, "settings.json"), await readFile(join(import.meta.dir, "../../../examples/domain-team.settings.json")));
    const config = await new ConfigStore(directory).load();
    const report = await inspectReadiness(config, local);
    expect(report.configurationReady).toBe(true);
    expect(report.issues).toEqual([]);
    const projectId = Object.keys(config.projects)[0]!;
    expect(projectId).toMatch(/^[a-f0-9-]{36}$/);
    const experts = report.profiles.filter(profile => profile.scope === projectId && profile.domain);
    expect(experts.map(profile => profile.domain).sort()).toEqual(["architecture", "docs", "security", "testing"]);
    expect(new Set(experts.map(profile => profile.layerId)).size).toBe(4);
    const effective = resolveProjectView(config, projectId)!.config;
    for (const layer of Object.values(effective.layers)) {
      for (const source of layer.sourceIds) expect(effective.sources[source]?.enabled).toBe(true);
    }
    expect(report.profiles.find(profile => profile.role === "execution")?.provider).toBe("claude-code");
    expect(report.profiles.filter(profile => profile.role !== "execution").every(profile => profile.provider === "subscription-decisions" && profile.model === "gpt-5.6-luna")).toBe(true);
    process.env.HOME = join(directory, "absent");
    expect((await inspectReadiness(config, local)).issues.map(item => item.code)).toEqual(["subscription-profile-unavailable", "subscription-profile-unavailable"]);
  } finally { process.env.HOME = home; await rm(directory, { recursive: true, force: true }); }
});
test("readiness resolves effective experts without dispatch, loading corpus or exposing secrets", async () => {
  const config = team(), before = JSON.stringify(config);
  const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(() => { throw Error("No network allowed"); }, { preconnect: globalThis.fetch.preconnect }));
  try {
    const report = await inspectReadiness(config, local);
    expect(report.configurationReady).toBe(true); expect(report.liveAccess).toBe("unverified");
    expect(report.profiles).toContainEqual({ scope: "P", agentId: "expert", role: "domain-advising", provider: "openai", model: "configured-model", domain: "docs", layerId: "docs" });
    expect(JSON.stringify(report)).not.toContain("PRIVATE_"); expect(JSON.stringify(config)).toBe(before); expect(fetch).not.toHaveBeenCalled();
  } finally { fetch.mockRestore(); }
});
test("readiness catches project-only expert ownership errors and unavailable providers", async () => {
  const config = team(); config.projects.P!.layers = { docs: { writers: { replace: ["wrong-owner"] } } };
  let report = await inspectReadiness(config, local);
  expect(report.configurationReady).toBe(false); expect(report.issues.some(item => item.scope === "P" && item.code === "invalid-expert-ownership")).toBe(true);
  delete config.projects.P!.layers; config.agents.expert!.provider = "anthropic";
  report = await inspectReadiness(config, { ...local, environment: { ...local.environment, ANTHROPIC_API_KEY: "PRIVATE_SECOND" } });
  expect(report.issues.some(item => item.code === "provider-not-constructed")).toBe(true);
});
test("readiness distinguishes missing native binaries and API credentials", async () => {
  const report = await inspectReadiness(team(), { environment: {}, which: () => null });
  expect(report.configurationReady).toBe(false);
  expect(report.issues.some(item => item.code === "native-cli-missing")).toBe(true);
  expect(report.issues.some(item => item.code === "provider-credential-missing")).toBe(true);
  expect(report.issues.some(item => item.code === "provider-not-constructed")).toBe(false);
});
test("Kastle inspection enforces the same private-file schema as launch and never claims live access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "foundry-readiness-"));
  try {
    const file = join(directory, "installation.json"), secret = `kastle_runtime_${"a".repeat(43)}`;
    const config = team(), id = crypto.randomUUID();
    config.kastles = [{ id, url: "http://127.0.0.1:1", credentialFile: file, selection: { model: "exact-model", effort: "low" } }]; config.defaults.kastleId = id; config.apiTokens = true;
    await writeFile(file, JSON.stringify({ secret }), { mode: 0o600 });
    const before = await readFile(file, "utf8"), inventory = await readdir(directory);
    const report = await inspectReadiness(config, local);
    expect(report.configurationReady).toBe(true); expect(report.issues.some(item => item.code === "kastle-access-unverified")).toBe(true);
    expect(JSON.stringify(report)).not.toContain(secret); expect(await readFile(file, "utf8")).toBe(before); expect(await readdir(directory)).toEqual(inventory);
    await writeFile(file, JSON.stringify({ secret, unexpected: true }));
    expect((await inspectReadiness(config, local)).configurationReady).toBe(false);
    config.projects.P!.defaults = { kastleId: crypto.randomUUID() };
    expect((await inspectReadiness(config, local)).issues.some(item => item.code === "project-authentication-override")).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("doctor handles missing settings without creating a directory or starting services", async () => {
  const directory = await mkdtemp(join(tmpdir(), "foundry-doctor-"));
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/doctor.ts"), join(directory, "absent")], { stdout: "pipe", stderr: "pipe" });
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(code).toBe(1); expect(JSON.parse(stdout).issues[0].code).toBe("settings-unavailable"); expect(await readdir(directory)).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("readiness refuses wrong-runtime sources and missing or non-executable helpers without invoking them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "foundry-helper-check-"));
  try {
    const config = team(), sourceId = crypto.randomUUID(), helper = join(directory, "helper");
    config.nativeAuthentication = [{ id: sourceId, connectionId: crypto.randomUUID(), runtime: "codex", mode: "gateway", baseUrl: "http://127.0.0.1:1", credential: { type: "command", command: helper } }];
    config.defaults.nativeAuthenticationId = sourceId; config.apiTokens = true;
    const missing = await inspectReadiness(config, local);
    expect(missing.issues.some(item => item.code === "native-runtime-mismatch")).toBe(true);
    expect(missing.issues.some(item => item.code === "gateway-helper-unavailable")).toBe(true);
    config.nativeAuthentication[0]!.runtime = "claude";
    await writeFile(helper, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
    expect((await inspectReadiness(config, local)).configurationReady).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
