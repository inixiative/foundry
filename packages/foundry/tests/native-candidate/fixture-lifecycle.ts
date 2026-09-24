/** Test-only ownership and phase diagnostics. A deadline is a failed observation,
 * never a claim of cancellation. Every acquired cleanup is attempted, even if an
 * earlier setup promise or cleanup rejects. No protocol/configuration is logged. */
export class FixtureLifecycle {
  readonly phases: Array<{ name: string; status: "pending" | "completed" | "failed"; startedAt: number; durationMs?: number; error?: { name: string; code?: number } }> = [];
  private readonly handles: Array<{ name: string; order: number; close: () => unknown }> = [];
  private cleaning?: Promise<unknown[]>;

  own(name: string, order: number, close: () => unknown): void { this.handles.push({ name, order, close }); }

  acquire<T>(name: string, order: number, create: () => Promise<T>, close: (value: T) => unknown, timeoutMs = 4000): Promise<T> {
    const pending = Promise.resolve().then(create);
    // Register the promise before awaiting it. If observation expires, a late
    // resource is still owned and closed; failed construction acquired nothing.
    this.own(name, order, () => pending.then(value => close(value), () => undefined));
    return this.step(name, () => pending, timeoutMs);
  }

  async step<T>(name: string, action: () => T | Promise<T>, timeoutMs = 4000): Promise<T> {
    const phase: (typeof this.phases)[number] = { name, status: "pending", startedAt: performance.now() };
    this.phases.push(phase);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([Promise.resolve().then(action), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error(`Fixture phase deadline: ${name}`)), timeoutMs);
      })]);
      phase.status = "completed";
      return result;
    } catch (error) {
      phase.status = "failed";
      const value = error as { name?: unknown; code?: unknown } | undefined;
      phase.error = { name: typeof value?.name === "string" ? value.name : "UnknownError",
        ...(typeof value?.code === "number" ? { code: value.code } : {}) };
      throw error;
    } finally { clearTimeout(timer); phase.durationMs = performance.now() - phase.startedAt; }
  }

  cleanup(): Promise<unknown[]> {
    return this.cleaning ??= (async () => {
      const errors: unknown[] = [];
      for (const handle of [...this.handles].sort((a, b) => a.order - b.order)) {
        try { await this.step(`cleanup:${handle.name}`, handle.close, 3000); }
        catch (error) { errors.push(error); }
      }
      return errors;
    })();
  }
}

export function throwFixtureFailures(primary: unknown, cleanup: unknown[]): void {
  if (primary !== undefined && !cleanup.length) throw primary;
  const errors = [...(primary !== undefined ? [primary] : []), ...cleanup];
  if (errors.length) throw new AggregateError(errors, "Controlled fixture failure; original errors retained", { cause: errors[0] });
}
