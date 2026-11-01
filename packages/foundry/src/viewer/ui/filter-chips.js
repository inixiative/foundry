/**
 * @atlas
 * @kind component
 * @partOf feature:viewer
 */
/**
 * Filter chips: a row of category chips (Project ▾, Kingdom ▾, …), each opening an inline list of
 * options to multi-select. Options OR within a group and AND across groups; each chip shows how many
 * of its options are on, and "Clear N" drops them all. One component for the Board and the Watchtower.
 */

import { html, useState } from './lib.js';

/** Does `item` pass `selected` ({ group: Set }) given each group's value(s) for it (`valuesOf`)? */
export function passesChips(selected, valuesOf, item) {
  return Object.entries(selected).every(([group, values]) => {
    if (!values?.size) return true;
    const own = [valuesOf[group]?.(item)].flat().filter((v) => v != null);
    return own.some((v) => values.has(v));
  });
}

/** groups: [{ id, label, options: [{ value, label, count? }] }]; selected: { id: Set }; onChange(next). */
export function FilterChips({ groups, selected, onChange, children }) {
  const [open, setOpen] = useState(null);
  const total = Object.values(selected).reduce((n, values) => n + (values?.size ?? 0), 0);
  const toggle = (group, value) => {
    const current = new Set(selected[group] ?? []);
    current.has(value) ? current.delete(value) : current.add(value);
    onChange({ ...selected, [group]: current });
  };
  const shown = groups.find((g) => g.id === open);
  return html`<div class="filter-chips">
    <div class="filter-chips-row" role="toolbar" aria-label="Filters">
      ${groups.map((g) => {
        const on = selected[g.id]?.size ?? 0;
        return html`<button key=${g.id} type="button" class="filter-chip ${on ? 'is-on' : ''}" aria-expanded=${open === g.id}
          onClick=${() => setOpen(open === g.id ? null : g.id)}>${g.label}${on ? html`<span class="filter-chip-count">${on}</span>` : null}<span class="filter-chip-caret">▾</span></button>`;
      })}
      ${total ? html`<button type="button" class="filter-chip-clear" onClick=${() => onChange({})}>Clear ${total}</button>` : null}
      <span class="filter-chips-spacer"></span>
      ${children}
    </div>
    ${
      shown
        ? html`<div class="filter-chip-options" role="group" aria-label=${shown.label}>
          ${
            shown.options.length
              ? shown.options.map(
                  (
                    o,
                  ) => html`<button key=${o.value} type="button" class="filter-option" aria-pressed=${!!selected[shown.id]?.has(o.value)}
              onClick=${() => toggle(shown.id, o.value)}>${o.label}${o.count != null ? html`<span class="filter-option-count">${o.count}</span>` : null}</button>`,
                )
              : html`<span class="filter-option-none">Nothing to pick yet.</span>`
          }
        </div>`
        : null
    }
  </div>`;
}
