/**
 * Gate for installing the daemon.
 *
 * A daemon that restarts forever on a configuration it can never satisfy is
 * worse than not installing one, so `inspectReadiness` decides — the same check
 * the viewer uses, rather than a second opinion that could disagree with it.
 */
import { join } from "node:path";
import { inspectReadiness } from "../../packages/foundry/src/readiness";
import { ConfigStore } from "../../packages/foundry/src/viewer/config";

export interface ReadinessGate {
  ready: boolean;
  errors: string[];
  warnings: string[];
}

export const checkReadiness = async (configDirectory: string): Promise<ReadinessGate> => {
  // ConfigStore returns defaults rather than throwing, so an absent file would
  // otherwise read as a valid configuration nobody wrote.
  if (!(await Bun.file(join(configDirectory, "settings.json")).exists()))
    return {
      ready: false,
      errors: [`No Foundry configuration at ${configDirectory}. Run \`bun run setup\` first.`],
      warnings: [],
    };

  let config: Awaited<ReturnType<ConfigStore["load"]>>;
  try {
    config = await new ConfigStore(configDirectory).load();
  } catch {
    return { ready: false, errors: ["Foundry configuration could not be read."], warnings: [] };
  }

  const report = await inspectReadiness(config);
  const describe = (issue: { scope: string; message: string }) =>
    issue.scope === "global" ? issue.message : `${issue.scope}: ${issue.message}`;

  return {
    ready: report.configurationReady,
    errors: report.issues.filter((issue) => issue.severity === "error").map(describe),
    warnings: report.issues.filter((issue) => issue.severity === "warning").map(describe),
  };
};
