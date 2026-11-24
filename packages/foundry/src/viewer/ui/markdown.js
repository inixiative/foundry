/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * Agent and user text as Markdown. Raw HTML in the text is shown as text, never parsed, and links and
 * images keep only http(s), mailto, anchor and relative targets. A ```mermaid or ```blueprint block
 * renders as a diagram once its message has finished streaming; each runtime loads only when one appears.
 */
import { html, useEffect, useRef } from './lib.js';
import { Marked } from './marked.js';

const escapeHtml = (text) =>
  String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/** A target the viewer may follow: no `javascript:`, `data:` or other schemes. */
export function safeHref(href) {
  const value = String(href ?? '').trim();
  if (!value) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value);
  if (!scheme) return value;
  return ['http', 'https', 'mailto'].includes(scheme[1].toLowerCase()) ? value : null;
}

const marked = new Marked({
  gfm: true,
  renderer: {
    html: ({ text }) => escapeHtml(text),
    link({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens);
      const target = safeHref(href);
      if (!target) return label;
      const titled = title ? ` title="${escapeHtml(title)}"` : '';
      return `<a href="${escapeHtml(target)}"${titled} target="_blank" rel="noreferrer noopener">${label}</a>`;
    },
    image({ href, title, text }) {
      const target = safeHref(href);
      if (!target) return escapeHtml(text);
      const titled = title ? ` title="${escapeHtml(title)}"` : '';
      return `<img src="${escapeHtml(target)}" alt="${escapeHtml(text)}"${titled} loading="lazy">`;
    },
    code({ text, lang }) {
      const language = (lang ?? '').trim().split(/\s+/)[0];
      if (language === 'mermaid')
        return `<pre class="md-mermaid" data-mermaid>${escapeHtml(text)}</pre>`;
      if (language === 'blueprint' || language === 'blueprint-scene')
        return `<pre class="md-blueprint" data-blueprint>${escapeHtml(text)}</pre>`;
      const cls = language ? ` class="language-${escapeHtml(language)}"` : '';
      return `<pre><code${cls}>${escapeHtml(text)}</code></pre>`;
    },
  },
});

/**
 * Markdown to HTML with raw HTML escaped and unsafe link targets dropped. `breaks` keeps every
 * newline as a line break, for text a person typed.
 */
export function renderMarkdown(text, { breaks = false } = {}) {
  return marked.parse(String(text ?? ''), { async: false, breaks });
}

/** One line of text (a plan item, a loop step): links, emphasis and code, no blocks. */
export function renderInlineMarkdown(text) {
  return marked.parseInline(String(text ?? ''), { async: false });
}

let mermaidLoad;
const mermaidSvgs = new Map();
let mermaidSeq = 0;

function loadMermaid() {
  mermaidLoad ??= import('/ui/mermaid/mermaid.esm.min.mjs').then(({ default: mermaid }) => {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'dark' });
    return mermaid;
  });
  return mermaidLoad;
}

async function renderDiagrams(root) {
  const blocks = [...root.querySelectorAll('pre[data-mermaid]')];
  if (!blocks.length) return;
  const mermaid = await loadMermaid();
  for (const block of blocks) {
    const source = block.textContent;
    try {
      let svg = mermaidSvgs.get(source);
      if (!svg) {
        ({ svg } = await mermaid.render(`foundry-mermaid-${++mermaidSeq}`, source));
        mermaidSvgs.set(source, svg);
      }
      if (!block.isConnected) continue;
      const figure = document.createElement('div');
      figure.className = 'md-mermaid-diagram';
      figure.innerHTML = svg;
      block.replaceWith(figure);
    } catch {
      block.classList.add('md-mermaid-invalid');
    }
  }
}

let blueprintLoad;

const MAX_BLUEPRINT_DIM = 2400;
const MAX_BLUEPRINT_PARTS = 40;
const MAX_BLUEPRINT_LINES = 80;
const MAX_BLUEPRINT_STEPS = 40;
const MAX_BLUEPRINT_RUNS = 200;

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

function loadBlueprint() {
  if (globalThis.BLUEPRINT) return Promise.resolve(globalThis.BLUEPRINT);
  blueprintLoad ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/ui/vendor/blueprint.js';
    script.async = true;
    script.onload = () => {
      if (globalThis.BLUEPRINT) return resolve(globalThis.BLUEPRINT);
      script.remove();
      blueprintLoad = undefined;
      reject(new Error('Blueprint runtime did not register BLUEPRINT'));
    };
    script.onerror = () => {
      script.remove();
      blueprintLoad = undefined;
      reject(new Error('Could not load /ui/vendor/blueprint.js'));
    };
    document.head.appendChild(script);
  });
  return blueprintLoad;
}

function checkBounds(spec) {
  if (Array.isArray(spec.size)) {
    const [w, h] = spec.size;
    if (
      !isFiniteNumber(w) ||
      !isFiniteNumber(h) ||
      w <= 0 ||
      h <= 0 ||
      w > MAX_BLUEPRINT_DIM ||
      h > MAX_BLUEPRINT_DIM
    )
      throw new Error('Blueprint size out of bounds');
  }
  const parts = asList(spec.parts);
  const lines = asList(spec.lines);
  const steps = asList(spec.steps);
  if (
    parts.length > MAX_BLUEPRINT_PARTS ||
    lines.length > MAX_BLUEPRINT_LINES ||
    steps.length > MAX_BLUEPRINT_STEPS
  )
    throw new Error('Blueprint exceeds maximum part, line, or step count');
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const dims = [part.w, part.h, ...(Array.isArray(part.size) ? part.size : [])];
    for (const dim of dims) {
      if (dim === undefined || dim === null) continue;
      const n = Number(dim);
      if (!Number.isFinite(n) || n < 0 || n > MAX_BLUEPRINT_DIM)
        throw new Error('Blueprint part dimension out of bounds');
    }
  }
  let runCount = 0;
  for (const step of steps) {
    if (!step || typeof step !== 'object' || step.run == null) continue;
    const runs = asList(step.run);
    runCount += runs.length;
    if (runCount > MAX_BLUEPRINT_RUNS) throw new Error('Blueprint exceeds maximum run count');
    for (const run of runs) {
      if (!run || typeof run !== 'object' || run.span == null) continue;
      if (
        !Array.isArray(run.span) ||
        run.span.length !== 2 ||
        !isFiniteNumber(run.span[0]) ||
        !isFiniteNumber(run.span[1])
      )
        throw new Error('Blueprint run.span must be two finite numbers');
    }
  }
}

/** Parse and validate an untrusted Blueprint JSON string against bounds, layout and timeline compilation. */
export function validateBlueprintSpec(source, blueprint) {
  const spec = typeof source === 'string' ? JSON.parse(source) : source;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec))
    throw new Error('Blueprint spec must be a JSON object');
  checkBounds(spec);
  const checked = blueprint.layout(spec);
  if (checked.errors.length > 0) throw new Error(checked.errors[0]);
  const compiled = blueprint.compile(spec, checked);
  if (checked.errors.length > 0) throw new Error(checked.errors[0]);
  if (!compiled.steps.length) throw new Error('Blueprint scene has no steps');
  return spec;
}

async function renderBlueprints(root, controllers, isCancelled) {
  const blocks = [...root.querySelectorAll('pre[data-blueprint]')];
  if (!blocks.length) return;
  const blueprint = await loadBlueprint();
  if (isCancelled()) return;
  const defaultPaper = document.documentElement.classList.contains('dark') ? 'blue' : 'linen';
  for (const block of blocks) {
    if (!block.isConnected || isCancelled()) continue;
    try {
      const spec = validateBlueprintSpec(block.textContent, blueprint);
      const paper = spec.paper === 'blue' || spec.paper === 'linen' ? spec.paper : defaultPaper;
      const figure = document.createElement('div');
      figure.className = 'md-blueprint-diagram';
      const controller = blueprint.mount(figure, spec, {
        play: 'view',
        key: true,
        font: false,
        paper,
      });
      controllers.push(controller);
      block.replaceWith(figure);
    } catch {
      block.classList.add('md-blueprint-invalid');
    }
  }
}

/** One message's Markdown; `streaming` holds diagrams back until the text is whole. */
export function Markdown({ text, streaming = false, breaks = false, className = '' }) {
  const ref = useRef(null);
  const markup = renderMarkdown(text, { breaks });
  useEffect(() => {
    if (streaming || !ref.current) return;
    let cancelled = false;
    const controllers = [];
    renderDiagrams(ref.current).catch(() => {});
    renderBlueprints(ref.current, controllers, () => cancelled).catch(() => {});
    return () => {
      cancelled = true;
      for (const controller of controllers) controller?.destroy?.();
    };
  }, [markup, streaming]);
  return html`<div ref=${ref} class="md ${className}" dangerouslySetInnerHTML=${{ __html: markup }}></div>`;
}

/** Inline Markdown in a span, for short agent-written labels. */
export function InlineMarkdown({ text, className = '' }) {
  return html`<span class="md-inline ${className}" dangerouslySetInnerHTML=${{ __html: renderInlineMarkdown(text) }}></span>`;
}
