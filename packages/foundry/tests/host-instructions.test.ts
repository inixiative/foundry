import { expect, test } from 'bun:test';
import { splitHostInstructions } from '../src/turns/host-instructions';

test('T3 instruction and orchestration wrappers split from the user request', () => {
  expect(
    splitHostInstructions(
      '<t3_code_instructions>\nPlan mode.\n</t3_code_instructions>\n\n<user_request>\nAdd tests\nfor the parser\n</user_request>',
    ),
  ).toEqual({
    userText: 'Add tests\nfor the parser',
    instructions: [{ tag: 't3_code_instructions', text: 'Plan mode.' }],
  });
  expect(
    splitHostInstructions(
      '<t3_code_orchestration_instructions>Spawn threads.</t3_code_orchestration_instructions>\n\n<user_request>\nGo\n</user_request>',
    ),
  ).toEqual({
    userText: 'Go',
    instructions: [{ tag: 't3_code_orchestration_instructions', text: 'Spawn threads.' }],
  });
});

test('a prompt without a known wrapper, or with trailing text after the request, is left alone', () => {
  expect(splitHostInstructions('Just a question')).toBeNull();
  expect(splitHostInstructions('<user_request>\nhi\n</user_request>')).toBeNull();
  expect(
    splitHostInstructions(
      '<t3_code_instructions>x</t3_code_instructions>\n\n<user_request>\nhi\n</user_request>\nmore',
    ),
  ).toBeNull();
  expect(
    splitHostInstructions(
      '<other_instructions>x</other_instructions><user_request>hi</user_request>',
    ),
  ).toBeNull();
});
