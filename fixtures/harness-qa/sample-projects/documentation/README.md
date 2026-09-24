# Documentation QA Project

First task: read the architecture and conventions, then create `operations.md`
describing restart behavior without inventing guarantees. Inspect the source IDs,
source revisions, and injected conventions in Foundry's turn artifact.

Next, in this disposable copy only, change architecture.md to revision 2: messages
are now persisted atomically, but traces remain in memory and replay is manual.
Ask for an updated operations guide without restating those facts. Verify the new
source revision reaches the next message and the older turn still shows revision 1.

Teach thread A a private decision: its deployment name is `ONLY-A`. Ask thread B
for a guide without that decision. It must not invent or repeat `ONLY-A`. Fork A
and inspect the declared inheritance boundary; do not infer success from prose.

The knowledge-update and provenance checks are G3/G4/G6 scenarios, not currently
verified capabilities. This fixture defines expected behavior rather than mocking
the harness into passing it.
