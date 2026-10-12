import { expect, test } from 'bun:test';
import {
  ContextLayer,
  type LLMMessage,
  type LLMProvider,
  SignalBus,
} from '@inixiative/foundry-core';
import { DomainLibrarian, type ReviewInput } from '../src/agents/domain-librarian';
import { chartered } from '../src/agents/warden-charter';

for (const custom of [false, true]) {
  test(`post-work response protocol survives ${custom ? 'custom' : 'default'} domain instructions`, async () => {
    const calls: LLMMessage[][] = [];
    const llm: LLMProvider = {
      id: 'parent-review-contract',
      async complete(messages) {
        calls.push(structuredClone(messages));
        return {
          model: 'controlled',
          content: JSON.stringify({
            knowledge: 'Keep legacy writes compatible',
            facts: [],
            reason: 'observed result',
          }),
        };
      },
    };
    const cache = new ContextLayer({ id: 'architecture', segment: 'domain-knowledge' });
    cache.set('DOMAIN_KNOWLEDGE: preserve existing records');
    const instructions = 'DOMAIN_INSTRUCTIONS: track architecture decisions and their evidence.';
    const lib = new DomainLibrarian({
      domain: 'architecture',
      cache,
      signals: new SignalBus(),
      llm,
      ...(custom ? { reviewPrompt: instructions } : {}),
    });
    const evidence = { kind: 'dispatch' as const, id: 'completed-work', timestamp: 1 };
    lib.threadKnowledge.learn(
      'OWN_UNDERSTANDING: legacy callers remain',
      evidence,
      'parent-fixture',
    );
    const input: ReviewInput = {
      evidence,
      agentId: 'worker',
      userMessage: 'REQUEST: add preferred names',
      output: 'RESULT: migration passed',
      ok: true,
      toolObservations: [
        { tool: 'Bash', callId: 'test-call', ok: true, output: 'TOOL_EVIDENCE: nine tests passed' },
      ],
    };
    const result = await lib.review(input);
    expect(result.decision).toBe('learn');
    expect(calls).toHaveLength(1);
    if (custom) expect(calls[0]![0]).toEqual({ role: 'system', content: chartered(instructions) });
    const user = calls[0]!
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .join('\n');
    for (const part of [
      'DOMAIN_KNOWLEDGE',
      'OWN_UNDERSTANDING',
      'REQUEST',
      'RESULT',
      'TOOL_EVIDENCE',
    ])
      expect(user).toContain(part);
    // The phase owns its response contract independently of configurable domain instructions.
    for (const field of ['knowledge', 'facts', 'reason']) expect(user).toContain(`"${field}"`);
    expect(user).toContain('respond with exactly NO_COMMENT and nothing else');
    // NO_COMMENT is the review's nothing-new answer; the retired decision field is outside the protocol.
    expect(lib.parseReviewAnswer('NO_COMMENT')).toEqual({ decision: 'no-comment', facts: [] });
    expect(
      lib.parseReviewAnswer(JSON.stringify({ decision: 'abstain', knowledge: 'x' })).decision,
    ).toBe('invalid');
    expect(lib.parseReviewAnswer('NO_COMMENT: nothing new').decision).toBe('invalid');
  });
}
