import type { LLMProvider } from "@inixiative/foundry-core";

/** Per-instance evidence, not a guess based on a provider name or an error message. */
export class HttpCompletionSettlement {
  private readonly finishedErrors = new WeakSet<object>();
  readonly lifecycle: NonNullable<LLMProvider["completionLifecycle"]> = Object.freeze({
    kind: "request" as const,
    admission: ({ error }: { result?: unknown; error?: unknown }) =>
      typeof error === "object" && error !== null && this.finishedErrors.has(error) ? "attempted" as const : "unknown" as const,
    settlement: ({ result, error }: { result?: unknown; error?: unknown }) =>
      result !== undefined || (typeof error === "object" && error !== null && this.finishedErrors.has(error))
        ? "settled" as const : "unknown" as const,
  });
  completedError(message: string): Error {
    const error = new Error(message);
    this.finishedErrors.add(error);
    return error;
  }
}
