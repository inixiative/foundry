import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_CONSUMED_TOOLS,
  LINEAR_ISSUE_TOOLS,
  SEARCH_TOOLS,
  toolCapability,
  toolGlobMatcher,
  toolInputPaths,
  workItemId,
} from '../src/index';

describe('native tools', () => {
  test('capability by name across Claude, Codex, Antigravity, and Gemini CLI', () => {
    expect(toolCapability('Edit')).toBe('file:write');
    expect(toolCapability('apply_patch')).toBe('file:write');
    expect(toolCapability('write_to_file')).toBe('file:write');
    expect(toolCapability('replace_file_content')).toBe('file:write');
    expect(toolCapability('multi_replace_file_content')).toBe('file:write');
    expect(toolCapability('edit_file')).toBe('file:write');
    expect(toolCapability('write_file')).toBe('file:write');
    expect(toolCapability('Bash')).toBe('exec:shell');
    expect(toolCapability('run_command')).toBe('exec:shell');
    expect(toolCapability('Grep')).toBe('file:read');
    expect(toolCapability('view_file')).toBe('file:read');
    expect(toolCapability('list_dir')).toBe('file:read');
    expect(toolCapability('grep_search')).toBe('file:read');
    expect(toolCapability('find_by_name')).toBe('file:read');
    expect(toolCapability('WebFetch')).toBe('net:fetch');
    expect(toolCapability('search_web')).toBe('net:fetch');
    expect(toolCapability('read_url_content')).toBe('net:fetch');
    expect(toolCapability('mcp__plugin_linear_linear__get_issue')).toBe('net:api');
    expect(toolCapability('TodoWrite')).toBe('tool:TodoWrite');
    expect(SEARCH_TOOLS.has('grep_search')).toBe(true);
    expect(SEARCH_TOOLS.has('search_web')).toBe(true);
    expect(SEARCH_TOOLS.has('view_file')).toBe(false);
  });

  test('toolInputPaths extracts trimmed, deduplicated paths across snake_case and PascalCase keys', () => {
    expect(toolInputPaths(undefined)).toEqual([]);
    expect(
      toolInputPaths({
        file_path: '  src/a.ts  ',
        Path: 'src/a.ts',
        TargetFile: 'src/b.ts',
        AbsolutePath: '   ',
        DirectoryPath: '/repo/dir',
        SearchPath: '/repo/search',
        SearchDirectory: '/repo/find',
        other: 123,
      }),
    ).toEqual(['src/a.ts', 'src/b.ts', '/repo/dir', '/repo/search', '/repo/find']);
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
