---
name: running
description: Use in a Foundry thread before starting a background shell, a dev server, a watcher or a monitor. Foundry lists every background task the agent starts in the thread's Running panel with its label and command; covers labeling them, checking them and leaving them stoppable.
---

# Background work (the Running panel)

Every background task you start (a shell with `run_in_background`, a monitor) shows in this thread's **Running** panel: its label, its exact command, running or finished, and a Stop button for the person.

## Label it

The tool call's `description` is the label. Name what it is, then where, in a few plain words (labeling rules):

- "API server · :8200", "Typecheck (watch)", "Foundry full check"
- Not "Run command", "background task", "wait".

## Use it sparingly

- Start one only when the work outlives a turn (a server, a watcher, a long check). Short commands run in the foreground.
- Don't start a second copy of something already running; check what you started.
- Stop what you no longer need before handing back. A server the person should keep using, leave running and say so.
- Ports come from the project's registry, never hand-picked.

## Waiting on it

Wait for its completion notice or its output; don't poll it with sleeps.
