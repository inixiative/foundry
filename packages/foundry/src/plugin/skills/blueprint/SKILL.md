---
name: blueprint
description: Make animated explainers drawn like a Victorian patent sheet on blueprint paper. A mechanism is built part by part, each numbered with a leader line, each added because the last one fell short ("but… so…"), while tokens travel along lines and a one-line caption tells the story. Use in Foundry when Blueprint diagrams are enabled for plans and loops, or whenever the user asks for a blueprint or patent-drawing explainer, an animated mechanism diagram, or a visual walkthrough of a system, flow, or incident. Renders live in Foundry Viewer via `set_artifact` (`kind: 'blueprint'`) or a fenced ```` ```blueprint ```` JSON block.
---

# Blueprint

One scene explains one mechanism. The sheet starts empty. Each step draws in the parts it needs, moves something along a line, or changes a part's state, and shows one caption. Parts are numbered like a patent drawing, and the captions refer to them by number. The finished sheet must explain the idea on its own as a still image.

The drawing is done by `blueprint.js` (bundled directly in Foundry Viewer — no network fetches, no hand-drawn SVG). You write a plain JSON scene object of `title`, `size`, `parts`, `lines`, and `steps`, and Foundry Viewer draws it, animates it, and adds play/step/replay controls plus the parts key.

## Showing a Blueprint in Foundry

- **Side-by-side artifact (preferred for plans, architecture, and loops):** call `set_artifact` with `kind: "blueprint"` and `content` set to the raw JSON scene object (no fence, no `BLUEPRINT.scene(...)` wrapper). Each update with the same `id` saves a new version beside the thread.
- **Inline in a reply:** emit a fenced ```` ```blueprint ```` block containing the raw JSON scene object. Foundry Viewer lazy-loads the Blueprint runtime once the turn finishes streaming and renders the interactive scene in place (cyanotype `blue` paper in dark mode, `linen` paper in light mode, or whatever `"paper"` the scene specifies).

## Files

- `references/craft.md`: the scene format, every part kind with its sizes and states, line kinds, step actions, the metaphor catalogue, and common layout mistakes. **Read it before writing a scene.** (Note: in Foundry, write raw JSON objects — double-quoted keys, no `BLUEPRINT.scene(...)` wrapper, no JS comments.)
- `scripts/check.mjs`: lints a `.json` or `.js` scene without a browser (unknown ids, empty scenes, parts no step draws, overlaps, lines through parts or text, labels off the sheet, long captions).

## Minimal JSON example

```json
{
  "title": "How a cache works",
  "size": [600, 260],
  "parts": [
    { "id": "app", "kind": "screen", "at": [100, 130], "label": "APP" },
    { "id": "cache", "kind": "drawer", "at": [300, 130], "n": 1, "name": "Cache", "note": "keeps recent answers", "label": "CACHE" },
    { "id": "db", "kind": "cabinet", "at": [500, 130], "n": 2, "name": "Database", "label": "DB" }
  ],
  "lines": [
    { "id": "req", "from": "app.e", "to": "cache.w", "arrow": true },
    { "id": "miss", "from": "cache.e", "to": "db.w", "arrow": true }
  ],
  "steps": [
    { "say": "The app checks the cache (1) first.", "draw": ["app", "cache", "req"], "run": { "on": "req", "item": "chip", "text": "#42" } },
    { "say": "On a miss, it falls through to the database (2).", "draw": ["db", "miss"], "run": { "on": "miss", "item": "chip", "text": "#42" } }
  ]
}
```

## Workflow

1. **Find the mechanism.** In one line: what goes in, what comes out, and what the reader should understand at the end. Then write the "but… so…" chain: the simplest version first, the problem it has, the part that fixes it, the next problem, and so on. Each link becomes a step. If you cannot write the chain, the topic is too broad: pick one mechanism inside it.
2. **Pick the parts** from the kit using the metaphor catalogue in `references/craft.md` (a cache is a drawer, a queue is a rack of slots, auth is a lock and key, a rate limit is a tank).
3. **Lay out the sheet on paper first.** Flow runs left to right, layers top to bottom. Fix every part's centre (`at`) on a 20 px grid with at least 40 px between parts, then the lines, then the steps.
4. **Lint it** before emitting it, until `check.mjs` prints `clean`:
   ```sh
   node <skill-dir>/scripts/check.mjs /tmp/scene.json
   ```
   `<skill-dir>` is the folder this `SKILL.md` is in. Fix every error and layout warning unless an overlap is deliberate.
5. **Show it in Foundry** with `set_artifact` (`kind: "blueprint"`) or a ```` ```blueprint ```` fenced JSON block.

## Style rules

- **Concrete first.** Open with one specific request, token, or event. Generalize only at the end.
- **But… so….** Every part after the first arrives because of a problem the reader just saw. If a part cannot justify why the simpler design before it fell short, cut that part from the design too.
- **Number parts in the order they appear** (`n: 1`, `2`, `3`…) and refer to them in captions as `(2)`. Give every numbered part a `name` and `note` for the key.
- **Plain words in captions.** One caption, one sentence, under 100 characters, in present tense. Leave out `hold` so the runtime sizes reading time automatically.
- **Real numbers.** Notes carry concrete units (`~120 MS`, `15 MIN`, `3 TRIES`).
- **Every step changes something.** If a step only has a caption, merge it into the next one.
- **Small scenes: 3–6 steps, 3–6 parts.** **Complex scenes: 7–10 steps, 6–14 parts** (use `view` camera moves and end on `"all"`).
- **The last frame is a summary.** By the final step every part is drawn and a reader looking only at the still gets the whole idea.
