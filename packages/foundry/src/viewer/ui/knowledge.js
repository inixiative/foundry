/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * A project's Knowledge and chorus page: how Foundry learns the project, in six steps (set up, update,
 * analyse the docs, build regions, tune Wardens, Oracle). It shows what Foundry can read today: the
 * chorus layers and regions (`/api/projects/:id/chorus`) and the project's Kingdoms (`/about`). The
 * actions run as scripts outside the server (the region builder, the eval scripts), so each is shown
 * and marked not built.
 */

import { html, useEffect, useState } from './lib.js';
import {
  BuildHistory,
  BuildRegions,
  DetectionTests,
  latestBuild,
  usePipeline,
} from './region-pipeline.js';
import { navigate } from './route.js';
import { activeProjectId, projectPage, projects } from './store.js';

// Region size (Foundry #81): about 20k tokens of knowledge per Warden, 40k the hard cap.
const HEALTHY_TOKENS = 20_000;
const CAP_TOKENS = 40_000;
// Stage-one detection recall every docs, regions or Warden change must hold (finding 2026-10-17-slice1-diagnose).
const DETECTION_BAR = '0.81';

function useJson(url) {
  const [value, setValue] = useState(undefined);
  useEffect(() => {
    let live = true;
    setValue(undefined);
    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((body) => live && setValue(body));
    return () => {
      live = false;
    };
  }, [url]);
  return value;
}

/** A region's size in tokens: counted when the roster has it, else estimated from its bytes. */
const tokensOf = (region) => region.tokens ?? Math.round((region.bytes ?? 0) / 4);
const k = (n) => `${Math.round(n / 1000)}k`;

function NotBuilt({ label, why }) {
  return html`<button type="button" class="proj-btn" disabled title=${why}>${label} · not built</button>`;
}

function Step({ n, title, desc, actions, children }) {
  return html`<section class="kstep" aria-label=${title}>
    <span class="kstep-n">${n}</span>
    <div><h3>${title}</h3><p>${desc}</p></div>
    <div class="kstep-actions">${actions}</div>
    <div class="kstep-body">${children}</div>
  </section>`;
}

function SizeBar({ region }) {
  const tokens = tokensOf(region);
  const level = tokens > CAP_TOKENS ? 'over' : tokens > HEALTHY_TOKENS ? 'large' : 'ok';
  return html`<div class="ksize" data-level=${level} title=${`${region.id}: ${tokens} tokens${region.tokens == null ? ' (estimated from bytes)' : ''}`}>
    <span class="ksize-name">${region.title || region.id}</span>
    <span class="ksize-track"><span class="ksize-fill" style=${`width:${Math.min(100, (tokens / CAP_TOKENS) * 100)}%`}></span><span class="ksize-mark"></span></span>
    <span class="ksize-n">${k(tokens)}</span>
  </div>`;
}

/**
 * What every Warden of the project is given, in order (Aron, 2026-11-02): Foundry's charter, the
 * project's Warden brief, its region, the thread context of the call. Never the CLAUDE.md ladder.
 */
function WardenLayers({ wardens }) {
  if (!wardens) return null;
  const ignored = wardens.ignored;
  const brief = wardens.brief;
  return html`<h4 class="ksub">What each Warden is given</h4>
    <table class="ktable" aria-label="Warden layers">
      <tr><td>1. Charter</td><td>What a Warden is. Part of Foundry, the same for every project.</td><td class="kok">≈${k(wardens.charter.tokens)} tokens</td></tr>
      <tr><td>2. Warden brief</td><td class="mono">${brief?.path ?? '.foundry/warden-brief.md'}</td>${
        brief?.exists
          ? html`<td class="kok">≈${brief.tokens < 1000 ? brief.tokens : k(brief.tokens)} tokens</td>`
          : html`<td class="kwarn">missing: Wardens get no project brief</td>`
      }</tr>
      <tr><td>3. Its region</td><td>The region's knowledge, sized above.</td><td></td></tr>
      <tr><td>4. Thread context</td><td>The moment and what the thread holds, per call.</td><td></td></tr>
    </table>
    <div class="rp-dim">No CLAUDE.md or AGENTS.md: those are written for the agent doing the work. The brief is shown as the registered checkout has it; a worktree's threads read their branch's copy.</div>
    ${
      ignored?.length
        ? html`<div class="kwarn">${ignored.map((line) => html`<div key=${line}>${line}</div>`)}</div>`
        : null
    }
    ${
      brief?.exists
        ? html`<details class="kbrief"><summary>Read the Warden brief</summary><pre class="mono">${brief.text}</pre></details>`
        : null
    }`;
}

export function KnowledgePage() {
  const projectId = activeProjectId.value;
  const project = projects.value.find((p) => p.id === projectId);
  const name = project?.label ?? projectId;
  const id = encodeURIComponent(projectId);
  const body = useJson(`/api/projects/${id}/chorus`);
  const about = useJson(`/api/projects/${id}/about`);
  const chorus = body?.chorus;
  const regions = [...(chorus?.regions ?? [])].sort((a, b) => tokensOf(b) - tokensOf(a));
  const over = regions.filter((r) => tokensOf(r) > CAP_TOKENS);
  const large = regions.filter((r) => tokensOf(r) > HEALTHY_TOKENS && tokensOf(r) <= CAP_TOKENS);
  const missing = chorus?.missingDocs ?? [];
  const kingdoms = about?.kingdoms ?? [];
  const [pipeline, reread] = usePipeline();
  const build = latestBuild(pipeline);
  const builtNote = build
    ? html`<span class="rp-dim">Last done as part of the region build of ${build.builtAt ? new Date(build.builtAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'an unknown date'} (template ${build.templateCommit?.slice(0, 10) ?? '—'}).</span>`
    : html`<span class="rp-dim">Runs as part of the region build (step 4); no build on this machine yet.</span>`;

  return html`<section class="knowledge" aria-label=${`${name}: Knowledge and chorus`}>
    <header class="ph-head">
      <button type="button" class="proj-btn" onClick=${() => {
        projectPage.value = 'home';
      }}>‹ ${name}</button>
      <h2>Knowledge and chorus</h2>
      <span class="ph-meta">How Foundry learns ${name}: its docs, its regions and the Wardens built from them</span>
    </header>
    ${body === undefined ? html`<div class="ph-meta">Reading the chorus…</div>` : null}
    <div class="know">
      <${Step} n="1" title="Set up"
        desc="Reads the project's docs and code once and initialises the levels Wardens compose from. Project is required; the others are optional."
        actions=${html`<span class="rp-dim">part of Build regions</span>`}>
        ${
          chorus?.layers?.length
            ? html`<table class="ktable">${chorus.layers.map(
                (l) =>
                  html`<tr key=${l.label}><td>${l.label}</td><td class="mono">${l.regionsDir}</td><td class="kok">${l.regions} region${l.regions === 1 ? '' : 's'}</td></tr>`,
              )}</table>`
            : html`<span class="kwarn">No chorus levels set up${chorus?.reason ? `: ${chorus.reason}` : ''}.</span>`
        }
        <div>${builtNote}</div>
      <//>
      <${Step} n="2" title="Update since the last setup"
        desc="Re-reads only what changed, so regions and Wardens stay current without a full rebuild."
        actions=${html`<span class="rp-dim">part of Build regions</span>`}>
        ${builtNote}
      <//>
      <${Step} n="3" title="Analyse the docs"
        desc="Checks every doc: its kind (system, pattern, guidance, feedback), anything it names that no longer exists, and code that changed without its doc. Reports only; nothing is rewritten."
        actions=${html`<span class="rp-dim">part of Build regions</span>`}>
        ${builtNote}
      <//>
      <${Step} n="4" title="Build regions"
        desc="Splits docs, rules and primitives into regions by concept, each a healthy size for one Warden. Each region gets the short text Wardens recognise from and the full catalog they pick from."
        actions=${html`<button type="button" class="proj-btn" onClick=${() => navigate(`/projects/${id}/settings/chorus`)}>See regions</button>`}>
        ${
          regions.length
            ? html`<div>${regions.length} regions · ≈20k tokens each · cap 40k${
                over.length || large.length || missing.length
                  ? html`<br /><span class="kwarn">${[
                      ...over.map((r) => `${r.id}: ${k(tokensOf(r))} · over the cap`),
                      ...(large.length ? [`${large.length} above 20k`] : []),
                      ...missing.map((m) => `${m.region}: no ${m.doc}`),
                    ].join(', ')}</span>`
                  : null
              }</div>
              <div class="ksizes">${regions.map((r) => html`<${SizeBar} key=${r.id} region=${r} />`)}</div>`
            : html`<span class="rp-dim">No regions in ${name}'s chorus.</span>`
        }
        <${WardenLayers} wardens=${body?.wardens} />
        <h4 class="ksub">Builds on this machine</h4>
        <${BuildHistory} pipeline=${pipeline} />
        <${BuildRegions} pipeline=${pipeline} reread=${reread} />
      <//>
      <${Step} n="5" title="Tune Wardens"
        desc="Tests whether each region's Warden recognises its moments. A change to docs, regions or Wardens ships only if detection holds the bar, with false yeses no worse."
        actions=${html`<${NotBuilt} label="Run the detection test" why="No committed runner: the detection test is an eval script that spends quota" />`}>
        <${DetectionTests} pipeline=${pipeline} bar=${DETECTION_BAR} />
      <//>
      <${Step} n="6" title="Oracle"
        desc="Oracle measures whether corrections stick: replays real work with and without the chorus and reports what changed. It reads this project's sessions from its Archives through Kingdom."
        actions=${html`<${NotBuilt} label="Connect Oracle" why="Foundry has no Oracle connection yet" />`}>
        <div>Kingdom: <b>${about === undefined ? '…' : kingdoms.length ? kingdoms.join(', ') : 'not linked'}</b> · Archives: local Archive</div>
        <span class="kwarn">Oracle isn't connected for ${name}.</span>
      <//>
    </div>
  </section>`;
}
