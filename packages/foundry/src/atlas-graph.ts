/**
 * @atlas
 * @kind service
 * @partOf feature:viewer
 */
import type { Graph } from '@inixiative/atlas';

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 20_000_000;

/**
 * A project's `atlas graph --json`, from the repo's own atlas devDep (`--no-install`: never npm,
 * where "atlas" is an unrelated package). Throws when the CLI fails, runs past 15 s or prints
 * more than 20 MB.
 */
export async function fetchAtlasGraph(root: string): Promise<Graph> {
  const proc = Bun.spawn(['bunx', '--no-install', 'atlas', 'graph', '--json'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
  try {
    const stdout = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) throw Error(`atlas graph failed in ${root}`);
    if (Buffer.byteLength(stdout) > MAX_BYTES) throw Error('Atlas graph exceeds 20 MB');
    return JSON.parse(stdout) as Graph;
  } finally {
    clearTimeout(timer);
  }
}
