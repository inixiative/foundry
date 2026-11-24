# Blueprint craft

Everything you need to write a scene. Read it once in full before the first scene.

## 1. The scene

```js
BLUEPRINT.scene('cache', {
  title: 'How a cache works',   // printed at the top of the sheet, in caps
  fig: 1,                        // "FIG. 1" at the top left (optional)
  sheet: 'SHEET 1 OF 1',         // top right (optional)
  paper: 'blue',                 // 'blue' (default) or 'linen'
  size: [640, 320],              // drawing area in units; small scenes 640×320, complex 800×400
  sources: [                     // optional: where the facts come from (incidents, news)
    ['Postmortem', 'https://example.com/postmortem'],
    ['Status page', 'https://example.com/status']
  ],
  parts: [ … ],
  lines: [ … ],
  steps: [ … ]
});
```

The sheet adds a border, a header and a caption band around the drawing area, so you only lay out inside `size`. (0, 0) is the top left of the drawing area. Keep parts at least 24 units from the edges so labels and numerals fit.

Ids: letters, digits, `_` and `-`. Parts and lines share one namespace.

`sources` is a list of `[name, url]` pairs. The sheet itself never shows them: `scripts/build.mjs` lists them as links under the scene, and so does the site's viewer. Only `http://` and `https://` links are kept. GIF, MP4 and PNG exports leave them out, so hand the links over with the file.

## 2. Parts

```js
{ id: 'drawer', kind: 'drawer', at: [300, 88], size: [84, 38],
  label: 'CACHE', labelAt: 'n',
  n: 2, lead: 'ne', name: 'Cache', note: 'a drawer by the door that keeps recent answers',
  slots: 3, fill: 0 }
```

- `at` **(required)**: the centre. Put centres on a 20-unit grid and line up parts that talk to each other on the same x or y, so lines run straight.
- `size: [w, h]`: optional, otherwise the kind's default.
- `label`: short caps text, `\n` for a second line. Keep each line to about 14 characters.
- `labelAt`: `in` (inside: default for `box`, `screen`), `s` (below: default for most), `n`, `e`, `w`, `top` (inside the top left: default for `zone`), `c` (centre: default for `label`).
- `n`: the reference numeral. Draws a fine curved leader from the part to the number. `lead` picks the direction: `ne` (default), `n`, `e`, `se`, `s`, `sw`, `w`, `nw`, or `[dx, dy]` from the centre for exact placement. `leadLen` (default 22) lengthens it.
- `name` and `note`: shown in the key under the sheet (`<blueprint-scene key>`). Every numbered part needs both.
- `hatch: true` on a `box`: fills it with section hatching (use for a base, a wall, something solid or "closed").
- `muted: true`: draws the label in the muted colour.
- `link: 'cache'`: clicking the part opens the scene with that id in the same place, with a `BACK` button (see **Linked sheets** below). The part needs a numeral (`n`): the link shows there as `3 ↗`.
- State keys (below) set the starting state, e.g. `fill: 0`, `open: 1`, `level: 0.8`.

### The kit

| kind | default size | state keys (`set`) | what it is good for |
|---|---|---|---|
| `box` | 96×56 | `text` | a service, machine, worker, anything with a name inside |
| `screen` | 100×74 | `text` | a browser, app, user, client; `text` shows what is on screen |
| `cabinet` | 80×96 | (`rows`) | a database, archive, storage, disk |
| `drum` | 72×86 | | a database (classic cylinder), a big store |
| `drawer` | 76×36 | `fill` (0…slots), (`slots`) | a cache, a buffer of recent things, buckets |
| `stack` | 56×72 | `count` (0…max), (`max`) | a stack, call stack, undo history, plates |
| `queue` | 130×30 | `count` (0…slots), (`slots`) | a queue, inbox, buffer; fills from the right end |
| `tank` | 56×78 | `level` (0…1) | a token bucket, memory, capacity, a budget |
| `book` | 74×54 | `lines` (0…max), (`max`) | a log, ledger, history, an address book |
| `wheel` | 50×50 | spins | slow work, a crank, a disk |
| `gear` | 50×50 | spins, (`teeth`) | processing, a worker running, CPU |
| `clock` | 46×46 | spins (the hand) | a timer, timeout, delay, debounce, TTL |
| `gauge` | 56×56 | `value` (0…1) | a metric, load, error rate, a threshold |
| `lamp` | 30×42 | `on` (0/1), lights | a status, health, a signal |
| `bell` | 40×42 | rings | an alert, a notification, an interrupt |
| `valve` | 30×30 | `open` (0/1) | a flow you can shut: circuit breaker, feature flag |
| `gate` | 76×44 | `open` (0/1) | allow or deny: auth check, rate limit, barrier |
| `lock` | 32×40 | `open` (0/1) | encryption, a mutex, a locked resource |
| `key` | 38×16 | | a secret, a token, credentials |
| `switch` | 48×48 | `to` (index), (`outs`: angles) | a router, load balancer, a choice |
| `sieve` | 62×36 | | a filter, validation, a bloom filter |
| `press` | 58×82 | `down` (0…1) | transform, compress, compile, hash |
| `hopper` | 58×46 | | an intake, a funnel, batching |
| `letter` | 36×24 | | a message, an email, an event |
| `tower` | 40×84 | `on`, lights (waves) | a network, broadcast, radio, a publisher |
| `zone` | 220×150 | | a boundary: a server, a data centre, a process |
| `label` | 80×14 | `text` | free text on the sheet |
| `dot` | 8×8 | | a junction where lines branch |

Every part also takes `text` in `set`, which replaces its label.

Spinning is an action (`spin: ['gear']`), not a state. `rate` (turns per second, default 0.7, clock 1.2) and `angle` (start angle) tune it.

## 3. Lines

```js
{ id: 'a1', from: 'app.e', to: 'junc', kind: 'track', label: 'HTTPS', arrow: true }
```

- `from` / `to`: a port. `'id'` is the centre, `'id.e'` the middle of the right side (also `n`, `s`, `w`, `ne`, `nw`, `se`, `sw`). Add an offset along the side: `'store.w-12'` is 12 units above the middle of the left side, `'bus.n+30'` is 30 units right of the middle of the top. Or give `[x, y]`.
- Routing: with no `via`, lines leave and enter along the sides you name and bend at right angles with rounded corners. `bend: 'hv'` (horizontal then vertical), `'vh'`, `'h'` (zig-zag with a vertical middle), `'v'`, or `'straight'` (diagonal). For anything else give `via: [[x, y], …]`.
- `kind`: `track` (default, a single line), `pipe` (a hollow tube), `belt` (a conveyor whose ticks move while something runs on it), `wire` (dashed, for control signals or "talks to"), `dim` (a dimension line with arrowheads and end ticks, for a measured span: put the measure in `label`).
- `heavy: true`: a thicker track (shafts, axles).
- `arrow: true` or `'both'`: open chevrons at the end (or both ends).
- `label` and `labelPos` (0…1 along the line, default 0.5).

Lines are drawn under parts, and parts have paper fills, so a line can end at a part's centre and disappear behind it. Lines must not cut through a part they do not connect to: `check.mjs` warns.

A `dot` part is the way to branch: `a → junc`, `junc → b`, `junc.n → c`.

## 4. Steps

Each step runs in this order: **draw/erase → run, spin, set, glow… (together) → then → hold**. Then the next step starts.

```js
{
  say: 'A request checks the drawer first. The first time, it is empty.',
  draw: ['up', 'drawer'],             // parts and lines to draw in, staggered
  erase: ['oldPart'],                  // fade out
  view: ['drawer', 'store'],           // camera: frame these ids, or [x, y, w, h], or 'all'
  run: [ … ],                          // things travelling along lines (see below)
  spin: ['gear'],                      // wheel, gear, clock spin while the runs play
  glow: ['drawer'],                    // dashed yellow highlight around a part or line
  ring: ['bell'],                      // a bell swings; anything else shakes
  light: ['lamp'],                     // a lamp or tower lights up for this step
  fail: ['drawer'],                    // red ✕ badge and a shake, until the step ends
  ok: ['drawer'],                      // green ✓ badge until the step ends
  set: { drawer: { fill: 1 }, lock: { open: 0 }, app: { text: 'DONE' } },
  note: { at: 'drawer.e', text: 'FAST · ~2 MS' },   // or an array of notes
  then: { set: { … }, ok: [ … ], glow: [ … ], note: { … } },   // after all runs finish
  hold: 1.4                            // seconds to rest on the result (default: long enough to read the caption)
}
```

- Everything except `say` is optional. Parts and lines that no step draws are on the sheet from the start; draw the first ones in step 1 so the sheet builds up.
- `say` can carry one caption per language: `say: { en: '…', zh: '…' }`. Give every step the same languages, in the same order; the first is the default (see **Languages** below).
- `set` values tween over half a second. Numbers can be fractional (`level: 0.35`).
- `note`: `{ at, text, dx, dy, anchor: 'start'|'middle'|'end', keep: true }`. A note stays up until its step ends (`keep: true`: until the loop ends). Notes in the last step stay on the finished sheet. Notes are yellow: use them for numbers and short asides, not sentences.
- `view`: the camera eases there at the start of the step and stays until another step moves it. It never zooms in closer than about half the sheet. Use it in complex scenes to follow the action, then `view: 'all'` for the summary.

### Runs

```js
run: [
  { on: 'a1', item: 'chip', text: '#42', dur: 0.8 },                   // along line a1
  { on: 'up', item: 'chip', text: '#42', dur: 0.6, arrive: { fail: ['drawer'] } },
  { on: 'a2', back: true },                                             // the other way
  { on: 't2', item: 'packet', count: 3, gap: 0.3, with: true },         // three, alongside the previous run
  { from: 'a.e', to: 'b.w', item: 'letter' }                            // straight, without a drawn line
]
```

- Runs play **one after another** by default, like a relay. `with: true` starts a run together with the previous one. `at: 1.5` starts it 1.5 s after the step's actions begin.
- `item`: `ball` (default), `chip` (a label tag, needs `text`; keep it under 14 characters), `packet`, `bit`, `letter`, `key`.
- `color`: `accent` (default), `fail`, `ok`, `ink`.
- `dur` (default 1.2 s), `back: true` to travel to → from, `span: [0, 0.5]` to stop halfway, `stay: true` to stay at the end until the step ends, `ease: 'linear'`.
- `count` and `gap`: several of the same item in a row.
- `arrive: { … }`: effects when this run ends (`set`, `glow`, `fail`, `ok`, `ring`, `light`, `note`, `spin`). This is how something lands: `{ on: 'up', arrive: { set: { drawer: { fill: 1 } } } }`.

### Timing

A step lasts: draws (0.85 s each, staggered 0.16 s) + runs + `then` (0.9 s) + `hold`. With no `hold`, the rest is at least 1.4 s and grows so the caption stays up for its length at about 17 characters a second (a 70-character caption gets about 4.1 s from the start of the step). A Chinese, Japanese or Korean character counts as two, and a step with captions in several languages rests for the slowest one. An explicit `hold` wins, and `check.mjs` warns when it leaves a caption up too briefly to read. Aim for 3–6 s per step. A small scene runs 15–30 s, a complex one 35–70 s. The loop fades out and starts again.

### Languages

```js
say: {
  en: 'So add a drawer (2) by the door that keeps recent answers.',
  zh: '所以在门边加一个抽屉 (2)，放最近用过的答案。'
}
```

- Keys are language codes: `en`, `zh`, `ja`, `pt-BR`. The sheet shows the element's `lang` attribute, else the reader's browser language (`zh-CN` finds `zh`), else the first language. Bar buttons switch it in place.
- Translate the caption, not the drawing: labels, notes, chips and the title stay as written, because they are sized for the sheet. Keep the numerals `(2)` in every language.
- Translate the meaning in plain words for that reader; don't transliterate the English. Keep each caption under 120 columns (a CJK character is two).
- `check.mjs` warns when a step is missing a language the others have. Export one language with `--lang zh`.

### Linked sheets

A big system is several sheets, not one crowded one. Write an overview scene and one scene per part worth opening, in the same file or loaded on the same page, and give the overview's part `link: '<scene id>'`:

```js
{ id: 'edgeL', kind: 'drawer', at: [300, 110], label: 'EDGE · LHR', n: 3, link: 'cache', name: 'Edge cache', note: '…' }
```

- Clicking the part (or Enter on it) opens the linked scene in the same place, playing from the start. `BACK · FIG. n` returns to the overview, paused where the reader left it.
- Give each scene its own `fig` number, so the Back button and the part's tooltip can name it.
- Link the part the reader will ask about ("what's in that drawer?"), at most two or three per sheet. The overview must still explain the whole on its own.
- Lint the files together (`check.mjs overview.js cache.js`) so it can check that every link goes somewhere.

## 5. Layout recipes

- **Left to right is time or flow.** The client on the left, the store on the right. Branches go up (`junc.n`).
- **Top to bottom is layers.** User above app above database. Put a `gear` above a `box` with a `heavy` shaft to show it works.
- **Line things up.** Parts that connect share a y (horizontal lines) or an x (vertical lines). Avoid diagonal lines except for `bend: 'straight'` fan-outs.
- **Leave room for numerals.** A numeral needs about 30 units beyond the part in its `lead` direction. Choose `lead` so the numeral lands in empty space, away from lines.
- **Labels below by default.** Use `labelAt: 'n'` when a line leaves from the bottom, `'e'` or `'w'` when the part sits in a column.
- **Zones go behind.** A `zone` is drawn first. Give it 30+ units of padding around what it holds and label it at the top left.
- **Complex scenes:** 800×400. Put the story's spine on one horizontal line through the middle (y ≈ 200) and hang the rest above and below it.

## 6. Metaphor catalogue

| concept | parts |
|---|---|
| cache, memoisation, CDN edge | `drawer` near the client, `cabinet` or `drum` far away, `gear` on the store for slow work |
| database, storage, archive | `cabinet` (rows of drawers) or `drum` |
| queue, inbox, job queue | `queue` with `count`, items go in on the left and leave on the right |
| stack, call stack, undo | `stack` with `count` |
| rate limit, token bucket | `tank` (tokens) + `gate` (allow/deny) + `clock` (refill) |
| debounce, throttle, timeout, retry, TTL | `clock` (spin), `bell` when it fires |
| authentication, login, session | `gate`, `lock`, `key` items, `screen` for the user |
| encryption, TLS | `lock` on a `pipe` |
| load balancer, router | `switch` with `outs` and `to` |
| validation, filter, bloom filter | `sieve`, `fail` on the rejects |
| compile, transform, hash, compress | `press` (`down`), `hopper` for the input |
| log, ledger, event store, git history | `book` with `lines` |
| pub/sub, broadcast, webhooks | `tower` (`light` makes waves), `letter` items |
| circuit breaker, feature flag | `valve` (`open`), `gauge` for error rate, `lamp` for the state |
| metrics, health | `gauge`, `lamp` |
| workers, CPU, threads | `gear` (spin), several boxes |
| boundary: server, process, network | `zone` |

## 7. Exporting

`scripts/export.mjs` renders the scene in a browser and writes:

| format | what you get | good for |
|---|---|---|
| `gif` | a looping GIF, 1280 px wide, motion at 1.8×, a pause on the finished sheet | READMEs, Slack, Notion, docs |
| `mp4` | H.264 video, 30 fps, motion at 1.25×, optional `--audio` | X, LinkedIn, talks |
| `png` | the finished sheet at 2× | thumbnails, docs, social cards |
| `png --steps` | one PNG per step's end | slide decks |

`--out` ending in `.png`, `.gif` or `.mp4` sets the file name (each format keeps its own extension; `--steps` adds `-01`, `-02`…). Any other `--out` is a folder. `--scene <id>` picks a scene from a file with several, and `--lang zh` the caption language of a scene written in several. Exports do not include `sources`, and a link is just a numeral in a GIF or PNG.

`--speed` speeds up only the motion: the rests play in real seconds, so every caption keeps its reading time. The `speed` attribute on the element works the same way.

A good GIF stays under about 5 MB: lower `--width` or `--fps` if it grows past that. Long rests cost little, since a GIF stores a still frame once.

## 8. Mistakes already made

- **A caption that describes the past.** "The request went to the server" → "The request travels to the server (4)."
- **Parts drawn before they are needed.** If step 1 draws everything, there is no "but… so…". Draw the cache in the step that introduces it.
- **Two things moving in different places at once.** The eye can follow one. Use `with: true` only for copies of the same thing (packets in a stream) or a real race.
- **Labels on top of lines.** A line leaving `drawer.s` runs through a label below the drawer. Move the label (`labelAt: 'n'`).
- **A numeral in the line's path.** Pick a `lead` pointing into empty space.
- **Long chips.** Chip text over ~14 characters covers the drawing. Use `#42`, `GET /`, `user=7`.
- **Steps without a change.** Every step must draw, move or change something.
- **Zooming too often.** Move the camera at most every second or third step, and end on `view: 'all'`.
- **Forgetting the summary.** The last step's notes stay on the finished sheet. Use them for the takeaway number (`TOTAL · ~250 MS`).
