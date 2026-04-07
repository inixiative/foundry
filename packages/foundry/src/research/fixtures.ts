// ---------------------------------------------------------------------------
// Built-in test fixtures + loader for custom fixtures
// ---------------------------------------------------------------------------

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Fixture } from "./types";

// ---------------------------------------------------------------------------
// Built-in fixtures — 10 diverse inputs covering all categories
// ---------------------------------------------------------------------------

export const BUILTIN_FIXTURES: Fixture[] = [
  // Bugs (classify=bug, route=executor-fix)
  {
    id: "bug-token-refresh",
    description: "Auth middleware token refresh failure",
    input:
      "The auth middleware isn't refreshing expired JWT tokens. Users get logged out mid-session even though the refresh token is valid. I think the issue is in the token validation check — it's comparing expiry times in seconds vs milliseconds.",
    expectedCategory: "bug",
    expectedRoute: "executor-fix",
    qualityRubric:
      "Should identify the seconds vs milliseconds mismatch as root cause. Should propose a specific fix (multiply/divide by 1000). Should not suggest unrelated changes.",
    tags: ["auth", "middleware"],
  },
  {
    id: "bug-null-payment",
    description: "Null reference in payment handler",
    input:
      "Getting a TypeError: Cannot read properties of null (reading 'amount') in the payment handler when a user tries to checkout with an empty cart. Stack trace points to processPayment() at line 47.",
    expectedCategory: "bug",
    expectedRoute: "executor-fix",
    qualityRubric:
      "Should identify the missing null check on cart/items before accessing amount. Should propose defensive guard (early return or validation). Should mention edge case of empty cart.",
    tags: ["payments", "null-check"],
  },

  // Features (classify=feature, route=executor-build)
  {
    id: "feat-user-prefs",
    description: "User preferences API endpoint",
    input:
      "Add a user preferences API endpoint. Users should be able to GET and PUT their preferences (theme, language, notification settings). Store in the existing users table with a jsonb preferences column.",
    expectedCategory: "feature",
    expectedRoute: "executor-build",
    qualityRubric:
      "Should outline GET/PUT endpoints with appropriate HTTP methods. Should mention the jsonb column migration. Should include basic input validation. Should follow REST conventions.",
    tags: ["api", "user-management"],
  },
  {
    id: "feat-webhooks",
    description: "Webhook support for order events",
    input:
      "We need webhook support for order events. When an order is created, updated, or cancelled, we should POST a signed payload to registered webhook URLs. Include retry logic with exponential backoff.",
    expectedCategory: "feature",
    expectedRoute: "executor-build",
    qualityRubric:
      "Should cover webhook registration, payload signing (HMAC), event types, retry with backoff. Should consider idempotency and failure handling. Should mention webhook URL validation.",
    tags: ["webhooks", "events"],
  },

  // Questions (classify=question, route=executor-answer)
  {
    id: "q-migrations",
    description: "Database migration strategy question",
    input:
      "How do we handle database migrations in this project? I see both Prisma and raw SQL files. Which one should I use for a new table?",
    expectedCategory: "question",
    expectedRoute: "executor-answer",
    qualityRubric:
      "Should explain the project's migration approach clearly. Should give a direct recommendation. Should not be evasive or overly generic.",
    tags: ["database", "migrations"],
  },
  {
    id: "q-testing",
    description: "Testing strategy question",
    input:
      "What's our testing strategy for API endpoints? Should I write unit tests, integration tests, or both? What framework do we use?",
    expectedCategory: "question",
    expectedRoute: "executor-answer",
    qualityRubric:
      "Should describe the testing approach concisely. Should mention specific tools/frameworks if identifiable from context. Should give practical guidance, not abstract principles.",
    tags: ["testing"],
  },

  // Refactor (classify=refactor, route=executor-build)
  {
    id: "refactor-payments",
    description: "Payment module adapter pattern refactor",
    input:
      "Refactor the payment module to use the adapter pattern. We currently have Stripe calls scattered across 6 files. Extract a PaymentAdapter interface so we can swap providers without touching business logic.",
    expectedCategory: "refactor",
    expectedRoute: "executor-build",
    qualityRubric:
      "Should define the PaymentAdapter interface with key methods. Should explain how to extract existing Stripe logic. Should not change business logic behavior. Should mention testing the adapter.",
    tags: ["refactor", "patterns"],
  },

  // Ambiguous / edge cases
  {
    id: "ambiguous-slow-search",
    description: "Ambiguous: slow search could be bug or feature",
    input:
      "The search is slow and sometimes returns wrong results when there are special characters in the query.",
    expectedCategory: "bug",
    expectedRoute: "executor-fix",
    qualityRubric:
      "Should address both the performance issue and the special character handling. Should identify likely causes (missing index, unescaped characters). Classification as 'bug' is preferred since it describes broken behavior.",
    tags: ["ambiguous", "search"],
  },
  {
    id: "ambiguous-mixed-concerns",
    description: "Mixed bug fix + feature request",
    input:
      "Add rate limiting to the API and also fix the existing auth bypass where unauthenticated requests to /api/admin are not being blocked.",
    expectedCategory: "bug",
    expectedRoute: "executor-fix",
    qualityRubric:
      "Should prioritize the security fix (auth bypass) over the feature (rate limiting). Should address both concerns. Classification as 'bug' is preferred because the auth bypass is a security issue.",
    tags: ["ambiguous", "security"],
  },

  // Convention
  {
    id: "convention-validation",
    description: "Convention question about validation library",
    input:
      "Should we use Zod or Joi for request validation in our API handlers? We're currently mixing both.",
    expectedCategory: "question",
    expectedRoute: "executor-answer",
    qualityRubric:
      "Should compare the two libraries briefly. Should give a clear recommendation (pick one, standardize). Should mention the cost of mixing both. Classification as 'question' or 'convention' both acceptable.",
    tags: ["convention", "validation"],
  },
];

// ---------------------------------------------------------------------------
// Fixture loader — loads custom fixtures from a directory
// ---------------------------------------------------------------------------

export function loadFixtures(dir: string): Fixture[] {
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const fixtures: Fixture[] = [];

  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), "utf-8");
      const parsed = JSON.parse(raw);
      // Support both single fixture and array of fixtures
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (item.id && item.input && item.expectedCategory && item.expectedRoute) {
          fixtures.push(item as Fixture);
        }
      }
    } catch {
      console.warn(`[research] Skipping invalid fixture file: ${file}`);
    }
  }

  return fixtures;
}

/** Get all fixtures: built-in + custom from a directory. */
export function getAllFixtures(customDir?: string): Fixture[] {
  const custom = customDir ? loadFixtures(customDir) : [];
  // Custom fixtures with same ID override built-in ones
  const customIds = new Set(custom.map((f) => f.id));
  const builtIn = BUILTIN_FIXTURES.filter((f) => !customIds.has(f.id));
  return [...builtIn, ...custom];
}
