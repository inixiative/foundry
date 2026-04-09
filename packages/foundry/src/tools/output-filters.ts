// ---------------------------------------------------------------------------
// Output filters — RTK-style token reduction for shell output
// ---------------------------------------------------------------------------
//
// These filters transform command output before it enters agent context,
// stripping noise that wastes tokens without adding signal.
//
// RTK (Rust Token Killer) saves 60-90% on dev operations by filtering
// output. These are the same patterns, built into Foundry's shell tools.
//
// Usage:
//   import { builtinFilters } from "@inixiative/foundry";
//
//   const shell = new JustBashShell({
//     outputFilter: builtinFilters.compose(
//       builtinFilters.stripAnsi,
//       builtinFilters.collapseWhitespace,
//       builtinFilters.gitStatus,
//     ),
//   });
// ---------------------------------------------------------------------------

import type { OutputFilter } from "@inixiative/foundry-core";

// -- Individual filters --

/** Strip ANSI escape codes (colors, cursor movement, etc.) */
export const stripAnsi: OutputFilter = (stdout) =>
  // eslint-disable-next-line no-control-regex
  stdout.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");

/** Collapse repeated blank lines into one. */
export const collapseBlankLines: OutputFilter = (stdout) =>
  stdout.replace(/\n{3,}/g, "\n\n");

/** Collapse all runs of whitespace (spaces, tabs) within lines. */
export const collapseWhitespace: OutputFilter = (stdout) =>
  stdout.split("\n").map((line) => line.replace(/[ \t]+/g, " ").trimEnd()).join("\n");

/** Strip common progress/spinner lines that waste tokens. */
export const stripProgress: OutputFilter = (stdout) =>
  stdout
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      // Spinner patterns
      if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏|\/\\-]/.test(trimmed) && trimmed.length < 80) return false;
      // Progress bar patterns
      if (/[█▓▒░]{3,}/.test(trimmed)) return false;
      if (/\d+%\s*[\[|]/.test(trimmed)) return false;
      // "downloading..." / "installing..." single-word status
      if (/^(downloading|installing|resolving|linking|fetching)\.\.\./i.test(trimmed)) return false;
      return true;
    })
    .join("\n");

/** Deduplicate consecutive identical lines (e.g., repeated warnings). */
export const dedup: OutputFilter = (stdout) => {
  const lines = stdout.split("\n");
  const result: string[] = [];
  let lastLine = "";
  let dupeCount = 0;

  for (const line of lines) {
    if (line === lastLine) {
      dupeCount++;
    } else {
      if (dupeCount > 0) {
        result.push(`  ... (repeated ${dupeCount} more time${dupeCount > 1 ? "s" : ""})`);
      }
      result.push(line);
      lastLine = line;
      dupeCount = 0;
    }
  }
  if (dupeCount > 0) {
    result.push(`  ... (repeated ${dupeCount} more time${dupeCount > 1 ? "s" : ""})`);
  }

  return result.join("\n");
};

/**
 * Git status filter — compress verbose git output.
 * Collapses long file lists into counts per status.
 */
export const gitStatus: OutputFilter = (stdout, command) => {
  if (!command.includes("git status") && !command.includes("git diff --stat")) return stdout;

  const lines = stdout.split("\n");
  if (lines.length < 30) return stdout; // Short output, don't compress

  // Count by status prefix
  const counts: Record<string, number> = {};
  const kept: string[] = [];

  for (const line of lines) {
    const match = line.match(/^\s*(modified|new file|deleted|renamed|copied|untracked):/i)
      ?? line.match(/^\s*([MADRCU?!])\s/);

    if (match) {
      const status = match[1].toLowerCase();
      counts[status] = (counts[status] || 0) + 1;
    } else {
      kept.push(line);
    }
  }

  if (Object.keys(counts).length > 0) {
    const summary = Object.entries(counts)
      .map(([status, count]) => `  ${status}: ${count} file${count > 1 ? "s" : ""}`)
      .join("\n");
    kept.push("File changes:", summary);
  }

  return kept.join("\n");
};

/**
 * Test output filter — compress test runner output to just results.
 * Keeps pass/fail summary, collapses individual test details.
 */
export const testOutput: OutputFilter = (stdout, command) => {
  if (!command.includes("test") && !command.includes("jest") && !command.includes("vitest")) {
    return stdout;
  }

  const lines = stdout.split("\n");
  if (lines.length < 20) return stdout;

  const kept: string[] = [];
  let inPassingBlock = false;
  let passingCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    // Keep failure lines always
    if (/fail|error|✗|✘|×|FAIL/i.test(trimmed)) {
      if (inPassingBlock && passingCount > 0) {
        kept.push(`  ... ${passingCount} passing tests (collapsed)`);
        passingCount = 0;
        inPassingBlock = false;
      }
      kept.push(line);
      continue;
    }
    // Collapse passing tests
    if (/pass|✓|✔|PASS/i.test(trimmed) && !trimmed.includes("Tests:")) {
      inPassingBlock = true;
      passingCount++;
      continue;
    }
    // Keep summary lines
    if (/Tests:|Test Suites:|Snapshots:|Time:|Duration:/i.test(trimmed)) {
      if (passingCount > 0) {
        kept.push(`  ... ${passingCount} passing tests (collapsed)`);
        passingCount = 0;
        inPassingBlock = false;
      }
      kept.push(line);
      continue;
    }
    // Keep non-test lines (headers, etc.)
    if (passingCount > 0) {
      kept.push(`  ... ${passingCount} passing tests (collapsed)`);
      passingCount = 0;
      inPassingBlock = false;
    }
    kept.push(line);
  }

  if (passingCount > 0) {
    kept.push(`  ... ${passingCount} passing tests (collapsed)`);
  }

  return kept.join("\n");
};

// -- Composition --

/** Compose multiple filters into one (applied left to right). */
export function compose(...filters: OutputFilter[]): OutputFilter {
  return (stdout, command) =>
    filters.reduce((output, filter) => filter(output, command), stdout);
}

/**
 * The default RTK-style filter stack.
 * Strips ANSI, collapses whitespace, deduplicates, strips progress,
 * compresses git/test output. ~60-80% token savings on typical dev output.
 */
export const rtk = compose(
  stripAnsi,
  stripProgress,
  collapseBlankLines,
  collapseWhitespace,
  dedup,
  gitStatus,
  testOutput,
);

/** All built-in filters as a namespace. */
export const builtinFilters = {
  stripAnsi,
  collapseBlankLines,
  collapseWhitespace,
  stripProgress,
  dedup,
  gitStatus,
  testOutput,
  compose,
  rtk,
};
