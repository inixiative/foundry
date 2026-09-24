// Structure of a recording, independent of what the model happened to say. Drift in
// structure is a finding for a human; drift in content is expected between live runs.

export type Signature = { status: number; shape: Record<string, string[]> };

const MAX_DEPTH = 3;

/** Dotted key paths (arrays collapse to `[]`) and leaf types, to `MAX_DEPTH`. */
function paths(value: unknown, prefix = "", depth = 0, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) { out.add(`${prefix}[]`); return out; }
    if (!value.length) out.add(`${prefix}[]`);
    for (const item of value) paths(item, `${prefix}[]`, depth + 1, out);
    return out;
  }
  if (value && typeof value === "object") {
    if (depth >= MAX_DEPTH) { out.add(`${prefix}{}`); return out; }
    for (const [key, child] of Object.entries(value)) paths(child, prefix ? `${prefix}.${key}` : key, depth + 1, out);
    return out;
  }
  out.add(`${prefix}:${value === null ? "null" : typeof value}`);
  return out;
}

/** An event's kind: its protocol discriminators (`type`, `subtype`, `method`, item type). */
export function eventKind(event: unknown): string {
  if (!event || typeof event !== "object") return typeof event;
  const record = event as Record<string, unknown>;
  const item = record.item as Record<string, unknown> | undefined;
  const params = record.params as Record<string, unknown> | undefined;
  const nested = (item?.type ?? (params?.item as Record<string, unknown> | undefined)?.type) as string | undefined;
  const parts = [record.type, record.subtype, record.method, nested].filter((part): part is string => typeof part === "string");
  if (parts.length) return parts.join(":");
  if ("id" in record && ("result" in record || "error" in record)) return "result" in record ? "rpc:result" : "rpc:error";
  return "object";
}

const parse = (line: string): unknown => { try { return JSON.parse(line); } catch { return line; } };

type Transcript = { kind: "process" | "websocket"; argv?: string[]; frames: { stream: string; data: string }[]; exit?: { code: number | null } };
const isTranscript = (body: unknown): body is Transcript =>
  !!body && typeof body === "object" && ["process", "websocket"].includes((body as { kind?: string }).kind ?? "");

export function signatureOf(status: number, body: unknown): Signature {
  const shape: Record<string, Set<string>> = {};
  const add = (kind: string, value: unknown) => {
    const set = shape[kind] ??= new Set();
    for (const path of paths(value)) set.add(path);
  };
  if (isTranscript(body)) {
    if (body.argv) shape["argv"] = new Set(body.argv.filter(arg => arg.startsWith("-")));
    for (const frame of body.frames) {
      if (frame.stream === "stderr") { (shape["stderr"] ??= new Set()).add("text"); continue; }
      const event = parse(frame.data);
      add(`${frame.stream}:${eventKind(event)}`, event);
    }
    if (body.exit) shape["exit"] = new Set([String(body.exit.code)]);
  } else add("body", body);
  return { status, shape: Object.fromEntries(Object.entries(shape).map(([kind, set]) => [kind, [...set].sort()])) };
}

/** Event kinds whose presence and shape follow model behavior or transient service state (thinking,
 * rate-limit notices, reconnect errors, CLI logging), not the protocol. Their changes are notices. */
export const VOLATILE_KINDS = [
  /^stdout:system:thinking_tokens$/, /^stdout:rate_limit_event$/, /^stdout:error$/, /^stderr$/,
  /:reasoning$/, /^stdout:item\.completed:error$/, /^stdout:account\/rateLimits\/updated$/, /^stdout:mcpServer\/startupStatus\/updated$/,
];
const volatile = (kind: string) => VOLATILE_KINDS.some(pattern => pattern.test(kind));

function differences(before: Signature, after: Signature, pick: (kind: string) => boolean): string[] {
  const out: string[] = [];
  const kinds = new Set([...Object.keys(before.shape), ...Object.keys(after.shape)]);
  for (const kind of [...kinds].sort().filter(pick)) {
    const was = before.shape[kind], now = after.shape[kind];
    if (!was) { out.push(`new ${kind}`); continue; }
    if (!now) { out.push(`missing ${kind}`); continue; }
    const added = now.filter(path => !was.includes(path)), removed = was.filter(path => !now.includes(path));
    if (added.length) out.push(`${kind} added ${added.join(", ")}`);
    if (removed.length) out.push(`${kind} removed ${removed.join(", ")}`);
  }
  return out;
}

/** Protocol drift: human-readable structural differences; empty when the recordings agree. */
export function compareSignatures(before: Signature, after: Signature): string[] {
  return [...(before.status !== after.status ? [`status ${before.status} -> ${after.status}`] : []), ...differences(before, after, kind => !volatile(kind))];
}

/** Changes in volatile kinds: reported, never a reason to hold a recording back. */
export function volatileDifferences(before: Signature, after: Signature): string[] {
  return differences(before, after, volatile);
}
