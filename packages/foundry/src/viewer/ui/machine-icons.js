/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * Machines and actors: a machine's icon (a glyph and a colour, `installationIcon` in settings), an
 * actor chip (a person, a machine, or a person on a machine) and the icon picker in the machine's
 * rename window. This machine's profile (`GET /api/profile`) is read once and shared.
 */

import { html, signal } from './lib.js';
import { authFetch, toast } from './store.js';

const GLYPHS = {
  anvil: html`<path d="M2 5h8l2-2v4H9v2l2 2H3l2-2V7H2z" />`,
  bolt: html`<path d="M8 1 3 8h3l-1 5 5-7H7z" />`,
  leaf: html`<path d="M2 12C2 6 6 2 12 2c0 6-4 10-10 10Zm0 0 6-6" />`,
  moon: html`<path d="M10 2a5 5 0 1 0 2 8A6 6 0 0 1 10 2Z" />`,
  peak: html`<path d="M1 12 5 5l2 3 2-4 4 8z" />`,
  wave: html`<path d="M1 8c2-3 4 3 6 0s4 3 6 0M1 11c2-3 4 3 6 0s4 3 6 0" />`,
  star: html`<path d="m7 1 1.8 4 4.2.4-3.2 2.8 1 4.2L7 10.2 3.2 12.4l1-4.2L1 5.4 5.2 5z" />`,
  hex: html`<path d="M7 1 12.5 4v6L7 13 1.5 10V4z" />`,
};
export const GLYPH_NAMES = Object.keys(GLYPHS);
/** Slots of the theme's categorical palette (`--layer-N`) a machine may take. */
export const MACHINE_COLORS = [6, 0, 2, 5, 3, 1, 7, 4];
const DEFAULT_ICON = { glyph: 'anvil', color: MACHINE_COLORS[0] };
const paint = (slot) => `--dc:var(--layer-${slot})`;

/** This machine's profile ({ installationName, installationIcon }), once read. */
export const machineProfile = signal(null);
let reading = null;
export function loadMachineProfile() {
  reading ??= authFetch('/api/profile')
    .then((res) => (res.ok ? res.json() : null))
    .then((profile) => {
      if (profile) machineProfile.value = profile;
    })
    .catch(() => {});
  return reading;
}

export const machineIcon = (profile = machineProfile.value) =>
  profile?.installationIcon ?? DEFAULT_ICON;

/** A machine's icon tile. */
export function DeviceIcon({ icon = DEFAULT_ICON, size = 18, title }) {
  return html`<span class="dva" style=${`${paint(icon.color)};width:${size}px;height:${size}px`} title=${title}>
    <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">${GLYPHS[icon.glyph] ?? GLYPHS.anvil}</svg>
  </span>`;
}

const initials = (person) => (person === 'You' ? 'You' : person.slice(0, 1).toUpperCase());

/** An actor: a person on a machine, a person alone (no Foundry), or a machine alone (a Foundry working on its own). */
export function ActorChip({ person, machine, icon, me = false, here = false }) {
  // This machine reads "this machine" on a chip; its name is in the tooltip.
  const shown = here ? 'this machine' : machine;
  const label = person && machine ? `${person} · ${shown}` : person || shown;
  const title =
    person && machine
      ? `${person} on ${machine}`
      : person
        ? `${person} (no Foundry: Slack, Linear, GitHub)`
        : `${machine} (a Foundry working on its own)`;
  return html`<span class="actor ${me ? 'is-me' : ''}" title=${title}>
    ${person ? html`<span class="pva">${initials(person)}</span>` : null}
    ${machine ? html`<span class=${person ? 'dvcorner' : ''}><${DeviceIcon} icon=${icon} size=${person ? 13 : 20} /></span>` : null}
    <b>${label}</b>
  </span>`;
}

/** Pick this machine's icon; each pick saves at once. */
export function MachineIconPicker() {
  const current = machineIcon();
  const save = async (next) => {
    try {
      const res = await authFetch('/api/settings/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ installationIcon: next }),
      });
      if (!res.ok)
        throw Error((await res.json().catch(() => ({}))).error || 'Could not save the icon');
      machineProfile.value = { ...machineProfile.value, installationIcon: next };
    } catch (error) {
      toast.value = { message: error.message, type: 'error' };
    }
  };
  return html`<div class="machine-icon-picker" role="group" aria-label="Machine icon">
    <div class="mip-row" role="radiogroup" aria-label="Glyph">
      ${GLYPH_NAMES.map(
        (
          glyph,
        ) => html`<button key=${glyph} type="button" role="radio" aria-checked=${current.glyph === glyph} aria-label=${glyph}
          onClick=${() => save({ ...current, glyph })}><${DeviceIcon} icon=${{ ...current, glyph }} size=${22} /></button>`,
      )}
    </div>
    <div class="mip-row" role="radiogroup" aria-label="Colour">
      ${MACHINE_COLORS.map(
        (
          color,
        ) => html`<button key=${color} type="button" role="radio" class="mip-color" aria-checked=${current.color === color} aria-label=${`colour ${color}`}
          style=${paint(color)} onClick=${() => save({ ...current, color })}></button>`,
      )}
    </div>
  </div>`;
}
