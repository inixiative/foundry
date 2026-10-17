// Region Wardens for tests. Settings declare no Wardens (the hand-named roster was retired on
// 2026-10-17), so a test that needs a Warden writes a project's regions and enables its chorus, exactly
// as a repository does: `.foundry/regions/<id>/{region.json,knowledge.md}` and `.foundry/project.json`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TestRegion {
  /** The region id: also the Warden's agent id and domain. */
  readonly id: string;
  /** The region's knowledge.md, whole (the Warden's domain knowledge). Default: one line naming it. */
  readonly knowledge?: string;
  readonly title?: string;
  readonly routing?: string;
}

/**
 * Write `regions` under `<projectPath>/.foundry/regions` and, unless `enabled` is false, enable the
 * project's chorus in its `.foundry/project.json`. Returns the regions directory.
 */
export function writeRegions(
  projectPath: string,
  regions: readonly TestRegion[],
  options: { enabled?: boolean } = {},
): string {
  const dir = join(projectPath, '.foundry', 'regions');
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
      join(projectPath, '.foundry', 'project.json'),
      JSON.stringify({ chorus: { enabled: true } }),
    );
  return dir;
}
