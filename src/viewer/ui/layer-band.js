/**
 * LayerBand — thin colored strip between agent calls showing active context layers.
 *
 * Each layer gets a persistent color (hashed from ID). The band is a row of
 * thin colored slivers. Hover shows layer name, click opens detail in right drawer.
 *
 * Visual: ▐▐▐▐▐ where each sliver is 4px wide, colored per-layer.
 */

import { html } from "./lib.js";
import { layerColor, selectedSpanId } from "./store.js";

export function LayerBand({ layerIds, contextHash, onClick }) {
  if (!layerIds || layerIds.length === 0) return null;

  return html`
    <div class="layer-band" title="Context: ${layerIds.join(", ")}">
      <span class="layer-band-label">${layerIds.length}</span>
      <div class="layer-band-slivers">
        ${layerIds.map(id => html`
          <span
            key=${id}
            class="layer-sliver"
            style="background: ${layerColor(id)}"
            title=${id}
            onClick=${(e) => { e.stopPropagation(); onClick && onClick(id); }}
          ></span>
        `)}
      </div>
      ${contextHash ? html`
        <span class="layer-band-hash">${contextHash.slice(0, 8)}</span>
      ` : null}
    </div>
  `;
}
