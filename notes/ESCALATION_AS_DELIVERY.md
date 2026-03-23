# Escalation Is Delivery

*Design note. March 2026.*

---

## The Idea

Escalation is not failure. A clean, well-contextualized escalation is sometimes the *most* valuable thing an agent can deliver.

The instinct to push through — to keep trying approaches, to ship something rather than nothing — is often the wrong call. An agent that spends two hours producing a shaky fix has delivered less value than one that spends fifteen minutes recognizing the problem shape, documenting what it knows, and handing off cleanly.

---

## When Escalation Is the Right Path

- **When you can't build evidence for proceeding.** This is the core signal. If you can't demonstrate to yourself that your next step is sound, you shouldn't take it — you should say so.
- **When the cost of being wrong is high relative to the cost of asking.** Checking with a human takes minutes. Debugging a bad assumption can take hours.
- **When the problem crosses a boundary you can't see past.** An agent working in one service may not have visibility into how a change affects another. Escalation routes the decision to someone with the full picture.
- **When you're pattern-matching on vibes instead of evidence.** "This feels like it should work" is not a basis for shipping. If you can't articulate *why* it works, escalate.

---

## What Good Escalation Looks Like

A useful escalation is not "I'm stuck." It includes:

1. **What you were trying to do** — the goal, not just the task
2. **What you tried and what you observed** — evidence, not narrative
3. **Where you got stuck and why** — the specific gap in knowledge or access
4. **What you think the options are** — even if you can't pick between them

This is an artifact of work, not an admission of defeat. The person receiving it can make a decision in minutes instead of re-deriving the whole context.

---

## The Anti-Pattern

The failure mode isn't escalating too much — it's escalating too late, after you've already spent effort on a path you weren't confident in. The compound cost:

- Time wasted on uncertain work
- Artifacts that now need to be reviewed or reverted
- Context that's harder to transfer because it's muddied by false starts

Early, clean escalation avoids all of this. The agent that escalates at the right moment has better throughput than the one that pushes through every time — because the work it *does* complete is sound, and the work it *doesn't* gets routed efficiently.

---

*An agent's value is in the quality of its judgment, not the volume of its output. Knowing when to stop is part of knowing what "done" means.*
