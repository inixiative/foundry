// ---------------------------------------------------------------------------
// Config variation generators — sweep strategies for experiments
// ---------------------------------------------------------------------------

import type { FoundryConfig, AgentSettingsConfig } from "../viewer/config";
import type { ConfigVariation } from "./types";

// ---------------------------------------------------------------------------
// One-at-a-time: vary one agent's one parameter
// ---------------------------------------------------------------------------

/**
 * Generate variations by sweeping a single parameter of a single agent.
 * Everything else stays at baseline.
 */
export function oneAtATime(
  agentId: string,
  paramName: keyof Pick<AgentSettingsConfig, "model" | "temperature" | "maxTokens" | "tools">,
  values: Array<string | number | boolean>,
): ConfigVariation[] {
  return values.map((value) => ({
    id: `${agentId}-${paramName}-${value}`,
    description: `${agentId}: ${paramName}=${value}`,
    agentOverrides: {
      [agentId]: { [paramName]: value } as Partial<AgentSettingsConfig>,
    },
  }));
}

// ---------------------------------------------------------------------------
// Model sweep — Phase 1: which model for each agent role
// ---------------------------------------------------------------------------

/** Cross-provider model options organized by tier. */
const FAST_MODELS: Array<{ provider: string; model: string; label: string }> = [
  { provider: "anthropic", model: "claude-haiku-4-5-20251001", label: "haiku" },
  { provider: "anthropic", model: "claude-sonnet-4-6-20250627", label: "sonnet" },
  { provider: "openai", model: "gpt-4o-mini", label: "gpt-4o-mini" },
  { provider: "gemini", model: "gemini-2.5-flash", label: "gemini-flash" },
];

const STANDARD_MODELS: Array<{ provider: string; model: string; label: string }> = [
  { provider: "anthropic", model: "claude-sonnet-4-6-20250627", label: "sonnet" },
  { provider: "anthropic", model: "claude-opus-4-6-20250627", label: "opus" },
  { provider: "openai", model: "gpt-4o", label: "gpt-4o" },
  { provider: "gemini", model: "gemini-3.1-pro", label: "gemini-pro" },
];

/**
 * Generate Phase 1 model sweep variations.
 * Classifier/router sweep fast models; executors sweep standard models.
 */
export function modelSweep(config: FoundryConfig): ConfigVariation[] {
  const variations: ConfigVariation[] = [];

  // Baseline — whatever's currently configured
  variations.push({
    id: "baseline",
    description: "Current config (baseline)",
    agentOverrides: {},
  });

  // Classifier model sweep
  for (const m of FAST_MODELS) {
    variations.push({
      id: `classifier-${m.label}`,
      description: `Classifier: ${m.label} (${m.provider})`,
      agentOverrides: {
        classifier: { model: m.model, provider: m.provider },
      },
    });
  }

  // Router model sweep
  for (const m of FAST_MODELS) {
    variations.push({
      id: `router-${m.label}`,
      description: `Router: ${m.label} (${m.provider})`,
      agentOverrides: {
        router: { model: m.model, provider: m.provider },
      },
    });
  }

  // Executor model sweeps
  const executorIds = Object.entries(config.agents)
    .filter(([_, a]) => a.kind === "executor" && a.enabled)
    .map(([id]) => id);

  for (const execId of executorIds) {
    for (const m of STANDARD_MODELS) {
      variations.push({
        id: `${execId}-${m.label}`,
        description: `${execId}: ${m.label} (${m.provider})`,
        agentOverrides: {
          [execId]: { model: m.model, provider: m.provider },
        },
      });
    }
  }

  return variations;
}

// ---------------------------------------------------------------------------
// Temperature sweep — Phase 2: optimal temperature per role
// ---------------------------------------------------------------------------

const TEMPERATURE_VALUES = [0, 0.1, 0.2, 0.3, 0.5];

/**
 * Generate Phase 2 temperature sweep variations.
 * Takes winners from Phase 1 as base overrides.
 */
export function temperatureSweep(
  config: FoundryConfig,
  winners: Record<string, Partial<AgentSettingsConfig>>,
): ConfigVariation[] {
  const variations: ConfigVariation[] = [];

  for (const [agentId, winnerOverrides] of Object.entries(winners)) {
    for (const temp of TEMPERATURE_VALUES) {
      variations.push({
        id: `${agentId}-temp-${temp}`,
        description: `${agentId}: temp=${temp} (with ${winnerOverrides.model || "default"})`,
        agentOverrides: {
          // Apply winner model + sweep temperature
          ...Object.fromEntries(
            Object.entries(winners).map(([id, ov]) => [id, { ...ov }]),
          ),
          [agentId]: { ...winnerOverrides, temperature: temp },
        },
      });
    }
  }

  return variations;
}

// ---------------------------------------------------------------------------
// Tools sweep — test tools on/off per agent role
// ---------------------------------------------------------------------------

/**
 * Generate tools sweep variations.
 * Tests each agent with tools enabled vs disabled.
 * Classifier/router default to tools=false; executors default to tools=true.
 * This sweep tests the opposite of each default.
 */
export function toolsSweep(config: FoundryConfig): ConfigVariation[] {
  const variations: ConfigVariation[] = [];

  for (const [id, agent] of Object.entries(config.agents)) {
    if (!agent.enabled) continue;

    const currentDefault = agent.kind === "classifier" || agent.kind === "router" ? false : true;

    // Test with tools toggled from default
    variations.push({
      id: `${id}-tools-${!currentDefault}`,
      description: `${id}: tools=${!currentDefault} (flipped from default)`,
      agentOverrides: {
        [id]: { tools: !currentDefault },
      },
    });

    // Also test with explicit default (for measurement baseline)
    variations.push({
      id: `${id}-tools-${currentDefault}`,
      description: `${id}: tools=${currentDefault} (explicit default)`,
      agentOverrides: {
        [id]: { tools: currentDefault },
      },
    });
  }

  return variations;
}

// ---------------------------------------------------------------------------
// Full dimension sweep — all knobs for one agent
// ---------------------------------------------------------------------------

export interface DimensionSweepOpts {
  models?: Array<{ provider: string; model: string; label: string }>;
  temperatures?: number[];
  toolsValues?: boolean[];
  maxTokenValues?: number[];
  thinkingValues?: Array<"none" | "low" | "medium" | "high" | number>;
  timeoutValues?: number[];
  permissionsValues?: Array<"bypass" | "supervised" | "restricted">;
}

/**
 * Generate all dimension variations for a single agent.
 * Each dimension is swept independently (one-at-a-time), not as a grid.
 */
export function dimensionSweep(
  agentId: string,
  opts: DimensionSweepOpts,
): ConfigVariation[] {
  const variations: ConfigVariation[] = [];

  if (opts.models) {
    for (const m of opts.models) {
      variations.push({
        id: `${agentId}-model-${m.label}`,
        description: `${agentId}: model=${m.label} (${m.provider})`,
        agentOverrides: {
          [agentId]: { model: m.model, provider: m.provider },
        },
      });
    }
  }

  if (opts.temperatures) {
    for (const temp of opts.temperatures) {
      variations.push({
        id: `${agentId}-temp-${temp}`,
        description: `${agentId}: temp=${temp}`,
        agentOverrides: {
          [agentId]: { temperature: temp },
        },
      });
    }
  }

  if (opts.toolsValues) {
    for (const tools of opts.toolsValues) {
      variations.push({
        id: `${agentId}-tools-${tools}`,
        description: `${agentId}: tools=${tools}`,
        agentOverrides: {
          [agentId]: { tools },
        },
      });
    }
  }

  if (opts.maxTokenValues) {
    for (const maxTokens of opts.maxTokenValues) {
      variations.push({
        id: `${agentId}-maxTokens-${maxTokens}`,
        description: `${agentId}: maxTokens=${maxTokens}`,
        agentOverrides: {
          [agentId]: { maxTokens },
        },
      });
    }
  }

  if (opts.thinkingValues) {
    for (const thinking of opts.thinkingValues) {
      variations.push({
        id: `${agentId}-thinking-${thinking}`,
        description: `${agentId}: thinking=${thinking}`,
        agentOverrides: {
          [agentId]: { thinking },
        },
      });
    }
  }

  if (opts.timeoutValues) {
    for (const timeout of opts.timeoutValues) {
      variations.push({
        id: `${agentId}-timeout-${timeout}`,
        description: `${agentId}: timeout=${timeout}ms`,
        agentOverrides: {
          [agentId]: { timeout },
        },
      });
    }
  }

  if (opts.permissionsValues) {
    for (const permissions of opts.permissionsValues) {
      variations.push({
        id: `${agentId}-permissions-${permissions}`,
        description: `${agentId}: permissions=${permissions}`,
        agentOverrides: {
          [agentId]: { permissions },
        },
      });
    }
  }

  return variations;
}

// ---------------------------------------------------------------------------
// Manual — explicit variations
// ---------------------------------------------------------------------------

/** Passthrough for manually defined config variations. */
export function manual(variations: ConfigVariation[]): ConfigVariation[] {
  return variations;
}

// ---------------------------------------------------------------------------
// Apply variations to config
// ---------------------------------------------------------------------------

/** Deep-clone a config and apply a variation's overrides. */
export function applyVariation(
  baseConfig: FoundryConfig,
  variation: ConfigVariation,
): FoundryConfig {
  // Deep clone
  const config: FoundryConfig = JSON.parse(JSON.stringify(baseConfig));

  // Apply default overrides
  if (variation.defaultOverrides) {
    Object.assign(config.defaults, variation.defaultOverrides);
  }

  // Apply agent overrides
  for (const [agentId, overrides] of Object.entries(variation.agentOverrides)) {
    if (config.agents[agentId]) {
      Object.assign(config.agents[agentId], overrides);
    }
  }

  // Apply layer overrides
  if (variation.layerOverrides) {
    for (const [layerId, overrides] of Object.entries(variation.layerOverrides)) {
      if (config.layers[layerId]) {
        Object.assign(config.layers[layerId], overrides);
      }
    }
  }

  return config;
}
