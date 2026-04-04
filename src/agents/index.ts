// Context primitives
export {
  ContextLayer,
  computeHash,
  type ContextSource,
  type ContextLayerConfig,
  type LayerState,
} from "./context-layer";

export {
  ContextStack,
  type Compressor,
  type LayerFilter,
  type ContextSnapshot,
} from "./context-stack";

export {
  CacheLifecycle,
  type LifecycleEvent,
  type LifecycleHandler,
  type LifecycleRule,
} from "./cache-lifecycle";

// Hydration
export {
  HydrationRegistry,
  RefSource,
  type ContextRef,
  type HydrationAdapter,
} from "./hydrator";

// Agent primitives
export {
  BaseAgent,
  type ExecutionResult,
  type AgentConfig,
} from "./base-agent";

export {
  Executor,
  type ExecuteHandler,
  type ExecutorConfig,
} from "./executor";

export {
  Decider,
  type Decision,
  type DecideHandler,
  type DeciderConfig,
} from "./decider";

export {
  Classifier,
  type Classification,
  type ClassifyHandler,
  type ClassifierConfig,
} from "./classifier";

export {
  Router,
  type Route,
  type RouteHandler,
  type RouterConfig,
} from "./router";

// Middleware
export {
  MiddlewareChain,
  type Middleware,
  type DispatchContext,
  type DispatchOutcome,
  type MiddlewareNext,
} from "./middleware";

// Signals
export {
  SignalBus,
  type Signal,
  type SignalKind,
  type SignalHandler,
} from "./signal";

// Orchestration
export {
  Thread,
  type ThreadStatus,
  type ThreadMeta,
  type ThreadConfig,
  type Dispatch,
  type FanResult,
} from "./thread";
export {
  Harness,
  type Message,
  type HarnessResult,
  type PipelineStep,
} from "./harness";

// Sessions
export {
  SessionManager,
  type ThreadBlueprint,
  type LayerInheritance,
  type SessionEvent,
} from "./session";

// Observability
export {
  EventStream,
  type StreamEvent,
} from "./event-stream";
