import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { claudeStatusOnly } from "./helpers/vcr";
import { join } from "node:path";
import { VCR, ProcessCassettes, httpCassettes, webSocketCassettes, checkFreshness, findLeaks, scrubLine, scrubValue, signatureOf, compareSignatures, volatileDifferences, type Fixture, type ProcessTranscript } from "../src/vcr";

const mode = process.env.FOUNDRY_VCR;
const setMode = (value: "record" | "replay") => { process.env.FOUNDRY_VCR = value; };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vcr-"));
  VCR.clearVersionCache();
  VCR.drift = [];
  setMode("record");
});

afterEach(() => {
  if (mode === undefined) delete process.env.FOUNDRY_VCR; else process.env.FOUNDRY_VCR = mode;
  rmSync(dir, { recursive: true, force: true });
});

const read = (name: string) => JSON.parse(readFileSync(join(dir, name), "utf-8")) as Fixture;

describe("VCR (ported)", () => {
  it("captures real result, sanitizes, returns sanitized on first run, and stamps the recording", async () => {
    const vcr = new VCR(dir, { service: "svc", cli: "svc", model: "m", version: () => "1.0.0", sanitizers: { fetch: { keys: ["secret"] } } }).queue("fetch", "default");
    const result = await vcr.capture("fetch", async () => ({ secret: "shh", visible: "hi" }));
    expect(result).toEqual({ secret: "REDACTED", visible: "hi" });
    const saved = read("fetch.default.json");
    expect(saved).toMatchObject({ version: "1.0.0", status: 200, body: { secret: "REDACTED", visible: "hi" }, recorded: { service: "svc", cli: "svc", model: "m", environment: "terminal" } });
    expect(Date.parse(saved.recorded!.recordedAt)).toBeGreaterThan(Date.now() - 60_000);
  });

  it("replay returns the identical sanitized shape and never calls live", async () => {
    const realFn = mock(async () => ({ secret: "shh", visible: "hi" }));
    const opts = { service: "svc", version: () => "1.0.0", sanitizers: { fetch: { keys: ["secret"] } } };
    const first = await new VCR(dir, opts).queue("fetch", "default").capture("fetch", realFn);
    setMode("replay");
    const second = await new VCR(dir, opts).queue("fetch", "default").capture("fetch", realFn);
    expect(first).toEqual(second);
    expect(realFn).toHaveBeenCalledTimes(1);
  });

  it("replay refuses a missing cassette instead of calling live", async () => {
    setMode("replay");
    const realFn = mock(async () => 1);
    await expect(new VCR(dir, { service: "svc", version: () => "1" }).queue("fetch", "absent").capture("fetch", realFn)).rejects.toThrow("bun run test:live");
    expect(realFn).not.toHaveBeenCalled();
  });

  it("throws with body string on replayed error cassette", async () => {
    const v1 = new VCR(dir, { service: "svc", version: () => "1.0.0" }).queue("fetch", "default");
    await expect(v1.capture("fetch", async () => { throw new Error("upstream 500"); })).rejects.toThrow("upstream 500");
    setMode("replay");
    const realFn = mock(async () => "should-not-run");
    await expect(new VCR(dir, { service: "svc", version: () => "1.0.0" }).queue("fetch", "default").capture("fetch", realFn)).rejects.toThrow("upstream 500");
    expect(realFn).not.toHaveBeenCalled();
  });

  it("writes a sidecar for binary bodies and reads it back on replay", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await new VCR(dir, { service: "svc", version: () => "1.0.0", sanitizers: { download: { binaryExtension: ".png" } } }).queue("download", "icon").capture("download", async () => bytes);
    expect(read("download.icon.json").bodyFile).toBe("download.icon.png");
    setMode("replay");
    const replayed = await new VCR(dir, { service: "svc", version: () => "1.0.0" }).queue("download", "icon").capture("download", async () => Buffer.from([0]));
    expect((replayed as Buffer).equals(bytes)).toBe(true);
  });

  it("shares a resolved version across instances of one service; setVersion pre-seeds it", async () => {
    const versionFn = mock(async () => "1.0.0");
    await new VCR(dir, { service: "shared", version: versionFn }).queue("a", "default").capture("a", async () => 1);
    await new VCR(dir, { service: "shared", version: versionFn }).queue("b", "default").capture("b", async () => 2);
    expect(versionFn).toHaveBeenCalledTimes(1);
    VCR.setVersion("preseeded", "forced-1.0");
    const never = mock(async () => "real");
    await new VCR(dir, { service: "preseeded", version: never }).queue("c", "default").capture("c", async () => 1);
    expect(never).not.toHaveBeenCalled();
    expect(read("c.default.json").version).toBe("forced-1.0");
  });

  it("consumes queues FIFO and refuses an unqueued method", async () => {
    const vcr = new VCR(dir, { service: "svc", version: () => "1.0.0" });
    vcr.queue("m", "first").queue("m", "second");
    await vcr.capture("m", async () => 1);
    await vcr.capture("m", async () => 2);
    expect(existsSync(join(dir, "m.first.json")) && existsSync(join(dir, "m.second.json"))).toBe(true);
    expect(vcr.isEmpty()).toBe(true);
    await expect(vcr.capture("unqueued", async () => 1)).rejects.toThrow('VCR: no cassette queued for "unqueued"');
  });

  it("applies a structured transform before key redaction, and per item for arrays", async () => {
    const vcr = new VCR(dir, { service: "svc", version: () => "1.0.0", sanitizers: {
      fetch: { fn: body => ({ ...(body as object), transformed: true }), keys: ["secret"] },
      list: { isArray: true, fn: item => ({ ...(item as object), seen: true }) },
    } }).queue("fetch", "s").queue("list", "l");
    expect((await vcr.captureResponse("fetch", async () => ({ status: 201, body: { secret: "x", visible: "kept" } }))))
      .toEqual({ status: 201, body: { secret: "REDACTED", visible: "kept", transformed: true } });
    expect(await vcr.capture("list", async () => [{ id: 1 }, { id: 2 }])).toEqual([{ id: 1, seen: true }, { id: 2, seen: true }]);
  });
});

describe("live drift", () => {
  it("keeps the committed cassette and writes a pending one when the structure changed", async () => {
    await new VCR(dir, { service: "svc", version: () => "1" }).queue("m", "x").capture("m", async () => ({ a: 1 }));
    await new VCR(dir, { service: "svc", version: () => "1" }).queue("m", "x").capture("m", async () => ({ a: 2 }));
    expect(VCR.drift).toEqual([]);
    expect(read("m.x.json").body).toEqual({ a: 2 });
    await new VCR(dir, { service: "svc", version: () => "1" }).queue("m", "x").capture("m", async () => ({ a: "2", b: true }));
    expect(read("m.x.json").body).toEqual({ a: 2 });
    expect(read("m.x.pending.json").body).toEqual({ a: "2", b: true });
    expect(VCR.drift[0]!.differences).toEqual(["body added a:string, b:boolean", "body removed a:number"]);
  });

  it("an outcome recorded after its transcript drifted is held back with it", async () => {
    await new VCR(dir, { service: "svc", version: () => "1" }).queue("t", "x").queue("outcome", "x").capture("t", async () => ({ a: 1 }))
      .then(() => undefined);
    const first = new VCR(dir, { service: "svc", version: () => "1" }).queue("outcome", "x");
    await first.outcome("outcome", { ok: true });
    const vcr = new VCR(dir, { service: "svc", version: () => "1" }).queue("t", "x").queue("outcome", "x");
    await vcr.capture("t", async () => ({ a: "changed" }));
    await vcr.outcome("outcome", { ok: false });
    expect(read("outcome.x.json").body).toEqual({ ok: true });
    expect(read("outcome.x.pending.json").body).toEqual({ ok: false });
  });
});

describe("drift classification", () => {
  const transcript = (...events: object[]) => signatureOf(0, { kind: "process", argv: ["claude", "--print"], frames: events.map(event => ({ stream: "stdout", data: JSON.stringify(event) })), exit: { code: 0 } });
  const init = { type: "system", subtype: "init", model: "m" }, result = { type: "result", subtype: "success", result: "x" };
  it("treats thinking, rate-limit notices and reconnects as notices, and protocol shape as drift", () => {
    const before = transcript(init, result);
    const noisy = transcript(init, { type: "system", subtype: "thinking_tokens", estimated_tokens: 1 }, { type: "rate_limit_event" }, result);
    expect(compareSignatures(before, noisy)).toEqual([]);
    expect(volatileDifferences(before, noisy)).toEqual(["new stdout:rate_limit_event", "new stdout:system:thinking_tokens"]);
    const changed = transcript({ ...init, model: 1 }, { type: "result", subtype: "error_max_turns" });
    const tool = transcript(init, { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } }, result);
    expect(compareSignatures(transcript(init, { type: "assistant", message: { content: [{ type: "text", text: "x" }] } }, result), tool))
      .toEqual(["missing stdout:assistant:text", "new stdout:assistant:tool_use"]);
    const login = (line: string) => signatureOf(0, { kind: "process", frames: [{ stream: "stderr", data: line, kept: true }], exit: { code: 0 } });
    expect(compareSignatures(login("Logged in using ChatGPT"), login("Logged in using an API key"))).toEqual(["stderr:kept added text:Logged in using an API key", "stderr:kept removed text:Logged in using ChatGPT"]);
    expect(compareSignatures(before, changed)).toEqual(["new stdout:result:error_max_turns", "missing stdout:result:success", "stdout:system:init added model:number", "stdout:system:init removed model:string"]);
  });
});

// A tiny line protocol: each stdin line is answered with one JSON line; `bye` exits 3.
const echo = `for await (const chunk of Bun.stdin.stream()) for (const line of new TextDecoder().decode(chunk).split("\\n").filter(Boolean)) {
  const m = JSON.parse(line); if (m.method === "bye") process.exit(3);
  console.log(JSON.stringify({ id: m.id, result: { echo: m.params, cwd: process.cwd(), home: process.env.HOME } }));
}`;

describe("process cassettes", () => {
  it("record captures stdin/stdout ordering; replay re-emits it, remaps JSON-RPC ids and rehydrates cwd", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "vcr-cwd-"));
    const drive = async (cassettes: ProcessCassettes, from: number, cwdNow: string) => {
      const child = cassettes.spawn([process.execPath, "-e", echo], { cwd: cwdNow, env: { PATH: process.env.PATH } });
      const lines: string[] = [];
      const reading = (async () => { let buffer = ""; for await (const chunk of child.stdout) { buffer += new TextDecoder().decode(chunk); } lines.push(...buffer.split("\n").filter(Boolean)); })();
      child.stdin.write(JSON.stringify({ id: from, method: "ping", params: "one" }) + "\n");
      await Bun.sleep(150);
      child.stdin.write(JSON.stringify({ id: from + 1, method: "ping", params: "two" }) + "\n");
      await Bun.sleep(150);
      child.stdin.write(JSON.stringify({ method: "bye" }) + "\n");
      const code = await child.exited;
      await reading;
      return { code, lines: lines.map(line => JSON.parse(line)) };
    };
    const vcr = new VCR(dir, { service: "echo", version: () => "1" }).queue("session", "ok");
    const live = await drive(new ProcessCassettes(vcr, "session"), 1, cwd);
    await vcr.settled();
    expect(live.code).toBe(3);
    expect(live.lines.map(line => line.id)).toEqual([1, 2]);
    const cassette = read("session.ok.json") as Fixture<ProcessTranscript>;
    expect(cassette.body!.frames.map(frame => frame.after)).toEqual([1, 2]);
    expect(cassette.body!.exit).toEqual({ after: 3, code: 3, killed: false });
    expect(JSON.stringify(cassette)).not.toContain(userInfo().homedir);
    expect(JSON.stringify(cassette)).toContain("{{cwd}}");

    setMode("replay");
    const otherCwd = mkdtempSync(join(tmpdir(), "vcr-cwd-"));
    const replayed = await drive(new ProcessCassettes(vcr.queue("session", "ok"), "session"), 41, otherCwd);
    expect(replayed.code).toBe(3);
    expect(replayed.lines.map(line => line.id)).toEqual([41, 42]);
    expect(replayed.lines.map(line => line.result.echo)).toEqual(["one", "two"]);
    expect(replayed.lines[0].result.cwd).toContain(otherCwd.split("/").at(-1));
    rmSync(cwd, { recursive: true }); rmSync(otherCwd, { recursive: true });
  });

  it("replay refuses a request the recording never saw", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.short.json"), JSON.stringify({ version: "1", status: 0, body: { kind: "process", argv: ["x"], cwd: "{{cwd}}",
      stdin: ['{"id":1,"method":"ping"}'], stdinEnded: false, frames: [], exit: { after: 9, code: 0, killed: false } } }));
    setMode("replay");
    const child = new ProcessCassettes(new VCR(dir, { service: "echo", version: () => "1" }).queue("session", "short"), "session").spawn(["x"], { cwd: dir, env: {} });
    expect(() => child.stdin.write('{"id":1,"method":"other"}\n')).toThrow("stdin line 1 differs from the recording (other vs ping)");
  });

  it("replay compares whole requests, plain text included, and refuses to end short", async () => {
    const cassette = (name: string, stdin: string[]) => writeFileSync(join(dir, `session.${name}.json`), JSON.stringify({ version: "1", status: 0, body: { kind: "process", argv: ["codex", "exec"], cwd: "{{cwd}}",
      stdin, stdinEnded: true, frames: [{ after: 2, stream: "stdout", data: '{"answer":"feature"}' }], exit: { after: 2, code: 0, killed: false } } }));
    cassette("prompt", ["Classify: add a toggle"]); cassette("two", ["first line", "second line"]);
    setMode("replay");
    const vcr = new VCR(dir, { service: "codex", version: () => "1" }).queue("session", "prompt").queue("session", "prompt").queue("session", "two");
    const cassettes = new ProcessCassettes(vcr, "session");
    expect(() => cassettes.spawn(["codex", "exec"], { cwd: dir, env: {} }).stdin.write("Delete the production database")).toThrow("stdin line 1 differs");
    const same = cassettes.spawn(["codex", "exec"], { cwd: dir, env: {} });
    same.stdin.write("Classify: add a toggle"); same.stdin.end();
    expect(await new Response(same.stdout).text()).toBe('{"answer":"feature"}\n');
    const short = cassettes.spawn(["codex", "exec"], { cwd: dir, env: {} });
    short.stdin.write("first line");
    expect(() => short.stdin.end()).toThrow("stdin ended after 1 of 2 recorded lines");
  });

  it("a status probe shared by many tests is recorded once per live run, then replayed", async () => {
    const file = join(dir, "probe.ts"); writeFileSync(file, `console.log(JSON.stringify({ n: Math.random() }))`);
    const vcr = new VCR(dir, { service: "probe", version: () => "1" }).queue("status", "ok").queue("status", "ok");
    const cassettes = new ProcessCassettes(vcr, "status", { argv: [process.execPath, file], recordOnce: true });
    const first = await new Response(cassettes.statusSpawn().stdout).text();
    await vcr.settled();
    const second = await new Response(cassettes.statusSpawn().stdout).text();
    expect(second).toBe(first);
    expect(VCR.liveCalls).toBeGreaterThan(0);
  });

  it("a status probe keeps only what the sanitizer allows and the account never reaches disk", async () => {
    const script = `console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "person@company.com", orgId: "0f8fad5b-d9cb-469f-a165-70867728950e" }, null, 2))`;
    const vcr = new VCR(dir, { service: "probe", version: () => "1" }).queue("status", "ok");
    const file = join(dir, "status.ts"); writeFileSync(file, script);
    const cassettes = new ProcessCassettes(vcr, "status", { argv: [process.execPath, file], sanitize: frames => {
      const status = JSON.parse(frames.filter(f => f.stream === "stdout").map(f => f.data).join("\n"));
      return [{ after: 0, stream: "stdout", data: JSON.stringify({ loggedIn: status.loggedIn, authMethod: status.authMethod }) }];
    } });
    const child = cassettes.statusSpawn("/unused");
    expect(JSON.parse(await new Response(child.stdout).text()).email).toBe("person@company.com");
    await child.exited; await vcr.settled();
    const text = readFileSync(join(dir, "status.ok.json"), "utf8");
    expect(text).not.toContain("company.com"); expect(text).not.toContain("0f8fad5b");
    setMode("replay");
    const replayed = new ProcessCassettes(vcr.queue("status", "ok"), "status", { argv: ["unused"] }).statusSpawn();
    expect(JSON.parse(await new Response(replayed.stdout).text())).toEqual({ loggedIn: true, authMethod: "claude.ai" });
    expect(await replayed.exited).toBe(0);
  });
});

describe("http and websocket cassettes", () => {
  it("records a response with its request, never the credential, and replays it", async () => {
    const server = Bun.serve({ port: 0, fetch: async request => Response.json({ saw: request.headers.get("authorization") ? "credential" : "none", body: await request.json() }, { status: 401 }) });
    try {
      const vcr = new VCR(dir, { service: "api", version: () => "1" }).queue("post", "refused");
      const live = await httpCassettes(vcr, "post")(`http://127.0.0.1:${server.port}/api/v1/access/x`, { method: "POST", headers: { authorization: "Bearer kastle_runtime_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG" }, body: JSON.stringify({ n: 1 }) });
      expect(live.status).toBe(401);
      const text = readFileSync(join(dir, "post.refused.json"), "utf8");
      expect(text).not.toContain("kastle_runtime_abc");
      expect(JSON.parse(text).request).toMatchObject({ method: "POST", path: "/api/v1/access/x", body: { n: 1 } });
      setMode("replay");
      const replayed = await httpCassettes(vcr.queue("post", "refused"), "post")("http://unused.invalid/api/v1/access/x", { method: "POST" });
      expect(replayed.status).toBe(401);
      expect(await replayed.json()).toEqual(await live.json());
      await expect(httpCassettes(vcr.queue("post", "refused"), "post")("http://unused.invalid/api/v1/access/other", { method: "POST" })).rejects.toThrow("was recorded as POST /api/v1/access/x");
    } finally { server.stop(true); }
  });

  it("records server frames against client sends and replays them in order", async () => {
    const server = Bun.serve({ port: 0, fetch(request, s) { return s.upgrade(request) ? undefined : new Response("no", { status: 426 }); },
      websocket: { open(ws) { ws.send(JSON.stringify({ type: "connected" })); }, message(ws, raw) { if (JSON.parse(String(raw)).action === "ping") ws.send(JSON.stringify({ type: "pong" })); } } });
    const session = async (socket: ReturnType<ReturnType<typeof webSocketCassettes>>) => {
      const seen: string[] = [];
      await new Promise<void>(resolve => {
        socket.onmessage = event => {
          seen.push(JSON.parse(String(event.data)).type);
          if (seen.length === 1) socket.send(JSON.stringify({ action: "ping" }));
          else { socket.close(1000); resolve(); }
        };
      });
      return seen;
    };
    try {
      const vcr = new VCR(dir, { service: "ws", version: () => "1" }).queue("socket", "ping");
      expect(await session(webSocketCassettes(vcr, "socket")(`ws://127.0.0.1:${server.port}/`))).toEqual(["connected", "pong"]);
      await Bun.sleep(50); await vcr.settled();
      setMode("replay");
      expect(await session(webSocketCassettes(vcr.queue("socket", "ping"), "socket")("ws://unused.invalid/"))).toEqual(["connected", "pong"]);
    } finally { server.stop(true); }
  });
});

describe("scrubbing and freshness", () => {
  it("scrubs secrets, identity keys, emails and the account home, keeping JSON valid", () => {
    const home = userInfo().homedir;
    const line = scrubLine(JSON.stringify({ cwd: `${home}/code/x`, email: "a@b.co", orgId: "0f8fad5b-d9cb-469f-a165-70867728950e", note: "key sk-ant-api03-abcdefghijklmnop", token: "Bearer abcdefghijkl" }));
    expect(JSON.parse(line)).toEqual({ cwd: "~/code/x", email: "redacted@example.invalid", orgId: "00000000-0000-4000-8000-000000000000", note: "key sk-ant-REDACTED", token: "Bearer REDACTED" });
    expect(findLeaks(line)).toEqual([]);
    expect(findLeaks(JSON.stringify({ path: "/Users/someone/x", orgName: "Acme" }))).toEqual(["home path", "unredacted orgName"]);
    expect(scrubValue({ user_id: "u-1", nested: [{ access_token: "x" }] })).toEqual({ user_id: "REDACTED", nested: [{ access_token: "REDACTED" }] });
  });

  it("redacts everything under an identity key, and finds identity wherever a cassette hides it", () => {
    const nested = { account: { uuid: "0f8fad5b-d9cb-469f-a165-70867728950e", name: "Person", display_name: "P" }, organization: { uuid: "0f8fad5b-d9cb-469f-a165-70867728950e", name: "Acme" }, model: "m" };
    expect(scrubValue(nested)).toEqual({ account: { uuid: "00000000-0000-4000-8000-000000000000", name: "REDACTED", display_name: "REDACTED" },
      organization: { uuid: "00000000-0000-4000-8000-000000000000", name: "REDACTED" }, model: "m" });
    expect(findLeaks(JSON.stringify({ body: nested }))).toContain("unredacted name");
    const embedded = JSON.stringify({ frames: [{ data: `Update available\n{"loggedIn":true,"orgId":"0f8fad5b-d9cb-469f-a165-70867728950e","orgName":"Acme Secret Corp"}` }] });
    expect(findLeaks(embedded)).toEqual(expect.arrayContaining(["unredacted orgId", "unredacted orgName"]));
  });

  it("an auth status that does not parse is withheld whole, never kept as text", () => {
    const frames = [{ after: 0, stream: "stdout" as const, data: "Update available" }, { after: 0, stream: "stdout" as const, data: '{"loggedIn":true,"orgName":"Acme"}' }];
    expect(claudeStatusOnly(frames)).toEqual([{ after: 0, stream: "stdout", data: "VCR: unparseable auth status withheld" }]);
  });

  it("fails cassettes that are old, recorded on an older CLI or agent-session, leaking, or pending review", () => {
    const now = Date.parse("2026-09-24T00:00:00Z");
    writeFileSync(join(dir, "policy.json"), JSON.stringify({ maxAgeDays: 14, blessed: { claude: "2.1.281", "@inixiative/agent-session": "0.2.0" } }));
    const cassette = (name: string, recordedAt: string, version: string, extra: object = {}) => writeFileSync(join(dir, name), JSON.stringify({ version, status: 0, body: {},
      recorded: { service: "claude", cli: "claude", recordedAt, environment: "terminal", agentSession: "0.2.0" }, ...extra }));
    cassette("fresh.json", "2026-09-20T00:00:00Z", "2.1.281");
    cassette("old.json", "2026-09-01T00:00:00Z", "2.1.281");
    cassette("under-blessed.json", "2026-09-20T00:00:00Z", "2.1.200");
    cassette("under-installed.json", "2026-09-20T00:00:00Z", "2.1.281");
    cassette("leak.json", "2026-09-20T00:00:00Z", "2.1.290", { body: { path: "/Users/someone" } });
    cassette("x.pending.json", "2026-09-20T00:00:00Z", "2.1.281");
    const findings = checkFreshness(dir, { now, installed: { claude: "2.1.282" }, agentSession: "0.3.0" });
    const problems = (name: string) => findings.filter(f => f.cassette === name).map(f => f.problem);
    expect(problems("old.json")).toContain("recorded 23 days ago; the limit is 14");
    expect(problems("under-blessed.json")).toContain("recorded on claude 2.1.200; blessed is 2.1.281");
    expect(problems("under-installed.json")).toContain("recorded on claude 2.1.281; installed is 2.1.282");
    expect(problems("fresh.json")).toContain("recorded through agent-session 0.2.0; installed is 0.3.0");
    expect(problems("leak.json")).toContain("contains home path");
    expect(problems("x.pending.json")[0]).toContain("unreviewed live drift");
    expect(checkFreshness(dir, { now, installed: { claude: "2.1.281" }, agentSession: "0.2.0" }).map(f => f.cassette).filter((c, i, all) => all.indexOf(c) === i).sort()).toEqual(["leak.json", "old.json", "under-blessed.json", "x.pending.json"]);
  });
});
