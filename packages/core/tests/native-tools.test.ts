import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_CONSUMED_TOOLS,
  LINEAR_ISSUE_TOOLS,
  toolCapability,
  toolGlobMatcher,
  workItemId,
} from '../src/index';

describe('native tools', () => {
  test('capability by name', () => {
    expect(toolCapability('Edit')).toBe('file:write');
    expect(toolCapability('apply_patch')).toBe('file:write');
    expect(toolCapability('Bash')).toBe('exec:shell');
    expect(toolCapability('Grep')).toBe('file:read');
    expect(toolCapability('WebFetch')).toBe('net:fetch');
    expect(toolCapability('mcp__plugin_linear_linear__get_issue')).toBe('net:api');
    expect(toolCapability('TodoWrite')).toBe('tool:TodoWrite');
  });

  test('tool globs match case-insensitively, under any server name', () => {
    const linear = toolGlobMatcher(LINEAR_ISSUE_TOOLS);
    expect(linear('mcp__plugin_linear_linear__get_issue')).toBe(true);
    expect(linear('mcp__claude_ai_Linear__get_issue')).toBe(true);
    expect(linear('mcp__plugin_linear_linear__get_document')).toBe(false);
    expect(toolGlobMatcher(DEFAULT_CONSUMED_TOOLS)('mcp__claude_ai_Notion__notion-fetch')).toBe(
      true,
    );
  });

  test('a fetch names its item by the first id field it has', () => {
    expect(workItemId({ id: '', issueId: 'ZLT-1', url: 'x' })).toBe('ZLT-1');
    expect(workItemId({ query: 'x' })).toBeUndefined();
  });
});
