import { Thread, type ThreadConfig, ContextStack } from "@inixiative/foundry-core";
import type { RuntimeAdapter } from "../providers/runtime";
import type { ProjectSettingsConfig } from "../viewer/config";

// ---------------------------------------------------------------------------
// Project config — serializable, lives in the registry
// ---------------------------------------------------------------------------

export interface ProjectConfig {
  /** Unique project identifier. */
  id: string;
  /** Absolute path to project root directory. */
  path: string;
  /** Display label. */
  label: string;
  /** Categorization tags (e.g. "frontend", "production", "rust"). */
  tags: string[];
  /** Which runtime adapter to use for this project. */
  runtime: "claude-code" | "codex" | "cursor";
  /** Optional description of the project. */
  description?: string;
}

/** Convert a ProjectSettingsConfig (from config store) into a ProjectConfig. */
export function fromSettingsConfig(cfg: ProjectSettingsConfig): ProjectConfig {
  return {
    id: cfg.id,
    path: cfg.path,
    label: cfg.label,
    tags: cfg.tags,
    runtime: cfg.runtime,
    description: cfg.description,
  };
}

// ---------------------------------------------------------------------------
// Project — top-level container, owns threads
// ---------------------------------------------------------------------------

export type ProjectStatus = "active" | "idle" | "archived";

/**
 * A Project is the top-level container in Foundry.
 *
 * It represents a codebase/repo and owns:
 * - A directory path (the repo root)
 * - A runtime adapter (how to inject context into agent runtimes)
 * - Multiple threads (conversations/work streams within the project)
 * - Categorization tags for organizing across projects
 *
 * Each project maps to a directory on disk. The project's `.foundry/`
 * subdirectory holds per-project configuration, memory, and analytics.
 */
export class Project {
  readonly id: string;
  readonly path: string;
  label: string;
  tags: string[];
  readonly runtimeId: string;
  description: string;
  readonly createdAt: number;
  status: ProjectStatus;

  private _threads: Map<string, Thread> = new Map();
  private _runtimeAdapter?: RuntimeAdapter;

  constructor(config: ProjectConfig) {
    this.id = config.id;
    this.path = config.path;
    this.label = config.label;
    this.tags = [...config.tags];
    this.runtimeId = config.runtime;
    this.description = config.description ?? "";
    this.createdAt = Date.now();
    this.status = "idle";
  }

  // -- Runtime adapter --

  get runtimeAdapter(): RuntimeAdapter | undefined {
    return this._runtimeAdapter;
  }

  setRuntime(adapter: RuntimeAdapter): void {
    this._runtimeAdapter = adapter;
  }

  // -- Thread management --

  createThread(id: string, stack: ContextStack, opts?: ThreadConfig): Thread {
    if (this._threads.has(id)) {
      throw new Error(`Thread "${id}" already exists in project "${this.id}"`);
    }
    const thread = new Thread(id, stack, opts);
    this._threads.set(id, thread);
    this.status = "active";
    return thread;
  }

  addThread(thread: Thread): void {
    if (this._threads.has(thread.id)) {
      throw new Error(`Thread "${thread.id}" already exists in project "${this.id}"`);
    }
    this._threads.set(thread.id, thread);
    this.status = "active";
  }

  getThread(id: string): Thread | undefined {
    return this._threads.get(id);
  }

  removeThread(id: string): boolean {
    const thread = this._threads.get(id);
    if (thread) {
      thread.archive();
      this._threads.delete(id);
      if (this._threads.size === 0) this.status = "idle";
      return true;
    }
    return false;
  }

  get threads(): ReadonlyMap<string, Thread> {
    return this._threads;
  }

  get threadCount(): number {
    return this._threads.size;
  }

  /** Get all active (non-archived) threads. */
  activeThreads(): Thread[] {
    return [...this._threads.values()].filter(
      (t) => t.meta.status !== "archived"
    );
  }

  // -- Lifecycle --

  archive(): void {
    this.status = "archived";
    for (const thread of this._threads.values()) {
      thread.archive();
    }
  }

  // -- Summary for API/UI --

  summary(): ProjectSummary {
    const threads = [...this._threads.values()];
    const active = threads.filter((t) => t.meta.status !== "archived");
    return {
      id: this.id,
      path: this.path,
      label: this.label,
      tags: this.tags,
      runtime: this.runtimeId,
      description: this.description,
      status: this.status,
      threadCount: threads.length,
      activeThreadCount: active.length,
      createdAt: this.createdAt,
      lastActiveAt: threads.length > 0
        ? Math.max(...threads.map((t) => t.meta.lastActiveAt))
        : this.createdAt,
    };
  }

  // -- Serialization --

  toJSON(): ProjectConfig & { threadIds: string[]; createdAt: number; status: ProjectStatus } {
    return {
      id: this.id,
      path: this.path,
      label: this.label,
      tags: this.tags,
      runtime: this.runtimeId as ProjectConfig["runtime"],
      description: this.description,
      threadIds: [...this._threads.keys()],
      createdAt: this.createdAt,
      status: this.status,
    };
  }
}

export interface ProjectSummary {
  id: string;
  path: string;
  label: string;
  tags: string[];
  runtime: string;
  description: string;
  status: ProjectStatus;
  threadCount: number;
  activeThreadCount: number;
  createdAt: number;
  lastActiveAt: number;
}

// ---------------------------------------------------------------------------
// ProjectRegistry — manages multiple projects
// ---------------------------------------------------------------------------

/**
 * Central registry of all projects known to this Foundry instance.
 *
 * Projects are registered by path. The registry provides lookup,
 * tag-based filtering, and serialization for the config store.
 */
export class ProjectRegistry {
  private _projects: Map<string, Project> = new Map();

  register(config: ProjectConfig): Project {
    if (this._projects.has(config.id)) {
      throw new Error(`Project "${config.id}" already registered`);
    }
    const project = new Project(config);
    this._projects.set(config.id, project);
    return project;
  }

  get(id: string): Project | undefined {
    return this._projects.get(id);
  }

  /** Find project by directory path. */
  getByPath(path: string): Project | undefined {
    return [...this._projects.values()].find((p) => p.path === path);
  }

  remove(id: string): boolean {
    const project = this._projects.get(id);
    if (project) {
      project.archive();
      this._projects.delete(id);
      return true;
    }
    return false;
  }

  get all(): ReadonlyMap<string, Project> {
    return this._projects;
  }

  /** Filter projects by tag. */
  byTag(tag: string): Project[] {
    return [...this._projects.values()].filter((p) => p.tags.includes(tag));
  }

  /** Get all unique tags across all projects. */
  allTags(): string[] {
    const tags = new Set<string>();
    for (const project of this._projects.values()) {
      for (const tag of project.tags) tags.add(tag);
    }
    return [...tags].sort();
  }

  /** Summaries for all projects (for API/UI). */
  summaries(): ProjectSummary[] {
    return [...this._projects.values()].map((p) => p.summary());
  }

  /** Serialize the registry to config format. */
  toConfigs(): Record<string, ProjectConfig> {
    const configs: Record<string, ProjectConfig> = {};
    for (const [id, project] of this._projects) {
      configs[id] = {
        id: project.id,
        path: project.path,
        label: project.label,
        tags: project.tags,
        runtime: project.runtimeId as ProjectConfig["runtime"],
        description: project.description,
      };
    }
    return configs;
  }

  /** Load projects from config (accepts either ProjectConfig or ProjectSettingsConfig). */
  loadFromConfigs(configs: Record<string, ProjectConfig | ProjectSettingsConfig>): void {
    for (const config of Object.values(configs)) {
      if (!this._projects.has(config.id)) {
        // ProjectSettingsConfig has 'enabled' field; ProjectConfig doesn't
        const pc: ProjectConfig = "enabled" in config
          ? fromSettingsConfig(config as ProjectSettingsConfig)
          : config as ProjectConfig;
        if ("enabled" in config && !(config as ProjectSettingsConfig).enabled) continue;
        this.register(pc);
      }
    }
  }
}
