/**
 * Foundry UI lib — one local, pinned Preact/HTM/Signals module graph.
 * No external bootstrap dependency or build step. See vendor/manifest.json
 * for pinned source hashes/transformations and vendor/licenses.json for licenses.
 */

// Preact core + hooks
export {
  h, render, Component, Fragment, createRef, toChildArray, cloneElement
} from "./vendor/preact.module.js";

export {
  useState, useEffect, useRef, useMemo, useCallback, useReducer, useContext
} from "./vendor/hooks.module.js";

// Signals — fine-grained reactivity, no VDOM diffing for hot paths
// Local imports in signals/hooks use the SAME Preact instance as above.
export {
  signal, computed, effect, batch
} from "./vendor/signals.module.js";

// HTM — tagged template JSX alternative, no build step
import htm from "./vendor/htm.module.js";
import { h as _h } from "./vendor/preact.module.js";
export const html = htm.bind(_h);
