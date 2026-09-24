# Live inspection and segment semantics

Parent read-only browser audit, 12:39:59Z. Actual Foundry4400 project/thread,
desktop1440x960 and mobile390x960, fresh browser contexts, all API methods other
than GET/HEAD blocked. No native work, account mutation or server change.

Evidence: .foundry/qa/g6-live-inspection-2026-09-07T12-39-59.394Z/report.json,
1440-context.png and390-context.png (both independently viewed). Selected last
completed turn_b086ace9-9e7e-4c9d-95e5-a4c63fb89082, waited for trace controls,
clicked Turn Context, waited for Prepared initial provider messages before read.
Earlier12:38:55observation raced asynchronous trace loading: text came from current
thread while screenshot showed trace summary. Preserve it but don't use its text
as historical-context proof. This was an observer defect, not a UI selection bug.

## Findings

- Generated thread-knowledge:conventions and thread-knowledge:memory appear as
  DOMAIN-KNOWLEDGE contribution content. Actual runtime construction lacks explicit
  semantic segment; core messages.ts falls back to a small ID heuristic. This
  contradicts CORE002's requirement for explicit instructions/domain/thread fields.
- Fresh browser contexts each show100 browser-storage quota warnings. Message copy
  correctly says server-durable results were not lost, but normal use floods the
  conversation with optional-cache failures. Do not hide genuine unsaved work to
  fix this; use explicit cache policy and authoritative server history.
- Selected context has zero links. Raw file paths and unrendered Markdown in chat
  do not provide the requested actual artifact navigation. A turn-context check
  alone does not prove every application artifact surface is absent.
- No page-level horizontal overflow at either viewport; mobile inspector is usable
  for navigation. Desktop right panel is narrow enough to break words in long raw
  text frequently; native outcome/current history/three-part state need structured
  scanning, not merely more JSON. Screenshots document ergonomics, not full QA.

## Reproduction and next action

Parent acceptance/generated-knowledge-segment.test.ts creates actual runtime and
factory layers, seeds controlled generated content, and assembles the reading view
without model calls.1pass/1fail: generated content mislabeled domain-knowledge,
other-thread privacy control passes. Explicit strict types pass. Report:
.foundry/qa/2026-09-07T12-42-11.119Z-5dbbcf02-3238-4159-b6b9-368491e46bda-G6.

Fable owns G6-generated-segment-and-usability-request.md after actual prior review
end_turn12:42:02.036Z/full handoff read. New turn9a2df604 accepted4400 HTTP200/start.
Implement explicit semantics through construction/assembly/snapshots/clone/restore;
do not rewrite historical evidence, infer semantics from IDs, change provider
content or narrow privacy. Cache/artifact/layout proposal only in this assignment;
separate follow-up implementation after bounded ownership and acceptance.
Core002/003/004/005 full scope retained. No leadership count advance.
