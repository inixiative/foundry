// ---------------------------------------------------------------------------
// Report generation — JSON + Markdown summaries
// ---------------------------------------------------------------------------

import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { ExperimentReport, ConfigResult, FixtureResult } from "./types";

// ---------------------------------------------------------------------------
// Write reports to disk
// ---------------------------------------------------------------------------

export async function writeReport(
  report: ExperimentReport,
  dir: string,
): Promise<{ jsonPath: string; mdPath: string }> {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const jsonPath = `${dir}/${report.id}.json`;
  const mdPath = `${dir}/${report.id}.md`;

  await Bun.write(jsonPath, JSON.stringify(report, null, 2));
  await Bun.write(mdPath, generateMarkdown(report));

  return { jsonPath, mdPath };
}

// ---------------------------------------------------------------------------
// Markdown report
// ---------------------------------------------------------------------------

export function generateMarkdown(report: ExperimentReport): string {
  const lines: string[] = [];

  lines.push(`# Experiment Report: ${report.id}`);
  lines.push("");
  lines.push(`**Date:** ${new Date(report.startedAt).toISOString()}`);
  lines.push(`**Duration:** ${formatDuration(report.durationMs)}`);
  lines.push(`**Configs tested:** ${report.configs.length}`);
  lines.push(`**Fixtures:** ${report.fixtures.length}`);
  lines.push(`**Total cost:** $${report.totalCost.toFixed(4)}`);
  lines.push(`**Total tokens:** ${report.totalTokens.toLocaleString()}`);
  lines.push(`**Weights:** quality=${report.weights.quality}, correctness=${report.weights.correctness}, cost=${report.weights.cost}, latency=${report.weights.latency}`);
  lines.push("");

  // Ranking table
  lines.push("## Rankings");
  lines.push("");
  lines.push("| Rank | Config | Composite | Quality | Class Acc | Route Acc | P50 Latency | Cost |");
  lines.push("|------|--------|-----------|---------|-----------|-----------|-------------|------|");

  for (const entry of report.ranking) {
    const config = report.configs.find((c) => c.configId === entry.configId);
    if (!config) continue;

    lines.push(
      `| ${entry.rank} | ${config.description} | ${entry.compositeScore.toFixed(3)} | ${config.overallQualityMean.toFixed(1)}/10 | ${(config.overallClassificationAccuracy * 100).toFixed(0)}% | ${(config.overallRouteAccuracy * 100).toFixed(0)}% | ${formatMs(config.overallLatencyP50)} | $${config.totalCost.toFixed(4)} |`,
    );
  }
  lines.push("");

  // Best config recommendation
  if (report.ranking.length > 0) {
    const best = report.configs.find((c) => c.configId === report.ranking[0].configId);
    if (best) {
      lines.push("## Recommended Config");
      lines.push("");
      lines.push(`**${best.description}** (composite: ${report.ranking[0].compositeScore.toFixed(3)})`);
      lines.push("");
      lines.push(`- Quality: ${best.overallQualityMean.toFixed(1)}/10`);
      lines.push(`- Classification accuracy: ${(best.overallClassificationAccuracy * 100).toFixed(0)}%`);
      lines.push(`- Route accuracy: ${(best.overallRouteAccuracy * 100).toFixed(0)}%`);
      lines.push(`- P50 latency: ${formatMs(best.overallLatencyP50)}`);
      lines.push(`- P95 latency: ${formatMs(best.overallLatencyP95)}`);
      lines.push(`- Total cost: $${best.totalCost.toFixed(4)}`);
      lines.push("");
    }
  }

  // Per-config detail
  lines.push("## Config Details");
  lines.push("");

  for (const config of report.configs) {
    lines.push(`### ${config.description}`);
    lines.push("");
    lines.push(`| Fixture | Class | Route | Quality | Latency P50 |`);
    lines.push(`|---------|-------|-------|---------|-------------|`);

    for (const fixture of config.fixtures) {
      const classIcon = fixture.classificationAccuracy === 1 ? "✓" : fixture.classificationAccuracy > 0 ? "~" : "✗";
      const routeIcon = fixture.routeAccuracy === 1 ? "✓" : fixture.routeAccuracy > 0 ? "~" : "✗";

      lines.push(
        `| ${fixture.fixtureId} | ${classIcon} ${(fixture.classificationAccuracy * 100).toFixed(0)}% | ${routeIcon} ${(fixture.routeAccuracy * 100).toFixed(0)}% | ${fixture.qualityMean.toFixed(1)}±${fixture.qualityStdDev.toFixed(1)} | ${formatMs(fixture.latencyP50)} |`,
      );
    }
    lines.push("");
  }

  // Fixture heatmap — which fixtures are hardest
  lines.push("## Fixture Difficulty");
  lines.push("");
  lines.push("Average quality score across all configs:");
  lines.push("");

  const fixtureAvgs = report.fixtures.map((fixture) => {
    const scores = report.configs
      .flatMap((c) => c.fixtures.filter((f) => f.fixtureId === fixture.id))
      .map((f) => f.qualityMean);
    return { id: fixture.id, avg: scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0 };
  });

  fixtureAvgs.sort((a, b) => a.avg - b.avg);

  for (const { id, avg } of fixtureAvgs) {
    const bar = "█".repeat(Math.round(avg));
    lines.push(`- ${id}: ${avg.toFixed(1)}/10 ${bar}`);
  }
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = ((ms % 60_000) / 1000).toFixed(0);
  return `${mins}m ${secs}s`;
}
