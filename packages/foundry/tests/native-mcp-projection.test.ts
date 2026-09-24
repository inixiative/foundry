import { test, expect } from "bun:test";
import { projectNative } from "../src/providers/native-evidence";

test("public MCP identity and omission flags survive projection without raw protocol or mutation",()=>{
  const value={kind:"tool_use",admissionId:"a",callId:"call",toolServer:"foundry_controlled",toolMethod:"foundry_memory",
    toolName:"mcp__foundry_controlled__foundry_memory",toolInput:{id:"owned",secret:"PRIVATE"},raw:{reasoning:"PRIVATE",launch:{key:"PRIVATE"}}};
  const projected=projectNative(value);
  expect(projected.toolServer).toBe("foundry_controlled");expect(projected.toolMethod).toBe("foundry_memory");expect(projected.toolInput).toEqual({id:"owned"});
  expect(projected.toolInputOmitted).toBeDefined();expect(JSON.stringify(projected)).not.toContain("PRIVATE");
  value.toolInput.id="changed";expect(projected.toolInput?.id).toBe("owned");expect(Object.isFrozen(projected.toolInput)).toBe(true);
  const result=projectNative({...value,kind:"tool_result",toolOutput:'{"content":[{"type":"image"}]}',toolOutputOmitted:true,toolError:false});
  expect(result.toolOutputOmitted).toBe(true);expect(result.toolError).toBe(false);expect(result.toolInput).toBeUndefined();
});
