/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * Where a thread's work stands on plan → build → review → land, from what is recorded. Pure.
 *   planned  a turn recorded a task list (or work already started)
 *   built    a turn completed or is running
 *   reviewed guards ran on a turn, or a GitHub pull request is linked
 *   landed   the thread is closed (archived)
 */
export function lifecycle(turns, meta) {
  const planned = turns.some((t) => t.tasks?.length);
  const built = turns.some((t) => t.status === 'completed' || t.status === 'active');
  const reviewed =
    turns.some((t) => Array.isArray(t.guards) && t.guards.length) ||
    (meta?.context?.references ?? []).some((r) => r.integration === 'github');
  const landed = meta?.status === 'archived';
  const steps = [
    { id: 'plan', label: 'Plan', done: planned || built },
    { id: 'build', label: 'Build', done: built },
    { id: 'review', label: 'Review', done: reviewed },
    { id: 'land', label: 'Land', done: landed },
  ];
  const current = landed ? 'land' : (steps.find((s) => !s.done)?.id ?? 'land');
  return steps.map((s) => ({ ...s, current: s.id === current }));
}
