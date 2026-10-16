import { html } from './lib.js';

/** An on/off switch: a checkbox with role="switch", labelled for assistive tech. */
export function Switch({ checked, onChange, label, disabled }) {
  return html`<label class="switch" title=${label}>
    <input type="checkbox" role="switch" aria-label=${label} checked=${checked} disabled=${disabled}
      onChange=${(e) => onChange(e.target.checked)} />
    <span class="switch-track"><span class="switch-thumb"></span></span>
  </label>`;
}
