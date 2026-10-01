import { Writable } from 'node:stream';
import * as readline from 'readline/promises';

export interface SetupPrompts {
  ask(question: string, fallback?: string): Promise<string>;
  choose(question: string, options: string[], defaultIdx?: number): Promise<number>;
  confirm(question: string, fallback?: boolean): Promise<boolean>;
  /** Reads without echo. */
  secret(question: string): Promise<string>;
}

export function createTerminalPrompts(): SetupPrompts & { close(): void } {
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, done) {
      if (!muted) process.stdout.write(chunk, encoding);
      done();
    },
  });
  const rl = readline.createInterface({
    input: process.stdin,
    output,
    terminal: Boolean(process.stdin.isTTY),
  });
  const ask = async (question: string, fallback?: string) => {
    const hint = fallback ? ` [${fallback}]` : '';
    const answer = await rl.question(`  ${question}${hint}: `);
    return answer.trim() || fallback || '';
  };
  return {
    ask,
    async choose(question, options, defaultIdx = 0) {
      console.log(`\n  ${question}\n`);
      for (let i = 0; i < options.length; i++) {
        const marker = i === defaultIdx ? '>' : ' ';
        console.log(`    ${marker} ${i + 1}. ${options[i]}`);
      }
      console.log();
      const answer = await ask('Choice', String(defaultIdx + 1));
      const idx = parseInt(answer) - 1;
      return idx >= 0 && idx < options.length ? idx : defaultIdx;
    },
    async confirm(question, fallback = true) {
      const hint = fallback ? 'Y/n' : 'y/N';
      const answer = await ask(`${question} (${hint})`);
      if (!answer) return fallback;
      return answer.toLowerCase().startsWith('y');
    },
    async secret(question) {
      process.stdout.write(`  ${question}: `);
      muted = true;
      try {
        return (await rl.question('')).trim();
      } finally {
        muted = false;
        process.stdout.write('\n');
      }
    },
    close: () => rl.close(),
  };
}
