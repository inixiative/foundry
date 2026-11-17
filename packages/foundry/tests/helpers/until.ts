/** Waits until `predicate` holds, polling every 2ms; throws naming `label` past `ms`. */
export async function until(predicate: () => boolean | Promise<boolean>, label: string, ms = 2000) {
  const end = performance.now() + ms;
  while (!(await predicate())) {
    if (performance.now() > end) throw Error(`deadline: ${label}`);
    await Bun.sleep(2);
  }
}
