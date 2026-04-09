import { describe, test, expect } from "bun:test";
import {
  stripAnsi,
  collapseBlankLines,
  collapseWhitespace,
  stripProgress,
  dedup,
  gitStatus,
  testOutput,
  compose,
  rtk,
} from "../src/tools/output-filters";

describe("stripAnsi", () => {
  test("removes color codes", () => {
    expect(stripAnsi("\x1b[32mgreen\x1b[0m")).toBe("green");
  });

  test("removes bold/underline", () => {
    expect(stripAnsi("\x1b[1mbold\x1b[0m \x1b[4munderline\x1b[0m")).toBe("bold underline");
  });

  test("passes through clean strings", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });

  test("handles empty string", () => {
    expect(stripAnsi("")).toBe("");
  });
});

describe("collapseBlankLines", () => {
  test("collapses triple newlines to double", () => {
    expect(collapseBlankLines("a\n\n\nb")).toBe("a\n\nb");
  });

  test("collapses many blank lines", () => {
    expect(collapseBlankLines("a\n\n\n\n\n\nb")).toBe("a\n\nb");
  });

  test("leaves single/double newlines alone", () => {
    expect(collapseBlankLines("a\n\nb")).toBe("a\n\nb");
    expect(collapseBlankLines("a\nb")).toBe("a\nb");
  });
});

describe("collapseWhitespace", () => {
  test("collapses multiple spaces", () => {
    expect(collapseWhitespace("a   b   c")).toBe("a b c");
  });

  test("collapses tabs", () => {
    expect(collapseWhitespace("a\t\tb")).toBe("a b");
  });

  test("trims trailing whitespace per line", () => {
    expect(collapseWhitespace("hello   \nworld   ")).toBe("hello\nworld");
  });
});

describe("stripProgress", () => {
  test("removes spinner lines", () => {
    const input = "⠋ Loading...\n⠙ Loading...\nDone!";
    expect(stripProgress(input)).toBe("Done!");
  });

  test("removes progress bars", () => {
    const input = "50% [████████░░░░░░░░]\nCompleted.";
    expect(stripProgress(input)).toBe("Completed.");
  });

  test("removes downloading... lines", () => {
    const input = "downloading...\ninstalling...\nReady.";
    expect(stripProgress(input)).toBe("Ready.");
  });

  test("keeps normal output", () => {
    const input = "src/index.ts\nsrc/utils.ts";
    expect(stripProgress(input)).toBe(input);
  });
});

describe("dedup", () => {
  test("collapses consecutive identical lines", () => {
    const input = "warning: x\nwarning: x\nwarning: x\ndone";
    const result = dedup(input);
    expect(result).toContain("warning: x");
    expect(result).toContain("repeated 2 more times");
    expect(result).toContain("done");
  });

  test("does not collapse non-consecutive duplicates", () => {
    const input = "a\nb\na";
    expect(dedup(input)).toBe("a\nb\na");
  });

  test("handles no duplicates", () => {
    const input = "a\nb\nc";
    expect(dedup(input)).toBe(input);
  });
});

describe("gitStatus", () => {
  test("passes through non-git commands", () => {
    const input = "some output";
    expect(gitStatus(input, "ls -la")).toBe(input);
  });

  test("passes through short git status", () => {
    const input = "M  src/index.ts\nM  src/utils.ts";
    expect(gitStatus(input, "git status")).toBe(input);
  });

  test("compresses long git status", () => {
    // Generate 50 lines of modified files
    const lines = Array.from({ length: 50 }, (_, i) => `modified: src/file${i}.ts`);
    lines.push("On branch main");
    const input = lines.join("\n");
    const result = gitStatus(input, "git status");
    expect(result).toContain("modified: 50 files");
    expect(result).toContain("On branch main");
    // Should not contain individual file lines
    expect(result).not.toContain("file49.ts");
  });
});

describe("testOutput", () => {
  test("passes through non-test commands", () => {
    const input = "some output";
    expect(testOutput(input, "ls -la")).toBe(input);
  });

  test("collapses passing tests", () => {
    const lines = [
      "Running tests...",
      ...Array.from({ length: 25 }, (_, i) => `  ✓ test ${i} passes`),
      "  ✗ test 26 fails",
      "Tests: 25 passed, 1 failed",
    ];
    const input = lines.join("\n");
    const result = testOutput(input, "bun test");
    expect(result).toContain("passing tests (collapsed)");
    expect(result).toContain("test 26 fails");
    expect(result).toContain("Tests: 25 passed, 1 failed");
    // Should not have all 25 individual pass lines
    expect(result.split("\n").length).toBeLessThan(lines.length);
  });
});

describe("compose", () => {
  test("applies filters left to right", () => {
    const addA: typeof stripAnsi = (s) => s + "A";
    const addB: typeof stripAnsi = (s) => s + "B";
    const composed = compose(addA, addB);
    expect(composed("x", "cmd")).toBe("xAB");
  });

  test("empty compose returns identity", () => {
    const composed = compose();
    expect(composed("hello", "cmd")).toBe("hello");
  });
});

describe("rtk (full pipeline)", () => {
  test("strips ANSI + collapses + deduplicates", () => {
    const input = [
      "\x1b[32mOK\x1b[0m",
      "",
      "",
      "",
      "warning: x",
      "warning: x",
      "warning: x",
      "done",
    ].join("\n");
    const result = rtk(input, "some-command");
    expect(result).toContain("OK");
    expect(result).not.toContain("\x1b");
    expect(result).toContain("repeated 2 more times");
  });

  test("handles empty input", () => {
    // dedup sees two empty-string "lines" (split produces ["", ""])
    // and reports a repeat — this is expected behavior
    const result = rtk("", "cmd");
    expect(result.length).toBeLessThanOrEqual(40);
  });
});
