import { expect, test } from "bun:test";
import { validateMemorySelection } from "../../../packages/core/src/adapters/file-memory";

for (const key of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
  test(`memory policy rejects inherited object name ${key} as an unknown option`, () => {
    const value = JSON.parse(`{"${key}":1}`);
    expect(() => validateMemorySelection(value)).toThrow(/unknown field/);
  });
}

test("memory policy still accepts its declared numeric fields", () => {
  expect(validateMemorySelection({ budgetChars: 6000, recentLimit: 0 })).toEqual({ budgetChars: 6000, recentLimit: 0 });
});
