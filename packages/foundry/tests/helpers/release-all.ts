/**
 * Release owned resources in order, never throwing. A step whose handle was
 * never created (partial setup) is skipped; a step that throws is recorded and
 * the remaining steps still run. Returns the failures for the caller's report.
 */
export type ReleaseStep = readonly [name: string, release: (() => unknown | Promise<unknown>) | undefined];

export async function releaseAll(steps: readonly ReleaseStep[], timeoutMs = 5_000): Promise<string[]> {
  const failures: string[] = [];
  for (const [name, release] of steps) {
    if (!release) continue;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([Promise.resolve().then(release), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(`cleanup observation exceeded ${timeoutMs}ms; resource outcome unresolved`)), timeoutMs);
    })]); }
    catch (err) { failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`); }
    finally { clearTimeout(timer); }
  }
  return failures;
}
