import { expect, test } from "bun:test";
import { projectNative } from "../../../packages/foundry/src/providers/native-evidence";

const owner = { threadId: "controlled-thread", projectId: "controlled-project", generation: "g1", messageId: "logical-1", dispatchId: "dispatch-1" };

test("owned public tool arguments remain inspectable and immutable after projection", () => {
  const input = { command: "bun --version", cwd: "/controlled/project", options: { readOnly: true } };
  const projected = projectNative({ kind: "tool_use", admissionId: "admission-1", nativeSessionId: "native-1", callId: "call-1", toolName: "Bash", toolInput: input }, owner) as ReturnType<typeof projectNative> & { toolInput?: typeof input };
  expect(projected.toolInput).toEqual(input);
  expect(projected.owner).toEqual(owner);
  input.command = "changed after observation";
  input.options.readOnly = false;
  expect(projected.toolInput?.command).toBe("bun --version");
  expect(projected.toolInput?.options.readOnly).toBe(true);
  expect(Object.isFrozen(projected.toolInput)).toBe(true);
  expect(Object.isFrozen(projected.toolInput?.options)).toBe(true);
});

test("thinking text and unknown raw envelopes do not become public tool input", () => {
  const projected = projectNative({ kind: "thinking", admissionId: "admission-1", text: "CONTROLLED_PRIVATE_REASONING", toolInput: { text: "CONTROLLED_PRIVATE_INPUT" }, raw: { text: "CONTROLLED_PRIVATE_RAW" } }, owner);
  expect(JSON.stringify(projected)).not.toMatch(/CONTROLLED_PRIVATE_/);
  expect(projected.owner).toEqual(owner);
  expect(projected.admissionId).toBe("admission-1");
  expect(projected.nativeOutcome).toBe("unknown");
});

test("normal tool result retains owned output correlation without inventing input", () => {
  const projected = projectNative({ kind: "tool_result", admissionId: "admission-1", callId: "call-1", toolOutput: "1.3.14", toolError: false }, owner);
  expect(projected).toMatchObject({ kind: "tool_result", admissionId: "admission-1", callId: "call-1", toolOutput: "1.3.14", toolError: false, owner });
  expect("toolInput" in projected).toBe(false);
});
