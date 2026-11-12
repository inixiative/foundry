---
name: artifacts
description: Use in a Foundry thread when you make something the person should look at or keep beside the conversation (a design doc, a diagram, a mock page, a report, a script), rather than paste it into a reply. Covers set_artifact (markdown, mermaid, html, code), its versions, and what an HTML page may do in its sandbox.
---

# Artifacts (`set_artifact`)

An artifact is something you made to show the person: it sits in the thread's Artifacts tab, beside Plan, and as a card on the turn that saved it. Each save of the same `id` is a new version; earlier versions stay readable from a picker.

## When

- Something worth looking at or coming back to: a design doc, an architecture diagram, a mock of a page, a comparison table, a report, a script the person will run.
- Not for an answer that fits in the reply, and not for files in the repository (write those to the repository).

## How

| Field | What |
|---|---|
| `id` | a short slug (`checkout-flow`); the same id again saves its next version |
| `title` | what it is, in a few plain words |
| `kind` | `markdown`, `mermaid` (the diagram source only, no fence), `html` (a whole page), `code` |
| `language` | for `code`: `ts`, `python`, `sql`… |
| `content` | the whole artifact every time, never a diff |

Saving the same content, title and kind again is not a new version. `get_plan` lists the thread's artifacts (id, title, kind, newest version), so you can find them after a compaction.

## An HTML page

It runs in a sandboxed frame: its scripts run, but it has an opaque origin, so it cannot read the viewer, its cookies or its storage. It cannot fetch, open a socket or submit a form. Scripts, styles, fonts and images may load over https (a charting library from a CDN), or be inlined. Put the data the page needs in the page.
