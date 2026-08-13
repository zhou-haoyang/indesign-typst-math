/**
 * What the status line says, as pure functions.
 *
 * The rules are the most carefully-reasoned and least-tested behaviour in this
 * panel, so they live apart from the DOM where they can be asserted. In full,
 * because each clause was paid for:
 *
 *   - **An operation that succeeded says nothing.** The equation appearing in
 *     the document is the feedback. A panel that announces every success trains
 *     people to ignore the one line failures also arrive on.
 *   - **A compile error belongs to the preview, not here.** The webview paints
 *     the diagnostics under the artwork that failed, so repeating them stacked
 *     two copies of one error in two formats — and once, two *different* wrong
 *     ones. The panel still reports failures for actions it owns, where the
 *     message answers a button press.
 *   - **A placement result is sticky.** Inserting selects the new frame, which
 *     triggers a preview, whose success path would otherwise wipe the message a
 *     quarter of a second after it appeared.
 *   - **Progress must be taken down by whoever put it up.** Now that finishing
 *     is silent, an "Inserting…" left standing reads as a hang.
 *
 * The previous implementation decided that last one by asking the DOM whether
 * its own class attribute contained the substring "busy". This models it as
 * state instead, which is the whole reason the module exists.
 */

/** How long a placement result resists being overwritten by routine updates. */
const STICKY_MS = 15000;

/** Nothing to say. Also what `.status:empty` collapses away in the CSS. */
const EMPTY = { text: "", kind: "", stickyUntil: 0 };

/**
 * The status after `request`, or the current one unchanged if it should be
 * ignored.
 *
 * Returning the *same object* when nothing should change matters: the store
 * compares with Object.is, so an ignored update costs no view pass.
 *
 * @param {{text: string, kind?: ""|"error"|"busy", sticky?: boolean}} request
 * @param {number} now  injected so stickiness is testable without waiting 15 s
 */
function next(current, request, now) {
  const kind = request.kind || "";
  const text = request.text || "";
  const important = !!request.sticky || kind === "error";

  // Routine updates yield to a sticky message; progress is allowed through
  // without becoming sticky itself, so "Inserting…" can interrupt and then be
  // cleared without stranding the message it replaced.
  if (!important && kind !== "busy" && now < current.stickyUntil) return current;

  const settled = { text, kind, stickyUntil: important ? now + STICKY_MS : 0 };
  return same(current, settled) ? current : settled;
}

/**
 * Take down a progress message, and only a progress message.
 *
 * An error raised while busy is the thing we stayed quiet to make room for, so
 * it must survive `setBusy(false)`.
 */
function clearBusy(current) {
  return current.kind === "busy" ? EMPTY : current;
}

/** Whether this status should also be echoed to the console. */
function worthLogging(status) {
  return !!status.text && (status.kind === "error" || status.stickyUntil > 0);
}

/** The class attribute the DOM node should carry. */
function className(status) {
  return `status${status.kind ? ` ${status.kind}` : ""}`;
}

function same(a, b) {
  return a.text === b.text && a.kind === b.kind && a.stickyUntil === b.stickyUntil;
}

module.exports = { next, clearBusy, worthLogging, className, EMPTY, STICKY_MS };
