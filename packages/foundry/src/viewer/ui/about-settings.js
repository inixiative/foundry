/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * Settings → About: what Foundry is, who helped shape it, its version and licence.
 */

import { REPO_URL } from './coming-soon.js';
import { html, useEffect, useState } from './lib.js';
import { authFetch } from './store.js';
import { UpdateFact } from './update-notice.js';

const T3_CODE_URL = 'https://github.com/pingdotgg/t3code';
const PASEO_URL = 'https://github.com/getpaseo/paseo';
const USEREVIDENCE_URL = 'https://userevidence.com';

export function AboutSection() {
  const [version, setVersion] = useState(null);
  useEffect(() => {
    authFetch('/api/health')
      .then((res) => res.json())
      .then((body) => setVersion(typeof body.version === 'string' ? body.version : null))
      .catch(() => setVersion(null));
  }, []);

  return html`
    <div class="about-page">
      <section class="settings-card about-card" data-about="what">
        <div class="settings-card-header"><span class="settings-card-title">About Foundry</span></div>
        <p class="about-text">
          Foundry is a local harness for coding agents (Claude Code, Codex). It keeps your agents working the way
          your project already works: small agents called Wardens each hold one part of what your project knows and
          remind the main thread what already exists and where it's written down, and every thread is captured, so a
          correction you give once sticks instead of being repeated.
        </p>
        <dl class="about-facts">
          <dt>Version</dt>
          <dd class="mono">${version ?? '—'}</dd>
          <dt>Updates</dt>
          <dd data-about="update"><${UpdateFact} /></dd>
          <dt>Source</dt>
          <dd><a href=${REPO_URL} target="_blank" rel="noreferrer">github.com/inixiative/foundry ↗</a></dd>
          <dt>Licence</dt>
          <dd>
            <code>packages/foundry</code> under${' '}
            <a href=${`${REPO_URL}/blob/main/LICENSE-BSL`} target="_blank" rel="noreferrer">BSL 1.1</a>${' '}
            (converts to MIT on 2030-04-06); <code>packages/core</code> and <code>packages/acp</code> under${' '}
            <a href=${`${REPO_URL}/blob/main/LICENSE-MIT`} target="_blank" rel="noreferrer">MIT</a>.
          </dd>
        </dl>
      </section>

      <section class="settings-card about-card" data-about="open-source">
        <div class="settings-card-header"><span class="settings-card-title">Built on open source</span></div>
        <p class="about-text">
          Big thanks to${' '}<a href=${T3_CODE_URL} target="_blank" rel="noreferrer"><strong>T3 Code</strong></a>${' '}
          (Theo and the Ping team) and <a href=${PASEO_URL} target="_blank" rel="noreferrer"><strong>Paseo</strong></a>,
          open-source agent runners that helped shape the language Foundry uses and gave us a reference to check our
          work against. Thank you for working in the open.
        </p>
      </section>

      <section class="settings-card about-card" data-about="supporters">
        <p class="about-text">Thanks to <strong>UserEvidence</strong> for supporting open-source software.</p>
        <div class="about-links">
          <a class="proj-btn" href=${USEREVIDENCE_URL} target="_blank" rel="noreferrer">UserEvidence ↗</a>
          <a class="proj-btn" href=${USEREVIDENCE_URL} target="_blank" rel="noreferrer">The customer advocacy platform ↗</a>
        </div>
      </section>
    </div>
  `;
}
