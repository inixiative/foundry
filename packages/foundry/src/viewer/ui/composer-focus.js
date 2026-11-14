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
 * - A paste anywhere that isn't a text field lands in the message box (Aron 11-14: Wispr Flow
 *   dictation "frequently doesn't paste"; Wispr pastes with ⌘V into whatever holds focus). So does
 *   coming back to the window, opening the app, and a select once it is set.
 */

/** A place to type, or a control that takes keys of its own while in use. */
const PLACE_TO_TYPE =
  'input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=reset]):not([type=range]):not([type=color]):not([type=file]), textarea, select, [contenteditable=""], [contenteditable="true"]';

/** A place to type text into: where a paste belongs. A select takes keys but no paste. */
const TEXT_FIELD = PLACE_TO_TYPE.replace(', select', '');

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
  // An artifact's page (a sandboxed frame) holds its own fields.
  if (el.tagName === 'IFRAME') return true;
  return !!el.closest?.('[role="dialog"], [role="menu"], [aria-modal="true"], .gloss-review');
}

/** A dialog is open over the page: it holds the keyboard, whatever has focus inside it. */
const dialogOpen = () =>
  !!document.querySelector('[aria-modal="true"], .gloss-review, .overlay-backdrop');

const selecting = () => {
  const selection = window.getSelection?.();
  return !!selection && !selection.isCollapsed && selection.toString().trim().length > 0;
};

/** Put focus back in the composer unless something is rightly holding it. */
export function returnFocus() {
  if (!document.hasFocus()) return;
  if (holding(document.activeElement) || dialogOpen() || selecting()) return;
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

  // A place to type that closes or loses focus hands it back.
  document.addEventListener('focusout', (e) => {
    if (isComposer(e.target)) return;
    if (e.relatedTarget) return;
    soon();
  });
}
