import { expect, test } from "bun:test";
import { releaseAll } from "./helpers/release-all";
test("unresolved cleanup is bounded and never prevents remaining owned cleanup", async () => {
  let next = false;
  const failures = await releaseAll([["hung", () => new Promise(() => {})], ["next", () => { next = true; }]], 5);
  expect(next).toBe(true); expect(failures[0]).toContain("resource outcome unresolved");
});

test("releaseAll runs every step in order, skips absent handles and records failures without throwing", async () => {
  const order: string[] = [];
  const failures = await releaseAll([
    ["browser", () => { order.push("browser"); throw new Error("close exploded"); }],
    ["server", undefined],
    ["fixture", async () => { order.push("fixture"); }],
    ["temp", () => { order.push("temp"); return Promise.reject(new Error("rm failed")); }],
  ]);
  expect(order).toEqual(["browser", "fixture", "temp"]);
  expect(failures).toEqual(["browser: close exploded", "temp: rm failed"]);
});
