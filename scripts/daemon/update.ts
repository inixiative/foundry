/**
 * Auto-update policy. The daemon never restarts itself in place — it pulls,
 * then exits with RESTART_EXIT_CODE so launchd's KeepAlive relaunches it into
 * the new code. A browser page reconnects invisibly.
 */
import { $ } from "bun";

export type AutoUpdate = "off" | "check" | "apply";

/** Distinct from a crash so the logs can tell the two apart. */
export const RESTART_EXIT_CODE = 75;

export interface UpdateResult {
  behind: number;
  action: "none" | "reported" | "applied" | "failed";
  detail?: string;
}

export const readAutoUpdate = async (repoRoot: string): Promise<AutoUpdate> => {
  try {
    const settings = await Bun.file(`${repoRoot}/.foundry/settings.json`).json();
    const value = settings?.daemon?.autoUpdate;
    return value === "check" || value === "apply" ? value : "off";
  } catch {
    return "off";
  }
};

const commitsBehind = async (repoRoot: string, branch: string): Promise<number> => {
  const out = await $`git -C ${repoRoot} rev-list --count HEAD..origin/${branch}`.quiet().text();
  const count = Number.parseInt(out.trim(), 10);
  return Number.isSafeInteger(count) ? count : 0;
};

/**
 * Only fast-forwards. A diverged or dirty tree is left alone and reported —
 * an unattended runtime must never resolve a merge or discard local work.
 */
export const applyUpdate = async (repoRoot: string, branch = "main"): Promise<UpdateResult> => {
  try {
    await $`git -C ${repoRoot} fetch --quiet origin ${branch}`.quiet();
  } catch (error) {
    return { behind: 0, action: "failed", detail: `fetch failed: ${String(error)}` };
  }

  const behind = await commitsBehind(repoRoot, branch);
  if (behind === 0) return { behind: 0, action: "none" };

  const mode = await readAutoUpdate(repoRoot);
  if (mode !== "apply") return { behind, action: "reported" };

  const dirty = (await $`git -C ${repoRoot} status --porcelain`.quiet().text()).trim();
  if (dirty) return { behind, action: "failed", detail: "working tree is dirty" };

  try {
    await $`git -C ${repoRoot} merge --ff-only origin/${branch}`.quiet();
    await $`bun install --frozen-lockfile --cwd ${repoRoot}`.quiet();
    return { behind, action: "applied" };
  } catch (error) {
    return { behind, action: "failed", detail: String(error) };
  }
};
