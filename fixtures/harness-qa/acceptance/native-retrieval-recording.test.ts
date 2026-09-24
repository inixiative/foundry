import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { replayRetrieval } from "../../../scripts/check-native-retrieval-replay";

// Explicit saved-public-capture integration, never a model call. Ordinary
// source checkouts need not contain the supervisor's private QA recordings.
const capture = process.env.FOUNDRY_QA_RETRIEVAL_CAPTURE;
test.skipIf(!capture)("recording replay preserves sidecars and refuses contradictory second-admission evidence", async () => {
  const path = await mkdtemp(join(tmpdir(), "foundry-recording-control-"));
  try {
    await cp(capture!, path, { recursive: true });
    const valid = await replayRetrieval(path);
    expect(valid.passed).toBe(true);
    expect(valid.nativeCalls).toBe(0);
    expect(Object.keys(valid.before).some(key => key.endsWith("-shm"))).toBe(true);
    expect(valid.after).toEqual(valid.before);
    const db = new Database(join(path, "state/sessions.sqlite"));
    try {
      const rows = db.query("SELECT seq, record FROM session_native WHERE turn_id = ? ORDER BY seq")
        .all(valid.turns[1].turnId) as Array<{ seq: number; record: string }>;
      const row = rows.find(row => JSON.parse(row.record).kind === "tool_result");
      expect(row).toBeDefined();
      const event = JSON.parse(row!.record);
      event.admissionId = "foreign-admission";
      db.query("UPDATE session_native SET record = ? WHERE seq = ?").run(JSON.stringify(event), row!.seq);
    } finally { db.close(); }
    const invalid = await replayRetrieval(path);
    expect(invalid.passed).toBe(false);
    expect(invalid.stable).toBe(true);
    expect(invalid.integrity).toContain("authenticate capture hashes separately");
    expect(invalid.turns).toHaveLength(2);
    expect(invalid.turns[0].valid).toBe(true);
    expect(invalid.turns[1].valid).toBe(false);
    expect(JSON.stringify(invalid.turns[1].diagnostics)).toContain("owner-tuple");
  } finally { await rm(path, { recursive: true, force: true }); }
});
