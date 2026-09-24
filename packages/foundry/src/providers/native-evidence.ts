import { freezeEvidence, type NativeEvidence, type NativeOwner } from "@inixiative/foundry-core";

const strings = ["admissionId", "nativeSessionId", "externalSessionId", "threadId", "turnId", "itemId", "callId", "localFailure", "correlation"] as const;
/** Public allowlisted labels for omitted non-text tool-result blocks; anything else is "unsupported". */
const OMITTED_RESULT_TYPES = new Set(["image", "audio", "document", "resource", "resource_link", "unsupported"]);
/** Translate once. Unknown fields and raw envelopes never cross this boundary. */
export function projectNative(value: unknown, owner?: NativeOwner): NativeEvidence {
  const v = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const out: Record<string, unknown> = { schema: 1, ...(owner ? { owner } : {}), nativeOutcome: "unknown" };
  for (const key of strings) if (typeof v[key] === "string") out[key] = v[key];
  if (typeof v.timestamp === "number" && Number.isFinite(v.timestamp)) out.observedAt=v.timestamp;
  const runtime = v.kind === "native_status" && v.raw && typeof v.raw === "object" ? v.raw as Record<string,unknown> : undefined;
  if (runtime && ["thread-refused","mcp-ready","server-request-refusal"].includes(String(runtime.type))) {
    const status: Record<string,unknown> = {type:runtime.type};
    if (["unknown","active","notLoaded","systemError","connected","refused","write-failed"].includes(String(runtime.status))) status.status=runtime.status;
    if (["binding-mismatch","not-idle","configuration-missing-or-incompatible","mcp-inventory-malformed","mcp-inventory-duplicate","mcp-inventory-unavailable","mcp-inventory-cursor","mcp-inventory-page-limit"].includes(String(runtime.reason))) status.reason=runtime.reason;
    if (runtime.type === "mcp-ready" && typeof runtime.server === "string" && /^foundry_[a-zA-Z0-9]+$/.test(runtime.server)) {
      status.server=runtime.server;
      if(Array.isArray(runtime.tools))status.tools=runtime.tools.filter(t=>["foundry_query","foundry_memory"].includes(String(t)));
    }
    out.runtimeStatus=status;
  }
  for (const [key, allowed] of Object.entries({ nativeOutcome: ["unknown","completed","failed"], localOutcome: ["pending","resolved","rejected"],
    dispatch: ["not-dispatched","attempted"], transportOutcome: ["open","failed","closed"], rpcOutcome: ["pending","resolved","failed","unknown"] })) {
    if (typeof v[key] === "string" && allowed.includes(v[key] as string)) out[key] = v[key];
  }
  if (typeof v.rpcRequestId === "string" || typeof v.rpcRequestId === "number") out.rpcRequestId = v.rpcRequestId;
  if (typeof v.content === "string" && typeof v.admissionId === "string" && ["unknown","completed","failed"].includes(String(v.nativeOutcome)) && v.kind !== "thinking") out.content = v.content;
  const terminal = v.terminal as Record<string, unknown> | undefined;
  if (terminal && typeof terminal.type === "string") {
    const t: Record<string, unknown> = { type: terminal.type };
    for (const key of ["eventId","turnId","subtype","reason"]) if (typeof terminal[key] === "string") t[key] = terminal[key];
    if (typeof terminal.apiErrorStatus === "number") t.apiErrorStatus = terminal.apiErrorStatus;
    out.terminal = t;
    if (terminal.reason === "api_error" || (typeof terminal.apiErrorStatus === "number" && terminal.apiErrorStatus >= 400) || (typeof terminal.subtype === "string" && terminal.subtype.startsWith("error_"))) out.nativeOutcome = "failed";
  }
  if (["text","text_delta","result","tool_start","tool_end","tool_use","tool_result","native_status","session_end"].includes(String(v.kind))) {
    out.kind = v.kind;
    if (typeof v.text === "string") out.text = v.text;
    if (v.kind === "text" || v.kind === "text_delta") {
      const raw = v.raw as {type?:unknown;phase?:unknown} | undefined;
      out.textKind = v.kind === "text_delta" || raw?.type === "agent_message_delta" ? "delta" : "snapshot";
      if (raw?.phase === "commentary" || raw?.phase === "final_answer") out.textPhase = raw.phase;
    }
    if (typeof v.toolName === "string") out.toolName = v.toolName;
    for (const key of ["toolServer", "toolMethod", "toolInputOmitted"]) if (typeof v[key] === "string") out[key] = v[key];
    if (v.toolOutputOmitted === true) out.toolOutputOmitted = true;
    if (v.kind === "tool_use" && v.toolInput && typeof v.toolInput === "object" && !Array.isArray(v.toolInput)) {
      // Public tool arguments are an explicit protocol subtree. Preserve owned
      // JSON data, excluding secret/environment/reasoning fields at every depth.
      const seen = new WeakSet<object>(); let omitted = false;
      const clean = (value: unknown, depth = 0): unknown => {
        if (depth > 32) { omitted=true; return "[depth unavailable]"; }
        if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
        if (!value || typeof value !== "object" || seen.has(value)) { omitted=true; return "[unsupported value]"; }
        seen.add(value);
        const result = Array.isArray(value) ? value.map(item=>clean(item,depth+1)) : Object.fromEntries(Object.entries(value).flatMap(([key,item])=> {
          if (/^(?:__proto__|constructor|prototype|env|environment|authorization|credentials?|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|reasoning|thinking)$/i.test(key)) { omitted=true; return []; }
          return [[key,clean(item,depth+1)]];
        }));
        seen.delete(value);return result;
      };
      out.toolInput=clean(v.toolInput);
      // The recorded MCP exec_command_begin envelope retains original argv;
      // its legacy normalized display string loses argument boundaries. Copy
      // only this explicitly known field, never a generic raw passthrough.
      const raw=v.raw as {type?:unknown;command?:unknown;params?:{msg?:{type?:unknown;command?:unknown}}}|undefined;
      const command = raw?.params?.msg?.type === "exec_command_begin" ? raw.params.msg.command : raw?.type === "exec_command_begin" ? raw.command : undefined;
      if (Array.isArray(command) && command.every(arg=>typeof arg==="string")) (out.toolInput as Record<string,unknown>).commandArgv=clean(command);
      if(omitted)out.toolInputOmitted="secret, environment, reasoning or unsupported fields omitted";
    }
    if (v.kind === "tool_result" && typeof v.toolOutput === "string") out.toolOutput = v.toolOutput;
    if (v.kind === "tool_result" && typeof v.toolError === "boolean") out.toolError = v.toolError;
    if (v.kind === "tool_result") {
      // Public tool-reference contract. Only non-empty strings are references; any other
      // entry or a non-array value cannot be represented and becomes an explicit omission,
      // so a partial list is never mistaken for a complete discovery result.
      const omittedTypes: string[] = [];
      const omit = (label: unknown) => { const value = typeof label === "string" && OMITTED_RESULT_TYPES.has(label) ? label : "unsupported"; if (!omittedTypes.includes(value)) omittedTypes.push(value); };
      if (Object.hasOwn(v, "toolReferences")) {
        if (Array.isArray(v.toolReferences)) {
          const valid = v.toolReferences.filter((r): r is string => typeof r === "string" && r.length > 0);
          if (valid.length) out.toolReferences = [...valid];
          if (valid.length !== v.toolReferences.length) omit("unsupported");
        } else omit("unsupported");
      }
      if (Array.isArray(v.toolOutputOmittedTypes)) for (const label of v.toolOutputOmittedTypes) omit(label);
      else if (v.toolOutputOmittedTypes !== undefined) omit("unsupported");
      if (omittedTypes.length) { out.toolOutputOmitted = true; out.toolOutputOmittedTypes = omittedTypes; }
    }
  }
  return freezeEvidence(out) as unknown as NativeEvidence;
}
