import { describe, expect, test } from 'bun:test';
import { planEntries, toolKind, toolLocations, toolTitle } from '../src/tools';

describe('ACP tool projection', () => {
  test('toolKind maps Claude, Codex, Antigravity, and Gemini CLI tools without shadow lists', () => {
    expect(toolKind('Read')).toBe('read');
    expect(toolKind('read_file')).toBe('read');
    expect(toolKind('view_file')).toBe('read');
    expect(toolKind('list_dir')).toBe('read');

    expect(toolKind('Edit')).toBe('edit');
    expect(toolKind('apply_patch')).toBe('edit');
    expect(toolKind('edit_file')).toBe('edit');
    expect(toolKind('write_file')).toBe('edit');
    expect(toolKind('write_to_file')).toBe('edit');
    expect(toolKind('replace_file_content')).toBe('edit');
    expect(toolKind('multi_replace_file_content')).toBe('edit');

    expect(toolKind('Glob')).toBe('search');
    expect(toolKind('Grep')).toBe('search');
    expect(toolKind('WebSearch')).toBe('search');
    expect(toolKind('ToolSearch')).toBe('search');
    expect(toolKind('grep_search')).toBe('search');
    expect(toolKind('find_by_name')).toBe('search');
    expect(toolKind('search_web')).toBe('search');

    expect(toolKind('Bash')).toBe('execute');
    expect(toolKind('exec_command')).toBe('execute');
    expect(toolKind('run_command')).toBe('execute');

    expect(toolKind('WebFetch')).toBe('fetch');
    expect(toolKind('read_url_content')).toBe('fetch');

    expect(toolKind('TodoWrite')).toBe('think');
    expect(toolKind('update_plan')).toBe('think');
    expect(toolKind('ExitPlanMode')).toBe('switch_mode');
    expect(toolKind('mcp__linear__get_issue')).toBe('other');
  });

  test('toolLocations resolves, trims, and deduplicates snake_case and PascalCase path keys', () => {
    expect(toolLocations(undefined, '/repo')).toEqual([]);
    expect(
      toolLocations(
        {
          Path: '  src/app.ts  ',
          AbsolutePath: '/repo/src/app.ts',
          TargetFile: 'src/other.ts',
          DirectoryPath: '   ',
        },
        '/repo',
      ),
    ).toEqual([{ path: '/repo/src/app.ts' }, { path: '/repo/src/other.ts' }]);
  });

  test('toolTitle formats PascalCase path, command, pattern, url, and query keys', () => {
    expect(toolTitle('run_command', { CommandLine: '  bun test  ' })).toBe('run_command: bun test');
    expect(toolTitle('grep_search', { Query: 'toolKind' })).toBe('grep_search: toolKind');
    expect(toolTitle('find_by_name', { Pattern: '*.ts' })).toBe('find_by_name: *.ts');
    expect(toolTitle('read_url_content', { Url: 'https://example.com' })).toBe(
      'read_url_content: https://example.com',
    );
    expect(toolTitle('write_to_file', { TargetFile: '/repo/a.ts' })).toBe(
      'write_to_file: /repo/a.ts',
    );
    expect(toolTitle('list_dir', { DirectoryPath: '/repo/src' })).toBe('list_dir: /repo/src');
    expect(toolTitle('custom', {})).toBe('custom');
  });

  test('planEntries extracts TodoWrite and update_plan items', () => {
    expect(
      planEntries('TodoWrite', {
        todos: [{ content: 'Fix ACP tools', status: 'in_progress' }],
      }),
    ).toEqual([{ content: 'Fix ACP tools', priority: 'medium', status: 'in_progress' }]);
    expect(
      planEntries('update_plan', {
        plan: [{ step: 'Run check', status: 'completed' }],
      }),
    ).toEqual([{ content: 'Run check', priority: 'medium', status: 'completed' }]);
  });
});
