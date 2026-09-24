import type { LLMProvider } from "@inixiative/foundry-core";
import { auxiliarySessionId } from "./agents/thread-runtime";

export function startupSelfTestEnabled(value: string | undefined): boolean {
  if (value === undefined || value === "0") return false;
  if (value === "1") return true;
  throw Error("FOUNDRY_STARTUP_SELF_TEST must be 0 or 1");
}

/** Import-safe policy seam: only explicit opt-in invokes the supplied provider. */
export async function runStartupSelfTest(options: { enabled: boolean; provider: LLMProvider; model: string; cwd: string;
  log: (message: string) => void; warn: (message: string) => void; error: (message: string) => void }) {
  if (!options.enabled) { options.log("Provider self-test skipped (opt in with FOUNDRY_STARTUP_SELF_TEST=1)"); return { status: "skipped" as const }; }
  options.log("Running provider self-test (explicit opt-in)...");
  try {
    const result = await options.provider.complete([{ role: "user", content: "Respond with exactly: FOUNDRY_OK" }],
      { maxTokens: 32, threadId: auxiliarySessionId("foundry", "self-test"), cwd: options.cwd });
    if (result.content.includes("FOUNDRY_OK")) {
      options.log(`Self-test: PASSED (${options.provider.id}/${options.model})`);
      return { status: "passed" as const, result };
    }
    options.warn(`Self-test: provider responded but unexpected output: "${result.content.slice(0, 60)}"`);
    return { status: "unexpected" as const, result };
  } catch (error) {
    options.error(`Self-test: FAILED — ${error instanceof Error ? error.message : String(error)}`);
    options.error("The viewer remains available; this self-test did not establish provider readiness.");
    return { status: "failed" as const, error };
  }
}
