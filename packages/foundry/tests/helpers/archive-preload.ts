import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import './isolate-archive';

// Scenario tests make their scratch directories under `.foundry/qa` (gitignored); it exists before
// any of them runs, so a single test file passes alone as it does in the full suite.
mkdirSync(resolve('.foundry/qa'), { recursive: true });
