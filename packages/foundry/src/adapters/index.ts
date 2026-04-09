// Lightweight adapters — re-exported from core
export {
  FileMemory,
  fileSource,
  inlineSource,
  type MemoryEntry,
} from "@inixiative/foundry-core";
export { SqliteMemory, type SqliteEntry } from "@inixiative/foundry-core";
export { MarkdownDocs, claudemdSource } from "@inixiative/foundry-core";
export { HttpMemory } from "@inixiative/foundry-core";

// Heavy-infra adapters (optional peer deps)
export { RedisMemory, type RedisClient, type RedisEntry } from "./redis-memory";
export { PostgresMemory } from "./postgres-memory";

// Hosted / SaaS
export { SupermemoryAdapter, type SupermemoryConfig } from "./supermemory";
