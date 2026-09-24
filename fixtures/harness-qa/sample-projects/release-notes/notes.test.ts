import { expect, test } from "bun:test";
import { parseChanges, renderNotes } from "./notes";

test("renders changes in source order", () => {
  expect(renderNotes(parseChanges('[{"kind":"fixed","text":" Retry recovery "},{"kind":"added","text":"History"}]')))
    .toBe("# Release Notes\n\n- fixed: Retry recovery\n- added: History\n");
});

test("empty release is valid", () => {
  expect(renderNotes(parseChanges("[]"))).toBe("# Release Notes\n\n");
});

test("invalid input is rejected", () => {
  for (const input of ["{", "null", "{}", "[null]", '[{"kind":"other","text":"a"}]', '[{"kind":"fixed","text":""}]', '[{"kind":"fixed","text":"a\\nb"}]']) {
    expect(() => parseChanges(input)).toThrow();
  }
});

test("CLI reports malformed data as failure", async () => {
  const process = Bun.spawn(["bun", "notes.ts", "missing-input.json"], {
    cwd: import.meta.dir, stdout: "pipe", stderr: "pipe",
  });
  const output = await new Response(process.stdout).text();
  expect(await process.exited).toBe(1);
  expect(output).toBe("");
});
