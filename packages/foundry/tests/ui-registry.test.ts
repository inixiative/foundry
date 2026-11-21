import { beforeEach, expect, test } from 'bun:test';
import { safeCall } from '../src/viewer/ui/error-boundary.js';
import {
  _resetRegistryForTests,
  extendSection,
  leftTabs,
  mainViews,
  namespaceId,
  reconcileItems,
  registerBuiltinLeftTab,
  registerBuiltinMainView,
  registerBuiltinRightTab,
  registerCommand,
  registerLeftTab,
  registerMainView,
  registerRightTab,
  resolveActiveId,
  rightTabs,
  sectionItems,
  setExtensionOrder,
  setFlags,
  uiConfigSignal,
  unregisterExtension,
  useComponentFlags,
} from '../src/viewer/ui/ui-registry.js';

beforeEach(() => {
  _resetRegistryForTests();
});

test('reconcileItems applies additive slotOverride (pinned -> order -> unlisted built-ins -> minus hidden)', () => {
  const builtIns = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd-new' }];
  const result = reconcileItems(builtIns, [], {
    pinned: ['c'],
    order: ['b'],
    hidden: ['a'],
  });
  // c (pinned), b (ordered), d-new (unlisted built-in preserved!), a (hidden)
  expect(result.map((x) => x.id)).toEqual(['c', 'b', 'd-new']);
});

test('reconcileItems resolves before/after chains, preserves multi-after order, appends missing targets, and breaks cycles', () => {
  const builtIns = [{ id: 'one' }, { id: 'two' }, { id: 'three' }];
  const exts = [
    // Chain where e2 targets e1 even though e2 appears first.
    { id: 'ext:e2', extId: 'ext', before: 'ext:e1', _seq: 1 },
    { id: 'ext:e1', extId: 'ext', before: 'two', _seq: 2 },
    // Two items anchored after 'two' preserve registration order.
    { id: 'ext:a1', extId: 'ext', after: 'two', _seq: 3 },
    { id: 'ext:a2', extId: 'ext', after: 'two', _seq: 4 },
    // Missing target appends at end.
    { id: 'ext:orphan', extId: 'ext', before: 'does-not-exist', _seq: 5 },
    // Cycle between c1 and c2 breaks deterministically with neither dropped.
    { id: 'ext:c1', extId: 'ext', before: 'ext:c2', _seq: 6 },
    { id: 'ext:c2', extId: 'ext', before: 'ext:c1', _seq: 7 },
  ];
  const ids = reconcileItems(builtIns, exts).map((x) => x.id);
  expect(ids).toEqual([
    'one',
    'ext:e2',
    'ext:e1',
    'two',
    'ext:a1',
    'ext:a2',
    'three',
    'ext:orphan',
    'ext:c2',
    'ext:c1',
  ]);
});

test('reconcileItems chains replace wrappers in ui.extensions[] order (last wins)', () => {
  const builtIns = [{ id: 'github', render: () => 'base' }];
  const exts = [
    { mode: 'replace', target: 'github', extId: 'ext-b', render: () => 'b', _seq: 1 },
    { mode: 'replace', target: 'github', extId: 'ext-a', render: () => 'a', _seq: 2 },
  ];
  const result = reconcileItems(builtIns, exts, null, {
    extensionOrder: ['ext-a', 'ext-b'],
  });
  expect(result).toHaveLength(1);
  // Ordered by ui.extensions[]: ext-a first, then ext-b outermost (last wins).
  expect(result[0]?._replacements?.map((r) => r.extId)).toEqual(['ext-a', 'ext-b']);
});

test('reconcileItems guarantees non-empty fallback when all tabs are hidden and resolveActiveId falls back', () => {
  const builtIns = [{ id: 'plan' }, { id: 'context' }];
  const result = reconcileItems(
    builtIns,
    [],
    { hidden: ['plan', 'context'] },
    { requireNonEmpty: true },
  );
  expect(result.map((x) => x.id)).toEqual(['plan']);
  expect(resolveActiveId(result, 'context', 'plan')).toBe('plan');
  expect(resolveActiveId(result, 'missing')).toBe('plan');
});

test('registry namespaces extension ids, resolves flags precedence, and cleans up on unregisterExtension', () => {
  expect(namespaceId('demo', 'panel')).toBe('demo:panel');
  expect(() => namespaceId('demo', '../bad')).toThrow();

  registerBuiltinLeftTab({ id: 'attention', label: 'Attention', row: 0, render: () => null });
  registerBuiltinRightTab({ id: 'context', label: 'Context', render: () => null });
  registerBuiltinMainView({ id: 'threads', label: 'Threads', scope: 'workspace' });

  setExtensionOrder(['ext-a', 'ext-b']);
  registerLeftTab('ext-a', { id: 'notes', label: 'Notes', render: () => null });
  registerRightTab('ext-a', { id: 'metrics', label: 'Metrics', render: () => null });
  registerMainView('ext-a', {
    id: 'dash',
    label: 'Dashboard',
    scope: 'workspace',
    render: () => null,
  });
  extendSection('ext-a', 'rightPanel.context.sections', {
    id: 'extra',
    after: 'github',
    render: () => null,
  });
  registerCommand('ext-a', { id: 'ping', label: 'Ping', action: () => {} });

  // Flag precedence: user ui.flags > ext-b > ext-a > defaults.
  setFlags('ext-a', 'rightPanel', { showComingSoon: false, showUsageBar: false });
  setFlags('ext-b', 'rightPanel', { showUsageBar: true });
  expect(
    useComponentFlags('rightPanel', {
      showComingSoon: true,
      showUsageBar: true,
      showRunningFooter: true,
    }),
  ).toEqual({
    showComingSoon: false,
    showUsageBar: true,
    showRunningFooter: true,
  });

  uiConfigSignal.value = { flags: { rightPanel: { showComingSoon: true } } };
  expect(useComponentFlags('rightPanel', { showComingSoon: true, showUsageBar: true })).toEqual({
    showComingSoon: true,
    showUsageBar: true,
  });

  expect(leftTabs().map((t) => t.id)).toEqual(['attention', 'ext-a:notes']);
  expect(rightTabs().map((t) => t.id)).toEqual(['context', 'ext-a:metrics']);
  expect(mainViews('workspace').map((v) => v.id)).toEqual(['threads', 'ext-a:dash']);
  expect(
    sectionItems('rightPanel.context.sections', [{ id: 'github' }, { id: 'runs-on' }]).map(
      (s) => s.id,
    ),
  ).toEqual(['github', 'ext-a:extra', 'runs-on']);

  // Unwired v1 scopes are rejected loudly.
  expect(() =>
    registerMainView('ext-a', {
      id: 'proj-view',
      label: 'Proj',
      scope: 'project',
      render: () => null,
    }),
  ).toThrow(/expected workspace \| thread/);

  unregisterExtension('ext-a');
  expect(leftTabs().map((t) => t.id)).toEqual(['attention']);
  expect(rightTabs().map((t) => t.id)).toEqual(['context']);
  expect(mainViews('workspace').map((v) => v.id)).toEqual(['threads']);
  expect(
    sectionItems('rightPanel.context.sections', [{ id: 'github' }, { id: 'runs-on' }]).map(
      (s) => s.id,
    ),
  ).toEqual(['github', 'runs-on']);
});

test('safeCall catches both sync throws and async Promise rejections', async () => {
  expect(
    safeCall(
      'broken',
      () => {
        throw new Error('sync boom');
      },
      'fallback-sync',
    ),
  ).toBe('fallback-sync');
  const asyncResult = await safeCall(
    'broken',
    async () => {
      throw new Error('async boom');
    },
    'fallback-async',
  );
  expect(asyncResult).toBe('fallback-async');
});
