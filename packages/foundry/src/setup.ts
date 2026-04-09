#!/usr/bin/env bun
/**
 * Foundry Setup — cumulative interactive configuration.
 *
 * First run: walks through provider, model, creates starter config.
 * Subsequent runs: menu-driven — add/edit/delete any section.
 *
 * Run with: bun run setup
 */

import * as readline from "readline/promises";
import { existsSync, mkdirSync } from "fs";
import { defaultConfig, type FoundryConfig } from "./viewer/config";

const FOUNDRY_DIR = ".foundry";
const CONFIG_PATH = `${FOUNDRY_DIR}/settings.json`;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------

async function ask(question: string, fallback?: string): Promise<string> {
  const hint = fallback ? ` [${fallback}]` : "";
  const answer = await rl.question(`  ${question}${hint}: `);
  return answer.trim() || fallback || "";
}

async function choose(question: string, options: string[], defaultIdx = 0): Promise<number> {
  console.log(`\n  ${question}\n`);
  for (let i = 0; i < options.length; i++) {
    const marker = i === defaultIdx ? ">" : " ";
    console.log(`    ${marker} ${i + 1}. ${options[i]}`);
  }
  console.log();
  const answer = await ask("Choice", String(defaultIdx + 1));
  const idx = parseInt(answer) - 1;
  return idx >= 0 && idx < options.length ? idx : defaultIdx;
}

async function confirm(question: string, fallback = true): Promise<boolean> {
  const hint = fallback ? "Y/n" : "y/N";
  const answer = await ask(`${question} (${hint})`);
  if (!answer) return fallback;
  return answer.toLowerCase().startsWith("y");
}

// ---------------------------------------------------------------------------
// Provider definitions
// ---------------------------------------------------------------------------

const PROVIDERS = [
  {
    id: "claude-code",
    label: "Claude Code (CLI subscription — no API key)",
    envKey: "",
    models: [
      { id: "sonnet", label: "Sonnet 4.6 (latest)", tier: "standard" },
      { id: "opus", label: "Opus 4.6 (latest, powerful)", tier: "powerful" },
      { id: "haiku", label: "Haiku 4.5 (fast, cheap)", tier: "fast" },
    ],
    defaultModel: 0,
  },
  {
    id: "anthropic",
    label: "Anthropic (API key)",
    envKey: "ANTHROPIC_API_KEY",
    models: [
      { id: "claude-sonnet-4-6-20250627", label: "Sonnet 4.6 (latest)", tier: "standard" },
      { id: "claude-opus-4-6-20250627", label: "Opus 4.6 (latest, powerful)", tier: "powerful" },
      { id: "claude-sonnet-4-20250514", label: "Sonnet 4", tier: "standard" },
      { id: "claude-opus-4-20250514", label: "Opus 4", tier: "powerful" },
      { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5 (fast, cheap)", tier: "fast" },
    ],
    defaultModel: 0,
  },
  {
    id: "openai",
    label: "OpenAI",
    envKey: "OPENAI_API_KEY",
    models: [
      { id: "gpt-5.4", label: "GPT-5.4 (latest)", tier: "powerful" },
      { id: "gpt-4o", label: "GPT-4o", tier: "standard" },
      { id: "gpt-4o-mini", label: "GPT-4o Mini (fast, cheap)", tier: "fast" },
      { id: "o3", label: "o3 (reasoning)", tier: "powerful" },
      { id: "o4-mini", label: "o4-mini (reasoning, fast)", tier: "standard" },
    ],
    defaultModel: 0,
  },
  {
    id: "gemini",
    label: "Google (Gemini)",
    envKey: "GEMINI_API_KEY",
    models: [
      { id: "gemini-3.1-flash", label: "Gemini 3.1 Flash (latest)", tier: "standard" },
      { id: "gemini-3.1-pro", label: "Gemini 3.1 Pro (powerful)", tier: "powerful" },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", tier: "standard" },
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", tier: "powerful" },
    ],
    defaultModel: 0,
  },
] as const;

type ProviderId = (typeof PROVIDERS)[number]["id"];

function detectKeys(): { id: ProviderId; key: string }[] {
  const found: { id: ProviderId; key: string }[] = [];
  for (const p of PROVIDERS) {
    if (!p.envKey) continue;
    const key = process.env[p.envKey];
    if (key) found.push({ id: p.id, key });
  }
  return found;
}

// ---------------------------------------------------------------------------
// Config I/O
// ---------------------------------------------------------------------------

async function loadConfig(): Promise<FoundryConfig | null> {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    const saved = await Bun.file(CONFIG_PATH).json() as Partial<FoundryConfig>;
    return {
      ...defaultConfig(),
      ...saved,
      providers: { ...defaultConfig().providers, ...saved.providers },
      projects: { ...saved.projects },
    };
  } catch {
    return null;
  }
}

async function saveConfig(config: FoundryConfig): Promise<void> {
  mkdirSync(FOUNDRY_DIR, { recursive: true });
  await Bun.write(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

async function main() {
  console.log();
  console.log("  ┌─────────────────────────────────┐");
  console.log("  │          foundry setup           │");
  console.log("  └─────────────────────────────────┘");
  console.log();

  const existing = await loadConfig();

  if (!existing) {
    // First-time setup
    const config = await firstTimeSetup();
    await saveConfig(config);
    await ensureDirs();
    await seedMemory();
    printDone(config);
  } else {
    // Cumulative — menu loop
    await configureLoop(existing);
  }

  rl.close();
}

// ---------------------------------------------------------------------------
// First-time setup (no existing config)
// ---------------------------------------------------------------------------

async function firstTimeSetup(): Promise<FoundryConfig> {
  console.log("  No config found — starting fresh.\n");

  const { providerId, apiKey, model } = await pickProvider();
  const port = await ask("Viewer port", "4400");

  const config = buildStarterConfig(providerId, model);

  if (apiKey) {
    const envKey = PROVIDERS.find(p => p.id === providerId)?.envKey;
    if (envKey) await writeEnvLocal(envKey, apiKey, port);
  } else {
    await writeEnvLocal("", "", port);
  }

  return config;
}

// ---------------------------------------------------------------------------
// Cumulative config loop
// ---------------------------------------------------------------------------

async function configureLoop(config: FoundryConfig) {
  const counts = () => ({
    agents: Object.keys(config.agents).length,
    layers: Object.keys(config.layers).length,
    sources: Object.keys(config.sources).length,
    projects: Object.keys(config.projects).length,
  });

  let running = true;
  while (running) {
    const c = counts();
    const idx = await choose("What would you like to configure?", [
      `Provider & defaults  (${config.defaults.provider} / ${config.defaults.model})`,
      `Agents               (${c.agents} configured)`,
      `Layers               (${c.layers} configured)`,
      `Sources              (${c.sources} configured)`,
      `Projects             (${c.projects} configured)`,
      "Reset to starter config",
      "Done",
    ]);

    switch (idx) {
      case 0: await configureDefaults(config); break;
      case 1: await configureSection(config, "agents", agentEditor); break;
      case 2: await configureSection(config, "layers", layerEditor); break;
      case 3: await configureSection(config, "sources", sourceEditor); break;
      case 4: await configureSection(config, "projects", projectEditor); break;
      case 5: {
        if (await confirm("Replace config with starter defaults?", false)) {
          const providerId = config.defaults.provider as ProviderId;
          const model = config.defaults.model;
          const starter = buildStarterConfig(providerId, model);
          Object.assign(config, starter);
          console.log("  Config reset to starter defaults.");
        }
        break;
      }
      case 6: running = false; break;
    }

    await saveConfig(config);
  }

  console.log("\n  Config saved to .foundry/settings.json\n");
}

// ---------------------------------------------------------------------------
// Generic section editor (agents, layers, sources, projects)
// ---------------------------------------------------------------------------

type ItemEditor<T> = {
  label: string;
  summarize: (id: string, item: T) => string;
  create: (config: FoundryConfig) => Promise<[string, T] | null>;
  edit: (id: string, item: T, config: FoundryConfig) => Promise<T>;
};

async function configureSection<T>(
  config: FoundryConfig,
  section: "agents" | "layers" | "sources" | "projects",
  editor: ItemEditor<T>,
) {
  const map = config[section] as Record<string, T>;

  let running = true;
  while (running) {
    const ids = Object.keys(map);
    console.log(`\n  ── ${editor.label} (${ids.length}) ──\n`);

    if (ids.length > 0) {
      for (const id of ids) {
        console.log(`    • ${editor.summarize(id, map[id])}`);
      }
    } else {
      console.log("    (none)");
    }

    const options = ["Add new", ...(ids.length > 0 ? ["Edit existing", "Delete"] : []), "Back"];
    const idx = await choose("", options);
    const picked = options[idx];

    if (picked === "Add new") {
      const result = await editor.create(config);
      if (result) {
        const [id, item] = result;
        map[id] = item;
        console.log(`  Added: ${id}`);
      }
    } else if (picked === "Edit existing") {
      const editIdx = await choose("Which item?", ids);
      const id = ids[editIdx];
      map[id] = await editor.edit(id, map[id], config);
      console.log(`  Updated: ${id}`);
    } else if (picked === "Delete") {
      const delIdx = await choose("Which item to delete?", ids);
      const id = ids[delIdx];
      if (await confirm(`Delete "${id}"?`, false)) {
        delete map[id];
        console.log(`  Deleted: ${id}`);
      }
    } else {
      running = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Defaults editor
// ---------------------------------------------------------------------------

async function configureDefaults(config: FoundryConfig) {
  console.log(`\n  ── Defaults ──\n`);
  console.log(`    Provider:    ${config.defaults.provider}`);
  console.log(`    Model:       ${config.defaults.model}`);
  console.log(`    Temperature: ${config.defaults.temperature}`);
  console.log(`    Max tokens:  ${config.defaults.maxTokens}`);

  if (await confirm("\n  Change provider?", false)) {
    const { providerId, apiKey, model } = await pickProvider(config.defaults.provider as ProviderId);
    config.defaults.provider = providerId;
    config.defaults.model = model;

    if (apiKey) {
      const envKey = PROVIDERS.find(p => p.id === providerId)?.envKey;
      if (envKey) await writeEnvLocal(envKey, apiKey);
    }
  }

  if (await confirm("Change model?", false)) {
    const provider = PROVIDERS.find(p => p.id === config.defaults.provider);
    if (provider) {
      const currentIdx = provider.models.findIndex(m => m.id === config.defaults.model);
      const modelIdx = await choose(
        "Which model?",
        provider.models.map(m => `${m.label}  (${m.id})`),
        currentIdx >= 0 ? currentIdx : 0,
      );
      config.defaults.model = provider.models[modelIdx].id;
    } else {
      config.defaults.model = await ask("Model", config.defaults.model);
    }
  }

  const temp = await ask("Temperature", String(config.defaults.temperature));
  config.defaults.temperature = parseFloat(temp) || 0;

  const tokens = await ask("Max tokens", String(config.defaults.maxTokens));
  config.defaults.maxTokens = parseInt(tokens) || 4096;
}

// ---------------------------------------------------------------------------
// Agent editor
// ---------------------------------------------------------------------------

const agentEditor: ItemEditor<any> = {
  label: "Agents",
  summarize: (id, a) => `${id}  (${a.kind}, ${a.model || "default"})${a.enabled ? "" : " [disabled]"}`,
  async create(config) {
    const id = await ask("Agent ID (e.g. code-reviewer)");
    if (!id) return null;

    const kindIdx = await choose("Kind?", ["executor", "classifier", "router", "decider"]);
    const kind = ["executor", "classifier", "router", "decider"][kindIdx];

    const prompt = await ask("System prompt");

    const provider = PROVIDERS.find(p => p.id === config.defaults.provider);
    let model = config.defaults.model;
    if (provider) {
      const currentIdx = provider.models.findIndex(m => m.id === config.defaults.model);
      const modelIdx = await choose(
        "Model?",
        [...provider.models.map(m => `${m.label}  (${m.id})`), "Use default"],
        provider.models.length, // default to "Use default"
      );
      model = modelIdx < provider.models.length ? provider.models[modelIdx].id : config.defaults.model;
    }

    const temp = await ask("Temperature", "0");
    const maxTokens = await ask("Max tokens", kind === "executor" ? "4096" : "256");

    return [id, {
      id, kind, prompt,
      provider: config.defaults.provider,
      model,
      temperature: parseFloat(temp) || 0,
      maxTokens: parseInt(maxTokens) || 4096,
      visibleLayers: [],
      peers: [],
      maxDepth: 3,
      enabled: true,
    }];
  },
  async edit(id, item, config) {
    console.log(`\n  Editing agent: ${id}\n`);
    item.prompt = await ask("System prompt", item.prompt);
    item.model = await ask("Model", item.model || config.defaults.model);
    item.temperature = parseFloat(await ask("Temperature", String(item.temperature))) || 0;
    item.maxTokens = parseInt(await ask("Max tokens", String(item.maxTokens))) || 4096;
    const enabled = await confirm("Enabled?", item.enabled);
    item.enabled = enabled;
    return item;
  },
};

// ---------------------------------------------------------------------------
// Layer editor
// ---------------------------------------------------------------------------

const layerEditor: ItemEditor<any> = {
  label: "Layers",
  summarize: (id, l) => `${id}  (trust: ${l.trust}, sources: ${(l.sourceIds || []).length})${l.enabled ? "" : " [disabled]"}`,
  async create(config) {
    const id = await ask("Layer ID (e.g. security-rules)");
    if (!id) return null;

    const prompt = await ask("Prompt (what this layer provides)");
    const trust = await ask("Trust (0-1)", "0.5");
    const staleness = await ask("Staleness ms (0 = never stale)", "0");
    const maxTokens = await ask("Max tokens", "4000");

    // Offer to attach sources
    const sourceIds: string[] = [];
    const availableSources = Object.keys(config.sources);
    if (availableSources.length > 0 && await confirm("Attach sources?", false)) {
      console.log("  Available sources: " + availableSources.join(", "));
      const picked = await ask("Source IDs (comma-separated)");
      if (picked) sourceIds.push(...picked.split(",").map(s => s.trim()).filter(Boolean));
    }

    return [id, {
      id, prompt, sourceIds,
      trust: parseFloat(trust) || 0.5,
      staleness: parseInt(staleness) || 0,
      maxTokens: parseInt(maxTokens) || 4000,
      enabled: true,
    }];
  },
  async edit(id, item, config) {
    console.log(`\n  Editing layer: ${id}\n`);
    item.prompt = await ask("Prompt", item.prompt);
    item.trust = parseFloat(await ask("Trust (0-1)", String(item.trust))) || 0.5;
    item.staleness = parseInt(await ask("Staleness ms", String(item.staleness))) || 0;
    item.maxTokens = parseInt(await ask("Max tokens", String(item.maxTokens))) || 4000;
    const enabled = await confirm("Enabled?", item.enabled);
    item.enabled = enabled;
    return item;
  },
};

// ---------------------------------------------------------------------------
// Source editor
// ---------------------------------------------------------------------------

const SOURCE_TYPES = ["file", "sqlite", "postgres", "redis", "http", "markdown", "inline", "supermemory"] as const;

const sourceEditor: ItemEditor<any> = {
  label: "Sources",
  summarize: (id, s) => `${id}  (${s.type}: ${s.uri?.slice(0, 40) || "—"})${s.enabled ? "" : " [disabled]"}`,
  async create(_config) {
    const id = await ask("Source ID (e.g. project-docs)");
    if (!id) return null;

    const typeIdx = await choose("Type?", SOURCE_TYPES.map(t => {
      if (t === "supermemory") return "supermemory (hosted memory + RAG)";
      return t;
    }));
    const type = SOURCE_TYPES[typeIdx];

    const label = await ask("Label", id);

    let uri = "";
    switch (type) {
      case "file":
        uri = await ask("Directory path", ".foundry/memory");
        break;
      case "sqlite":
        uri = await ask("SQLite path", ".foundry/memory.db");
        break;
      case "postgres":
        uri = await ask("Connection string", "postgresql://localhost:5432/foundry");
        break;
      case "redis":
        uri = await ask("Redis URL", "redis://localhost:6379");
        break;
      case "http":
        uri = await ask("Base URL");
        break;
      case "markdown":
        uri = await ask("Directory path (glob for *.md)");
        break;
      case "inline":
        uri = await ask("Content (inline text)");
        break;
      case "supermemory": {
        const key = process.env.SUPERMEMORY_API_KEY;
        if (key) {
          console.log(`  Detected SUPERMEMORY_API_KEY: ${key.slice(0, 12)}...`);
        } else {
          console.log("  Set SUPERMEMORY_API_KEY in .env.local to connect.");
        }
        const tag = await ask("Container tag (scopes memories)", "default");
        uri = tag; // URI field stores the container tag for supermemory
        break;
      }
    }

    return [id, { id, type, label, uri, enabled: true }];
  },
  async edit(id, item, _config) {
    console.log(`\n  Editing source: ${id}\n`);
    item.label = await ask("Label", item.label);
    item.uri = await ask(item.type === "inline" ? "Content" : "URI", item.uri);
    const enabled = await confirm("Enabled?", item.enabled);
    item.enabled = enabled;
    return item;
  },
};

// ---------------------------------------------------------------------------
// Project editor
// ---------------------------------------------------------------------------

const projectEditor: ItemEditor<any> = {
  label: "Projects",
  summarize: (id, p) => `${id}  (${p.path || "—"}, runtime: ${p.runtime || "claude-code"})${p.enabled ? "" : " [disabled]"}`,
  async create(_config) {
    const id = await ask("Project ID (e.g. my-api)");
    if (!id) return null;

    const path = await ask("Project directory (absolute path)");
    const label = await ask("Label", id);
    const tags = await ask("Tags (comma-separated)", "");
    const runtimeIdx = await choose("Runtime adapter?", ["claude-code", "codex", "cursor"]);
    const runtime = ["claude-code", "codex", "cursor"][runtimeIdx];

    return [id, {
      id, path, label,
      tags: tags ? tags.split(",").map(t => t.trim()) : [],
      runtime,
      enabled: true,
    }];
  },
  async edit(id, item, _config) {
    console.log(`\n  Editing project: ${id}\n`);
    item.path = await ask("Directory", item.path);
    item.label = await ask("Label", item.label);
    const runtimeIdx = await choose("Runtime?", ["claude-code", "codex", "cursor"],
      ["claude-code", "codex", "cursor"].indexOf(item.runtime) ?? 0);
    item.runtime = ["claude-code", "codex", "cursor"][runtimeIdx];
    const enabled = await confirm("Enabled?", item.enabled);
    item.enabled = enabled;
    return item;
  },
};

// ---------------------------------------------------------------------------
// Provider picker (shared between first-time and defaults)
// ---------------------------------------------------------------------------

async function pickProvider(currentId?: ProviderId): Promise<{ providerId: ProviderId; apiKey: string; model: string }> {
  const detected = detectKeys();

  if (detected.length > 0) {
    console.log("  Detected API keys in environment:");
    for (const d of detected) {
      const p = PROVIDERS.find(p => p.id === d.id)!;
      console.log(`    ${p.label}: ${d.key.slice(0, 12)}...`);
    }
    console.log();
  }

  const defaultIdx = currentId
    ? PROVIDERS.findIndex(p => p.id === currentId)
    : detected.length > 0
      ? PROVIDERS.findIndex(p => p.id === detected[0].id)
      : 0;

  const providerIdx = await choose(
    "Which LLM provider?",
    PROVIDERS.map(p => {
      const found = detected.find(d => d.id === p.id);
      return found ? `${p.label}  (key detected)` : p.label;
    }),
    defaultIdx >= 0 ? defaultIdx : 0,
  );
  const provider = PROVIDERS[providerIdx];

  let apiKey = "";
  if (provider.envKey) {
    const existingKey = detected.find(d => d.id === provider.id);
    if (existingKey) {
      const useIt = await confirm(`Use detected ${provider.envKey}?`);
      apiKey = useIt ? existingKey.key : await ask("Enter API key");
    } else {
      console.log(`\n  No ${provider.envKey} found in environment.`);
      apiKey = await ask("Enter API key");
    }
    if (!apiKey) {
      console.log("  No key — add it to .env.local later.");
    }
  } else {
    console.log("\n  Using Claude Code CLI subscription (no API key needed).");
  }

  const modelIdx = await choose(
    "Which model?",
    provider.models.map(m => `${m.label}  (${m.id})`),
    provider.defaultModel,
  );
  const model = provider.models[modelIdx].id;

  return { providerId: provider.id, apiKey, model };
}

// ---------------------------------------------------------------------------
// Starter config builder
// ---------------------------------------------------------------------------

function buildStarterConfig(providerId: ProviderId | string, model: string): FoundryConfig {
  const config = defaultConfig();
  config.defaults.provider = providerId;
  config.defaults.model = model;

  config.layers = {
    system: {
      id: "system",
      prompt: "Core system instructions.",
      sourceIds: ["system-prompt"],
      trust: 1.0,
      staleness: 0,
      maxTokens: 2000,
      enabled: true,
    },
    conventions: {
      id: "conventions",
      prompt: "Project conventions and coding standards.",
      sourceIds: ["conventions-src"],
      trust: 0.8,
      staleness: 60_000,
      maxTokens: 4000,
      enabled: true,
    },
    memory: {
      id: "memory",
      prompt: "Working memory — recent context, signals, decisions.",
      sourceIds: ["memory-src"],
      trust: 0.3,
      staleness: 30_000,
      maxTokens: 8000,
      enabled: true,
    },
  };

  config.agents = {
    classifier: {
      id: "classifier",
      kind: "classifier",
      prompt: "Classify the incoming message into exactly one category.\nCategories: bug, feature, refactor, question, convention, general.\nRespond with JSON: {\"category\": \"...\", \"subcategory\": \"...\", \"reasoning\": \"...\"}",
      provider: providerId,
      model,
      temperature: 0,
      maxTokens: 256,
      visibleLayers: ["system"],
      peers: [],
      maxDepth: 1,
      enabled: true,
    },
    router: {
      id: "router",
      kind: "router",
      prompt: "Route the classified message to the appropriate executor.\nAvailable executors: executor-fix (bugs), executor-build (features, refactors), executor-answer (questions, general).\nChoose context layers relevant to the task.\nRespond with JSON: {\"destination\": \"...\", \"contextSlice\": [\"layer1\"], \"priority\": 5, \"reasoning\": \"...\"}",
      provider: providerId,
      model,
      temperature: 0,
      maxTokens: 256,
      visibleLayers: ["system"],
      peers: [],
      maxDepth: 1,
      enabled: true,
    },
    "executor-fix": {
      id: "executor-fix",
      kind: "executor",
      prompt: "You are a bug-fixing assistant.\nAnalyze the reported issue, identify root cause, and propose a fix.\nInclude the reasoning behind your fix.",
      provider: providerId,
      model,
      temperature: 0,
      maxTokens: 4096,
      visibleLayers: [],
      peers: [],
      maxDepth: 3,
      enabled: true,
    },
    "executor-build": {
      id: "executor-build",
      kind: "executor",
      prompt: "You are a feature-building assistant.\nBreak down the request into subtasks, then implement.\nFollow project conventions. Write clean, tested code.",
      provider: providerId,
      model,
      temperature: 0,
      maxTokens: 4096,
      visibleLayers: [],
      peers: [],
      maxDepth: 3,
      enabled: true,
    },
    "executor-answer": {
      id: "executor-answer",
      kind: "executor",
      prompt: "You are a knowledgeable assistant.\nAnswer questions using project context and conventions.\nBe concise but thorough.",
      provider: providerId,
      model,
      temperature: 0,
      maxTokens: 4096,
      visibleLayers: [],
      peers: [],
      maxDepth: 3,
      enabled: true,
    },
  };

  config.sources = {
    "system-prompt": {
      id: "system-prompt",
      type: "inline",
      label: "System prompt",
      uri: "You are a helpful engineering assistant.\nFollow project conventions. Ask clarifying questions when requirements are ambiguous.\nWrite clean, tested code.",
      enabled: true,
    },
    "conventions-src": {
      id: "conventions-src",
      type: "file",
      label: "Conventions store",
      uri: ".foundry/memory",
      enabled: true,
    },
    "memory-src": {
      id: "memory-src",
      type: "file",
      label: "Working memory",
      uri: ".foundry/memory",
      enabled: true,
    },
  };

  return config;
}

// ---------------------------------------------------------------------------
// .env.local — additive, never clobbers existing keys
// ---------------------------------------------------------------------------

async function writeEnvLocal(envKey: string, apiKey: string, port?: string) {
  const lines: string[] = [];
  if (envKey && apiKey) lines.push(`${envKey}=${apiKey}`);
  if (port) lines.push(`VIEWER_PORT=${port}`);
  if (lines.length === 0) return;

  if (existsSync(".env.local")) {
    const existing = await Bun.file(".env.local").text();
    const newLines: string[] = [];
    for (const line of lines) {
      const key = line.split("=")[0];
      if (!existing.includes(key + "=")) {
        newLines.push(line);
      } else {
        // Replace existing key in-place
        const updated = existing.replace(
          new RegExp(`^${key}=.*$`, "m"),
          line,
        );
        await Bun.write(".env.local", updated);
        console.log(`  Updated ${key} in .env.local`);
      }
    }
    if (newLines.length > 0) {
      const current = await Bun.file(".env.local").text();
      await Bun.write(".env.local", current.trimEnd() + "\n" + newLines.join("\n") + "\n");
      console.log(`  Added ${newLines.map(l => l.split("=")[0]).join(", ")} to .env.local`);
    }
  } else {
    await Bun.write(".env.local", "# Foundry — generated by `bun run setup`\n" + lines.join("\n") + "\n");
    console.log("  Wrote .env.local");
  }
}

// ---------------------------------------------------------------------------
// Directory setup + memory seeding
// ---------------------------------------------------------------------------

async function ensureDirs() {
  mkdirSync(`${FOUNDRY_DIR}/memory`, { recursive: true });
  mkdirSync(`${FOUNDRY_DIR}/analytics`, { recursive: true });
}

async function seedMemory() {
  const seedFile = `${FOUNDRY_DIR}/memory/seed.json`;
  if (existsSync(seedFile)) return;

  await Bun.write(seedFile, JSON.stringify([
    { id: "conv-zod-validation", kind: "convention", content: "Validate API inputs with Zod schemas at system boundaries.", timestamp: Date.now() },
    { id: "conv-naming", kind: "convention", content: "Use snake_case for database columns, camelCase for TypeScript.", timestamp: Date.now() },
    { id: "conv-error-handling", kind: "convention", content: "Return structured errors with { error, code, detail } shape.", timestamp: Date.now() },
  ], null, 2));

  console.log("  Seeded .foundry/memory/");
}

// ---------------------------------------------------------------------------
// Done message
// ---------------------------------------------------------------------------

function printDone(config: FoundryConfig) {
  const port = process.env.VIEWER_PORT || "4400";
  console.log();
  console.log("  ── Ready ──");
  console.log();
  console.log("  Start Foundry:   bun run start");
  console.log("  Open viewer:     http://localhost:" + port);
  console.log("  Reconfigure:     bun run setup");
  console.log();
  console.log(`  ${Object.keys(config.agents).length} agents, ${Object.keys(config.layers).length} layers, ${Object.keys(config.sources).length} sources`);
  console.log();
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error("\n  Setup failed:", err.message ?? err);
  rl.close();
  process.exit(1);
});
