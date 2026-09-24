import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { replayRetrieval } from "../../../scripts/check-native-retrieval-replay";

async function fixture(agents: number, finished = true) {
  const path = await mkdtemp(join(tmpdir(), "foundry-replay-"));
  await mkdir(join(path, "state"));
  const db = new Database(join(path, "state/sessions.sqlite"), { create: true });
  db.exec("CREATE TABLE session_messages(seq INTEGER, turn_id TEXT, actor TEXT, record TEXT); CREATE TABLE session_native(seq INTEGER, turn_id TEXT, record TEXT); CREATE TABLE session_native_tools(seq INTEGER, turn_id TEXT, record TEXT, publication TEXT)");
  for (let i = 0; i < agents; i++) db.query("INSERT INTO session_messages VALUES(?, ?, ?, ?)")
    .run(i, `turn-${i}`, "agent", JSON.stringify({ meta: { persistence: "committed" } }));
  db.close();
  await writeFile(join(path, "report.json"), JSON.stringify({ plan: { retrieval: true },
    turns: [{ http: 200 }, { http: 200 }], writes: 2, spawns: 1,
    finishedAt: finished ? "controlled-finished" : undefined, ownedExit: finished }));
  return { path, close: () => rm(path, { recursive: true, force: true }) };
}

test("saved replay refuses an unfinished capture", async () => {
  const f = await fixture(2, false);
  try { await expect(replayRetrieval(f.path)).rejects.toThrow("completed two-admission"); }
  finally { await f.close(); }
});

test("saved replay refuses missing persisted admissions", async () => {
  const f = await fixture(0);
  try { await expect(replayRetrieval(f.path)).rejects.toThrow("exactly two distinct"); }
  finally { await f.close(); }
});

test("saved replay does not accept report counters in place of actual native evidence", async () => {
  const f = await fixture(2);
  try {
    const result = await replayRetrieval(f.path);
    expect(result.passed).toBe(false);
    expect(result.stable).toBe(true);
    expect(result.nativeCalls).toBe(0);
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0].valid).toBe(false);
  } finally { await f.close(); }
});
