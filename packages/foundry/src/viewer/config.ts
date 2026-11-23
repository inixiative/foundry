/**
 * @atlas
 * @kind config
 * @partOf feature:viewer, primitive:settings
 */
import { existsSync, mkdirSync, watch } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  computeHash,
  createSerializedQueue,
  DECISION_MODEL,
  type Harness,
  type MemorySelectionPolicy,
  newId,
  REASONING_EFFORTS,
  ROLE_NAMESPACE_SEPARATOR,
  registryModel,
  SUBSCRIPTION_WORKER_MODELS,
  type VersionEntry,
  type VersionLog,
  validateMemorySelection,
} from '@inixiative/foundry-core';
import { configuredWardens } from '../agents/configured-wardens';
import { type LearningSettings, validateLearningSettings } from '../agents/learning-config';
import { THREAD_STATE_LAYER_ID } from '../agents/librarian';
import { isRoleLayerId } from '../agents/role-layers';
import { isThreadKnowledgeLayerId } from '../agents/warden';
import { WARDEN_BRIEF_NODES } from '../agents/warden-brief';
import type { GuardMode } from '../agents/warden-triggers';
import { AuditLog, type SourceVersion, settingsRow } from '../audit/audit-log';
import { type StageConfig, validateStages } from '../classify';
import {
  type ConversationSettingsInput,
  type FoundryConversationSettings,
  validateConversationSettings,
  validateFoundryConversationSettings,
} from '../conversations/types';
import { type FeedbackSettings, validateFeedbackSettings } from '../feedback/types';
import { SUBSCRIPTION_WORKERS, subscriptionWorker, workerName } from '../models/registry';
import {
  mergeVendorSettings,
  patchVendorSettings,
  type VendorSettingsMap,
  validateVendorSettings,
  vendorSettingsFromRegistry,
} from '../models/vendors';
import {
  COMPOSITION_SLOTS,
  type CompositionSettings,
  type CompositionSlot,
  isThreadRole,
  MAIN_ROLE,
  resolveInstructionLadder,
  validateCompositionSettings,
} from '../prompts/instruction-settings';
import { roleIdIn, roleNameIn, roleNamespace } from '../prompts/role-namespace';
import {
  type KingdomAccessSource,
  validateKingdomAccess,
} from '../providers/kingdom-access-client';
import {
  KingdomAuthentication,
  type KingdomInferenceAssignment,
  type KingdomInferenceSource,
} from '../providers/kingdom-authentication';
import { subscriptionRuntimeSchema } from '../providers/kingdom-client';
import {
  type KingdomIntegration,
  kingdomIntegrationsSchema,
  selectKingdomIntegration,
} from '../providers/kingdom-installation-connection';
import {
  NativeAuthentication,
  type NativeAuthenticationSource,
} from '../providers/native-authentication';
import {
  assertMainThreadLabs,
  type LoginPoolsSettings,
  POOLED_RUNTIMES,
  resolveSubscriptionPolicy,
  runtimeLogins,
  SUBSCRIPTION_DECISIONS,
  type SubscriptionSettings,
  validateLoginPools,
} from '../providers/subscription-policy';
import { type SchedulerSettings, validateSchedulerSettings } from '../scheduler/types';
import { type SecretsSettings, validateSecretsSettings } from '../secrets/scratch';

const GUARD_MODES: readonly GuardMode[] = ['per-turn', 'per-call'];
export type ThreadOnMerge = 'done' | 'auto-archive';
const THREAD_ON_MERGE: readonly ThreadOnMerge[] = ['done', 'auto-archive'];
/** Where the viewer's left rail goes once you start a thread from the Projects rail. */
export type AfterProjectStart = 'attention' | 'stay';
const AFTER_PROJECT_START: readonly AfterProjectStart[] = ['attention', 'stay'];

/**
 * Whether a message sent during a running turn steers into it (CORE-001): your project setting, then
 * the repository's `.foundry/project.json`, then Foundry-wide, then on.
 */
export function steerOnSend(config: FoundryConfig, projectId?: string): boolean {
  const project = projectId ? config.projects?.[projectId] : undefined;
  return (
    project?.steer ??
    (project ? readRepositorySettings(project.path)?.steer : undefined) ??
    config.steer ??
    true
  );
}

/** What a thread in `projectId` becomes when its branch merges: project, then Foundry-wide, then `done`. */
export function threadOnMerge(config: FoundryConfig, projectId?: string): ThreadOnMerge {
  return (
    (projectId && config.projects?.[projectId]
      ? effectiveProject(config, projectId)?.threadOnMerge
      : undefined) ??
    config.threadOnMerge ??
    'done'
  );
}

import type { ReasoningEffort } from '@inixiative/foundry-core';
import { writeFileAtomic } from '../client/private-file';
import type { ToolRules } from '../turns/tool-gate';
import {
  effectiveProject,
  type ResolvedLayerDefinition,
  type ResolvedProjectView,
  readRepositorySettings,
  resolveProjectView,
} from './config-resolve';
import { CUSTOM_UI_SLUG } from './theme-files';

// ---------------------------------------------------------------------------
// Settings config model — serializable representation of system configuration
// ---------------------------------------------------------------------------

/**
 * The full settings config. Serialized to disk as JSON.
 * Everything the UI can configure lives here.
 *
 * Two-tier model:
 * - Global level: defaults, providers, agents, layers, sources — shared baseline
 * - Project level: each project can inherit global settings or override per-field
 */
/** The glyphs a machine's icon may use (the viewer draws them). */
export const MACHINE_GLYPHS = [
  'anvil',
  'bolt',
  'leaf',
  'moon',
  'peak',
  'wave',
  'star',
  'hex',
] as const;
export type MachineGlyph = (typeof MACHINE_GLYPHS)[number];

const validMachineIcon = (icon: unknown): icon is { glyph: MachineGlyph; color: number } =>
  !!icon &&
  typeof icon === 'object' &&
  Object.keys(icon).every((k) => k === 'glyph' || k === 'color') &&
  MACHINE_GLYPHS.includes((icon as { glyph: MachineGlyph }).glyph) &&
  Number.isInteger((icon as { color: unknown }).color) &&
  (icon as { color: number }).color >= 0 &&
  (icon as { color: number }).color <= 11;

export interface FoundryConfig {
  /** Opt in to API-key providers (paid tokens). Absent or false: subscription-only, and no API provider is constructed. */
  apiTokens?: boolean;
  /**
   * This Foundry's own conversation settings: `joining`, the conversation permissions and outbound
   * setting someone joining its threads starts with, per audience (built in: in your orgs every
   * permission but `agent.act`; outside `member.log`, `member.wake`, `member.take` and
   * `member.agent`; outbound `review` for both). A project's floor, conch and the rest are `projects.<id>.conversations`.
   */
  conversations?: FoundryConversationSettings;
  /**
   * Global and scope schedules (Forge Master, Feedback): work this Foundry starts on its own, each run
   * a thread. A project's are `projects.<id>.scheduler`. Local only: never in a repository.
   */
  scheduler?: SchedulerSettings;
  /** Subscription-mode overrides; every field has a default. See docs/subscription-decisions.md. */
  subscriptionOnly?: SubscriptionSettings;
  /** Structural tool rules: the only tool denials, held in every permission mode (turns/tool-gate.ts). */
  toolRules?: ToolRules;
  /** Credential references only; do not put tokens in settings. Several of one runtime are a pool. */
  nativeAuthentication?: NativeAuthenticationSource[];
  /**
   * How a runtime with several logins balances them (Aron, 2026-11-02: "a balancing toggle… like a
   * scale"): `routing` (default `quartile-balanced`; `pinned` is balancing off) and the login
   * `owner-first` or `pinned` prefers. A project's `subscriptionPools` overrides it.
   */
  subscriptionPools?: LoginPoolsSettings;
  /** Kingdom subscription pools this Foundry draws main-thread logins from: one per owner's Signet (URL, credential file, pool selection). */
  kingdomInference?: KingdomInferenceSource[];
  /** Project-scoped integration grants. Independent of inference resource selection. Restart to apply. */
  kingdomAccess?: KingdomAccessSource[];
  /** Which Kingdom owner's pool (and spread or selection) a given thread draws its login from, by thread id. */
  kingdomInferenceAssignments?: Record<string, KingdomInferenceAssignment>;
  /** Explicit thread-to-source UUID assignments, applied on Foundry startup. */
  nativeAuthenticationSelections?: Record<string, string>;
  /** Background domain review phase; does not override decision or executor profiles. */
  learning?: LearningSettings;
  /** The feedback lifecycle: capture, tuning prompts and the role-file changes they apply (docs/FEEDBACK-LOOP.md). */
  feedback?: FeedbackSettings;
  /** `$$word` secrets lifted into the thread's scratch pad, and paths no agent reads (FEAT-005). On by default. */
  secrets?: SecretsSettings;
  /** The local journal (docs/THREAD-TREE.md spec A). */
  journal?: JournalSettings;
  /**
   * How often the Wardens' guard fires: `per-turn` (default), once over a turn's whole tool activity
   * when the turn's tool activity ends; or `per-call`, on each tool call (Aron, 2026-10-15).
   */
  guard?: GuardMode;
  /**
   * What a thread becomes when its branch merges (Aron, 2026-11-01): `done` (default; the thread
   * shows done and can take another task) or `auto-archive` (archived, its worktree released per
   * FEAT-003). A project's `threadOnMerge` overrides it.
   */
  threadOnMerge?: ThreadOnMerge;
  /**
   * When you send while a thread's turn runs (CORE-001, Aron 2026-11-01): `true` (default) steers the
   * message into that turn; `false` queues it after. A queued message can always be steered in with
   * "Steer now". A project's `steer` (yours, then the repository's) overrides it.
   */
  steer?: boolean;
  /**
   * Where the viewer's left rail goes once you start a thread from the Projects rail (Aron,
   * 2026-11-14): `attention` (default) returns to the Attention list, `stay` keeps Projects.
   */
  afterProjectStart?: AfterProjectStart;
  /**
   * The composition view: one ladder (CLAUDE.md, AGENTS.md, auto memory, role files) composes the
   * instructions and domain knowledge of every role; see docs/usage-and-context.md.
   */
  composition?: CompositionSettings;
  /** Global defaults: executor provider/model + decision provider/model. */
  defaults: {
    /** The provider new threads run on (e.g. `claude-code`, `codex`). */
    provider: string;
    /** The model new threads run on. */
    model: string;
    /** Which local login (a native authentication source) threads use by default. */
    nativeAuthenticationId?: string;
    /** Which Kingdom owner's subscription pool threads use by default. */
    kingdomOwnerKey?: string;
    /** Reasoning effort for Codex threads; omitted, Codex's own default. */
    codexEffort?: ReasoningEffort;
    /** The decision roles' provider (Wardens, feedback routing); omitted, the decision default. */
    decisionProvider?: string;
    /** The decision roles' model; omitted, the decision default. */
    decisionModel?: string;
  };

  /**
   * Vendors (keyed by vendor id: anthropic, openai, google, ...), each with an on/off switch and its
   * subscription and API modes (models/vendors.ts).
   */
  vendors: VendorSettingsMap;

  /** This Foundry's installation name: what Kingdom pairing names it. Default "Foundry on <host>". */
  installationName?: string;
  /** This machine's icon where machines are shown (Watchtower actors, Watching): a glyph and a slot of the theme's categorical palette (`--layer-0` to `--layer-11`). */
  installationIcon?: {
    /** The icon's shape (anvil, bolt, leaf, moon, peak, wave, star, hex). */
    glyph: MachineGlyph;
    /** The icon's colour: a slot of the theme's categorical palette, 0 to 11. */
    color: number;
  };
  /** The message box: one box with a destination label (Thread · /btw · /aside), or a box per open view. */
  messageBox?: {
    /** Show a message box per open view (Thread, /btw, /aside) instead of one box with a destination label. */
    separateViews?: boolean;
  };
  /** Personal viewer customization: color scheme, custom theme, opt-in local extensions, per-slot layout, cross-pane tab placement, and component display flags. Local only. */
  ui?: UiSettingsConfig;

  /**
   * Global agent templates (keyed by agent ID).
   * Projects inherit these by id; a project override of the same id wins.
   * A fresh install is seeded from defaultAgents(): one executor.
   */
  agents: Record<string, AgentSettingsConfig>;

  /**
   * Global layer templates (keyed by layer ID).
   * Projects inherit these by id; a project override of the same id wins.
   * A fresh install has none: a thread is unwrapped until one is configured.
   */
  layers: Record<string, LayerSettingsConfig>;

  /**
   * Global data source templates (keyed by source ID).
   * On a fresh install this is empty: sources are project-scoped.
   */
  sources: Record<string, DataSourceConfig>;

  /** Registered projects (keyed by project ID). */
  projects: Record<string, ProjectSettingsConfig>;

  /** Every Kingdom integration this Foundry is paired as, once per Kingdom + owner; Signets stay in private files. */
  kingdomIntegrations?: KingdomIntegration[];
  /**
   * Paired Kingdoms (by URL) that may not open this Foundry's viewer. A paired Kingdom may unless it
   * is listed. Changed only on this machine (`POST /api/kingdom/viewer`), never through a Kingdom.
   */
  kingdomViewerRefused?: string[];

  /** Whether the initial setup wizard has been completed. */
  setupComplete?: boolean;
}

/**
 * Project configuration — points to a directory. That's it.
 *
 * The only required input is `path`. Everything else is derived:
 * - id: derived from directory basename (e.g., "/Users/me/my-app" → "my-app")
 * - label: derived from id or package.json name
 * - tags: auto-detected from project contents (has package.json → "node", etc.)
 *
 * Provider/runtime is NOT a project concern — threads and agents choose that.
 * Projects just say "here's a directory" and optionally override agents/layers.
 */
export interface ProjectSettingsConfig {
  /** This project's `threadOnMerge`, over the Foundry-wide one. */
  threadOnMerge?: ThreadOnMerge;
  /** Your `steer` for this project, over the repository's `.foundry/project.json` and the Foundry-wide one. */
  steer?: boolean;
  /** Opt-in maintenance; existing margins remain readable when disabled. */
  gloss?: {
    /** Keep this project's gloss (margin commentary beside the code) maintained. */
    enabled: boolean;
    /** How gloss shows beside the code: in the margin, on hover, or inline. */
    display: 'margin' | 'hover' | 'inline';
  };
  /** Auto-generated UUID. Never manually specified. */
  id: string;
  /** Path to project root directory. The only truly required field. */
  path: string;
  /** Display label. Defaults to id. */
  label?: string;
  /** Categorization tags. Auto-detected if omitted. */
  tags?: string[];
  /** Optional description. */
  description?: string;
  /** Override global defaults for this project. Omitted fields inherit from global. */
  defaults?: Partial<FoundryConfig['defaults']>;
  /** Project tool rules: a capability here overrides the global one; protected paths add up. */
  toolRules?: ToolRules;
  /** Project feedback settings: each field overrides the global one. */
  feedback?: FeedbackSettings;
  /** Project secrets settings: `scratchPad` overrides the global one; `privatePaths` add up. */
  secrets?: SecretsSettings;
  /**
   * Project agents. Each is standalone (a full definition, replacing any global agent of the same id)
   * or `extends` a global agent. No entry: the global agent applies unchanged.
   */
  agents?: Record<string, ProjectAgentSettings>;
  /**
   * Project-specific layer overrides (merged over global layers).
   * Scalar fields override directly.
   * List fields use explicit patch objects: { replace } or { append/remove }.
   */
  layers?: Record<string, LayerSettingsOverride>;
  /** Project-specific sources (merged over global sources). */
  sources?: Record<string, DataSourceConfig>;
  /** Whether this project is enabled. Default: true. */
  enabled?: boolean;
  /**
   * `archived`: hidden from the viewer's project list until unarchived; its settings and threads are
   * kept and it still runs. Absent: live, its runtime status (active or idle) derived from its threads.
   */
  status?: 'archived';
  /**
   * This project's Wardens: each knows one topic of the project and reminds its threads what
   * already exists and where it's written down. Merged over the repository's own
   * `<project>/.foundry/project.json` `chorus`, these settings winning. Wardens run only when `enabled`
   * is true; absent, the project has no Wardens and topics present are reported as off. In
   * a resolved project view this is normalized (`enabled` effective, `layers` absolute); see
   * docs/usage-and-context.md, "Chorus".
   */
  chorus?: ChorusSettings;
  /**
   * This project's agent conversations (docs/reference/CONVERSATIONS.md §4.6): floor mode, depth
   * bound and conch, over the repository's `conversations`, each thread's own overrides last.
   */
  conversations?: ConversationSettingsInput;
  /** This project's schedules: each run a thread in the project. This machine's only, never committed. */
  scheduler?: SchedulerSettings;
  /** Where main threads get their subscription: this machine's login (`local`, the default) or a Kingdom pool. */
  capacity?: 'local' | 'kingdom';
  /** How this project's threads balance this machine's logins, per runtime; over the Foundry-wide `subscriptionPools`. */
  subscriptionPools?: LoginPoolsSettings;
  /** Required when `capacity` is `kingdom`. */
  kingdomCapacity?: ProjectKingdomCapacity;
  /** The one Kingdom project this Foundry project links to (Aron, 2026-11-01); its pool chooses a Kingdom-capacity login. */
  kingdomProject?: ProjectKingdomLink;
}

/** One layer of a project's chorus: a regions directory (`<dir>/<region id>/{region.json,knowledge.md}`). */
export interface ChorusLayerSettings {
  /** Absolute, or relative to the project. */
  regions: string;
  /** Names the layer in the view, the startup log and the journal; default `layer-<n>`. */
  label?: string;
}

/**
 * A project's chorus, the set of region Wardens its threads run (Aron, 2026-10-15: "each project needs
 * its own chorus"). Region Wardens are the only chorus: the hand-named settings roster was retired on
 * 2026-10-17 (Aron: "We're just doing the region wardens"). Opt-in (Aron, 2026-10-16): `enabled: true`
 * builds it from layers of regions, in order: a region id present in a later layer replaces the earlier
 * one whole; unique ids union. One layer is `regions` (default `.foundry/regions`); several are
 * `layers`, e.g. a template base then this project's delta. Not enabled, or enabled with no regions
 * found, the project has no chorus and the view says why; `regions`/`layers` may stay written, unread.
 */
export interface ChorusSettings {
  /** Run this project's Wardens. Off by default. */
  enabled?: boolean;
  /** The one topics folder the Wardens read (absolute or relative to the project; default `.foundry/regions`). */
  regions?: string;
  /** Several topics folders in order, a later layer's topic replacing an earlier one (e.g. template base, then this project). */
  layers?: ChorusLayerSettings[];
  /** The `consumed` trigger: Wardens are asked when a thread takes in a work item. Off by default. */
  consumed?: ConsumedSettings;
  /**
   * The reception charter (`CHORUS_RECEPTION`): how the main thread reads a Warden's
   * reminder, held once as a standing layer. On with the Wardens (themselves opt-in); `false` leaves it out, e.g. for a baseline.
   */
  reception?: boolean;
  /**
   * How the Wardens classify (classify/): their stages, at most three. Omitted, the
   * two-layer chain: Haiku 5.5 low answers with its why inline and escalates each yes, without the why,
   * to Sonnet 5.5 low on the same knowledge.md (Oracle finding 2026-11-01-l2-nowhy); with API-token
   * decisions, one stage. The machine's list replaces the repository's whole.
   */
  wardens?: WardenSettings;
  /** How Herald topics would classify: the socket only. Heralds are not built; their topics do not run. */
  heralds?: ChorusRoleSettings;
}

/** One role's classification settings in a chorus. */
export interface ChorusRoleSettings {
  /**
   * Its stages, each `{ model?, effort?, doc?, outcomes?, reason?, task?, pointer?, escalate?,
   * carryWhy?, deadline? }`.
   */
  stages?: StageSettings[];
}

/** How the Wardens classify, and what each answered call is asked after its decision. */
export interface WardenSettings extends ChorusRoleSettings {
  /**
   * After a region Warden's decision is journalled, ask its last answering stage "why did you answer
   * that?" with the stage's own exchange resent inline (classify `FOLLOWUP_QUESTION`), unless that
   * stage's own follow-up gave it: its own call at the lowest priority, never on a held spare, journalled and archived beside the
   * one it explains, never delaying it. On unless `false` (Aron, 2026-11-18: it stays on for now).
   */
  debugReason?: boolean;
}

/** A stage as written in settings: any field omitted takes the default stage's (classify `DEFAULT_STAGE`). */
export type StageSettings = { [K in keyof StageConfig]?: StageConfig[K] };

/**
 * The `consumed` trigger (Aron, 2026-10-17): when a thread takes in a work item (reads a ticket or spec
 * file, fetches a Linear issue or a Notion page), every Warden is asked what of its domain the work
 * touches, so an over-specified ticket meets the existing systems before the build. Off unless
 * `enabled`; each key the machine's settings give wins over the repository's.
 */
export interface ConsumedSettings {
  /** Ask the Wardens when a thread takes in a work item (a ticket, spec or issue it read). Off by default. */
  enabled?: boolean;
  /** Globs on a tool's name; a matching call's output is the work item. Default `DEFAULT_CONSUMED_TOOLS`. */
  tools?: string[];
  /** Globs on a read file's path, relative to the project; the file is the work item. Default `DEFAULT_CONSUMED_PATHS`. */
  paths?: string[];
  /** The work item is clipped to this many characters, with a marker. Default 12,000. */
  maxChars?: number;
}

/** A Kingdom-capacity project: the paired Kingdom and the Signet (`subscription.use`) it runs under. The
 * Kingdom project whose pool chooses the login is the project's `kingdomProject` (absent: the Signet's own). */
export interface ProjectKingdomCapacity {
  /** Paired Kingdom id or API origin (`bun run kingdom status`). */
  kingdom: string;
  /** The Kingdom Signet that grants this project its subscription pool (`subscription.use`). */
  signetId: string;
}

/** A Foundry project's link to its Kingdom project: one per Foundry project. */
export interface ProjectKingdomLink {
  /** Paired Kingdom id or API origin (`bun run kingdom status`). */
  kingdom: string;
  /** The Kingdom project's id. */
  projectId: string;
}

/**
 * Explicit patch operations for list-valued project overrides.
 * Use `replace` to own the full list, or `append`/`remove` to modify the inherited list.
 */
export type ListPatch<T> =
  | { replace: T[] }
  | { append: T[]; remove?: T[] }
  | { append?: T[]; remove: T[] };

/**
 * Browser-specific configuration for agents with browser access.
 */
export interface BrowserConfig {
  /** Browser interaction mode. */
  mode: 'playwright-mcp' | 'js-execute' | 'hybrid';
  /** Whether to share authenticated browser sessions across agents. */
  shareSession?: boolean;
  /** Allowed URL patterns (glob). Empty = allow all. */
  allowedUrls?: string[];
  /** Blocked URL patterns (glob). Takes precedence over allowedUrls. */
  blockedUrls?: string[];
  /** Whether to capture screenshots for context. */
  screenshots?: boolean;
  /** Max page loads per dispatch (prevent runaway navigation). */
  maxNavigations?: number;
}

export interface BrowserConfigOverride
  extends Omit<Partial<BrowserConfig>, 'allowedUrls' | 'blockedUrls'> {
  allowedUrls?: ListPatch<string>;
  blockedUrls?: ListPatch<string>;
}

/**
 * Agent kinds. Executors are thread agents. A Warden (`warden`) is never written in settings: each is generated from a project's regions
 * (`agents/region-roster.ts`), so it appears only in a project view. The Librarian is programmatic and the Herald is not
 * wired, so neither takes settings.
 */
export const AGENT_KINDS = ['executor', 'warden'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];
/** The kinds settings may declare: a Warden is generated, never written. */
const SETTINGS_AGENT_KINDS: readonly AgentKind[] = ['executor'];

export interface AgentSettingsConfig {
  /** The agent's id: its key in `agents`, and how projects extend or override it. */
  id: string;
  /** What the agent does in a turn: `executor`, or `warden` for a generated Warden. */
  kind: AgentKind;
  /** Domain this agent operates in (e.g., "docs", "security", "cross-thread"). */
  domain?: string;
  /**
   * Human-readable description of this agent's role and responsibilities.
   * File path relative to project root (e.g., ".foundry/agents/executor.md").
   * Explains: what this agent does, which layers it reads/writes, who it delegates to, why.
   */
  description?: string;
  /** System prompt for this agent. Empty for an executor: a main thread's instructions come from its thread role. */
  prompt: string;
  /** LLM settings: provider/model default to global if omitted. */
  provider?: string;
  /** The model this agent runs on; omitted, the global default model. */
  model?: string;
  /** Temperature, set per agent. Decisions want 0, creative agents want higher. */
  temperature?: number;
  /**
   * Warden: source ids its domain knowledge composes from, before the composition view's files
   * (docs/usage-and-context.md, "Composition view"). A project extension appends its own.
   */
  domainKnowledge?: string[];
  /** Tool names that trigger this configured Warden's post-action guard. [] disables guards. */
  guardTriggers?: string[];
  /** Whether this agent can use tools (true) or is text-only (false). Default: true. */
  tools?: boolean;
  /** Extended thinking / reasoning effort. "none" | "low" | "medium" | "high" | number (budget tokens). */
  thinking?: 'none' | 'low' | 'medium' | 'high' | number;
  /** Permission level for code execution runtimes. Default: "bypass". */
  permissions?: 'bypass' | 'restricted';
  /** Browser-specific config. */
  browser?: BrowserConfig;
  /** Per-call timeout in ms. */
  timeout?: number;
  /** Enable prompt caching for this agent. */
  cacheControl?: boolean;
  /** Whether this agent is active. */
  enabled: boolean;
  /**
   * When this agent runs in the pipeline:
   * - "always": runs on every request
   * - "on-demand": available but only invoked when middleware explicitly requests it
   */
  invocation?: 'always' | 'on-demand';
}

/** Instructions and domain knowledge are the two composable chunks of a project Warden. */
export type AgentChunk = 'instructions' | 'domainKnowledge';

/**
 * A project agent composed with a global one. Instructions (`prompt`) and domain knowledge
 * (`domainKnowledge`, its sources) are appended to the parent's under
 * a heading per chunk; a chunk named in `override` replaces the parent's instead. Identity
 * (kind, role, domain) is the parent's; other fields override, lists patch.
 */
export interface AgentExtension
  extends Omit<
    Partial<AgentSettingsConfig>,
    'id' | 'kind' | 'domain' | 'guardTriggers' | 'browser'
  > {
  /** Global agent id. */
  extends: string;
  domainKnowledge?: string[];
  override?: AgentChunk[];
  guardTriggers?: ListPatch<string>;
  browser?: BrowserConfigOverride | null;
}

export type ProjectAgentSettings = AgentSettingsConfig | AgentExtension;

export const isAgentExtension = (agent: ProjectAgentSettings): agent is AgentExtension =>
  'extends' in agent;

/**
 * Layer definition in settings — the blueprint for a domain's context layer.
 *
 * This is the DEFINITION (policy, sources, defaults). At runtime, the ThreadFactory
 * creates ContextLayer INSTANCES from these definitions. The distinction matters:
 *
 * - Feedback that changes a definition affects all future instances:
 *   "conventions should include X" → update this config.
 * - Feedback that changes an instance affects only that thread:
 *   "this thread's convention cache is stale" → runtime mutation, not config.
 *
 * Agents relate to layers as readers, writers, or both:
 * - Wardens: own no configured layer (their knowledge is private, composed from their region)
 * - Librarian: WRITES the thread-state layer (sole writer)
 * - Executor (Claude Code): READS assembled context from all active layers
 */
export interface LayerSettingsConfig {
  /** The layer's id: its key in `layers`, and how projects and agents refer to it. */
  id: string;
  /** The domain this layer holds knowledge for. A Warden owns no configured layer: its knowledge
   * comes from its region. */
  domain?: string;
  /**
   * Human-readable description of this layer's job in the system.
   * File path relative to project root (e.g., ".foundry/layers/conventions.md").
   * Explains: what knowledge domain it covers, when it's relevant, who writes to it,
   * what the warmed content looks like.
   */
  description?: string;
  /** Instruction prompt for this layer. */
  prompt: string;
  /**
   * Semantic segment of the layer's CONTENT in the reading view. Optional: a
   * configured layer without it keeps the legacy id-based classification. Only
   * "domain-knowledge" (configured/published cache) or "thread-knowledge"
   * (generated, thread-private) are accepted; the prompt is always an instruction.
   */
  segment?: 'domain-knowledge' | 'thread-knowledge';
  /** Data source IDs that feed this layer. */
  sourceIds: string[];
  /** Staleness threshold in ms (0 = never stale). */
  staleness: number;
  /** Agent IDs that can write to this layer. Undefined = any agent. */
  writers?: string[];
  /** Whether this layer definition is enabled. */
  enabled: boolean;
  /**
   * When instances of this layer are included in context assembly:
   * - "always": included on every request
   * - "on-demand": only included when middleware explicitly requests it
   */
  activation?: 'always' | 'on-demand';
}

export interface LayerSettingsOverride
  extends Omit<Partial<LayerSettingsConfig>, 'sourceIds' | 'writers'> {
  /** Change the layer's data sources for this project: replace the list, or append and remove ids. */
  sourceIds?: ListPatch<string>;
  /** Change which agents may write the layer in this project: replace, or append and remove ids. */
  writers?: ListPatch<string>;
}

export interface DataSourceConfig {
  /** The source's id: its key in `sources`, and how layers name it in `sourceIds`. */
  id: string;
  /** Where the content comes from: a file, database, URL, markdown, inline text, the Archive, or instruction files. */
  type:
    | 'file'
    | 'sqlite'
    | 'postgres'
    | 'redis'
    | 'http'
    | 'markdown'
    | 'inline'
    | 'supermemory'
    | 'archive'
    | 'instructions';
  /**
   * Instruction sources only (`uri` is unused): which slot of the thread's role composition the
   * source returns. Default "instructions". Who it is for is the thread role's audience, else
   * `composition.roles["thread:main"].audience`.
   */
  slot?: CompositionSlot;
  /** Searches the local Archive for this project; `uri` is unused. */
  archive?: {
    /** The Archive project whose captured sessions are searched. */
    projectId: string;
    /** Most tokens of matching session text taken per search (128 to 16,000; default 2,048). */
    budget?: number;
  };
  /** The source's display name in Settings and the layer view. */
  label: string;
  /** Connection string, file path or URL, depending on type. */
  uri: string;
  /** Whether this source is enabled. */
  enabled: boolean;
  /**
   * Memory-backed ("file") sources only. Widest visibility this source
   * exposes to a thread: "thread" (default) = the thread's own captures plus
   * project/global publications; "project" = publications only;
   * "global" = globally published knowledge, identical for every project.
   */
  scope?: 'thread' | 'project' | 'global';
  /**
   * Memory-backed sources only. Also expose unowned legacy records written
   * before ownership existed. Off by default: legacy records are preserved
   * on disk but never become shared knowledge implicitly.
   */
  includeUnowned?: boolean;
  /**
   * Memory-backed sources only. Bounded automatic selection is on by default:
   * pinned kinds always, records relevant to the current message, a few recent
   * captures, and an explicit account of what was left out. Override fields of
   * the policy here, or set `false` to inject the full formatted log.
   */
  selection?: false | Partial<MemorySelectionPolicy>;
}

/** Per-slot layout overrides for a viewer surface: pinned items, custom order, and hidden item ids. */
export interface UiSlotOverride {
  /** Item ids in preferred order; unlisted new built-ins still appear after these. */
  order?: string[];
  /** Item ids hidden from this slot. */
  hidden?: string[];
  /** Item ids pinned at the start of this slot. */
  pinned?: string[];
}

/** Viewer color scheme preference: `dark` (default), `light`, or `system` (follow OS preference). */
export type UiColorScheme = 'dark' | 'light' | 'system';
export const UI_COLOR_SCHEMES: readonly UiColorScheme[] = ['dark', 'light', 'system'];

/** Side of the workspace a side-panel tab is placed on. */
export type UiPanelSide = 'left' | 'right';
export const UI_PANEL_SIDES: readonly UiPanelSide[] = ['left', 'right'];

/** Personal viewer customization: color scheme, custom theme, opt-in local extensions, slot layout, cross-pane tab placement, and component flags. */
export interface UiSettingsConfig {
  /** Viewer color scheme: `dark` (default), `light`, or `system` (follow OS preference). */
  colorScheme?: UiColorScheme;
  /** Named custom theme slug under `<configDir>/ui/themes/<slug>.css`, or null to use default `theme.css`. */
  theme?: string | null;
  /** Explicit opt-in list of local extension ids under `<configDir>/ui/extensions/` to load in the viewer. */
  extensions?: string[];
  /** Per-slot layout overrides (`order`, `hidden`, `pinned`) keyed by slot id. */
  slots?: Record<string, UiSlotOverride>;
  /**
   * Cross-pane tab placement overrides keyed by registered side-panel tab id (`'left'` or `'right'`).
   * Moving a registered side-panel tab ID to `'left'` or `'right'` keeps it receiving upstream component updates on whichever side it sits on.
   */
  panelPlacement?: Record<string, UiPanelSide>;
  /** Per-component display and behavior toggles, keyed by component id then flag name. */
  flags?: Record<string, Record<string, boolean | string | number>>;
}

// ---------------------------------------------------------------------------
// Project creation helper — just give it a path
// ---------------------------------------------------------------------------

/** Create a project config from just a path. Everything else is derived. */
export function createProject(
  projectPath: string,
  overrides?: Partial<Omit<ProjectSettingsConfig, 'id' | 'path'>>,
): ProjectSettingsConfig {
  return {
    id: newId('proj'),
    path: projectPath,
    label: overrides?.label ?? basename(projectPath),
    enabled: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Default config with sensible starting values
// ---------------------------------------------------------------------------

export function defaultConfig(): FoundryConfig {
  return {
    defaults: {
      provider: 'claude-code',
      model: 'fable',
      decisionProvider: SUBSCRIPTION_DECISIONS,
      decisionModel: DECISION_MODEL,
    },
    vendors: vendorSettingsFromRegistry(),
    agents: {},
    layers: {},
    sources: {},
    projects: {},
  };
}

/**
 * Starter config — minimal bootstrap for new installations.
 * Only sets providers + model defaults. NO agents, layers, or sources: a fresh install's one agent
 * comes from defaultAgents(), and layers, sources and decision roles are opt-in settings.
 * Used by auto-bootstrap when no config exists.
 */
export function starterConfig(
  providerId: string = 'claude-code',
  model: string = 'fable',
): FoundryConfig {
  const config = defaultConfig();
  config.defaults.provider = providerId;
  config.defaults.model = model;
  if (!subscriptionWorker(providerId)) {
    // Subscription mode runs the worker on Claude Code or Codex; any other worker is the API-token mode.
    config.apiTokens = true;
    delete config.defaults.decisionProvider;
    delete config.defaults.decisionModel;
  }
  config.setupComplete = false;
  return config;
}

/** The id of the one agent a fresh install has. */
export const DEFAULT_EXECUTOR_ID = 'executor';

/**
 * The agents a fresh install has: one executor with no instructions of its own, no provider and no
 * model, so it inherits the defaults and the user's message reaches the native session as typed. No
 * Warden runs, and no layer is composed into the session, until settings add one.
 */
export function defaultAgents(): Record<string, AgentSettingsConfig> {
  return {
    [DEFAULT_EXECUTOR_ID]: {
      id: DEFAULT_EXECUTOR_ID,
      kind: 'executor',
      prompt: '',
      tools: true,
      enabled: true,
    },
  };
}

/**
 * A saved settings.json as a full configuration: saved fields over the defaults, vendors merged
 * mode by mode.
 */
export function configFromSaved(raw: unknown): FoundryConfig {
  const saved = (raw ?? {}) as Partial<FoundryConfig>;
  const defaults = defaultConfig();
  return {
    ...defaults,
    ...saved,
    vendors: mergeVendorSettings(defaults.vendors, saved.vendors),
    projects: { ...saved.projects },
  };
}

/**
 * This Foundry's configuration directory, absolute: `FOUNDRY_CONFIG_DIR`, else `.foundry` under the
 * working directory. The daemon, setup, doctor and the CLIs all resolve it here, so a pairing or a
 * login written by a CLI lands where the daemon reads it.
 */
export const foundryConfigDir = (environment: Record<string, string | undefined> = process.env) =>
  resolve(environment.FOUNDRY_CONFIG_DIR ?? '.foundry');

// ---------------------------------------------------------------------------
// ConfigStore — persists settings to disk
// ---------------------------------------------------------------------------

/**
 * Runtime validation of operator/persisted configuration at every write
 * boundary. Only memory selection policies carry semantics the TypeScript
 * shapes cannot protect; validate them wherever a source may be declared:
 * global sources and each project's source overrides.
 */
/** A layer's content segment must be absent or exactly one of the two bounded values. Applied
 * to global definitions and every project override before any live or persisted publication. */
function validateLayerDefinition(owner: string, id: string, layer: unknown): void {
  if (isThreadKnowledgeLayerId(id))
    throw new Error(
      `invalid layer ${JSON.stringify(id)} in ${owner}: thread-knowledge layers are generated per thread, never configured`,
    );
  // A configured layer with the Librarian's id was a second, unrelated "thread-state" on the stack.
  if (id === THREAD_STATE_LAYER_ID)
    throw new Error(
      `invalid layer ${JSON.stringify(id)} in ${owner}: "${THREAD_STATE_LAYER_ID}" is the Librarian's generated layer, never configured; remove it (and its source) from settings`,
    );
  if (isRoleLayerId(id))
    throw new Error(
      `invalid layer ${JSON.stringify(id)} in ${owner}: "role:" layers are a role's generated composition slots, never configured`,
    );
  const activation = (layer as { activation?: unknown } | null | undefined)?.activation;
  if (activation !== undefined && activation !== 'always' && activation !== 'on-demand')
    throw new Error(
      `invalid layer ${JSON.stringify(id)} in ${owner}: activation must be "always" or "on-demand"`,
    );
  const segment = (layer as { segment?: unknown } | null | undefined)?.segment;
  if (segment !== undefined && segment !== 'domain-knowledge' && segment !== 'thread-knowledge')
    throw new Error(
      `invalid layer ${JSON.stringify(id)} in ${owner}: segment must be "domain-knowledge" or "thread-knowledge"`,
    );
}

/**
 * Every declared agent has a kind something runs. Settings declare executors only; a project view
 * also holds its generated region Wardens (`warden`).
 */
function validateAgentKinds(
  owner: string,
  agents: Record<string, Partial<AgentSettingsConfig>>,
  kinds: readonly AgentKind[] = SETTINGS_AGENT_KINDS,
) {
  for (const [id, agent] of Object.entries(agents)) {
    if (agent.kind === undefined) continue;
    if (!(kinds as readonly string[]).includes(agent.kind))
      throw Error(
        `${owner} agent ${JSON.stringify(id)}: kind ${JSON.stringify(agent.kind)} is not configurable (${kinds.join(', ')})`,
      );
    // Each phase supplies its response protocol; a second shape in the instructions contradicts it.
    if (agent.kind === 'warden' && /respond with json/i.test(agent.prompt ?? ''))
      throw Error(
        `${owner} agent ${JSON.stringify(id)}: instructions must not state a response format; the phase supplies it`,
      );
  }
}

function validateConsumedSettings(where: string, consumed: unknown): void {
  if (consumed === undefined) return;
  if (!consumed || typeof consumed !== 'object' || Array.isArray(consumed))
    throw Error(`${where} must be an object: { enabled?, tools?, paths?, maxChars? }`);
  const c = consumed as Record<string, unknown>;
  for (const key of Object.keys(c))
    if (!['enabled', 'tools', 'paths', 'maxChars'].includes(key))
      throw Error(`${where}.${key} is not a consumed setting (enabled, tools, paths, maxChars)`);
  if (c.enabled !== undefined && typeof c.enabled !== 'boolean')
    throw Error(`${where}.enabled must be true or false`);
  for (const key of ['tools', 'paths'] as const)
    if (
      c[key] !== undefined &&
      (!Array.isArray(c[key]) ||
        !(c[key] as unknown[]).every((g) => typeof g === 'string' && g.trim().length > 0))
    )
      throw Error(`${where}.${key} must be a list of globs`);
  if (
    c.maxChars !== undefined &&
    (typeof c.maxChars !== 'number' || !Number.isInteger(c.maxChars) || c.maxChars < 200)
  )
    throw Error(`${where}.maxChars must be a whole number of at least 200`);
}

const CHORUS_KEYS = ['enabled', 'regions', 'layers', 'consumed', 'reception', 'wardens', 'heralds'];
const ROLE_KEYS = { wardens: ['stages', 'debugReason'], heralds: ['stages'] } as const;

export function validateChorusSettings(where: string, chorus: unknown): void {
  if (chorus === undefined) return;
  if (!chorus || typeof chorus !== 'object' || Array.isArray(chorus))
    throw Error(`${where} must be an object: { enabled?, regions? | layers? }`);
  const c = chorus as Record<string, unknown>;
  // Charters are fixed per task and role, owned by Foundry (Aron, 2026-10-18: "keep it somewhat fixed
  // for now"); a project never sets one.
  for (const key of ['charter', 'charters', 'sections'])
    if (key in c)
      throw Error(
        `${where}.${key} is not a chorus setting: charters are fixed per task and role, owned by Foundry; an eval run config may set their sections (feedback/classify-run.ts)`,
      );
  for (const key of Object.keys(c))
    if (!CHORUS_KEYS.includes(key))
      throw Error(`${where}.${key} is not a chorus setting (${CHORUS_KEYS.join(', ')})`);
  for (const role of ['wardens', 'heralds'] as const) {
    const value = c[role];
    if (value === undefined) continue;
    const keys: readonly string[] = ROLE_KEYS[role];
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw Error(`${where}.${role} must be { ${keys.map((k) => `${k}?`).join(', ')} }`);
    for (const key of Object.keys(value))
      if (!keys.includes(key))
        throw Error(`${where}.${role}.${key} is not a role setting (${keys.join(', ')})`);
    const { stages, debugReason } = value as { stages?: unknown; debugReason?: unknown };
    if (stages !== undefined) validateStages(`${where}.${role}.stages`, stages);
    if (debugReason !== undefined && typeof debugReason !== 'boolean')
      throw Error(`${where}.${role}.debugReason must be true or false`);
  }
  if (c.enabled !== undefined && typeof c.enabled !== 'boolean')
    throw Error(`${where}.enabled must be true or false`);
  if (c.reception !== undefined && typeof c.reception !== 'boolean')
    throw Error(`${where}.reception must be true or false`);
  validateConsumedSettings(`${where}.consumed`, c.consumed);
  if (c.regions !== undefined && (typeof c.regions !== 'string' || !c.regions))
    throw Error(`${where}.regions must be a path (absolute, or relative to the project)`);
  if (c.layers !== undefined) {
    if (c.regions !== undefined)
      throw Error(`${where} names both regions and layers; regions is the one-layer form`);
    if (!Array.isArray(c.layers) || !c.layers.length)
      throw Error(`${where}.layers must be a non-empty list of { regions, label? }`);
    const labels = new Set<string>();
    c.layers.forEach((layer: unknown, index: number) => {
      const at = `${where}.layers[${index}]`;
      if (!layer || typeof layer !== 'object' || Array.isArray(layer))
        throw Error(`${at} must be { regions, label? }`);
      const l = layer as Record<string, unknown>;
      for (const key of Object.keys(l))
        if (key !== 'regions' && key !== 'label')
          throw Error(`${at}.${key} is not a layer setting`);
      if (typeof l.regions !== 'string' || !l.regions)
        throw Error(`${at}.regions must be a path (absolute, or relative to the project)`);
      if (l.label !== undefined && (typeof l.label !== 'string' || !l.label.trim()))
        throw Error(`${at}.label must be a non-empty name`);
      const label = typeof l.label === 'string' ? l.label : `layer-${index + 1}`;
      if (labels.has(label))
        throw Error(`${where}.layers: two layers are labelled ${JSON.stringify(label)}`);
      labels.add(label);
    });
  }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateProjectCapacity(config: FoundryConfig, project: ProjectSettingsConfig) {
  if (project.kingdomProject) {
    if (!uuidPattern.test(project.kingdomProject.projectId))
      throw Error(`Project ${project.id}: kingdomProject.projectId must be a Kingdom project id`);
    selectKingdomIntegration(config.kingdomIntegrations, project.kingdomProject.kingdom);
  }
  if (project.capacity === undefined && project.kingdomCapacity === undefined) return;
  if (project.capacity !== 'local' && project.capacity !== 'kingdom')
    throw Error(`Project ${project.id} capacity must be local or kingdom`);
  if (project.capacity === 'local') return;
  const capacity = project.kingdomCapacity;
  if (!capacity || !uuidPattern.test(capacity.signetId))
    throw Error(
      `Project ${project.id} uses Kingdom capacity: set kingdomCapacity { kingdom, signetId }`,
    );
  selectKingdomIntegration(config.kingdomIntegrations, capacity.kingdom);
  // Kingdom pools hold subscription logins: Claude Code, Codex and Muse Code only.
  const worker = project.defaults?.provider ?? config.defaults.provider;
  if (
    !subscriptionWorker(worker) ||
    !subscriptionRuntimeSchema.safeParse(SUBSCRIPTION_WORKERS[worker]).success
  )
    throw Error('Kingdom capacity requires a Claude Code, Codex or Muse Code default worker');
}

/** Each pool setting is well formed and prefers one of its runtime's logins. */
function validateLoginPoolReferences(config: FoundryConfig): void {
  const scopes: Array<[string, LoginPoolsSettings | undefined]> = [
    ['subscriptionPools', config.subscriptionPools],
    ...Object.entries(config.projects ?? {}).map(
      ([id, project]): [string, LoginPoolsSettings | undefined] => [
        `projects.${id}.subscriptionPools`,
        project?.subscriptionPools,
      ],
    ),
  ];
  for (const [where, pools] of scopes) {
    validateLoginPools(where, pools);
    for (const runtime of POOLED_RUNTIMES) {
      const preferred = pools?.[runtime]?.preferredLoginId;
      if (preferred === undefined) continue;
      if (!runtimeLogins(config, runtime).logins.some((login) => login.id === preferred))
        throw Error(
          `${where}.${runtime}.preferredLoginId is not one of this machine's ${runtime} logins`,
        );
    }
  }
}

export function validateConfig(config: FoundryConfig): void {
  validateVendorSettings(config.vendors);
  validateFoundryConversationSettings(config.conversations);
  validateSchedulerSettings('scheduler', config.scheduler, true);
  if (
    config.installationName !== undefined &&
    (typeof config.installationName !== 'string' ||
      !config.installationName.trim() ||
      config.installationName.length > 120)
  )
    throw Error('installationName must be 1 to 120 characters');
  if (config.installationIcon !== undefined && !validMachineIcon(config.installationIcon))
    throw Error(
      `installationIcon must be { glyph: ${MACHINE_GLYPHS.join(' | ')}, color: "#rrggbb" }`,
    );
  if (
    config.messageBox !== undefined &&
    (typeof config.messageBox !== 'object' ||
      config.messageBox === null ||
      (config.messageBox.separateViews !== undefined &&
        typeof config.messageBox.separateViews !== 'boolean'))
  )
    throw Error('messageBox.separateViews must be true or false');
  validateAgentKinds('global', config.agents ?? {});
  for (const [pid, project] of Object.entries(config.projects ?? {}))
    validateAgentKinds(
      `project ${JSON.stringify(pid)}`,
      Object.fromEntries(
        Object.entries(project?.agents ?? {}).filter(([, agent]) => !isAgentExtension(agent)),
      ) as Record<string, Partial<AgentSettingsConfig>>,
    );
  assertMainThreadLabs(config);
  for (const decisionProvider of [
    config.defaults.decisionProvider,
    ...Object.values(config.projects ?? {}).map((project) => project.defaults?.decisionProvider),
  ]) {
    if (
      decisionProvider &&
      subscriptionWorker(decisionProvider) &&
      decisionProvider !== 'claude-code' &&
      decisionProvider !== 'codex'
    )
      throw Error(
        `${decisionProvider === 'muse' ? 'Muse Code' : workerName(decisionProvider)} runs main threads only; decisions run on Claude, Codex, or an API provider`,
      );
  }
  resolveSubscriptionPolicy(config);
  if (config.kingdomIntegrations) {
    const parsed = kingdomIntegrationsSchema.safeParse(config.kingdomIntegrations);
    if (!parsed.success)
      throw Error(
        parsed.error.issues
          .map((issue) => `${['kingdomIntegrations', ...issue.path].join('.')}: ${issue.message}`)
          .join('; '),
      );
  }
  for (const project of Object.values(config.projects ?? {})) {
    if (project.status !== undefined && project.status !== 'archived')
      throw Error(`Project ${project.id} status must be archived or absent`);
    if (project.label !== undefined && (typeof project.label !== 'string' || !project.label.trim()))
      throw Error(`Project ${project.id} label must be a non-empty string`);
    validateProjectCapacity(config, project);
  }
  for (const source of validateKingdomAccess(config.kingdomAccess ?? [])) {
    if (
      source.projectIds.some((id) => !config.projects[id] || config.projects[id]!.enabled === false)
    )
      throw Error('Kingdom access references an unavailable project');
  }
  if (
    config.kingdomInference ||
    config.defaults.kingdomOwnerKey ||
    config.kingdomInferenceAssignments
  ) {
    if (
      config.defaults.nativeAuthenticationId ||
      Object.keys(config.nativeAuthenticationSelections ?? {}).length
    )
      throw Error('Choose Kingdom bindings or local native sources for this Foundry instance');
    if (!['claude-code', 'codex'].includes(config.defaults.provider))
      throw Error('Kingdom bindings require a native runtime provider');
    new KingdomAuthentication({
      directory: join(foundryConfigDir(), 'kingdom'),
      sources: config.kingdomInference ?? [],
      defaultOwnerKey: config.defaults.kingdomOwnerKey,
      assignments: config.kingdomInferenceAssignments,
    });
  }
  if (
    config.nativeAuthentication ||
    config.defaults.nativeAuthenticationId ||
    config.nativeAuthenticationSelections
  ) {
    const authentication = new NativeAuthentication({
      directory: join(foundryConfigDir(), 'runtime-profiles'),
      sources: config.nativeAuthentication ?? [],
      defaultSourceId: config.defaults.nativeAuthenticationId,
    });
    for (const [threadId, sourceId] of Object.entries(config.nativeAuthenticationSelections ?? {}))
      authentication.select(threadId, sourceId);
    if (config.defaults.nativeAuthenticationId && !subscriptionWorker(config.defaults.provider))
      throw Error('Native authentication requires a native runtime provider');
  }
  validateLearningSettings(config.learning);
  validateJournalSettings(config.journal);
  validateUiSettings(config.ui);
  validateFeedbackSettings('feedback', config.feedback);
  validateSecretsSettings('secrets', config.secrets);
  validateLoginPoolReferences(config);
  if (config.guard !== undefined && !GUARD_MODES.includes(config.guard))
    throw Error(`guard must be one of ${GUARD_MODES.map((m) => `"${m}"`).join(', ')}`);
  for (const [where, value] of [
    ['threadOnMerge', config.threadOnMerge],
    ...Object.entries(config.projects ?? {}).map(
      ([pid, project]) => [`projects.${pid}.threadOnMerge`, project?.threadOnMerge] as const,
    ),
  ] as const)
    if (value !== undefined && !THREAD_ON_MERGE.includes(value))
      throw Error(`${where} must be one of "done", "auto-archive"`);
  for (const [where, value] of [
    ['steer', config.steer],
    ...Object.entries(config.projects ?? {}).map(
      ([pid, project]) => [`projects.${pid}.steer`, project?.steer] as const,
    ),
  ] as const)
    if (value !== undefined && typeof value !== 'boolean')
      throw Error(`${where} must be true or false`);
  if (
    config.afterProjectStart !== undefined &&
    !AFTER_PROJECT_START.includes(config.afterProjectStart)
  )
    throw Error('afterProjectStart must be one of "attention", "stay"');
  for (const [pid, project] of Object.entries(config.projects ?? {})) {
    validateFeedbackSettings(`projects.${pid}.feedback`, project?.feedback);
    validateSecretsSettings(`projects.${pid}.secrets`, project?.secrets);
    validateChorusSettings(`projects.${pid}.chorus`, project?.chorus);
    validateConversationSettings(`projects.${pid}.conversations`, project?.conversations);
    validateSchedulerSettings(`projects.${pid}.scheduler`, project?.scheduler, false);
  }
  // A run's id names its schedule's id, so ids are unique across this Foundry, not per Where.
  const scheduleIds = new Map<string, string>();
  for (const [where, settings] of [
    ['scheduler', config.scheduler],
    ...Object.entries(config.projects ?? {}).map(
      ([pid, project]) => [`projects.${pid}.scheduler`, project?.scheduler] as const,
    ),
  ] as const)
    for (const schedule of settings?.schedules ?? []) {
      const other = scheduleIds.get(schedule.id);
      if (other) throw Error(`${where}: schedule id ${schedule.id} is already used in ${other}`);
      scheduleIds.set(schedule.id, where);
    }
  // The project Warden brief's nodes are Foundry's, made per project when its chorus runs.
  for (const id of WARDEN_BRIEF_NODES)
    if (config.composition?.nodes?.[id])
      throw Error(
        `composition.nodes.${id} is the project Warden brief's own node; settings may not define it`,
      );
  validateCompositionSettings(config.composition, resolveInstructionLadder(config.composition));
  // A written agent's role is `agent:<id>` (`roleIdOfAgent`), so it can't share a thread role's.
  for (const [owner, agents] of [
    ['agents', config.agents],
    ...Object.entries(config.projects ?? {}).map(
      ([pid, project]) => [`projects.${pid}.agents`, project?.agents] as const,
    ),
  ] as const)
    for (const id of Object.keys(agents ?? {})) {
      refuseNamespacedAgentId(owner, id);
    }
  for (const [id, layer] of Object.entries(config.layers ?? {}))
    validateLayerDefinition('global layers', id, layer);
  for (const [pid, project] of Object.entries(config.projects ?? {}))
    for (const [id, layer] of Object.entries(
      (project as { layers?: Record<string, unknown> } | null | undefined)?.layers ?? {},
    ))
      validateLayerDefinition(`project ${JSON.stringify(pid)} layers`, id, layer);
  configuredWardens(config);
  for (const projectId of Object.keys(config.projects ?? {})) {
    checkProjectView(
      projectId,
      resolveProjectView(config, projectId, { repository: false })!.config,
    );
  }
  const check = validateSourceDefinitions;
  check('global sources', config.sources);
  for (const [pid, project] of Object.entries(config.projects ?? {}))
    check(
      `project ${JSON.stringify(pid)} sources`,
      project?.sources as Record<string, DataSourceConfig> | undefined,
    );
}

function validateSourceDefinitions(
  owner: string,
  sources: Record<string, DataSourceConfig> | undefined,
): void {
  for (const [id, src] of Object.entries(sources ?? {})) {
    if (roleNameIn(roleNamespace.region, id) !== undefined)
      throw new Error(
        `invalid source ${JSON.stringify(id)} in ${owner}: the ${roleNamespace.region}: prefix names a region's own docs, which its regions generate; rename the source`,
      );
    if (src?.slot !== undefined && !(COMPOSITION_SLOTS as readonly string[]).includes(src.slot))
      throw new Error(
        `invalid source ${JSON.stringify(id)} in ${owner}: slot must be one of ${COMPOSITION_SLOTS.join(', ')}`,
      );
    if (!src || src.selection === undefined || src.selection === false) continue;
    try {
      validateMemorySelection(src.selection);
    } catch (err) {
      throw new Error(
        `invalid source ${JSON.stringify(id)} in ${owner}: ${(err as Error).message}`,
      );
    }
  }
}

/**
 * A project's settings shared with everyone through the repository's committed
 * `.foundry/project.json` (Aron 2026-10-16: every setting offers "set this for me" and "set this for
 * everyone"). They cascade: this machine's project settings over the repository's over the default.
 */
export const REPOSITORY_SETTING_KEYS = [
  'threadOnMerge',
  'steer',
  'gloss',
  'defaults',
  'feedback',
  'agents',
  'layers',
  'chorus',
  'conversations',
] as const;
export type RepositorySettingKey = (typeof REPOSITORY_SETTING_KEYS)[number];

/** Project settings that belong to this machine or this person, never the repository: why each. */
const PERSONAL_PROJECT_SETTINGS: Readonly<Record<string, string>> = {
  id: 'How this project is registered on this machine',
  path: 'Where this project is checked out on this machine',
  label: 'How this project is registered on this machine',
  tags: 'How this project is registered on this machine',
  description: 'How this project is registered on this machine',
  enabled: 'Whether this machine runs this project',
  status: 'Whether this machine has archived this project',
  capacity: 'Which subscriptions you run this project on',
  kingdomCapacity: 'Your Kingdom subscription pool',
  kingdomProject: 'Your link to a Kingdom project',
  subscriptionPools:
    'How your own logins on this machine are balanced (their ids are this machine’s)',
  scheduler:
    'Schedules start work on this machine on their own; they are yours, never a repository’s',
  toolRules:
    'Tool rules gate what agents may run on this machine; a cloned repository can’t loosen them',
  sources:
    'Sources read files and Archive projects on this machine; a cloned repository can’t point them elsewhere',
  'defaults.nativeAuthenticationId': 'Your login on this machine',
  'defaults.kingdomOwnerKey': 'Your Kingdom subscription pool',
  'defaults.decisionProvider':
    'Decision roles run on this machine’s subscription; a cloned repository can’t move them to a paid API',
  'defaults.decisionModel':
    'Decision roles run on this machine’s subscription; a cloned repository can’t move them to a paid API',
  ui: 'Viewer themes, extensions, slot layout, and display flags are personal to this machine; a repository cannot set them',
};

/** What a repository's agent may not set: where it runs and how it samples stay this machine's. */
const MACHINE_AGENT_FIELDS = [
  'provider',
  'tools',
  'temperature',
  'thinking',
  'cacheControl',
] as const;

/** A path segment that would reach an object's prototype: never a setting. */
export const UNSAFE_SETTING_SEGMENTS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/** Why a project setting has no "for everyone" form, or undefined when the repository may set it. */
export function personalOnlySetting(path: string): string | undefined {
  const parts = path.split('.');
  const exact = PERSONAL_PROJECT_SETTINGS[parts.slice(0, 2).join('.')];
  if (exact) return exact;
  if (PERSONAL_PROJECT_SETTINGS[parts[0]!]) return PERSONAL_PROJECT_SETTINGS[parts[0]!];
  return (REPOSITORY_SETTING_KEYS as readonly string[]).includes(parts[0]!)
    ? undefined
    : `${parts[0]} is not a project setting`;
}

/**
 * The repository's settings, checked by the same rules as this machine's project settings: one
 * error naming the first bad key. Machine and person settings are refused with why.
 */
/**
 * A written agent's id is a bare name: its role is `agent:<id>`, and a namespaced id is a generated
 * agent's (a region Warden's `region:<id>`), so a written one may never take it.
 */
function refuseNamespacedAgentId(owner: string, id: string): void {
  if (id.includes(ROLE_NAMESPACE_SEPARATOR))
    throw Error(
      `${owner}.${id}: an agent's id is a bare name (its role is ${roleIdIn(roleNamespace.agent, '<id>')}); a namespaced id such as ${roleNamespace.region}:… is a generated agent's; rename the agent`,
    );
}

export function validateRepositoryProject(settings: Record<string, unknown>): void {
  for (const key of Object.keys(settings)) {
    if (key === '$comment') continue;
    const personal = personalOnlySetting(key);
    if (personal) throw Error(`${key} is not a repository setting: ${personal}`);
  }
  const defaults = settings.defaults as Record<string, unknown> | undefined;
  if (defaults !== undefined) {
    if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults))
      throw Error('defaults must be an object');
    for (const key of Object.keys(defaults)) {
      const personal = personalOnlySetting(`defaults.${key}`);
      if (personal) throw Error(`defaults.${key} is not a repository setting: ${personal}`);
      if (typeof defaults[key] !== 'string') throw Error(`defaults.${key} must be a string`);
    }
    if (
      defaults.codexEffort !== undefined &&
      !(REASONING_EFFORTS as readonly unknown[]).includes(defaults.codexEffort)
    )
      throw Error(`defaults.codexEffort must be one of ${REASONING_EFFORTS.join(', ')}`);
    // The worker and its model go together (FEAT-007): a model is one the worker runs, never alone.
    if (defaults.model !== undefined && defaults.provider === undefined)
      throw Error(
        'defaults.model needs defaults.provider: a worker and its model are set together',
      );
    if (typeof defaults.provider === 'string') {
      if (!(defaults.provider in SUBSCRIPTION_WORKER_MODELS))
        throw Error(`defaults.provider ${defaults.provider} is not a subscription worker`);
      if (typeof defaults.model === 'string' && !registryModel(defaults.provider, defaults.model))
        throw Error(`defaults.model ${defaults.model} is not a ${defaults.provider} model`);
    }
  }
  if (
    settings.threadOnMerge !== undefined &&
    !THREAD_ON_MERGE.includes(settings.threadOnMerge as ThreadOnMerge)
  )
    throw Error('threadOnMerge must be one of "done", "auto-archive"');
  if (settings.steer !== undefined && typeof settings.steer !== 'boolean')
    throw Error('steer must be true or false');
  const gloss = settings.gloss as { enabled?: unknown; display?: unknown } | undefined;
  if (
    gloss !== undefined &&
    (!gloss ||
      typeof gloss !== 'object' ||
      (gloss.enabled !== undefined && typeof gloss.enabled !== 'boolean') ||
      (gloss.display !== undefined &&
        !['margin', 'hover', 'inline'].includes(gloss.display as string)))
  )
    throw Error('gloss must be { enabled?: boolean, display?: "margin" | "hover" | "inline" }');
  validateFeedbackSettings('feedback', settings.feedback);
  validateChorusSettings('chorus', settings.chorus);
  validateConversationSettings('conversations', settings.conversations);
  for (const key of ['agents', 'layers'] as const) {
    const records = settings[key];
    if (records !== undefined && !isRecordOfObjects(records))
      throw Error(`${key} must map ids to objects`);
  }
  const agents = settings.agents as Record<string, Partial<AgentSettingsConfig>> | undefined;
  if (agents !== undefined) {
    validateAgentKinds('repository', agents);
    for (const [id, agent] of Object.entries(agents)) {
      refuseNamespacedAgentId('agents', id);
      const set = MACHINE_AGENT_FIELDS.find((field) => field in agent);
      if (set)
        throw Error(
          `agents.${id}.${set} is not a repository setting: where an agent runs and how it samples stay this machine's`,
        );
    }
  }
  for (const [id, layer] of Object.entries((settings.layers as Record<string, unknown>) ?? {}))
    validateLayerDefinition('repository layers', id, layer);
}

const isRecordOfObjects = (value: unknown): boolean =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.values(value).every(
    (entry) => !!entry && typeof entry === 'object' && !Array.isArray(entry),
  );

/** What thread construction checks on a project's view: its agents' kinds and that they build. */
export function checkProjectView(projectId: string, view: FoundryConfig): void {
  validateAgentKinds(`project ${JSON.stringify(projectId)}`, view.agents, AGENT_KINDS);
  try {
    configuredWardens(view);
  } catch (error) {
    throw Error(`project ${JSON.stringify(projectId)}: ${(error as Error).message}`);
  }
}

/** A mutation named a settings revision that is no longer current. */
export class ConfigRevisionError extends Error {
  constructor() {
    super('Settings changed elsewhere. Reload before saving.');
  }
}

type ConfigDraft = (draft: FoundryConfig) => FoundryConfig | void;

/** One settings definition before and after an edit. */
export interface SettingsChange {
  before: unknown;
  after: unknown;
}

/** One line of the settings history: a versioned edit to one definition. */
export interface SettingsEdit {
  /** `agent:<id>`, `layer:<id>`, `source:<id>`, `provider:<id>`, `project:<id>` or `settings:<key>`. */
  subject: string;
  /** The store revision the edit produced. */
  revision: number;
  /** Its row in the audit log, when it was written. */
  auditId?: string;
  entry: VersionEntry<SettingsChange>;
}

export type SettingsListener = (config: FoundryConfig, edits: SettingsEdit[]) => unknown;

const KEYED_SECTIONS: Record<string, string> = {
  agents: 'agent',
  layers: 'layer',
  sources: 'source',
  vendors: 'vendor',
  projects: 'project',
};

/** Per-definition differences between two configurations. */
export function settingsChanges(
  before: FoundryConfig,
  after: FoundryConfig,
): Array<{ subject: string } & SettingsChange> {
  const changes: Array<{ subject: string } & SettingsChange> = [];
  const differ = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);
  const prior = before as unknown as Record<string, unknown>,
    next = after as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(prior), ...Object.keys(next)])) {
    const kind = KEYED_SECTIONS[key];
    if (!kind) {
      if (differ(prior[key], next[key]))
        changes.push({ subject: `settings:${key}`, before: prior[key], after: next[key] });
      continue;
    }
    const a = (prior[key] ?? {}) as Record<string, unknown>,
      b = (next[key] ?? {}) as Record<string, unknown>;
    for (const id of new Set([...Object.keys(a), ...Object.keys(b)]))
      if (differ(a[id], b[id]))
        changes.push({ subject: `${kind}:${id}`, before: a[id], after: b[id] });
  }
  return changes;
}

export class ConfigStore {
  private _dir: string;
  private _config: FoundryConfig;
  private _loaded = false;
  /** The settings.json text the live config was last checked against: the same text is not checked again. */
  private _loadedText: string | undefined;
  private _revision = 0;
  private readonly _queue = createSerializedQueue();
  private _listeners = new Set<SettingsListener>();
  private _notified: Promise<void> = Promise.resolve();

  constructor(dir: string) {
    this._dir = resolve(dir);
    if (!existsSync(this._dir)) {
      mkdirSync(this._dir, { recursive: true });
    }
    this._config = defaultConfig();
  }

  get directory(): string {
    return this._dir;
  }

  /** Increments whenever the committed config changes. */
  get revision(): number {
    return this._revision;
  }

  /** Load config from disk, merging with defaults. */
  load(): Promise<FoundryConfig> {
    return this._serialize(async () => {
      const path = join(this._dir, 'settings.json');
      const file = Bun.file(path);
      if (await file.exists()) {
        const text = await file.text();
        // Routes load before every read; checking settings walks every project's regions.
        if (this._loaded && text === this._loadedText) return this._config;
        // Merge saved over defaults into a candidate; validate before it becomes live.
        // An invalid persisted policy fails loudly, keeps the last working live
        // configuration, and leaves the file untouched for the operator to repair.
        const candidate = configFromSaved(JSON.parse(text));
        try {
          validateConfig(candidate);
        } catch (err) {
          throw new Error(`settings.json at ${path} was not loaded: ${(err as Error).message}`);
        }
        this._loadedText = text;
        if (JSON.stringify(candidate) !== JSON.stringify(this._config)) {
          const previous = this._config;
          this._revision++;
          this._config = candidate;
          // The first load reads the settings; a later one picks up an edit made to the file.
          if (this._loaded) await this._record(previous, candidate, 'file');
        }
      }
      this._loaded = true;
      return this._config;
    });
  }

  /** Called, in commit order, after each committed change. Returns an unsubscribe. */
  onChange(listener: SettingsListener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /** Reload when settings.json is edited by hand; returns a stop function. An invalid edit is refused and logged. */
  watch(): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watcher = watch(this._dir, (_event, file) => {
      if (file !== 'settings.json') return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        this.load().catch((error) => console.warn(`[settings] ${(error as Error).message}`));
      }, 200);
    });
    return () => {
      clearTimeout(timer);
      watcher.close();
    };
  }

  /** Resolves once every change listener has handled the changes committed so far. */
  settled(): Promise<void> {
    return this._notified;
  }

  /** Versioned edits, oldest first, grouped by subject; one subject when given (from the audit log). */
  async history(subject?: string): Promise<VersionLog<SettingsChange>[]> {
    return AuditLog.for(this._dir).settingsHistory(subject);
  }

  /** The audit log next to these settings (`audit.jsonl`). */
  get audit(): AuditLog {
    return AuditLog.for(this._dir);
  }

  /** Current committed config. Read-only: change it through update/save/patch/deleteItem. */
  get config(): FoundryConfig {
    return this._config;
  }

  /**
   * Apply `fn` to a deep copy of the latest committed config. Mutations run one at a time;
   * the result becomes live only after it validates and is persisted. `author` is the audit actor:
   * absent, the owner; otherwise an agent's id (`thread:<id>`).
   */
  update(fn: ConfigDraft, expectedRevision?: number, author = 'user'): Promise<FoundryConfig> {
    return this._serialize(async () => {
      this._expect(expectedRevision);
      const draft = structuredClone(this._config);
      return this._commit(fn(draft) ?? draft, author);
    });
  }

  /** Replace the full config and persist. */
  async save(config: FoundryConfig, expectedRevision?: number): Promise<void> {
    await this.update(() => structuredClone(config), expectedRevision);
  }

  /** Patch a section of the config. */
  patch(
    section: string,
    data: Record<string, unknown>,
    expectedRevision?: number,
  ): Promise<FoundryConfig> {
    const patch = structuredClone(data);
    return this.update((next) => {
      if (section === 'defaults') {
        next.defaults = { ...next.defaults, ...patch } as FoundryConfig['defaults'];
      } else if (section === 'vendors') {
        next.vendors = patchVendorSettings(next.vendors, patch);
      } else if (section === 'messageBox') {
        if (typeof patch.separateViews === 'boolean')
          next.messageBox = { ...next.messageBox, separateViews: patch.separateViews };
        else if (patch.separateViews === null) delete next.messageBox;
      } else if (section === 'profile') {
        // A name, or null to fall back to the default ("Foundry on <host>").
        if (typeof patch.installationName === 'string')
          next.installationName = patch.installationName.trim();
        else if (patch.installationName === null) delete next.installationName;
        if (patch.installationIcon === null) delete next.installationIcon;
        else if (patch.installationIcon !== undefined)
          next.installationIcon = patch.installationIcon as FoundryConfig['installationIcon'];
      } else if (section === 'threads') {
        // What a thread becomes when its branch merges; null returns to the default (done).
        if (patch.threadOnMerge === null) delete next.threadOnMerge;
        else if (patch.threadOnMerge !== undefined)
          next.threadOnMerge = patch.threadOnMerge as ThreadOnMerge;
        // Whether a send during a running turn steers into it; null returns to the default (on).
        if (patch.steer === null) delete next.steer;
        else if (patch.steer !== undefined) next.steer = patch.steer as boolean;
        // Where the rail goes once a thread starts from Projects; null returns to the default (Attention).
        if (patch.afterProjectStart === null) delete next.afterProjectStart;
        else if (patch.afterProjectStart !== undefined)
          next.afterProjectStart = patch.afterProjectStart as AfterProjectStart;
      } else if (section === 'agents') {
        next.agents = { ...next.agents, ...patch } as FoundryConfig['agents'];
      } else if (section === 'layers') {
        next.layers = { ...next.layers, ...patch } as FoundryConfig['layers'];
      } else if (section === 'sources') {
        next.sources = { ...next.sources, ...patch } as FoundryConfig['sources'];
      } else if (section === 'projects') {
        next.projects = { ...next.projects, ...patch } as FoundryConfig['projects'];
      } else if (section === 'learning') {
        next.learning = { ...next.learning, ...patch } as LearningSettings;
      } else if (section === 'composition') {
        next.composition = { ...next.composition, ...patch } as CompositionSettings;
      } else if (section === 'subscriptionOnly') {
        next.subscriptionOnly = { ...next.subscriptionOnly, ...patch } as SubscriptionSettings;
      } else if (section === 'feedback') {
        next.feedback = { ...next.feedback, ...patch } as FeedbackSettings;
      } else if (section === 'secrets') {
        next.secrets = { ...next.secrets, ...patch } as SecretsSettings;
      } else if (section === 'journal') {
        next.journal = { ...next.journal, ...patch } as JournalSettings;
      } else if (section === 'toolRules') {
        next.toolRules = { ...next.toolRules, ...patch } as ToolRules;
      } else if (section === 'apiTokens') {
        // Explicit opt-in to API-key providers; absent or false is subscription-only.
        if (patch.enabled === true) next.apiTokens = true;
        else delete next.apiTokens;
      } else if (section === 'ui') {
        const merged = patchUiSettings(next.ui, patch);
        if (merged && Object.keys(merged).length > 0) next.ui = merged;
        else delete next.ui;
      }
    }, expectedRevision);
  }

  /** Delete an item from a section. */
  deleteItem(section: string, id: string, expectedRevision?: number): Promise<FoundryConfig> {
    return this._serialize(async () => {
      this._expect(expectedRevision);
      if (!(id in (deletableSection(this._config, section) ?? {}))) return this._config;
      const draft = structuredClone(this._config);
      delete deletableSection(draft, section)![id];
      return this._commit(draft);
    });
  }

  /**
   * The saved config plus definitions that exist only at runtime, for inspection.
   * A copy: runtime state never becomes settings.
   */
  withRuntime(harness: Harness): FoundryConfig {
    const thread = harness.thread;
    const agents = { ...this._config.agents };
    const layers = { ...this._config.layers };

    // Runtime-only agents
    for (const [id, agent] of thread.agents) {
      if (!agents[id]) {
        agents[id] = {
          id,
          kind: agent.constructor.name.toLowerCase().replace('agent', '') as AgentKind,
          prompt: agent.prompt ?? '',
          provider: agent.llm?.provider ?? this._config.defaults.provider,
          model: agent.llm?.model ?? this._config.defaults.model,
          temperature: agent.llm?.temperature,
          enabled: true,
        };
      }
    }

    // Runtime-only layers
    for (const layer of thread.stack.layers) {
      if (!layers[layer.id]) {
        // A newly discovered layer carries its construction segment when it has one;
        // an existing configured definition is never overwritten and no absent field is added.
        layers[layer.id] = {
          id: layer.id,
          prompt: layer.prompt ?? '',
          sourceIds: layer.sources.map((s) => s.id),
          staleness: layer.staleness ?? 0,
          enabled: true,
          ...(layer.segment ? { segment: layer.segment } : {}),
        };
      }
    }
    return { ...this._config, agents, layers };
  }

  /**
   * Resolve effective config for a project.
   * Inherits global defaults, agents, layers, sources — then merges project overrides.
   */
  resolveProject(projectId: string): FoundryConfig | null {
    return this.resolveProjectView(projectId)?.config ?? null;
  }

  /** Resolve project config and include layer provenance for inspection/debugging. */
  resolveProjectView(projectId: string): ResolvedProjectView | null {
    return resolveProjectView(this._config, projectId);
  }

  /** Inspect only the resolved layer definitions for a project. */
  inspectResolvedLayers(projectId: string): ResolvedLayerDefinition[] | null {
    return this.resolveProjectView(projectId)?.layers ?? null;
  }

  private _serialize<T>(work: () => Promise<T>): Promise<T> {
    return this._queue.run(work);
  }

  private _expect(revision: number | undefined): void {
    if (revision !== undefined && revision !== this._revision) throw new ConfigRevisionError();
  }

  private async _commit(candidate: FoundryConfig, author = 'user'): Promise<FoundryConfig> {
    validateConfig(candidate);
    const path = join(this._dir, 'settings.json');
    const text = JSON.stringify(candidate, null, 2);
    writeFileAtomic(path, text, 0o600);
    this._loadedText = text;
    const previous = this._config;
    this._config = candidate;
    this._revision++;
    this._loaded = true;
    await this._record(previous, candidate, author);
    return candidate;
  }

  /** Append the edits to the audit log, then notify listeners in order. */
  private async _record(previous: FoundryConfig, next: FoundryConfig, author: string) {
    const changes = settingsChanges(previous, next);
    if (!changes.length) return;
    let rows: SourceVersion[] = [];
    try {
      rows = AuditLog.for(this._dir).append(
        changes.map(({ subject, before, after }) =>
          settingsRow(subject, this._revision, before, after, author),
        ),
      );
      // An agent's prompt is composed text too: its version is this edit, by this author.
      for (const { subject, before, after } of changes) {
        if (!subject.startsWith('agent:')) continue;
        const prompt = (value: unknown) => (value as { prompt?: unknown } | undefined)?.prompt;
        const next = prompt(after);
        if (typeof next !== 'string' || !next.trim() || next === prompt(before)) continue;
        const row = rows.find((r) => r.subject === subject)!;
        AuditLog.for(this._dir).observe(`prompt:${subject}`, next, {
          record: true,
          actor: row.actor,
          cause: row.cause,
        });
      }
    } catch (error) {
      console.warn(`[settings] audit not written: ${(error as Error).message}`);
    }
    const timestamp = new Date().toISOString();
    const edits: SettingsEdit[] = changes.map(({ subject, before, after }, i) => ({
      subject,
      revision: this._revision,
      ...(rows[i] ? { auditId: rows[i]!.id } : {}),
      entry: {
        hash: computeHash(JSON.stringify(after ?? null)),
        timestamp,
        trigger: 'settings',
        author,
        snapshot: { before, after },
      },
    }));
    const config = structuredClone(next);
    for (const listener of this._listeners)
      this._notified = this._notified
        .then(() => listener(config, edits))
        .then(
          () => undefined,
          (error) => console.warn(`[settings] change not applied: ${(error as Error).message}`),
        );
  }
}

function deletableSection(
  config: FoundryConfig,
  section: string,
): Record<string, unknown> | undefined {
  if (
    section === 'agents' ||
    section === 'layers' ||
    section === 'sources' ||
    section === 'projects'
  )
    return config[section];
}

/** The local journal's settings. */
export interface JournalSettings {
  /**
   * Days a middleware call's raw rows (its full input) stay in the journal after its turn is
   * reduced; Archive only ever gets the reduced entries. Default 30.
   */
  rawMiddlewareDays?: number;
}

export const DEFAULT_RAW_MIDDLEWARE_DAYS = 30;

function validateJournalSettings(journal: JournalSettings | undefined): void {
  if (journal === undefined) return;
  if (!journal || typeof journal !== 'object' || Array.isArray(journal))
    throw Error('journal must be an object');
  for (const key of Object.keys(journal))
    if (key !== 'rawMiddlewareDays') throw Error(`journal.${key} is not a journal setting`);
  const days = journal.rawMiddlewareDays;
  if (days !== undefined && (!Number.isFinite(days) || days < 0))
    throw Error('journal.rawMiddlewareDays must be a number of days, 0 or more');
}

const UI_SETTING_KEYS = new Set([
  'colorScheme',
  'theme',
  'extensions',
  'slots',
  'panelPlacement',
  'flags',
]);
const UI_SLOT_KEYS = new Set(['order', 'hidden', 'pinned']);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function assertSafeUiKey(where: string, key: string): void {
  if (
    !key ||
    key.length > 128 ||
    UNSAFE_SETTING_SEGMENTS.has(key) ||
    key.split('.').some((segment) => UNSAFE_SETTING_SEGMENTS.has(segment))
  ) {
    throw Error(`${where}: unsafe or invalid key ${JSON.stringify(key)}`);
  }
}

function validateUiSettings(ui: UiSettingsConfig | undefined): void {
  if (ui === undefined) return;
  if (!isPlainRecord(ui)) throw Error('ui must be an object');
  for (const key of Object.keys(ui)) {
    assertSafeUiKey('ui', key);
    if (!UI_SETTING_KEYS.has(key)) throw Error(`ui.${key} is not a ui setting`);
  }
  if (ui.colorScheme !== undefined) {
    if (
      typeof ui.colorScheme !== 'string' ||
      !UI_COLOR_SCHEMES.includes(ui.colorScheme as UiColorScheme)
    ) {
      throw Error(`ui.colorScheme must be one of: ${UI_COLOR_SCHEMES.join(', ')}`);
    }
  }
  if (ui.theme !== undefined && ui.theme !== null) {
    if (typeof ui.theme !== 'string' || !CUSTOM_UI_SLUG.test(ui.theme))
      throw Error('ui.theme must match /^[a-z0-9][a-z0-9_-]{0,63}$/ or be null');
  }
  if (ui.extensions !== undefined) {
    if (!Array.isArray(ui.extensions))
      throw Error('ui.extensions must be an array of extension ids');
    for (const id of ui.extensions) {
      if (typeof id !== 'string' || !CUSTOM_UI_SLUG.test(id))
        throw Error(
          `ui.extensions entry ${JSON.stringify(id)} must match /^[a-z0-9][a-z0-9_-]{0,63}$/`,
        );
    }
  }
  if (ui.slots !== undefined) {
    if (!isPlainRecord(ui.slots)) throw Error('ui.slots must be an object keyed by slot id');
    for (const [slotId, override] of Object.entries(ui.slots)) {
      assertSafeUiKey('ui.slots', slotId);
      if (!isPlainRecord(override))
        throw Error(`ui.slots.${slotId} must be { order?, hidden?, pinned? }`);
      for (const [field, value] of Object.entries(override)) {
        assertSafeUiKey(`ui.slots.${slotId}`, field);
        if (!UI_SLOT_KEYS.has(field))
          throw Error(`ui.slots.${slotId}.${field} is not a slot override key`);
        if (value !== undefined) {
          if (
            !Array.isArray(value) ||
            !value.every(
              (item) =>
                typeof item === 'string' &&
                item.length > 0 &&
                item.length <= 128 &&
                !UNSAFE_SETTING_SEGMENTS.has(item),
            )
          ) {
            throw Error(`ui.slots.${slotId}.${field} must be an array of non-empty item ids`);
          }
        }
      }
    }
  }
  if (ui.panelPlacement !== undefined) {
    if (!isPlainRecord(ui.panelPlacement))
      throw Error('ui.panelPlacement must be an object keyed by tab id');
    for (const [tabId, side] of Object.entries(ui.panelPlacement)) {
      assertSafeUiKey('ui.panelPlacement', tabId);
      if (typeof side !== 'string' || !UI_PANEL_SIDES.includes(side as UiPanelSide)) {
        throw Error(`ui.panelPlacement.${tabId} must be one of: ${UI_PANEL_SIDES.join(', ')}`);
      }
    }
  }
  if (ui.flags !== undefined) {
    if (!isPlainRecord(ui.flags)) throw Error('ui.flags must be an object keyed by component id');
    for (const [componentId, flagMap] of Object.entries(ui.flags)) {
      assertSafeUiKey('ui.flags', componentId);
      if (!isPlainRecord(flagMap))
        throw Error(`ui.flags.${componentId} must be an object of flag values`);
      for (const [flagKey, value] of Object.entries(flagMap)) {
        assertSafeUiKey(`ui.flags.${componentId}`, flagKey);
        const validPrimitive =
          typeof value === 'boolean' ||
          typeof value === 'string' ||
          (typeof value === 'number' && Number.isFinite(value));
        if (!validPrimitive)
          throw Error(
            `ui.flags.${componentId}.${flagKey} must be a boolean, string, or finite number`,
          );
      }
    }
  }
}

function patchUiSettings(
  existing: UiSettingsConfig | undefined,
  patch: Record<string, unknown>,
): UiSettingsConfig {
  if (!isPlainRecord(patch)) throw Error('ui patch must be an object');
  const next: Record<string, unknown> = existing
    ? { ...(structuredClone(existing) as Record<string, unknown>) }
    : {};
  for (const [key, value] of Object.entries(patch)) {
    assertSafeUiKey('ui', key);
    if (key === 'colorScheme') {
      if (value === null) delete next.colorScheme;
      else next.colorScheme = value;
      continue;
    }
    if (key === 'theme') {
      if (value === null) delete next.theme;
      else next.theme = value;
      continue;
    }
    if (key === 'extensions') {
      if (value === null) delete next.extensions;
      else next.extensions = value;
      continue;
    }
    if (key === 'slots') {
      if (value === null) {
        delete next.slots;
        continue;
      }
      if (!isPlainRecord(value)) {
        next.slots = value;
        continue;
      }
      const slots: Record<string, unknown> = isPlainRecord(next.slots) ? { ...next.slots } : {};
      for (const [slotId, slotPatch] of Object.entries(value)) {
        assertSafeUiKey('ui.slots', slotId);
        if (slotPatch === null) {
          delete slots[slotId];
          continue;
        }
        if (!isPlainRecord(slotPatch)) {
          slots[slotId] = slotPatch;
          continue;
        }
        const mergedSlot: Record<string, unknown> = isPlainRecord(slots[slotId])
          ? { ...(slots[slotId] as Record<string, unknown>) }
          : {};
        for (const [field, fieldVal] of Object.entries(slotPatch)) {
          assertSafeUiKey(`ui.slots.${slotId}`, field);
          if (fieldVal === null) delete mergedSlot[field];
          else mergedSlot[field] = fieldVal;
        }
        if (Object.keys(mergedSlot).length === 0) delete slots[slotId];
        else slots[slotId] = mergedSlot;
      }
      if (Object.keys(slots).length === 0) delete next.slots;
      else next.slots = slots;
      continue;
    }
    if (key === 'panelPlacement') {
      if (value === null) {
        delete next.panelPlacement;
        continue;
      }
      if (!isPlainRecord(value)) {
        next.panelPlacement = value;
        continue;
      }
      const placement: Record<string, unknown> = isPlainRecord(next.panelPlacement)
        ? { ...next.panelPlacement }
        : {};
      for (const [tabId, side] of Object.entries(value)) {
        assertSafeUiKey('ui.panelPlacement', tabId);
        if (side === null) delete placement[tabId];
        else placement[tabId] = side;
      }
      if (Object.keys(placement).length === 0) delete next.panelPlacement;
      else next.panelPlacement = placement;
      continue;
    }
    if (key === 'flags') {
      if (value === null) {
        delete next.flags;
        continue;
      }
      if (!isPlainRecord(value)) {
        next.flags = value;
        continue;
      }
      const flags: Record<string, unknown> = isPlainRecord(next.flags) ? { ...next.flags } : {};
      for (const [compId, compPatch] of Object.entries(value)) {
        assertSafeUiKey('ui.flags', compId);
        if (compPatch === null) {
          delete flags[compId];
          continue;
        }
        if (!isPlainRecord(compPatch)) {
          flags[compId] = compPatch;
          continue;
        }
        const mergedComp: Record<string, unknown> = isPlainRecord(flags[compId])
          ? { ...(flags[compId] as Record<string, unknown>) }
          : {};
        for (const [flagKey, flagVal] of Object.entries(compPatch)) {
          assertSafeUiKey(`ui.flags.${compId}`, flagKey);
          if (flagVal === null) delete mergedComp[flagKey];
          else mergedComp[flagKey] = flagVal;
        }
        if (Object.keys(mergedComp).length === 0) delete flags[compId];
        else flags[compId] = mergedComp;
      }
      if (Object.keys(flags).length === 0) delete next.flags;
      else next.flags = flags;
      continue;
    }
    next[key] = value;
  }
  return next as UiSettingsConfig;
}

/** The Kingdom project a Kingdom-capacity login bills: the project's link, when it is on the same Kingdom. */
export function capacityKingdomProject(
  config: Pick<FoundryConfig, 'kingdomIntegrations'>,
  project: Pick<ProjectSettingsConfig, 'kingdomCapacity' | 'kingdomProject'>,
): string | undefined {
  const capacity = project.kingdomCapacity;
  return capacity ? kingdomProjectOn(config, project, capacity.kingdom) : undefined;
}

/**
 * The Kingdom project this Foundry project links to (`kingdomProject`), when that link is on the
 * paired Kingdom `kingdom` names (its id or API origin); undefined otherwise.
 */
export function kingdomProjectOn(
  config: Pick<FoundryConfig, 'kingdomIntegrations'>,
  project: Pick<ProjectSettingsConfig, 'kingdomProject'>,
  kingdom: string,
): string | undefined {
  const link = project.kingdomProject;
  if (!link) return undefined;
  const url = (selector: string) =>
    selectKingdomIntegration(config.kingdomIntegrations, selector).url;
  return url(link.kingdom) === url(kingdom) ? link.projectId : undefined;
}
