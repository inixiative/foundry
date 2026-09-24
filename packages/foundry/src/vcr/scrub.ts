// Every recorded string passes through here before it touches disk. Paths the replay needs
// become placeholders it can fill back in; identity and secrets are replaced for good.
import { realpathSync } from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";

export type ScrubContext = { cwd?: string };

const REDACTED_UUID = "00000000-0000-4000-8000-000000000000";
const REDACTED_EMAIL = "redacted@example.invalid";

const SECRETS: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, "sk-ant-REDACTED"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/g, "sk-REDACTED"],
  [/\bkastle_(?:runtime_|run_|refresh_)?[A-Za-z0-9_-]{20,}/g, "kastle_REDACTED"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "JWT_REDACTED"],
  [/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/g, "GITHUB_TOKEN_REDACTED"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "SLACK_TOKEN_REDACTED"],
  [/\b(Bearer\s+)(?!REDACTED)[A-Za-z0-9._~+/=-]{8,}/gi, "$1REDACTED"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, REDACTED_EMAIL],
];

/** Keys whose values identify the account, whatever their format. */
const IDENTITY_KEY = /^(e-?mail(_?address)?|org(ani[sz]ation)?(_?(id|uuid|name|role))?|account(_?(id|uuid|name|email|type))?|user_?(id|uuid|email|name)|billing(_?\w+)?|subscription(_?(id|type|plan))?|plan_?type|workspace_?(id|name)|installation_?id|chatgpt_?(account|user|plan)(_?\w+)?)$/i;
const SECRET_KEY = /^(authorization|cookie|set-cookie|x-api-key|api_?key|(access|refresh|id|session)_?token|secret|password|credential)$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const variants = (path: string | undefined) => {
  if (!path) return [];
  const out = new Set([path.replace(/\/+$/, "")]);
  try { out.add(realpathSync(path)); } catch { /* A path that no longer exists has one spelling. */ }
  for (const value of [...out]) if (value.startsWith("/private/")) out.add(value.slice("/private".length));
  return [...out].filter(value => value.length > 1).sort((a, b) => b.length - a.length);
};

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The real account home, even when a test points HOME at a temporary profile. */
export const accountHome = () => userInfo().homedir;

const ruleCache = new Map<string, [RegExp, string][]>();
function pathRules(context: ScrubContext): [RegExp, string][] {
  const cached = ruleCache.get(context.cwd ?? "");
  if (cached) return cached;
  const rules: [RegExp, string][] = [];
  for (const cwd of variants(context.cwd)) rules.push([new RegExp(escape(cwd), "g"), "{{cwd}}"]);
  for (const temp of variants(tmpdir())) rules.push([new RegExp(escape(temp), "g"), "{{tmp}}"]);
  for (const home of variants(accountHome())) rules.push([new RegExp(escape(home), "g"), "~"]);
  const user = userInfo().username;
  if (user.length > 2) rules.push([new RegExp(`\\b${escape(user)}\\b`, "gi"), "user"]);
  const host = hostname().replace(/\.local$/, "");
  if (host.length > 2) rules.push([new RegExp(`\\b${escape(host)}(\\.local)?\\b`, "gi"), "host"]);
  ruleCache.set(context.cwd ?? "", rules);
  return rules;
}

export function scrubText(text: string, context: ScrubContext = {}): string {
  let out = text;
  for (const [pattern, replacement] of [...pathRules(context), ...SECRETS]) out = out.replace(pattern, replacement);
  return out;
}

export function scrubValue<T>(value: T, context: ScrubContext = {}): T {
  const walk = (node: unknown, key?: string): unknown => {
    if (typeof node === "string") {
      if (key && SECRET_KEY.test(key)) return "REDACTED";
      if (key && IDENTITY_KEY.test(key)) return UUID.test(node) ? REDACTED_UUID : node.includes("@") ? REDACTED_EMAIL : "REDACTED";
      return scrubText(node, context);
    }
    if (Array.isArray(node)) return node.map(item => walk(item));
    if (node && typeof node === "object") {
      return Object.fromEntries(Object.entries(node).map(([childKey, child]) => [scrubText(childKey, context), walk(child, childKey)]));
    }
    return node;
  };
  return walk(value) as T;
}

/** One protocol line: JSON stays valid JSON, anything else is scrubbed as text. */
export function scrubLine(line: string, context: ScrubContext = {}): string {
  const trimmed = line.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try { return JSON.stringify(scrubValue(JSON.parse(trimmed), context)); } catch { /* Not JSON after all. */ }
  }
  return scrubText(line, context);
}

/** Fill placeholders back in for this replay's own directories. */
export function rehydrate(text: string, context: ScrubContext = {}): string {
  let out = text.replaceAll("{{tmp}}", tmpdir().replace(/\/+$/, ""));
  if (context.cwd) out = out.replaceAll("{{cwd}}", context.cwd);
  return out;
}

/** What must never reach a committed cassette, independent of this machine's identity. */
export const LEAK_PATTERNS: [string, RegExp][] = [
  ["home path", /\/(?:Users|home)\/(?!Shared\b)[A-Za-z0-9._-]+/],
  ["email", /[A-Za-z0-9._%+-]+@(?!example\.invalid\b)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/],
  ["Anthropic key", /sk-ant-(?!REDACTED)[A-Za-z0-9_-]{8,}/],
  ["API key", /\bsk-(?!REDACTED)(?:proj-)?[A-Za-z0-9_-]{16,}/],
  ["Kastle secret", /\bkastle_(?!REDACTED)(?:runtime_|run_|refresh_)?[A-Za-z0-9_-]{20,}/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ["GitHub token", /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/],
  ["bearer credential", /\bBearer\s+(?!REDACTED)[A-Za-z0-9._~+/=-]{8,}/i],
];

/** Leaks in a cassette's text, plus identity keys whose values were not redacted. */
export function findLeaks(text: string): string[] {
  const found = LEAK_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  try {
    const walk = (node: unknown, key?: string): void => {
      if (typeof node === "string" && key && (IDENTITY_KEY.test(key) || SECRET_KEY.test(key))
        && !["REDACTED", REDACTED_UUID, REDACTED_EMAIL].includes(node) && node !== "") found.push(`unredacted ${key}`);
      else if (typeof node === "string" && /^\s*[{[]/.test(node)) { try { walk(JSON.parse(node)); } catch { /* Plain text. */ } }
      else if (Array.isArray(node)) node.forEach(item => walk(item));
      else if (node && typeof node === "object") for (const [childKey, child] of Object.entries(node)) walk(child, childKey);
    };
    walk(JSON.parse(text));
  } catch { /* Sidecar or non-JSON text: patterns only. */ }
  return [...new Set(found)];
}
