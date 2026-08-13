/**
 * The panel's state, and who to tell when it changes.
 *
 * Small on purpose. The panel is one screen with a flat set of fields, so
 * there is nothing here but a shallow merge and a subscriber list — no
 * reducers, no paths, no deep equality. Views subscribe and update their own
 * DOM imperatively; nothing is created, removed or re-parented after boot,
 * because a UXP text control that spends any time inside a `display: none`
 * subtree never becomes editable again.
 *
 * Two behaviours here are load-bearing rather than tidy-mindedness. Both have a
 * test.
 */

/**
 * @param {object} initial
 */
function createStore(initial) {
  let state = { ...initial };
  const subscribers = new Set();

  return {
    get() {
      return state;
    },

    /**
     * Merge `patch` and notify, unless nothing actually changed.
     *
     * The no-op guard is not an optimisation. The selection is polled every
     * 700 ms and re-derives most of this object each time; without the guard
     * every tick would run a full view pass, and a view pass writes `.value`
     * on the editor — which moves the caret to the start while someone is
     * typing. Compare with Object.is so that NaN settles and -0 does not
     * masquerade as a change.
     *
     * @returns {boolean} whether anything changed
     */
    set(patch) {
      if (!patch) return false;
      let dirty = false;
      for (const key of Object.keys(patch)) {
        if (!Object.is(state[key], patch[key])) { dirty = true; break; }
      }
      if (!dirty) return false;

      const previous = state;
      state = { ...state, ...patch };
      // Snapshot the list: a subscriber is allowed to unsubscribe itself, and
      // mutating the set mid-iteration would skip its neighbour.
      for (const notify of [...subscribers]) {
        try {
          notify(state, previous);
        } catch (err) {
          // One broken view must not take the others down with it. The panel is
          // a single JS context, and a throwing settings dialog silently
          // killing the live preview is exactly the kind of failure that gets
          // blamed on the compiler.
          console.error(`[typst] subscriber failed: ${(err && err.message) || err}`);
        }
      }
      return true;
    },

    /** @returns {() => void} unsubscribe */
    subscribe(notify) {
      subscribers.add(notify);
      return () => subscribers.delete(notify);
    },
  };
}

/**
 * Did any of `keys` change between two states?
 *
 * The state is deliberately flat so that this stays an Object.is compare and no
 * view ever has to diff a nested object.
 */
function changed(previous, next, ...keys) {
  return keys.some((key) => !Object.is(previous[key], next[key]));
}

module.exports = { createStore, changed };
