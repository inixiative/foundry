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
import { basename } from "path";
import { defaultConfig, type FoundryConfig, type ProjectPrompts } from "./viewer/config";
import { writeComposed, writeFileRef, RUNTIME_OUTPUT_FILES } from "./prompts/composer";

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
  { id: "claude-code", label: "Claude Code (CLI subscription — no API key)", envKey: "", defaultModel: "claude-sonnet-4-20250514" },
  { id: "anthropic", label: "Anthropic (API key)", envKey: "ANTHROPIC_API_KEY", defaultModel: "claude-sonnet-4-20250514" },
  { id: "openai", label: "OpenAI (GPT-4o)", envKey: "OPENAI_API_KEY", defaultModel: "gpt-4o" },
  { id: "gemini", label: "Google (Gemini)", envKey: "GEMINI_API_KEY", defaultModel: "gemini-2.5-flash" },
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

  // --- Project identity prompts ---
  console.log("\n  ── Project Identity ──\n");
  console.log("  This is the base description every AI model sees first.");
  console.log("  It gets composed into CLAUDE.md, .cursorrules, etc.\n");

  const projectName = await ask("Project name", basename(process.cwd()));
  const projectDesc = await ask("One-line description");

  if (projectName || projectDesc) {
    const prompts = await setupPrompts(projectName, projectDesc);
    // Store prompts in config for the project (will be linked to project on project creation)
    (config as any)._pendingPrompts = prompts;
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
    const hasPrompts = Object.values(config.projects).some(p => p.prompts);
    const idx = await choose("What would you like to configure?", [
      `Provider & defaults  (${config.defaults.provider} / ${config.defaults.model})`,
      `Prompts              (${hasPrompts ? "configured" : "not set up"})`,
      `Agents               (${c.agents} configured)`,
      `Layers               (${c.layers} configured)`,
      `Sources              (${c.sources} configured)`,
      `Projects             (${c.projects} configured)`,
      "Reset to starter config",
      "Done",
    ]);

    switch (idx) {
      case 0: await configureDefaults(config); break;
      case 1: await configurePrompts(config); break;
      case 2: await configureSection(config, "agents", agentEditor); break;
      case 3: await configureSection(config, "layers", layerEditor); break;
      case 4: await configureSection(config, "sources", sourceEditor); break;
      case 5: await configureSection(config, "projects", projectEditor); break;
      case 6: {
        if (await confirm("Replace config with starter defaults?", false)) {
          const providerId = config.defaults.provider as ProviderId;
          const model = config.defaults.model;
          const starter = buildStarterConfig(providerId, model);
          Object.assign(config, starter);
          console.log("  Config reset to starter defaults.");
        }
        break;
      }
      case 7: running = false; break;
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

  if (await confirm("\n  Change provider?", false)) {
    const { providerId, apiKey, model } = await pickProvider(config.defaults.provider as ProviderId);
    config.defaults.provider = providerId;
    config.defaults.model = model;

    if (apiKey) {
      const envKey = PROVIDERS.find(p => p.id === providerId)?.envKey;
      if (envKey) await writeEnvLocal(envKey, apiKey);
    }
  }

  const newModel = await ask("Model", config.defaults.model);
  if (newModel !== config.defaults.model) config.defaults.model = newModel;
}

// ---------------------------------------------------------------------------
// Agent editor
// ---------------------------------------------------------------------------

const agentEditor: ItemEditor<any> = {
  label: "Agents",
  summarize: (id, a) => {
    const layers = (a.visibleLayers?.length || 0) + (a.ownedLayers?.length || 0);
    const peers = a.peers?.length || 0;
    return `${id}  (${a.kind}, ${a.model || "default"}, ${layers} layers, ${peers} peers)${a.enabled ? "" : " [disabled]"}`;
  },
  async create(config) {
    console.log("\n  An agent is a named actor with a role — it reads layers, makes decisions,");
    console.log("  and can delegate to other agents.\n");

    const id = await ask("Agent ID (e.g. security-librarian, code-reviewer)");
    if (!id) return null;

    // Kind — explain each option
    console.log("\n  What kind of agent is this?");
    const kindIdx = await choose("Kind", [
      "executor — does real work (code, tools, full model)",
      "classifier — categorizes messages (cheap model, no tools)",
      "router — routes to the right agent (cheap model, no tools)",
      "domain-librarian — advises + guards a knowledge domain",
    ]);
    const kind = ["executor", "classifier", "router", "domain-librarian"][kindIdx];

    // Role description
    console.log("\n  What does this agent do? (saved as a description file)");
    const roleDesc = await ask("Role description");

    const prompt = await ask("System prompt", roleDesc);

    // Model — explain cheap vs capable
    if (kind === "executor") {
      console.log("\n  Executors use a capable model (Claude, GPT) for real work.");
    } else {
      console.log("\n  Classifiers, routers, and librarians should use a cheap/fast model");
      console.log("  (Gemini Flash, Haiku) — they make decisions, not produce artifacts.");
    }
    const model = await ask("Model", config.defaults.model);
    const temp = await ask("Temperature", "0");

    // Layers — what can this agent see and write?
    const layerIds = Object.keys(config.layers);
    let visibleLayers: string[] = [];
    let ownedLayers: string[] = [];

    if (layerIds.length > 0) {
      console.log("\n  Which layers can this agent READ? (its visible context)");
      console.log("  Available layers: " + layerIds.join(", "));
      const vis = await ask("Visible layers (comma-separated, empty = all)");
      if (vis) visibleLayers = vis.split(",").map(s => s.trim()).filter(Boolean);

      console.log("\n  Which layers can this agent WRITE? (its owned domain)");
      const own = await ask("Owned layers (comma-separated, empty = none)");
      if (own) ownedLayers = own.split(",").map(s => s.trim()).filter(Boolean);
    }

    // Peers — who can this agent delegate to?
    const agentIds = Object.keys(config.agents).filter(a => a !== id);
    let peers: string[] = [];
    if (agentIds.length > 0) {
      console.log("\n  Which agents can this agent delegate to?");
      console.log("  Available agents: " + agentIds.join(", "));
      const p = await ask("Peer agent IDs (comma-separated, empty = none)");
      if (p) peers = p.split(",").map(s => s.trim()).filter(Boolean);
    }

    // Write description file
    let description: string | undefined;
    if (roleDesc) {
      const descPath = `.foundry/agents/${id}.md`;
      const descContent = [
        `# ${id}`,
        "",
        roleDesc,
        "",
        `**Kind**: ${kind}`,
        `**Model**: ${model}`,
        visibleLayers.length > 0 ? `**Reads**: ${visibleLayers.join(", ")}` : "**Reads**: all layers",
        ownedLayers.length > 0 ? `**Writes**: ${ownedLayers.join(", ")}` : "**Writes**: none",
        peers.length > 0 ? `**Delegates to**: ${peers.join(", ")}` : "",
      ].filter(Boolean).join("\n") + "\n";

      mkdirSync(`${FOUNDRY_DIR}/agents`, { recursive: true });
      await writeFileRef(process.cwd(), descPath, descContent);
      description = descPath;
      console.log(`  Wrote ${descPath}`);
    }

    return [id, {
      id, kind, description, prompt,
      provider: config.defaults.provider,
      model,
      temperature: parseFloat(temp) || 0,
      visibleLayers,
      ownedLayers: ownedLayers.length > 0 ? ownedLayers : undefined,
      peers,
      maxDepth: kind === "executor" ? 5 : 1,
      tools: kind === "executor",
      enabled: true,
    }];
  },
  async edit(id, item, config) {
    console.log(`\n  Editing agent: ${id}\n`);
    if (item.description) console.log(`    Description: ${item.description}`);
    if (item.visibleLayers?.length) console.log(`    Reads: ${item.visibleLayers.join(", ")}`);
    if (item.ownedLayers?.length) console.log(`    Writes: ${item.ownedLayers.join(", ")}`);
    if (item.peers?.length) console.log(`    Delegates to: ${item.peers.join(", ")}`);
    console.log();

    item.prompt = await ask("System prompt", item.prompt);
    item.model = await ask("Model", item.model || config.defaults.model);
    item.temperature = parseFloat(await ask("Temperature", String(item.temperature))) || 0;
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
  summarize: (id, l) => {
    const shape = l.contentShape ? ` [${l.contentShape}]` : "";
    const writers = l.writers?.length ? ` writers: ${l.writers.join(",")}` : "";
    return `${id}  (trust: ${l.trust}${shape}${writers})${l.enabled ? "" : " [disabled]"}`;
  },
  async create(config) {
    console.log("\n  A layer is a knowledge shelf — a token-budgeted window into a domain.");
    console.log("  It holds warmed context that agents read when it's relevant.\n");

    const id = await ask("Layer ID (e.g. security-rules, api-docs)");
    if (!id) return null;

    // Job description — what is this layer for?
    console.log("\n  What knowledge domain does this layer cover?");
    console.log("  This becomes the layer's job description (saved to a file).\n");
    const jobDesc = await ask("Purpose (e.g. 'OWASP rules and auth patterns')");

    const prompt = await ask("Instruction prompt (how to use this layer's content)", jobDesc);
    const contentShape = await ask("Content shape (e.g. 'JSON array', 'Markdown index')", "");

    // Trust — explain in context
    console.log("\n  Trust (0-1): How reliable is this layer's content based on user feedback?");
    console.log("  1.0 = always correct (system instructions), 0.3 = needs validation (memory).");
    const trust = await ask("Trust", "0.5");

    // Staleness — explain in context
    console.log("\n  Staleness: How long (ms) before this layer needs re-warming?");
    console.log("  0 = never stale, 60000 = 1 min, 300000 = 5 min.");
    const staleness = await ask("Staleness ms", "0");

    // Activation
    console.log("\n  When should this layer be included in context?");
    const actIdx = await choose("Activation", [
      "always — included on every request (system, conventions)",
      "conditional — included when classification tags match",
      "on-demand — only when explicitly requested",
    ]);
    const activation = (["always", "conditional", "on-demand"] as const)[actIdx];

    // Writers — which agents can write to this layer?
    const writerIds: string[] = [];
    const agentIds = Object.keys(config.agents);
    if (agentIds.length > 0) {
      console.log("\n  Which agents can write to this layer? (empty = any agent)");
      console.log("  Available agents: " + agentIds.join(", "));
      const picked = await ask("Writer agent IDs (comma-separated, or empty for any)");
      if (picked) writerIds.push(...picked.split(",").map(s => s.trim()).filter(Boolean));
    }

    // Sources
    const sourceIds: string[] = [];
    const availableSources = Object.keys(config.sources);
    if (availableSources.length > 0 && await confirm("Attach data sources?", false)) {
      console.log("  Available sources: " + availableSources.join(", "));
      const picked = await ask("Source IDs (comma-separated)");
      if (picked) sourceIds.push(...picked.split(",").map(s => s.trim()).filter(Boolean));
    }

    // Write description file
    let description: string | undefined;
    if (jobDesc) {
      const descPath = `.foundry/layers/${id}.md`;
      const descContent = [
        `# ${id} Layer`,
        "",
        jobDesc,
        "",
        `**Activation**: ${activation}`,
        writerIds.length > 0 ? `**Writers**: ${writerIds.join(", ")}` : "**Writers**: any agent",
        contentShape ? `**Content shape**: ${contentShape}` : "",
      ].filter(Boolean).join("\n") + "\n";

      mkdirSync(`${FOUNDRY_DIR}/layers`, { recursive: true });
      await writeFileRef(process.cwd(), descPath, descContent);
      description = descPath;
      console.log(`  Wrote ${descPath}`);
    }

    return [id, {
      id, description, contentShape: contentShape || undefined, prompt, sourceIds,
      trust: parseFloat(trust) || 0.5,
      staleness: parseInt(staleness) || 0,
      activation,
      writers: writerIds.length > 0 ? writerIds : undefined,
      enabled: true,
    }];
  },
  async edit(id, item, config) {
    console.log(`\n  Editing layer: ${id}\n`);
    if (item.description) console.log(`    Description: ${item.description}`);
    if (item.contentShape) console.log(`    Content shape: ${item.contentShape}`);
    console.log();

    item.prompt = await ask("Prompt", item.prompt);
    item.contentShape = await ask("Content shape", item.contentShape || "") || undefined;
    item.trust = parseFloat(await ask("Trust (0-1)", String(item.trust))) || 0.5;
    item.staleness = parseInt(await ask("Staleness ms", String(item.staleness))) || 0;
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

  const model = await ask("Default model", provider.defaultModel);

  return { providerId: provider.id, apiKey, model };
}

// ---------------------------------------------------------------------------
// Prompts setup
// ---------------------------------------------------------------------------

const AVAILABLE_RUNTIMES = [
  { id: "claude", label: "Claude Code (CLAUDE.md)", file: "CLAUDE.md" },
  { id: "cursor", label: "Cursor (.cursorrules)", file: ".cursorrules" },
  { id: "codex", label: "Codex (CODEX.md)", file: "CODEX.md" },
] as const;

async function setupPrompts(projectName: string, projectDesc: string): Promise<ProjectPrompts> {
  mkdirSync(`${FOUNDRY_DIR}/prompts`, { recursive: true });

  // Write common identity file
  const commonContent = [
    `# ${projectName}`,
    "",
    projectDesc ? `${projectDesc}\n` : "",
  ].filter(Boolean).join("\n");

  await writeFileRef(process.cwd(), ".foundry/prompts/common.md", commonContent);
  console.log("  Wrote .foundry/prompts/common.md");

  const prompts: ProjectPrompts = {
    common: ".foundry/prompts/common.md",
  };

  // Ask which runtimes to generate for
  console.log("\n  Which AI tools do you use? (generates their config files)\n");
  const overrides: Record<string, string> = {};

  for (const rt of AVAILABLE_RUNTIMES) {
    const exists = existsSync(rt.file);
    const hint = exists ? " (file exists, will be managed by Foundry)" : "";
    if (await confirm(`  ${rt.label}${hint}?`)) {
      const overridePath = `.foundry/prompts/${rt.id}.md`;

      // Create a minimal override file
      const overrideContent = `# ${rt.label} — additional instructions\n\n`;
      if (!existsSync(overridePath)) {
        await writeFileRef(process.cwd(), overridePath, overrideContent);
        console.log(`  Wrote ${overridePath}`);
      }
      overrides[rt.id] = overridePath;
    }
  }

  if (Object.keys(overrides).length > 0) {
    prompts.overrides = overrides;
  }

  // Compose output files
  const runtimes = Object.keys(overrides).length > 0
    ? Object.keys(overrides)
    : Object.keys(RUNTIME_OUTPUT_FILES);
  const written = await writeComposed(process.cwd(), prompts, runtimes);
  for (const [rt, path] of written) {
    console.log(`  Composed ${RUNTIME_OUTPUT_FILES[rt]} from prompts`);
  }

  return prompts;
}

// ---------------------------------------------------------------------------
// Prompts editor (for configure loop)
// ---------------------------------------------------------------------------

async function configurePrompts(config: FoundryConfig) {
  // Find first project with prompts, or the first project
  const projects = Object.values(config.projects);
  if (projects.length === 0) {
    console.log("\n  No projects configured. Add a project first.\n");
    return;
  }

  const project = projects[0];
  const projectPath = project.path || process.cwd();

  console.log(`\n  ── Prompts (${project.label || project.id}) ──\n`);

  if (!project.prompts) {
    console.log("  No prompts configured for this project.");
    if (await confirm("  Set up prompts now?")) {
      const name = await ask("Project name", project.label || basename(projectPath));
      const desc = await ask("One-line description", project.description || "");
      project.prompts = await setupPrompts(name, desc);
    }
    return;
  }

  console.log(`    Common:    ${project.prompts.common}`);
  if (project.prompts.overrides) {
    for (const [rt, path] of Object.entries(project.prompts.overrides)) {
      console.log(`    ${rt}:${" ".repeat(Math.max(1, 9 - rt.length))}${path}`);
    }
  }

  const options = ["Add runtime override", "Recompose output files", "Back"];
  const idx = await choose("", options);

  if (idx === 0) {
    // Add a new runtime override
    const available = AVAILABLE_RUNTIMES.filter(
      rt => !project.prompts?.overrides?.[rt.id],
    );
    if (available.length === 0) {
      console.log("  All runtimes already configured.");
      return;
    }
    const rtIdx = await choose("Which runtime?", available.map(rt => rt.label));
    const rt = available[rtIdx];
    const overridePath = `.foundry/prompts/${rt.id}.md`;
    if (!existsSync(overridePath)) {
      await writeFileRef(projectPath, overridePath, `# ${rt.label} — additional instructions\n\n`);
    }
    if (!project.prompts.overrides) project.prompts.overrides = {};
    project.prompts.overrides[rt.id] = overridePath;
    console.log(`  Added ${rt.id} override: ${overridePath}`);
  } else if (idx === 1) {
    const written = await writeComposed(projectPath, project.prompts);
    for (const [rt] of written) {
      console.log(`  Composed ${RUNTIME_OUTPUT_FILES[rt]}`);
    }
  }
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
      enabled: true,
    },
    conventions: {
      id: "conventions",
      prompt: "Project conventions and coding standards.",
      sourceIds: ["conventions-src"],
      trust: 0.8,
      staleness: 60_000,
      enabled: true,
    },
    memory: {
      id: "memory",
      prompt: "Working memory — recent context, signals, decisions.",
      sourceIds: ["memory-src"],
      trust: 0.3,
      staleness: 30_000,
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
