/**
 * @atlas
 * @kind helper, component
 * @partOf feature:viewer
 */
/**
 * The Plan tab's checklist, built from what the flow stream already records: the agent's own plan
 * tools (Claude's TodoWrite, Codex's update_plan) per turn, and the thread's child threads.
 *
 * Each step keeps the turn where it reached its current status ("when"). A child thread nests under
 * the step that was in progress on the turn that spawned it, else at the end. Pure: no DOM, no store.
 */

/** A plan tool's status → a status-icon state. */
export function stepState(status, { needsYou = false, failed = false } = {}) {
  switch (status) {
    case 'completed':
    case 'done':
      return 'done';
    case 'in_progress':
    case 'active':
      return needsYou ? 'approve' : failed ? 'error' : 'working';
    case 'blocked':
      return 'blocked';
    default:
      return 'queued';
  }
}

/**
 * @param {{
 *   turns: Array<{ turnId: string, status?: string, tasks?: Array<{ source: string, goal?: string, items: Array<{ text: string, status: string }> }> }>,
 *   children?: Array<{ threadId: string, name: string, state: string, parentTurnId?: string }>,
 *   needsYou?: boolean,
 * }} input turns oldest first
 * @returns {{ goals: Array<{ goal: string | null, source: string, steps: Array<{ text: string, state: string, when: string | null, children: Array<{ threadId: string, name: string, state: string }> }> }>, loose: Array<{ threadId: string, name: string, state: string }> }}
 */
export function buildChecklist({ turns, children = [], needsYou = false }) {
  /** source → { goal, steps: Map<text, { status, when, order }> } */
  const lists = new Map();
  /** turnId → texts in progress on that turn, for nesting child threads */
  const activeAt = new Map();
  const lastTurn = turns.at(-1);
  const failed = lastTurn?.status === 'failed' || lastTurn?.status === 'interrupted';

  for (const turn of turns) {
    for (const list of turn.tasks ?? []) {
      const entry = lists.get(list.source) ?? { goal: null, steps: new Map() };
      if (list.goal) entry.goal = list.goal;
      // The latest list is the plan; steps it dropped are gone.
      const next = new Map();
      list.items.forEach((item, order) => {
        const before = entry.steps.get(item.text);
        const when = before && before.status === item.status ? before.when : turn.turnId;
        next.set(item.text, { status: item.status, when, order });
        if (item.status === 'in_progress') {
          const texts = activeAt.get(turn.turnId) ?? [];
          texts.push(`${list.source}\u0000${item.text}`);
          activeAt.set(turn.turnId, texts);
        }
      });
      entry.steps = next;
      lists.set(list.source, entry);
    }
  }

  const goals = [...lists.entries()].map(([source, entry]) => ({
    goal: entry.goal,
    source,
    steps: [...entry.steps.entries()]
      .sort((a, b) => a[1].order - b[1].order)
      .map(([text, step]) => ({
        text,
        state: stepState(step.status, { needsYou, failed }),
        when: step.when,
        children: [],
      })),
  }));

  const loose = [];
  for (const child of children) {
    const key = child.parentTurnId ? activeAt.get(child.parentTurnId)?.[0] : undefined;
    const [source, text] = key ? key.split('\u0000') : [];
    const step = goals.find((g) => g.source === source)?.steps.find((s) => s.text === text);
    const node = { threadId: child.threadId, name: child.name, state: child.state };
    if (step) step.children.push(node);
    else loose.push(node);
  }
  return { goals, loose };
}

/** Plan progress: done steps over all steps. */
export function progress(checklist) {
  const steps = checklist.goals.flatMap((g) => g.steps);
  return { done: steps.filter((s) => s.state === 'done').length, total: steps.length };
}
