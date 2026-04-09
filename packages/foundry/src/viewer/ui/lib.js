/**
 * Foundry UI lib — re-exports Preact, HTM, and Signals from ESM CDN.
 * Single import point for all components. ~5KB total runtime.
 * No build step required.
 */

// Preact core + hooks
export {
  h, render, Component, Fragment, createRef, toChildArray, cloneElement
} from "https://esm.sh/preact@10.25.4";

export {
  useState, useEffect, useRef, useMemo, useCallback, useReducer, useContext
} from "https://esm.sh/preact@10.25.4/hooks";

// Signals — fine-grained reactivity, no VDOM diffing for hot paths
// deps= pins signals to use the SAME Preact instance we import above
export {
  signal, computed, effect, batch
} from "https://esm.sh/@preact/signals@1.3.1?deps=preact@10.25.4";

// HTM — tagged template JSX alternative, no build step
import htm from "https://esm.sh/htm@3.1.1";
import { h as _h } from "https://esm.sh/preact@10.25.4";
export const html = htm.bind(_h);
