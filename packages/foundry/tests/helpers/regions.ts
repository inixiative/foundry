// Region Wardens for tests. Settings declare no Wardens (the hand-named roster was retired on
// 2026-10-17), so a test that needs a Warden writes a project's regions and enables its chorus, exactly
// as the Chorus host leaves them in the repository's Chorus working copy:
// `<copy>/.foundry/regions/<id>/{region.json,knowledge.md}` and `<copy>/.foundry/project.json`.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chorusWorkingCopyDir } from '../../src/agents/chorus-working-copy';

/**
 * The Chorus working copy of a scratch checkout (under the suite's own `CHORUS_HOME`). A checkout of
 * its own (`git init`) with an origin unique to it, so no two tests share a copy and none inherits the
 * enclosing repository's. Call it before anything resolves the project.
 */
export function prepareChorusWorkingCopy(projectPath: string): string {
  mkdirSync(projectPath, { recursive: true });
  const git = (...args: string[]) =>
    Bun.spawnSync(['git', '-C', projectPath, ...args], { stdout: 'ignore', stderr: 'ignore' });
  // Re-running init is safe and fills a bare `.git` marker directory some suites make for the ladder.
  git('init', '-q');
  if (!git('remote', 'get-url', 'origin').success)
    git('remote', 'add', 'origin', `git@github.com:test/${randomUUID()}.git`);
  const copy = chorusWorkingCopyDir(projectPath);
  if (!copy) throw new Error(`${projectPath} has no Chorus working copy`);
  return copy;
}

export interface TestRegion {
  /** The region id: the Warden's domain; its agent and role id is `regionRoleId(id)`. */
  readonly id: string;
  /** The region's knowledge.md, whole (the Warden's domain knowledge). Default: one line naming it. */
  readonly knowledge?: string;
  readonly title?: string;
  readonly routing?: string;
}

/**
 * Write `regions` under the project's Chorus working copy (`<copy>/.foundry/regions`) and, unless
 * `enabled` is false, enable its chorus in the copy's `.foundry/project.json`. Returns the regions
 * directory.
 */
export function writeRegions(
  projectPath: string,
  regions: readonly TestRegion[],
  options: { enabled?: boolean } = {},
): string {
  const copy = prepareChorusWorkingCopy(projectPath);
  const dir = join(copy, '.foundry', 'regions');
  mkdirSync(dir, { recursive: true });
  for (const region of regions) {
    const at = join(dir, region.id);
    mkdirSync(at, { recursive: true });
    writeFileSync(
      join(at, 'region.json'),
      JSON.stringify({
        id: region.id,
        title: region.title ?? `${region.id} region`,
        routing: region.routing ?? `Is this about ${region.id}?`,
        concepts: [region.id],
      }),
    );
    writeFileSync(
      join(at, 'knowledge.md'),
      region.knowledge ?? `# ${region.id}\n\n${region.id.toUpperCase()}_KNOWLEDGE\n`,
    );
  }
  if (options.enabled !== false)
    writeFileSync(
      join(copy, '.foundry', 'project.json'),
      JSON.stringify({ chorus: { enabled: true } }),
    );
  return dir;
}
