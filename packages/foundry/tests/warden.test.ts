import { beforeEach, describe, expect, it } from 'bun:test';
import {
  type CompletionResult,
  ContextLayer,
  type LLMMessage,
  type LLMProvider,
  SignalBus,
} from '@inixiative/foundry-core';
import { type GuardFinding, oneCall, type TurnActivity, Warden } from '../src/agents/warden';

// ---------------------------------------------------------------------------
// Mock LLM provider
// ---------------------------------------------------------------------------

function mockLLM(response: string): LLMProvider {
  return {
    id: 'mock',
    async complete(): Promise<CompletionResult> {
      return { content: response, model: 'mock' };
    },
  };
}

function failingLLM(): LLMProvider {
  return {
    id: 'failing',
    async complete(): Promise<CompletionResult> {
      throw new Error('LLM unavailable');
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConventionLibrarian(llm: LLMProvider, signals: SignalBus) {
  const cache = new ContextLayer({ id: 'convention-cache' });
  cache.set('Functions use camelCase. Files use kebab-case. No default exports.');
  return new Warden({
    domain: 'convention',
    cache,
    signals,
    llm,
    guardTriggers: ['file_write', 'file_create'],
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Warden', () => {
  let signals: SignalBus;

  beforeEach(() => {
    signals = new SignalBus();
  });

  describe('advise mode', () => {
    it('returns layers and snippets from LLM response', async () => {
      const llm = mockLLM(
        JSON.stringify({
          layers: ['auth-conventions', 'auth-api-docs'],
          snippets: ['Use JWT for all API endpoints'],
          confidence: 0.9,
        }),
      );
      const lib = makeConventionLibrarian(llm, signals);
      const result = await lib.advise('How should I handle auth tokens?');

      expect(result.layers).toEqual(['auth-conventions', 'auth-api-docs']);
      expect(result.snippets).toHaveLength(1);
      expect(result.confidence).toBe(0.9);
    });

    it('handles LLM response wrapped in code fence', async () => {
      const llm = mockLLM(
        '```json\n{"layers": ["test-layer"], "snippets": [], "confidence": 0.8}\n```',
      );
      const lib = makeConventionLibrarian(llm, signals);
      const result = await lib.advise('test message');

      expect(result.layers).toEqual(['test-layer']);
      expect(result.confidence).toBe(0.8);
    });

    it('returns empty on LLM failure', async () => {
      const lib = makeConventionLibrarian(failingLLM(), signals);
      const result = await lib.advise('test message');

      expect(result.layers).toHaveLength(0);
      expect(result.confidence).toBe(0);
    });

    it('returns empty when cache is empty', async () => {
      const cache = new ContextLayer({ id: 'empty-cache' });
      const lib = new Warden({
        domain: 'empty',
        cache,
        signals,
        llm: mockLLM('should not be called'),
      });
      const result = await lib.advise('test message');

      expect(result.layers).toHaveLength(0);
      expect(result.confidence).toBe(0);
    });

    it('includes thread state when provided', async () => {
      let capturedMessages: LLMMessage[] = [];
      const llm: LLMProvider = {
        id: 'capture',
        async complete(messages): Promise<CompletionResult> {
          capturedMessages = messages;
          return { content: '{"layers":[],"snippets":[],"confidence":0.5}', model: 'mock' };
        },
      };
      const lib = makeConventionLibrarian(llm, signals);
      await lib.advise('test', '{"domain":"auth"}');

      const userMsg = capturedMessages.find((m) => m.role === 'user')!;
      expect(userMsg.content).toContain('Thread state');
      expect(userMsg.content).toContain('auth');
    });
  });

  describe('guard mode', () => {
    it('guards file_write observations', async () => {
      const llm = mockLLM(
        JSON.stringify({
          findings: [
            {
              severity: 'advisory',
              description: 'Function name uses snake_case, should be camelCase',
              location: 'src/auth/service.ts:42',
            },
          ],
        }),
      );
      const lib = makeConventionLibrarian(llm, signals);
      const result = await lib.guard(
        oneCall({
          tool: 'file_write',
          input: { file_path: 'src/auth/service.ts' },
          output: 'function get_user() { ... }',
        }),
      );

      expect(result.outcome.status).not.toBe('not-sent');
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].severity).toBe('advisory');
      expect(result.findings[0].description).toContain('snake_case');
    });

    it('skips guard for non-matching tool types', async () => {
      const lib = makeConventionLibrarian(mockLLM('unused'), signals);
      const result = await lib.guard(
        oneCall({
          tool: 'file_read',
          input: { file_path: 'src/auth/service.ts' },
        }),
      );

      expect(result.outcome.status).toBe('not-sent');
      expect(result.findings).toHaveLength(0);
    });

    it('emits a guard_finding signal, not a correction, for advisory findings', async () => {
      const llm = mockLLM(
        JSON.stringify({
          findings: [
            {
              severity: 'advisory',
              description: 'Missing JSDoc',
            },
          ],
        }),
      );
      const lib = makeConventionLibrarian(llm, signals);

      const emitted: any[] = [];
      signals.onAny((s) => {
        emitted.push(s);
      });

      await lib.guard(
        oneCall({
          tool: 'file_write',
          input: { file_path: 'src/utils.ts' },
        }),
      );

      expect(emitted).toHaveLength(1);
      expect(emitted[0].kind).toBe('guard_finding');
    });
  });
});
