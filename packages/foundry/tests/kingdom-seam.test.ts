// The Kingdom client seams stay off the harness import graph: Kingdom imports them and typechecks
// everything they reach, type-only imports included, so a path into the session runtime breaks its build.
import { expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';

const SRC = resolve(import.meta.dir, '../src');
const SEAMS = ['kingdom/index.ts', 'runtime/index.ts', 'conversations/headless-host-protocol.ts'];
const HARNESS_FILE = /providers\/session-adapter\.ts$/;
const HARNESS_PACKAGE = '@inixiative/agent-session';

const resolveLocal = (from: string, specifier: string): string | null => {
  const base = resolve(dirname(from), specifier.replace(/\.js$/, ''));
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`])
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return null;
};

/** Every path from `entry` to a harness file or package, as `a → b → …` lines. */
const harnessPaths = (entry: string): string[] => {
  const parent = new Map<string, string>();
  const queue = [entry];
  const seen = new Set(queue);
  const hits: string[] = [];
  const chain = (file: string) => {
    const steps = [file];
    let at = file;
    while (parent.has(at)) {
      at = parent.get(at) as string;
      steps.unshift(at);
    }
    return steps.map((step) => relative(SRC, step)).join(' → ');
  };
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (HARNESS_FILE.test(file)) hits.push(chain(file));
    for (const { fileName } of ts.preProcessFile(readFileSync(file, 'utf8'), true, true)
      .importedFiles) {
      if (fileName === HARNESS_PACKAGE || fileName.startsWith(`${HARNESS_PACKAGE}/`)) {
        hits.push(`${chain(file)} → ${fileName}`);
        continue;
      }
      if (!fileName.startsWith('.')) continue;
      const next = resolveLocal(file, fileName);
      if (!next || seen.has(next)) continue;
      seen.add(next);
      parent.set(next, file);
      queue.push(next);
    }
  }
  return hits;
};

for (const seam of SEAMS) {
  test(`${seam} reaches no session runtime, type imports included`, () => {
    expect(harnessPaths(resolve(SRC, seam))).toEqual([]);
  });
}
