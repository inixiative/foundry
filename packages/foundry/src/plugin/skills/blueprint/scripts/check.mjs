#!/usr/bin/env node
// Lint a blueprint scene without a browser: unknown ids, bad steps, and the
// layout problems a still frame makes obvious only once you look: parts that
// overlap, lines that cut through a part, labels or numerals that collide or
// fall off the sheet, text across a zone's dashed border, a gate whose arm
// swings into something, ✓/✕ badges that cover text, captions that will not fit.
//
//   node scripts/check.mjs examples/small/cache.js [more.js ...]
//
// Exit code 1 when any scene has errors. Warnings are layout advice; fix them
// unless the overlap is intended (then say so in a comment in the scene).
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const runtimePath = resolve(here, '../../../../viewer/ui/vendor/blueprint.js');
const runtimeBox = { globalThis: {} };
runtimeBox.globalThis = runtimeBox;
vm.runInNewContext(readFileSync(runtimePath, 'utf8'), runtimeBox, { filename: runtimePath });
const BP = runtimeBox.BLUEPRINT;

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: check.mjs scene.js [scene2.js ...]');
  process.exit(2);
}

const CH = 6.6; // label char width at 9.5px with tracking
const box = (x, y, w, h) => ({ x, y, w, h });
const hit = (a, b, pad = 0) =>
  a.x < b.x + b.w - pad && b.x < a.x + a.w - pad && a.y < b.y + b.h - pad && b.y < a.y + a.h - pad;
const inset = (b, d) => box(b.x + d, b.y + d, b.w - 2 * d, b.h - 2 * d);
function segHitsBox(p, q, b) {
  // Liang–Barsky clip of segment pq against box b
  let t0 = 0,
    t1 = 1;
  const dx = q[0] - p[0],
    dy = q[1] - p[1];
  const P = [-dx, dx, -dy, dy],
    Q = [p[0] - b.x, b.x + b.w - p[0], p[1] - b.y, b.y + b.h - p[1]];
  for (let i = 0; i < 4; i++) {
    if (P[i] === 0) {
      if (Q[i] < 0) return false;
      continue;
    }
    const r = Q[i] / P[i];
    if (P[i] < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
  }
  return t1 - t0 > 1e-6;
}

// Same grammar as PORT_RE in runtime/blueprint.js: an id (letters, digits, _ and -), an
// optional side, an optional signed offset. Ids may contain "-", so never split on it.
const PORT_RE = /^([A-Za-z0-9_-]+)(?:\.(n|s|e|w|c|ne|nw|se|sw))?(?:([+-]\d+(?:\.\d+)?))?$/;
const endId = (r) => {
  if (Array.isArray(r)) return null;
  const m = PORT_RE.exec(String(r));
  return m ? m[1] : null;
};

let failed = 0;
// Load every file first, so a linked part can find a scene defined in another file checked with it.
const loaded = [];
for (const f of files) {
  const code = readFileSync(resolve(f), 'utf8');
  const got = {};
  if (f.endsWith('.json')) {
    try {
      const parsed = JSON.parse(code);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('JSON scene must be an object');
      }
      got[basename(f, '.json')] = parsed;
    } catch (e) {
      console.log(`\n${f}\n  ERROR  the JSON scene is invalid: ${e.message}`);
      failed++;
      continue;
    }
  } else {
    try {
      vm.runInNewContext(
        code,
        { BLUEPRINT: { scene: (id, spec) => (got[id] = spec) } },
        { filename: f },
      );
    } catch (e) {
      console.log(`\n${f}\n  ERROR  the file does not run: ${e.message}`);
      failed++;
      continue;
    }
    if (!Object.keys(got).length) {
      console.log(`\n${f}\n  ERROR  the file defines no scene (call BLUEPRINT.scene('id', { … }))`);
      failed++;
      continue;
    }
  }
  loaded.push([f, got]);
}
const allIds = new Set(loaded.flatMap(([, got]) => Object.keys(got)));
for (const [f, got] of loaded) {
  for (const [id, spec] of Object.entries(got)) {
    const L = BP.layout(spec),
      tl = BP.compile(spec, L),
      W = L.W,
      H = L.H;
    const warn = [...L.warnings],
      err = [...L.errors];
    if (!tl.steps.length) err.push('the scene has no steps; add at least one { say, draw } step');
    const sheet = box(0, 0, W, H);
    const solid = L.order.filter((p) => !['zone', 'label', 'dot'].includes(L.parts[p].p.kind));
    // When each id is on the sheet: from its first draw (or the start, if no step draws it)
    // until an erase that is not followed by another draw.
    const shown = (id) => {
      const ev = tl.draws[id];
      if (!ev || !ev.length) return [0, Infinity];
      const first = ev.find((e) => e.type === 'draw'),
        last = ev[ev.length - 1];
      return [first ? first.a : 0, last.type === 'erase' ? last.b : Infinity];
    };
    const meets = (a, b) => a[0] < b[1] && b[0] < a[1];
    for (const pid of L.order)
      if (!tl.draws[pid])
        warn.push(
          `part "${pid}" is never drawn by a step, so it sits on the sheet from the start (add it to a step's "draw")`,
        );
    for (const lid of Object.keys(L.lines))
      if (!tl.draws[lid])
        warn.push(
          `line "${lid}" is never drawn by a step, so it sits on the sheet from the start (add it to a step's "draw")`,
        );
    const rects = []; // things that must not collide: [name, box, owner]
    const texts = []; // text a line must not cross: [name, box, owner, [from, to] seconds]
    for (const pid of L.order) {
      const P = L.parts[pid],
        b = box(P.box.x, P.box.y, P.box.w, P.box.h),
        when = shown(pid);
      if (
        (P.p.kind !== 'zone' && P.p.kind !== 'label' && !hit(inset(b, -0.5), sheet)) ||
        b.x < -1 ||
        b.y < -1 ||
        b.x + b.w > W + 1 ||
        b.y + b.h > H + 1
      )
        warn.push(
          `part "${pid}" runs off the sheet (${Math.round(b.x)},${Math.round(b.y)} ${b.w}×${b.h} on ${W}×${H})`,
        );
      if (!['zone', 'label', 'dot'].includes(P.p.kind)) rects.push([`part "${pid}"`, b, pid]);
      const lg = BP.labelGeom(P);
      if (lg) {
        const wMax = Math.max(...lg.lines.map((s) => s.length)) * CH,
          x0 =
            P.box.x +
            (lg.anchor === 'middle' ? lg.x - wMax / 2 : lg.anchor === 'end' ? lg.x - wMax : lg.x);
        const lb = box(x0, P.box.y + lg.y - 9, wMax, 11 * lg.lines.length + 1);
        const inside = lg.at === 'in' || lg.at === 'c' || lg.at === 'top';
        if (!inside) rects.push([`label of "${pid}"`, lb, pid]);
        else if (P.p.kind === 'zone') rects.push([`the title of zone "${pid}"`, lb, pid]); // drawn under parts, but nothing should cover it
        // Lines run under parts, and a part's paper fill hides them, so text inside a solid part
        // is safe. A free label, a zone's corner title (zones sit under lines) and every outside
        // label are not.
        if (!inside || P.p.kind === 'label' || P.p.kind === 'zone')
          texts.push([`label of "${pid}"`, lb, pid, when]);
        if (lb.x < 0 || lb.y < 0 || lb.x + lb.w > W || lb.y + lb.h > H)
          warn.push(`label of "${pid}" runs off the sheet`);
        if (lg.at === 'in' && wMax > P.box.w - 8)
          warn.push(
            `label "${P.p.label}" is wider than "${pid}" (${Math.round(wMax)} > ${P.box.w - 8}px); widen the part or break the label with \\n`,
          );
      }
      const ld = BP.leaderOf(P);
      if (ld) {
        const tw = ld.text.length * 7.6,
          tx = ld.anchor === 'middle' ? ld.tx - tw / 2 : ld.anchor === 'end' ? ld.tx - tw : ld.tx;
        const nb = box(tx, ld.ty - 10, tw, 12);
        rects.push([`numeral ${ld.text} of "${pid}"`, nb, pid]);
        texts.push([`numeral ${ld.text} of "${pid}"`, nb, pid, when]);
        if (nb.x < 0 || nb.y < 0 || nb.x + nb.w > W || nb.y + nb.h > H)
          warn.push(`numeral ${ld.text} of "${pid}" falls off the sheet (try another "lead")`);
      }
    }
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) {
        const [na, a, oa] = rects[i],
          [nb, b, ob] = rects[j];
        if (oa === ob) continue;
        if (hit(a, b, 1)) warn.push(`${na} overlaps ${nb}`);
      }
    const lineLabels = {};
    for (const [lid, X] of Object.entries(L.lines)) {
      if (!X.l.label) continue;
      const at = BP.polyAt(X.pts, X.l.labelPos ?? 0.5),
        tw = String(X.l.label).length * CH + 6;
      const lb =
        Math.abs(at.dx) >= Math.abs(at.dy)
          ? box(at.x - tw / 2, at.y - 15, tw, 12)
          : box(at.x + 5, at.y - 6, tw, 12);
      lineLabels[lid] = lb;
      texts.push([`the label of line "${lid}"`, lb, lid, shown(lid)]);
    }
    // Notes: where each one sits and while it is up.
    tl.notes.forEach((m, i) => {
      const n = m.n;
      try {
        const p = Array.isArray(n.at)
          ? { x: n.at[0], y: n.at[1], side: null }
          : L.lines[n.at]
            ? { ...BP.polyAt(L.lines[n.at].pts, n.pos ?? 0.5), side: 'n' }
            : BP.port(n.at, L.parts);
        const rows = String(n.text).split('\n'),
          tw = Math.max(...rows.map((s) => s.length)) * 6.2;
        const dx = n.dx ?? (p.side && p.side.includes('w') ? -6 : 6),
          dy = n.dy ?? (p.side === 'n' ? -6 : p.side === 's' ? 14 : 3);
        const an =
          n.anchor || (dx < 0 ? 'end' : p.side === 'n' || p.side === 's' ? 'middle' : 'start');
        const x = p.x + dx,
          x0 = an === 'end' ? x - tw : an === 'middle' ? x - tw / 2 : x;
        const nb = box(x0, p.y + dy - 9, tw, 11 * rows.length + 1);
        if (x0 < 0 || x0 + tw > W || nb.y < 0 || nb.y + nb.h > H)
          warn.push(`note "${rows[0]}" runs off the sheet (set "anchor", "dx" or "dy")`);
        for (const [nm, b] of rects)
          if (hit(nb, b, 1.5)) {
            warn.push(`note "${rows[0]}" overlaps ${nm}`);
            break;
          }
        texts.push([`note "${rows[0]}"`, nb, `note${i}`, [m.a, m.b - 0.3]]); // fully faded 0.3 s before m.b
      } catch {}
    });
    for (const [lid, X] of Object.entries(L.lines)) {
      const ends = [X.l.from, X.l.to].map(endId),
        when = shown(lid);
      for (let k = 1; k < X.pts.length; k++) {
        for (const pid of solid) {
          if (ends.includes(pid)) continue;
          const b = L.parts[pid].box;
          if (segHitsBox(X.pts[k - 1], X.pts[k], inset(box(b.x, b.y, b.w, b.h), 2))) {
            warn.push(
              `line "${lid}" cuts through part "${pid}" (add "via" points or move the part)`,
            );
            break;
          }
        }
      }
      // No text on a line: part labels, numerals, notes and other lines' labels. Only text that is
      // on the sheet while the line is counts, and the text box is shrunk a little so a line that
      // merely grazes a letter's side bearing does not count.
      for (const [nm, b, owner, tw] of texts) {
        if (owner === lid || !meets(when, tw)) continue;
        const tb = inset(b, 1.5);
        if (X.pts.some((q, k) => k && segHitsBox(X.pts[k - 1], q, tb)))
          warn.push(
            `line "${lid}" runs through ${nm} (move the text: "labelAt", "lead", the note's "dx"/"dy", or route the line with "via")`,
          );
      }
      if (lineLabels[lid])
        for (const [n, b] of rects)
          if (hit(lineLabels[lid], b, 1)) warn.push(`label of line "${lid}" overlaps ${n}`);
    }
    // Zones are drawn as dashed borders under everything: text should sit inside or outside one,
    // never across its border.
    const zones = L.order
      .filter((p) => L.parts[p].p.kind === 'zone')
      .map((p) => [p, box(L.parts[p].box.x, L.parts[p].box.y, L.parts[p].box.w, L.parts[p].box.h)]);
    const within = (a, b) =>
      a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
    for (const [zid, z] of zones)
      for (const [nm, b, owner] of texts) {
        if (owner === zid) continue;
        const tb = inset(b, 1.5);
        if (hit(tb, z) && !within(tb, z))
          warn.push(`${nm} sits on the border of zone "${zid}" (move it fully inside or outside)`);
      }
    // A gate's arm swings up to 76° out of its box when it opens: what it sweeps must be clear.
    for (const pid of L.order) {
      const P = L.parts[pid];
      if (P.p.kind !== 'gate') continue;
      const open = Math.min(
        1,
        Math.max(
          0,
          ...[P.p.open, ...(tl.sets[pid] || []).filter((e) => e.key === 'open').map((e) => e.v)]
            .map(Number)
            .filter(Number.isFinite),
        ),
      );
      if (!(open > 0)) continue;
      const b = P.box,
        piv = [b.x + b.w * 0.06, b.y + b.h * 0.32],
        len = b.w * 0.94,
        arms = [];
      for (let deg = 0; deg <= 76 * open + 0.01; deg += 4) {
        const r = (-Math.min(deg, 76 * open) * Math.PI) / 180;
        arms.push([piv, [piv[0] + len * Math.cos(r), piv[1] + len * Math.sin(r)]]);
      }
      const top = Math.min(...arms.map(([, q]) => q[1]));
      if (top < 0)
        warn.push(
          `gate "${pid}" swings off the top of the sheet when it opens (move it down ${Math.ceil(-top)}px)`,
        );
      const swingHits = (r, pad = 0) => arms.some(([p0, q]) => segHitsBox(p0, q, inset(r, pad)));
      for (const [nm, r, owner] of rects)
        if (owner !== pid && swingHits(r, 1)) {
          warn.push(
            `gate "${pid}" swings into ${nm} when it opens (its arm rises ${Math.round(b.y - top)}px above the part)`,
          );
        }
      for (const [nm, r, owner] of texts)
        if (owner !== pid && !rects.some((x) => x[0] === nm) && swingHits(r, 1))
          warn.push(`gate "${pid}" swings into ${nm} when it opens`);
      for (const [zid, z] of zones) {
        const inside = (q) => q[0] > z.x && q[0] < z.x + z.w && q[1] > z.y && q[1] < z.y + z.h;
        if (arms.some(([p0, q]) => inside(p0) !== inside(q)))
          warn.push(`gate "${pid}" swings across the border of zone "${zid}" when it opens`);
      }
    }
    // ✓/✕ badges sit off a top corner of their part (BP.badgeAt): clear of the part's own leader, and
    // of everything else.
    for (const pid of [...new Set(tl.marks.map((m) => m.id))]) {
      const P = L.parts[pid],
        at = BP.badgeAt(P),
        badge = box(at.x - 9, at.y - 9, 18, 18),
        ld = BP.leaderOf(P);
      if (ld) {
        const [x0, y0, cx, cy, x1, y1] = ld.d.match(/-?\d+(?:\.\d+)?/g).map(Number),
          pts = [];
        for (let k = 0; k <= 8; k++) {
          const t = k / 8,
            u = 1 - t;
          pts.push([
            u * u * x0 + 2 * u * t * cx + t * t * x1,
            u * u * y0 + 2 * u * t * cy + t * t * y1,
          ]);
        }
        const nb = rects.find((x) => x[2] === pid && x[0].startsWith('numeral'));
        if (
          pts.some((q, k) => k && segHitsBox(pts[k - 1], q, badge)) ||
          (nb && hit(nb[1], badge, 1))
        )
          warn.push(
            `the ✓/✕ badge on "${pid}" lands on its numeral ${ld.text} (give the part another "lead")`,
          );
      }
      for (const [nm, r, owner] of rects)
        if (owner !== pid && hit(badge, r, 1))
          warn.push(`the ✓/✕ badge on "${pid}" overlaps ${nm}`);
      // Text that is up while one of this part's badges is (zone titles and notes included).
      const up = tl.marks.filter((m) => m.id === pid).map((m) => [m.a, m.b ?? Infinity]);
      for (const [nm, r, owner, tw] of texts)
        if (
          owner !== pid &&
          !rects.some((x) => x[0] === nm) &&
          up.some((w) => meets(w, tw)) &&
          hit(badge, r, 1)
        )
          warn.push(`the ✓/✕ badge on "${pid}" covers ${nm}`);
    }
    // Captions in every language: CJK characters count as two columns, like on the sheet.
    const captions = (s) => (s.says ? Object.entries(s.says) : [['', s.say]]);
    const inLang = (k) => (k && tl.langs.length > 1 ? ` (${k})` : '');
    tl.steps.forEach((s, i) => {
      for (const [k, text] of captions(s)) {
        const c = BP.cols(text);
        if (c > 120)
          warn.push(
            `step ${i + 1}: caption${inLang(k)} is ${c} columns wide; keep it under 120 (a CJK character counts as 2)`,
          );
      }
    });
    // A default rest always leaves time to read; an explicit hold can cut it short. The last
    // caption stays up until the sheet fades out.
    tl.steps.forEach((s, i) => {
      const up = (i === tl.steps.length - 1 ? tl.period : s.b) - s.a,
        short = s.read - up;
      const [k, text] = captions(s).reduce((m, x) => (BP.cols(x[1]) > BP.cols(m[1]) ? x : m));
      if (s.held && short > 0.05)
        warn.push(
          `step ${i + 1}: caption${inLang(k)} is up ${up.toFixed(1)} s but needs about ${s.read.toFixed(1)} s to read (${BP.cols(text)} columns at 17 a second); raise "hold" to ${(s.b - s.r + short).toFixed(1)} or drop it for the default rest`,
        );
    });
    // Linked parts open another sheet: it should exist, and the part needs its numeral, where the ↗ shows.
    const notes = [];
    for (const pid of L.order) {
      const link = L.parts[pid].p.link;
      if (!link) continue;
      if (link === id) warn.push(`part "${pid}" links to its own scene`);
      else if (!allIds.has(link))
        notes.push(
          `part "${pid}" links to scene "${link}", which is not in the files checked; load its file on the page too, and check both files together`,
        );
      if (L.parts[pid].p.n == null)
        warn.push(
          `part "${pid}" has a link but no numeral ("n"), so nothing on the sheet shows the link`,
        );
    }
    const T = tl.total;
    console.log(
      `\n${f}  ·  ${id}  ·  ${tl.steps.length} steps  ·  ${T.toFixed(1)} s  ·  ${L.order.length} parts, ${Object.keys(L.lines).length} lines${tl.langs.length ? '  ·  captions in ' + tl.langs.join(', ') : ''}`,
    );
    for (const e of new Set(err)) console.log('  ERROR  ' + e);
    for (const w of new Set(warn)) console.log('  warn   ' + w);
    for (const n of notes) console.log('  note   ' + n);
    if (!err.length && !warn.length) console.log('  clean');
    if (err.length) failed++;
  }
}
process.exit(failed ? 1 : 0);
