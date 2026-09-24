Implemented the bounded correction; awaiting independent review.

Current-message audit is excluded by message/thread/project identity while preserving the owned log, prior identical messages and mandatory context. Identity survives frozen plans, refire and historical inspection. A reproduced overlapping-load race now blocks the mismatched executor before its provider call.

Final checks passed with stable fingerprints:

- 89 focused tests.
- All 26 unchanged cases across eight memory acceptance files.
- 1,106 baseline test executions, source/strict test typechecks and diff checks.

[Dedicated handoff and exact reports](</Users/agreenspan/Library/Mobile Documents/com~apple~CloudDocs/Desktop/inixiative/foundry/docs/G3-current-admission-handoff.md>).

Browser verification and Fable review remain pending. Count stays 4. No probes, restarts, sibling/provider edits or commits. The separate learning-timeout investigation is the recommended next diagnostic slice; the full long-term goal remains unchanged.