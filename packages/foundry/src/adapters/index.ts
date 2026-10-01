// Lightweight adapters — re-exported from core
export {
  claudemdSource,
  FileMemory,
  fileSource,
  HttpMemory,
  inlineSource,
  MarkdownDocs,
  type MemoryEntry,
  type SqliteEntry,
  SqliteMemory,
} from '@inixiative/foundry-core';
// Neural memory (self-hosted)
export { type MuninnConfig, MuninnMemory } from './muninn-memory';
export { PostgresMemory } from './postgres-memory';
// Heavy-infra adapters (optional peer deps)
export { type RedisClient, type RedisEntry, RedisMemory } from './redis-memory';
// Hosted / SaaS
export { SupermemoryAdapter, type SupermemoryConfig } from './supermemory';
