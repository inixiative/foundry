/**
 * @atlas
 * @kind utils
 * @partOf feature:viewer
 */
/**
 * Focus lives in the message box (Aron 11-02: "If there's a thread message box on the screen, it
 * should always be in focus, unless something else is actually holding the focus: a place to type").
 *
 * - Typing goes to the message box: a printable key pressed anywhere that isn't a place to type lands
 *   in the composer, so a plain letter never fires an app command while a message box is showing.
 *   App commands are ⌥ chords (hotkeys.js); their plain forms act only where no message box is shown.
 * - Clicking a row, tab, card, panel or button leaves (or puts back) focus in the composer.
 * - A real place to type (Search, a settings field, a rename box, an answer's note, a select) or an
 *   open dialog holds focus while in use; when it closes or blurs, focus returns to the composer.
 * - A text selection is left alone, so reading and copying from the transcript still works.
 * - A paste anywhere that isn't a text field lands in the message box (Aron 11-14, 11-26: "paste
 *   should go there" unless a field holds focus). Wispr Flow only inserts into a focused text
 *   field (with none it offers Copy and never pastes), so rerouting ⌘V is not enough: focus has to
 *   rest in the box. It comes back after anything that took it without being a place to type: a
 *   press that ends without a click, the box losing focus to nothing, a copy from the transcript, a
 *   click in an artifact's page outside its fields, coming back to the window, opening the app, and
 *   a select once it is set.
 */

/** A place to type, or a control that takes keys of its own while in use. */
const PLACE_TO_TYPE =
  'input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=reset]):not([type=range]):not([type=color]):not([type=file]), textarea, select, [contenteditable=""], [contenteditable="true"]';

/** A place to type text into: where a paste belongs. A select takes keys but no paste. */
const TEXT_FIELD = PLACE_TO_TYPE.replace(', select', '');

/** The key an artifact's page reports its focus under: true while one of its own fields holds it. */
const ARTIFACT_FOCUS = 'foundryArtifactFocus';

/**
 * The script an artifact's page runs first (artifacts.js): it tells the viewer whether one of its
 * fields holds focus, so a click elsewhere in the page hands focus back to the message box.
 */
export const ARTIFACT_FOCUS_REPORTER = `<script>(() => {
  const place = ${JSON.stringify(PLACE_TO_TYPE)};
  const tell = () => parent.postMessage({ ${ARTIFACT_FOCUS}: !!document.activeElement?.closest?.(place) }, '*');
  addEventListener('focusin', tell);
  addEventListener('focusout', () => setTimeout(tell, 0));
  addEventListener('pointerup', () => setTimeout(tell, 0));
})();</script>`;

/**
 * Artifact pages that said none of their fields holds focus, by their window. Until a page says so it
 * holds focus, since its report can arrive after the click that moved focus into it.
 */
const framesIdle = new WeakSet();

const visible = (el) => !!el && el.isConnected && el.getBoundingClientRect().width > 0;

let lastComposer = null;

/** The message box typing goes to: the one used last, else the centre's, else any showing. */
export function composerOnScreen() {
  if (visible(lastComposer)) return lastComposer;
  const boxes = [...document.querySelectorAll('textarea.chat-input')].filter(visible);
  return boxes.find((box) => box.closest('.panel-center')) ?? boxes[0] ?? null;
}

const isComposer = (el) => !!el?.matches?.('textarea.chat-input');

/** Something other than the composer is holding focus: a place to type, or an open dialog. */
function holding(el) {
  if (!el || el === document.body || el === document.documentElement) return false;
  if (isComposer(el)) return false;
  if (el.closest?.(PLACE_TO_TYPE)) return true;
  // An artifact's page holds focus unless it said none of its fields does; any other frame holds it.
  if (el.tagName === 'IFRAME')
    return !el.matches('iframe.artifact-frame') || !framesIdle.has(el.contentWindow);
  return !!el.closest?.('[role="dialog"], [role="menu"], [aria-modal="true"], .gloss-review');
}

/** A dialog is open over the page: it holds the keyboard, whatever has focus inside it. */
const dialogOpen = () =>
  !!document.querySelector('[aria-modal="true"], .gloss-review, .overlay-backdrop');

const selecting = () => {
  const selection = window.getSelection?.();
  return !!selection && !selection.isCollapsed && selection.toString().trim().length > 0;
};

/** A mouse button or touch is down: a drag or a selection may be starting, so focus waits. */
let pressing = false;

/**
 * Put focus back in the composer unless something is rightly holding it. `afterCopy`: the selected
 * text is on the clipboard, so the selection no longer holds focus.
 */
export function returnFocus({ afterCopy = false } = {}) {
  if (!document.hasFocus() || pressing) return;
  if (holding(document.activeElement) || dialogOpen() || (!afterCopy && selecting())) return;
  const box = composerOnScreen();
  if (box && document.activeElement !== box) box.focus({ preventScroll: true });
}

/** After the click's handlers (and the render they cause) have run. */
function soon() {
  setTimeout(() => {
    returnFocus();
    // A click that opens a thread renders its message box a moment later.
    setTimeout(returnFocus, 60);
  }, 0);
}

export function initComposerFocus() {
  document.addEventListener('focusin', (e) => {
    if (isComposer(e.target)) lastComposer = e.target;
    // Focus moving into an artifact's page: it holds focus until the page reports otherwise.
    if (e.target.matches?.('iframe.artifact-frame')) framesIdle.delete(e.target.contentWindow);
  });

  // Typing anywhere that isn't a place to type goes to the message box. Capture: before the
  // hotkey bindings, so a plain letter is typed rather than taken as a command.
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.altKey || e.metaKey || e.ctrlKey || e.isComposing) return;
      if (e.key.length !== 1) return;
      if (holding(e.target) || isComposer(e.target) || dialogOpen()) return;
      const box = composerOnScreen();
      if (!box) return;
      box.focus({ preventScroll: true });
      // The key's character is inserted into the box now holding focus; no binding sees it.
      e.stopPropagation();
    },
    true,
  );

  // A paste (⌘V, Wispr Flow's dictation) outside a text field goes to the message box: focus moves
  // before the paste runs, so the box takes it as typed, images included.
  window.addEventListener(
    'keydown',
    (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== 'v') return;
      if (e.target.closest?.(TEXT_FIELD) || dialogOpen()) return;
      composerOnScreen()?.focus({ preventScroll: true });
    },
    true,
  );
  // A paste that still arrives outside a text field (the Edit menu, a key the page never saw) goes
  // to the message box: images to its own paste handling, text inserted.
  document.addEventListener('paste', (e) => {
    if (e.defaultPrevented || e.target.closest?.(TEXT_FIELD) || dialogOpen()) return;
    const box = composerOnScreen();
    const data = e.clipboardData;
    if (!box || !data) return;
    const images = [...data.items].some(
      (item) => item.kind === 'file' && item.type.startsWith('image/'),
    );
    const text = data.getData('text/plain');
    if (!images && !text) return;
    e.preventDefault();
    box.focus({ preventScroll: true });
    if (images) {
      box.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
      return;
    }
    // insertText fires the box's input event and keeps undo, as a typed paste would.
    if (document.execCommand('insertText', false, text)) return;
    box.setRangeText(text, box.selectionStart, box.selectionEnd, 'end');
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });

  // A press that ends anywhere but a place to type hands focus back, click or not (a drag, a
  // selection that collapsed, a press released off its target).
  window.addEventListener('pointerdown', () => (pressing = true), true);
  window.addEventListener(
    'pointerup',
    (e) => {
      pressing = false;
      if (!e.target.closest?.(PLACE_TO_TYPE)) soon();
    },
    true,
  );
  window.addEventListener('pointercancel', () => (pressing = false), true);
  window.addEventListener('blur', () => (pressing = false));

  // Copying from the transcript: once the text is on the clipboard, focus goes back to the box.
  document.addEventListener('copy', (e) => {
    if (e.target.closest?.(TEXT_FIELD)) return;
    setTimeout(() => returnFocus({ afterCopy: true }), 0);
  });

  // An artifact's page says when one of its fields holds focus; a click elsewhere in it hands focus
  // back to the box.
  window.addEventListener('message', (e) => {
    const typing = e.data?.[ARTIFACT_FOCUS];
    if (typeof typing !== 'boolean') return;
    const frame = [...document.querySelectorAll('iframe.artifact-frame')].find(
      (f) => f.contentWindow === e.source,
    );
    if (!frame) return;
    if (typing) return void framesIdle.delete(e.source);
    framesIdle.add(e.source);
    if (document.activeElement === frame) soon();
  });

  // Back to the window, or to the tab: focus the message box unless something holds focus.
  window.addEventListener('focus', soon);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') soon();
  });
  // A select keeps focus once set, and would take the next letters typed: let it go, focus comes back.
  document.addEventListener('change', (e) => {
    if (!e.target.matches?.('select') || e.target.closest?.('[role="dialog"], [aria-modal="true"]'))
      return;
    e.target.blur();
    soon();
  });

  // Clicking anything but a place to type leaves focus in (or returns it to) the message box.
  document.addEventListener('click', (e) => {
    if (e.target.closest?.(PLACE_TO_TYPE)) return;
    soon();
  });

  // Anything that loses focus to nothing hands it back, the box itself included.
  document.addEventListener('focusout', (e) => {
    if (e.relatedTarget) return;
    soon();
  });
}
