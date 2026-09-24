import { test, expect } from "bun:test";
import { projectNative } from "../src/providers/native-evidence";

// Foundry projection of the sibling's public tool-reference contract (tool_result only).
// Synthetic public shapes; not evidence of any native capture's actual content.
const tool = "mcp__foundry_controlled__foundry_memory";
const owner = { threadId: "sample", projectId: "P", generation: "g", messageId: "m", dispatchId: "d" };
const base = { kind: "tool_result", admissionId: "a", callId: "discovery-call", toolOutput: "", toolError: false, raw: { credentials: "PRIVATE_REFERENCE_PAYLOAD" } };

test("valid references are copied in order with duplicates, frozen, and detached from the source and raw payload", () => {
  const references = [tool, "mcp__other__tool", tool];
  const projected = projectNative({ ...base, toolReferences: references, raw: { ...base.raw, toolReferences: ["PRIVATE_RAW_REF"] } }, owner);
  expect(projected.toolReferences).toEqual([tool, "mcp__other__tool", tool]);
  expect(Object.isFrozen(projected.toolReferences)).toBe(true);
  references.push("late"); expect(projected.toolReferences).toHaveLength(3);
  expect(projected.toolOutput).toBe(""); expect(projected.toolError).toBe(false); expect(projected.callId).toBe("discovery-call");
  expect(projected.admissionId).toBe("a"); expect(projected.owner).toEqual(owner);
  expect(projected.toolOutputOmitted).toBeUndefined(); expect(projected.toolOutputOmittedTypes).toBeUndefined();
  expect(JSON.stringify(projected)).not.toContain("PRIVATE");
});

test("malformed reference entries are never represented as a complete list: valid names kept, explicit omission recorded", () => {
  for (const refs of [[tool, 7], [tool, ""], [tool, null], [tool, { tool_name: tool }], ["", ""]]) {
    const projected = projectNative({ ...base, toolReferences: refs });
    expect(projected.toolOutputOmitted).toBe(true);
    expect(projected.toolOutputOmittedTypes).toEqual(["unsupported"]);
    if (refs[0] === tool) expect(projected.toolReferences).toEqual([tool]); else expect(projected.toolReferences).toBeUndefined();
  }
  for (const refs of ["not-an-array", { 0: tool }, 5]) {
    const projected = projectNative({ ...base, toolReferences: refs });
    expect(projected.toolReferences).toBeUndefined(); expect(projected.toolOutputOmitted).toBe(true); expect(projected.toolOutputOmittedTypes).toEqual(["unsupported"]);
  }
  expect(projectNative({ ...base, toolReferences: [] }).toolReferences).toBeUndefined();
  expect(projectNative({ ...base, toolReferences: [] }).toolOutputOmitted).toBeUndefined();
});

test("omission labels are public allowlisted values only; unknown or private labels collapse to unsupported and imply omission", () => {
  const projected = projectNative({ ...base, toolOutputOmitted: true, toolOutputOmittedTypes: ["image", "PRIVATE_BLOB_KIND", "resource_link", "image", 3, "unsupported"] });
  expect(projected.toolOutputOmitted).toBe(true);
  expect(projected.toolOutputOmittedTypes).toEqual(["image", "unsupported", "resource_link"]);
  expect(Object.isFrozen(projected.toolOutputOmittedTypes)).toBe(true);
  expect(JSON.stringify(projected)).not.toContain("PRIVATE");
  // Types without the flag cannot be represented as complete output: the flag is derived.
  const implied = projectNative({ ...base, toolOutputOmittedTypes: ["audio"] });
  expect(implied.toolOutputOmitted).toBe(true); expect(implied.toolOutputOmittedTypes).toEqual(["audio"]);
  // Flag without types stays a bare omission, as before.
  const bare = projectNative({ ...base, toolOutputOmitted: true });
  expect(bare.toolOutputOmitted).toBe(true); expect(bare.toolOutputOmittedTypes).toBeUndefined();
  // Mixed: text, references and omitted blocks are all retained separately.
  const mixed = projectNative({ ...base, toolOutput: "1 tool found\ndone", toolReferences: [tool], toolOutputOmitted: true, toolOutputOmittedTypes: ["image", "unsupported"] });
  expect(mixed).toMatchObject({ toolOutput: "1 tool found\ndone", toolReferences: [tool], toolOutputOmitted: true, toolOutputOmittedTypes: ["image", "unsupported"] });
});

test("reference fields are ignored on every kind except tool_result", () => {
  for (const kind of ["tool_use", "text", "result", "native_status", undefined]) {
    const projected = projectNative({ ...base, kind, toolReferences: [tool], toolOutputOmittedTypes: ["image"], toolOutputOmitted: true });
    expect(projected.toolReferences).toBeUndefined(); expect(projected.toolOutputOmittedTypes).toBeUndefined();
    if (kind !== undefined) expect(projected.kind).toBe(kind);
  }
});
