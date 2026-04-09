#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// Foundry MCP Server — standalone entrypoint
//
// Claude Code spawns this as a subprocess via --mcp-config or settings.json:
//
//   {
//     "mcpServers": {
//       "foundry": {
//         "command": "bun",
//         "args": ["run", "packages/foundry/src/mcp/cli.ts"],
//         "cwd": "/path/to/project"
//       }
//     }
//   }
//
// Loads the project's .foundry/settings.json, builds a thread with warm
// layers, and exposes the 5 MCP tools from FLOW.md Loop 2.
// ---------------------------------------------------------------------------

import { resolve } from "path";
import {
  Thread,
  ContextLayer,
  ContextStack,
  type ContextSource,
} from "@inixiative/foundry-core";
import { ConfigStore, type FoundryConfig } from "../viewer/config";
import { createFoundryMcpServer, startStdioTransport } from "./server";

// ---------------------------------------------------------------------------
// Load config
// ---------------------------------------------------------------------------

const projectDir = process.cwd();
const configDir = resolve(projectDir, ".foundry");
const configStore = new ConfigStore(configDir);
const config = configStore.load();

// ---------------------------------------------------------------------------
// Build layers from config
// ---------------------------------------------------------------------------

function configToSources(config: FoundryConfig): ContextLayer[] {
  const layers: ContextLayer[] = [];

  for (const [id, layerCfg] of Object.entries(config.layers)) {
    if (!layerCfg.enabled) continue;

    const sources: ContextSource[] = [];

    // Inline content
    if (layerCfg.source.type === "inline" && layerCfg.source.content) {
      sources.push({
        id: `${id}-inline`,
        load: async () => layerCfg.source.content!,
      });
    }

    // File-based content
    if (layerCfg.source.type === "file" && layerCfg.source.path) {
      const filePath = resolve(projectDir, layerCfg.source.path);
      sources.push({
        id: `${id}-file`,
        load: async () => {
          try {
            return await Bun.file(filePath).text();
          } catch {
            return `[Failed to load ${filePath}]`;
          }
        },
      });
    }

    // Markdown directory
    if (layerCfg.source.type === "markdown" && layerCfg.source.path) {
      const dirPath = resolve(projectDir, layerCfg.source.path);
      sources.push({
        id: `${id}-markdown`,
        load: async () => {
          try {
            const glob = new Bun.Glob("**/*.md");
            const files: string[] = [];
            for await (const file of glob.scan({ cwd: dirPath })) {
              const content = await Bun.file(resolve(dirPath, file)).text();
              files.push(`# ${file}\n\n${content}`);
            }
            return files.join("\n\n---\n\n");
          } catch {
            return `[Failed to scan ${dirPath}]`;
          }
        },
      });
    }

    if (sources.length === 0) {
      // Placeholder for other source types (sqlite, postgres, etc.)
      sources.push({
        id: `${id}-placeholder`,
        load: async () => `[Layer ${id}: source type "${layerCfg.source.type}" not yet supported in MCP CLI]`,
      });
    }

    layers.push(new ContextLayer({
      id,
      trust: layerCfg.trust ?? 0.5,
      sources,
      prompt: layerCfg.prompt,
      staleness: layerCfg.staleness,
    }));
  }

  return layers;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const layers = configToSources(config);
const stack = new ContextStack(layers);

// Warm all layers before accepting connections
await stack.warmAll();

const thread = new Thread("mcp-session", stack);
thread.meta.description = "MCP bridge session";
thread.meta.tags = ["mcp"];

const server = createFoundryMcpServer({
  thread,
  name: "foundry",
  version: "0.1.0",
});

// Start stdio transport — Claude Code communicates via stdin/stdout
await startStdioTransport(server);
