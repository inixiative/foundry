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
  // Inline prose mentioning a runtime tag is not a trailing host instruction block.
  expect(splitHostInstructions('Fix the <runtime_info>foo</runtime_info>')).toBeNull();
  // Single-newline example or indented leading tag is user prose, not a T3 trailing block.
  expect(splitHostInstructions('Why did it emit?\n<runtime_info>foo</runtime_info>')).toBeNull();
  expect(splitHostInstructions('  <runtime_info>foo</runtime_info>')).toBeNull();
  // Unclosed/nested opening tag is malformed prose, not a trailing host block.
  expect(
    splitHostInstructions('<runtime_info>outer\n\n<runtime_info>inner</runtime_info>'),
  ).toBeNull();
});

test('T3 trailing runtime_info, pull_request_linking, and workspace_folders blocks split cleanly', () => {
  expect(
    splitHostInstructions(
      '<t3_code_instructions>\nDefault mode.\n</t3_code_instructions>\n\n<user_request>\nFix the parser\n</user_request>\n\n<runtime_info>Running in T3 Code.</runtime_info>\n\n<pull_request_linking>\nLink PRs.\n</pull_request_linking>\n\n<workspace_folders>\n- repoA\n</workspace_folders>',
    ),
  ).toEqual({
    userText: 'Fix the parser',
    instructions: [
      { tag: 't3_code_instructions', text: 'Default mode.' },
      { tag: 'runtime_info', text: 'Running in T3 Code.' },
      { tag: 'pull_request_linking', text: 'Link PRs.' },
      { tag: 'workspace_folders', text: '- repoA' },
    ],
  });

  // CRLF line endings split identically.
  expect(
    splitHostInstructions(
      '<t3_code_instructions>\r\nDefault mode.\r\n</t3_code_instructions>\r\n\r\n<user_request>\r\nFix CRLF\r\n</user_request>\r\n\r\n<runtime_info>Running on Windows.</runtime_info>',
    ),
  ).toEqual({
    userText: 'Fix CRLF',
    instructions: [
      { tag: 't3_code_instructions', text: 'Default mode.' },
      { tag: 'runtime_info', text: 'Running on Windows.' },
    ],
  });

  // Follow-up turn without <t3_code_instructions> / <user_request> when runtime context updates.
  expect(
    splitHostInstructions(
      'Now add a test\n\n<runtime_info>Running in T3 Code as Opus.</runtime_info>\n\n<workspace_folders>\n- repoA\n</workspace_folders>',
    ),
  ).toEqual({
    userText: 'Now add a test',
    instructions: [
      { tag: 'runtime_info', text: 'Running in T3 Code as Opus.' },
      { tag: 'workspace_folders', text: '- repoA' },
    ],
  });

  // A closed tag mentioned earlier in user prose does not prevent peeling the real trailing block.
  expect(
    splitHostInstructions(
      '<runtime_info>quoted example</runtime_info>\n\nPlease explain\n\n<runtime_info>Running in T3 Code.</runtime_info>',
    ),
  ).toEqual({
    userText: '<runtime_info>quoted example</runtime_info>\n\nPlease explain',
    instructions: [{ tag: 'runtime_info', text: 'Running in T3 Code.' }],
  });
});
