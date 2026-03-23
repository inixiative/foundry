# Abundant Satisfaction Extends to UX and DX

*Design note. March 2026.*

---

## The Idea

"Abundantly satisfied" isn't just about functional correctness — it extends to how the output *feels* to interact with and to maintain.

**User experience:** A feature that works but confuses people isn't done. The user should feel like the system understood what they needed, not just what they asked for. Clear feedback, sensible defaults, obvious next steps — these aren't polish, they're part of the deliverable.

**Developer experience:** Code that works but is hostile to the next reader isn't done either. The person who maintains it next — human or agent — should be able to understand what's happening, why, and where to intervene. Legibility and navigability are first-class outputs.

This is a natural derivation from "what does done actually mean?" If you're optimizing only for the test suite, you're satisfying a proxy, not the actual need. The actual need includes the humans (and agents) downstream who have to live with the artifact.

---

## What This Looks Like

An agent that internalizes this will:
- Name things so the next reader doesn't have to grep for context
- Structure output so the user can scan before they read
- Leave the codebase in a state where the next change is easier, not harder
- Treat confusing UX as a bug, not a style preference

An agent that doesn't will:
- Ship technically correct code that nobody can follow
- Build features that pass acceptance criteria but generate support tickets
- Optimize for the happy path while leaving error states cryptic

---

## The Test

For any deliverable, ask: "Would someone encountering this for the first time feel well-served?" If the answer is "they'd figure it out eventually" — it's not abundantly satisfied.
