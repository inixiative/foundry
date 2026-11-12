/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * Agent and user text as Markdown. Raw HTML in the text is shown as text, never parsed, and links and
 * images keep only http(s), mailto, anchor and relative targets. A ```mermaid block renders as a
 * diagram once its message has finished streaming; Mermaid loads only when one appears.
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

/** One message's Markdown; `streaming` holds diagrams back until the text is whole. */
export function Markdown({ text, streaming = false, breaks = false, className = '' }) {
  const ref = useRef(null);
  const markup = renderMarkdown(text, { breaks });
  useEffect(() => {
    if (streaming || !ref.current) return;
    renderDiagrams(ref.current).catch(() => {});
  }, [markup, streaming]);
  return html`<div ref=${ref} class="md ${className}" dangerouslySetInnerHTML=${{ __html: markup }}></div>`;
}

/** Inline Markdown in a span, for short agent-written labels. */
export function InlineMarkdown({ text, className = '' }) {
  return html`<span class="md-inline ${className}" dangerouslySetInnerHTML=${{ __html: renderInlineMarkdown(text) }}></span>`;
}
