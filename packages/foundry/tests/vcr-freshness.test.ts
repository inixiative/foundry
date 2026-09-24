// The freshness policy runs with every `bun run test`: replayed cassettes are only evidence
// while they are recent, recorded on the CLIs in use, scrubbed, and free of unreviewed drift.
import { expect, test } from "bun:test";
import { agentSessionVersion, cassettes, checkFreshness, installedVersions, readPolicy } from "../src/vcr";
import { FIXTURES_DIR } from "./helpers/vcr";

test("recorded cassettes are fresh, from the installed and blessed CLIs, scrubbed and reviewed", async () => {
  expect(cassettes(FIXTURES_DIR).length).toBeGreaterThan(0);
  const policy = readPolicy(FIXTURES_DIR);
  const clis = Object.keys(policy.blessed).filter(name => !name.startsWith("@"));
  const findings = checkFreshness(FIXTURES_DIR, { installed: await installedVersions(clis), agentSession: agentSessionVersion });
  if (findings.length) throw Error(`${findings.map(f => `${f.cassette}: ${f.problem}`).join("\n")}\n\nRefresh with \`bun run test:live\` (and review any drift it reports).`);
}, 30_000);
