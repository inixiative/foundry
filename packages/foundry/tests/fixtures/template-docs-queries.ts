/**
 * Hand-labeled routing fixtures for the template's docs/claude/ corpus
 * (/Users/arongreenspan/Desktop/inixiative/template/docs/claude, 34 files).
 *
 * Used by scripts/probe-docs-layer.ts to measure how well the docs warden's
 * advise() picks relevant files from a topology cache. Each fixture names
 * the docs a knowledgeable engineer would pull for that query; `mustNotInclude`
 * names docs that indicate the model is over-broad (reaching for UI docs on a
 * purely backend task, etc.).
 *
 * Ground truth is intentionally generous — includes any doc that a reasonable
 * person might reach for. Precision@K then measures whether the model's top-K
 * are in this set; recall measures whether we captured the whole set.
 *
 * Notes on ambiguous pairs:
 *   - AUTH.md = backend auth (BetterAuth, middleware, tokens)
 *   - AUTHENTICATION.md = frontend auth (hooks, components, store)
 *   - H2 headings are what disambiguate them — this pair is the test case
 *     for whether topology-B/C are genuinely earning their extra tokens.
 */

export interface RoutingFixture {
  /** Realistic user message. */
  query: string;
  /** Docs a senior engineer would actually pull for this query. */
  expectedDocs: string[];
  /** Docs that, if returned, signal the model is routing too broadly. */
  mustNotInclude?: string[];
  /** Short prose explaining why this selection. */
  rationale: string;
}

export const TEMPLATE_DOCS_FIXTURES: RoutingFixture[] = [
  {
    query: "Add a new API route for password reset via email",
    expectedDocs: ["API_ROUTES.md", "AUTH.md", "COMMUNICATIONS.md"],
    mustNotInclude: ["FRONTEND.md", "ZUSTAND.md", "DOCKER.md"],
    rationale: "Backend route + auth session handling + email delivery. No UI, no infra.",
  },
  {
    query: "Add webhook retry logic with exponential backoff",
    expectedDocs: ["JOBS.md", "REDIS.md", "API_ROUTES.md"],
    mustNotInclude: ["FRONTEND.md", "AUTHENTICATION.md", "ZUSTAND.md"],
    rationale: "Background job with Redis-backed queue, triggered from an API route.",
  },
  {
    query: "Create a new database model for invoices with line items",
    expectedDocs: ["DATABASE.md", "HOOKS.md", "NAMING.md"],
    mustNotInclude: ["FRONTEND.md", "ZUSTAND.md", "AUTHENTICATION.md"],
    rationale: "Schema/model work — table conventions, lifecycle hooks, naming.",
  },
  {
    query: "What's the session timeout behavior and how do I configure it?",
    expectedDocs: ["AUTH.md"],
    mustNotInclude: ["AUTHENTICATION.md", "FRONTEND.md", "ZUSTAND.md"],
    rationale: "Backend session config — AUTH.md. AUTHENTICATION.md is the frontend side.",
  },
  {
    query: "Add a new Zustand slice for in-app notifications",
    expectedDocs: ["ZUSTAND.md", "FRONTEND.md"],
    mustNotInclude: ["AUTH.md", "DATABASE.md", "JOBS.md"],
    rationale: "Pure frontend state management.",
  },
  {
    query: "Set up a new background worker that processes uploads",
    expectedDocs: ["JOBS.md", "REDIS.md", "APPS.md"],
    mustNotInclude: ["FRONTEND.md", "ZUSTAND.md"],
    rationale: "Worker process, queue, monorepo app placement.",
  },
  {
    query: "Where do I configure environment variables for staging?",
    expectedDocs: ["ENVIRONMENTS.md", "DOCKER.md", "CICD.md"],
    mustNotInclude: ["FRONTEND.md", "ZUSTAND.md", "DATABASE.md"],
    rationale: "Env config touches deployment, containers, and pipeline.",
  },
  {
    query: "Write tests for the batch endpoint",
    expectedDocs: ["TESTING.md", "BATCH.md"],
    mustNotInclude: ["FRONTEND.md", "ZUSTAND.md", "DOCKER.md"],
    rationale: "Test conventions + the batch feature doc.",
  },
  {
    query: "Add a permission check on a new resource endpoint",
    expectedDocs: ["PERMISSIONS.md", "AUTH.md", "API_ROUTES.md"],
    mustNotInclude: ["FRONTEND.md", "ZUSTAND.md"],
    rationale: "Backend authz: permissions model, auth middleware, the route itself.",
  },
  {
    query: "Explain the overall architecture and how the packages relate",
    expectedDocs: ["ARCHITECTURE.md", "MONOREPO.md", "TURBOREPO.md", "APPS.md"],
    rationale: "Architecture overview query — high-level layout docs.",
  },
  {
    query: "Add a new AppEvent for when a user completes onboarding",
    expectedDocs: ["APP_EVENTS.md", "COMMUNICATIONS.md"],
    mustNotInclude: ["ZUSTAND.md", "DOCKER.md"],
    rationale: "Event system + downstream handlers (notifications, emails).",
  },
  {
    query: "Update the init script to seed a new entity type",
    expectedDocs: ["INIT_SCRIPT.md", "INIT_SCRIPT_PATTERNS.md", "DATABASE.md"],
    mustNotInclude: ["FRONTEND.md", "ZUSTAND.md"],
    rationale: "Init script modification needs the script doc + patterns + schema context.",
  },
  {
    query: "How does the login form wire up to the auth backend?",
    expectedDocs: ["AUTHENTICATION.md", "AUTH.md"],
    mustNotInclude: ["ZUSTAND.md", "DATABASE.md", "DOCKER.md"],
    rationale: "Crossing the backend/frontend boundary — both auth docs, no state specifics.",
  },
  {
    query: "Encrypt a new field on the user model at rest",
    expectedDocs: ["ENCRYPTION.md", "DATABASE.md", "HOOKS.md"],
    mustNotInclude: ["FRONTEND.md", "ZUSTAND.md", "AUTHENTICATION.md"],
    rationale: "Encryption utility + schema change + hook for transparent encrypt/decrypt.",
  },
  {
    query: "What naming conventions do we use for API endpoints and DB columns?",
    expectedDocs: ["NAMING.md", "STYLE.md", "API_ROUTES.md", "DATABASE.md"],
    rationale: "Naming is the primary doc; style, routes, and DB are the surfaces.",
  },
];
