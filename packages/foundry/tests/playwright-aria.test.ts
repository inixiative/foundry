import { expect, test } from 'bun:test';
import { ariaElements } from '../src/tools/playwright-browser';

test("a Playwright ARIA snapshot becomes the page's elements in order", () => {
  const aria = [
    '- heading "Welcome \\"home\\"" [level=1]',
    '- link "Docs":',
    '  - /url: /docs',
    '- textbox "Email": a@b.c',
    '- button "Go"',
    '- text: hello',
  ].join('\n');
  expect(ariaElements(aria)).toEqual([
    { role: 'heading', name: 'Welcome "home"' },
    { role: 'link', name: 'Docs' },
    { role: 'textbox', name: 'Email', value: 'a@b.c' },
    { role: 'button', name: 'Go' },
    { role: 'text', name: '', value: 'hello' },
  ]);
});
