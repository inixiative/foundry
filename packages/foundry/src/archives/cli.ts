import { createTerminalPrompts } from '../setup/prompts';
import { runArchiveCli } from './local';
import { runArchiveSetup } from './setup';

/** `bun run archive`: `setup` starts the local Archive; every other command is the Archive CLI. */
export async function runFoundryArchiveCli(args = Bun.argv.slice(2)) {
  if (args[0] !== 'setup') {
    process.exitCode = (await runArchiveCli(args)).code;
    return;
  }
  if (args.includes('--help')) {
    console.log(
      "setup [--yes]   Start this machine's local Archive (archive up, Docker Compose) and confirm it answers. Hosted Archives connect through Kingdom.",
    );
    return;
  }
  const prompts =
    !args.includes('--yes') && process.stdin.isTTY ? createTerminalPrompts() : undefined;
  try {
    const result = await runArchiveSetup({ prompts });
    console.log(JSON.stringify(result, null, 2));
    if (!result.reachable) process.exitCode = 1;
  } finally {
    prompts?.close();
  }
}
if (import.meta.main)
  runFoundryArchiveCli().catch((error) => {
    console.error(
      error instanceof Error && error.name === 'Error' ? error.message : 'Archive setup failed.',
    );
    process.exitCode = 1;
  });
