---
name: context
description: Use in a Foundry thread when you hit a gap about this codebase, its conventions or earlier decisions, or when the person gives feedback or a correction. Covers foundry_query, foundry_conventions, foundry_memory, foundry_device, Warden chimes, and the person's /feedback, /correction, /btw and /aside commands.
---

# Context, feedback and corrections

## When you need to know how something is done here

1. Read the Warden chimes on the person's message first: each points at an existing system ("Look over here: …"). Follow the pointer into the code.
2. Gaps the chimes don't cover: `foundry_query` `{topic}` searches this thread's Foundry context layers; `foundry_conventions` `{domain}` gives one region's instructions and knowledge (the region a chime named); `foundry_memory` searches the project's retained records.
3. Then the code itself.

Before building anything new, look for the thing already doing it, and name it in the plan's technical rows (see the `plan` skill).

`foundry_device` tells you which machine and checkout this session is bound to; use it instead of guessing paths.

## The person's commands

`/feedback`, `/correction`, `/btw` and `/aside` are Foundry's, not yours:

- `/feedback`, `/correction`: Foundry records what he said against this thread and turn and routes it to the Wardens. Don't argue with it or re-record it; apply it to the work now and say what you changed.
- `/btw`: a private note to you; act on it, don't repeat it back into a shared conversation.
- `/aside`: between the humans in a shared thread; you don't see it unless he promotes it.

A correction that contradicts an existing system needs his explicit acknowledgement before you replace that system: ask "this doesn't match what we have (X); confirm?"
