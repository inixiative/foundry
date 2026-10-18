// Foundry's own harness sessions (decision hosts, the startup self-test) run in folders Foundry makes,
// stamped for Archive so they never enter it as a person's work (Aron, 2026-10-18: no Foundry-generated
// sessions in the Archive). A process already stamped by a test or eval harness (ARCHIVE_RUN) keeps its kind.
import { RUN_ENV, RUN_KINDS, type RunKind, stampRunDirectory } from '@inixiative/archive/exemption';

export { RUN_ENV };

/** The run kind this process stamps its own folders with: the harness's, else `foundry`. */
export function foundryRunKind(env: Record<string, string | undefined> = process.env): RunKind {
  const kind = env[RUN_ENV]?.trim();
  return RUN_KINDS.includes(kind as RunKind) ? (kind as RunKind) : 'foundry';
}

/** Stamp a folder Foundry made for its own sessions; returns the folder. */
export function stampFoundryRun(directory: string): string {
  stampRunDirectory(directory, foundryRunKind());
  return directory;
}
