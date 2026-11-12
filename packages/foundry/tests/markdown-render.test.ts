import { expect, test } from 'bun:test';
import { renderInlineMarkdown, renderMarkdown, safeHref } from '../src/viewer/ui/markdown.js';

test('agent Markdown renders emphasis, lists, code and tables', () => {
  const out = renderMarkdown(
    '## Plan\n\n**bold** and `code`\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = 1 < 2;\n```',
  );
  expect(out).toContain('<h2>Plan</h2>');
  expect(out).toContain('<strong>bold</strong>');
  expect(out).toContain('<code>code</code>');
  expect(out).toContain('<li>one</li>');
  expect(out).toContain('<td>1</td>');
  expect(out).toContain('<pre><code class="language-ts">const x = 1 &lt; 2;</code></pre>');
});

test('raw HTML in agent text is shown as text, never parsed', () => {
  const out = renderMarkdown(
    'hi <img src=x onerror=alert(1)> <script>alert(1)</script>\n\n<div onclick="x()">block</div>',
  );
  expect(out).not.toContain('<img');
  expect(out).not.toContain('<script');
  expect(out).not.toContain('<div');
  expect(out).toContain('&lt;script&gt;');
});

test('links and images keep only safe targets', () => {
  for (const bad of [
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'data:text/html,x',
    'vbscript:x',
  ])
    expect(safeHref(bad)).toBeNull();
  for (const good of ['https://a.b/c', 'http://a.b', 'mailto:a@b.c', '/api/x', '#top', 'docs/x.md'])
    expect(safeHref(good)).toBe(good);
  const out = renderMarkdown('[bad](javascript:alert(1)) [good](https://a.b) ![img](javascript:x)');
  expect(out).not.toContain('javascript:');
  expect(out).toContain('<a href="https://a.b" target="_blank" rel="noreferrer noopener">good</a>');
});

test('a mermaid block is held as escaped source for the diagram renderer', () => {
  const out = renderMarkdown('```mermaid\ngraph TD; A-->B\n```');
  expect(out).toBe('<pre class="md-mermaid" data-mermaid>graph TD; A--&gt;B</pre>');
});

test('typed text keeps every newline as a line break', () => {
  const out = renderMarkdown('first line\nsecond line', { breaks: true });
  expect(out).toContain('first line<br>second line');
  expect(renderMarkdown('first line\nsecond line')).not.toContain('<br>');
});

test('inline Markdown renders safe links and code with no block wrapper', () => {
  const out = renderInlineMarkdown('See [the doc](https://example.com/a) and `x`');
  expect(out).not.toContain('<p>');
  expect(out).toContain(
    '<a href="https://example.com/a" target="_blank" rel="noreferrer noopener">the doc</a>',
  );
  expect(out).toContain('<code>x</code>');
});

test('inline Markdown drops unsafe links and escapes raw HTML', () => {
  const out = renderInlineMarkdown('[click](javascript:alert(1)) <img src=x onerror=alert(1)>');
  expect(out).not.toContain('<a');
  expect(out).not.toContain('javascript:');
  expect(out).not.toContain('<img');
  expect(out).toContain('click');
  expect(out).toContain('&lt;img');
});
