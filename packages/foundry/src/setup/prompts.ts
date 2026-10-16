import * as readline from 'node:readline';
import { Writable } from 'node:stream';

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
  // Lines are queued as they arrive, so answers piped in faster than the questions are asked
  // (scripted or agent-driven setup) wait for their question instead of being dropped.
  const lines: string[] = [];
  const waiting: Array<(line: string | undefined) => void> = [];
  let ended = false;
  rl.on('line', (line) => {
    const next = waiting.shift();
    if (next) next(line);
    else lines.push(line);
  });
  rl.on('close', () => {
    ended = true;
    for (const next of waiting.splice(0)) next(undefined);
  });
  const nextLine = async (prompt: string): Promise<string> => {
    if (ended) output.write(prompt);
    else {
      rl.setPrompt(prompt);
      rl.prompt();
    }
    const line =
      lines.length > 0
        ? lines.shift()
        : ended
          ? undefined
          : await new Promise<string | undefined>((resolve) => waiting.push(resolve));
    if (line === undefined) throw Error('Setup input ended before every question was answered');
    return line;
  };
  const ask = async (label: string, fallback?: string) => {
    const hint = fallback ? ` [${fallback}]` : '';
    const answer = await nextLine(`  ${label}${hint}: `);
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
        return (await nextLine('')).trim();
      } finally {
        muted = false;
        process.stdout.write('\n');
      }
    },
    close: () => rl.close(),
  };
}
