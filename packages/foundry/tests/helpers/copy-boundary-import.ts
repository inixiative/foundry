import { cp } from "node:fs/promises";
import { expect } from "bun:test";
import { resolve } from "node:path";
import { copyBoundaryPreloadStatus } from "../../../../scripts/copy-boundary-preload";

// Independent named import: the preload must reach this binding, not merely its
// own wrapper or a separately reproduced copy algorithm.
export function independentlyImportedCopy(...args: Parameters<typeof cp>): ReturnType<typeof cp> {
  return cp(...args);
}

export async function secondFileCopyProbe() {
  expect(copyBoundaryPreloadStatus()?.invocations).toBe(2);
  await cp(resolve("fixtures/harness-qa/sample-projects/contact-migration"), resolve(".foundry/qa/m4-controlled-second-file/project-a"), { recursive: true });
  expect(copyBoundaryPreloadStatus()?.invocations).toBe(3);
}
