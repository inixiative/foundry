import { expect, spyOn, test } from "bun:test";
import { acquireOwnedBrowser, systemProcessControl, type OwnedBrowserDriver } from "../../../scripts/owned-browser";

test("an unrelated replacement at the old browser PID must never receive fallback termination", async () => {
  const pid = 424242;
  let occupant: string = "browser";
  const signals: Array<{ pid: number; occupant: string }> = [];
  // Controlled process table only. The original exits during graceful close;
  // its PID is reused before the next liveness check. No OS calls are made.
  const driver: OwnedBrowserDriver = {
    async launch() {
      return {
        isConnected: () => occupant === "browser",
        async close() { occupant = "replacement"; },
        async newPage() { throw Error("No page requested"); },
        async newBrowserCDPSession() {
          return {
            async send() { return { processInfo: [{ type: "browser", id: pid }] }; },
            async detach() {},
          };
        },
      };
    },
  };
  const owned = await acquireOwnedBrowser({
    driver,
    control: {
      alive: candidate => candidate === pid,
      terminate(candidate) {
        signals.push({ pid: candidate, occupant });
        throw Error("Controlled process table refused signaling the replacement");
      },
    },
    budgets: { launchMs: 100, readinessMs: 100, closeMs: 5, terminateMs: 5 },
  });
  const result = await owned.close();
  expect(occupant).toBe("replacement");
  expect(result.exitConfirmed).toBe(false);
  expect(signals).toEqual([]);
});

test("an unexpected OS liveness error is not evidence that the browser exited", () => {
  const probe = spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(Error("Controlled liveness probe failure"), { code: "EINVAL" });
  });
  try {
    expect(() => systemProcessControl.alive(424242)).toThrow("Controlled liveness probe failure");
    expect(probe).toHaveBeenCalledWith(424242, 0);
  } finally { probe.mockRestore(); }
});
