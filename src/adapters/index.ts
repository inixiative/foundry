// Built-in (zero deps)
export { FileMemory, fileSource, inlineSource, type MemoryEntry } from "./file-memory";
export { SqliteMemory, type SqliteEntry } from "./sqlite-memory";
export { MarkdownDocs, claudemdSource } from "./markdown-docs";
export { HttpMemory } from "./http-memory";

// Optional peer deps
export { RedisMemory, type RedisClient, type RedisEntry } from "./redis-memory";
