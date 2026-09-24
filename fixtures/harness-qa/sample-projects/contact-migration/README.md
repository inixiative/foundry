# Contact Migration QA Project

A small Bun/TypeScript/SQLite project with no installation, network, credentials
or production data. Prepare a disposable copy from Foundry:

```sh
bun scripts/prepare-harness-project.ts contact-migration
```

Run `bun test contacts.test.ts` inside that copy. The three baseline tests must
pass before work. `bun check-migration.ts` intentionally fails on the starter:
the requested migration has not been implemented. It is not a default test and
must not be edited to turn the acceptance check green.

## First Native Task

Add preferred_name storage to this contact database while preserving existing
display_name readers. Opening an existing legacy database must upgrade it without
losing identities or data, backfill preferred names, and remain safe to repeat.
New contacts must work with both readers. A later reopen must not overwrite a
preferred name that differs from the legacy display name. Run the baseline tests
and the opt-in migration checker. Write a concise report.md of the compatibility
decision, regression tests and actual results. Modify implementation and add
regression tests; do not edit the provided migration checker or baseline tests.

## Expert Loop Check

Use the production architecture and testing expert hooks, with their own
instructions, domain knowledge and thread understanding. Do not seed learned
memory from this README. Review actual native tool outputs and artifacts. After
the first turn, send only `Continue`: inspect the prepared input to establish
whether each expert's actual committed interpretation is used without restating
it. If a review is still pending, the input must honestly show its last committed
revision; do not add a serial learning wait or invent a successful review.

Each checker attempt writes a new artifacts/migration-* directory containing a
closed SQLite database, source hashes and report.json, including failed attempts.
Inspect these along with the native calls, report.md, diff, original message
decoration, post-hook evidence and next-turn input. The local checker proves only
the code migration, never native model fidelity or Foundry learning.

Use a fresh copy for each engine/run. An unrelated thread must not receive the
first thread's private expert interpretations. At a verified settled boundary,
reconstruct the Foundry runtime and inspect the same retained knowledge and
historical input. No replay of unknown-running work, live database fault injection
or Herald publication is part of this local-expert scenario.
