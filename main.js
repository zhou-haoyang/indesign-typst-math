const { entrypoints } = require("uxp");

const PANEL_ID = "typstMath";

/** The panel DOM is created once; boot may be triggered from several places. */
let started = false;

function fail(message) {
  const status = document.getElementById("status");
  if (status) {
    status.className = "status error";
    status.textContent = message;
  }
  console.error(message);
}

function boot() {
  if (started) return;
  started = true;
  require("./src/ui/panel").start().catch((err) => {
    fail(String((err && err.message) || err));
    console.error(err);
  });
}

/**
 * Flyout items and command entrypoints share one dispatch in the panel.
 * A command can arrive before the panel has ever been shown, so boot first —
 * the compiler lives in the panel's webview, and `invokeMenu` reports for
 * itself if it is not up yet.
 */
function menu(id) {
  boot();
  try {
    const result = require("./src/ui/panel").invokeMenu(id);
    if (result && result.catch) result.catch((err) => fail(String((err && err.message) || err)));
  } catch (err) {
    fail(String((err && err.message) || err));
  }
}

/**
 * Every flyout item needs an `id`, including a separator: InDesign rejects the
 * whole call with "'id' should be defined in menuItem object" otherwise. Since
 * `entrypoints.setup` may only be called once, one malformed item here silently
 * costs the commands too — which is exactly how a cosmetic separator once left
 * both menu commands inert. Hence no separator, and the fallback below.
 *
 * Static items only, too. InDesign does not reliably honour mutating a flyout
 * after registration (checked/enabled/label), and with more than one panel it
 * attaches the menu to the wrong one — neither applies here, but both are the
 * reason nothing here is dynamic.
 */
const MENU_ITEMS = [
  { id: "settings", label: "Settings…" },
  { id: "rerender", label: "Re-render all in document" },
  { id: "about", label: "About Typst Math" },
];

/** Reachable from Plug-Ins ▸ Typst Math without opening the panel. */
const COMMANDS = {
  typstSettings: () => menu("settings"),
  typstRerenderAll: () => menu("rerender"),
};

function register(withFlyout) {
  const panel = { show() { boot(); } };
  if (withFlyout) {
    panel.menuItems = MENU_ITEMS;
    panel.invokeMenu = (id) => menu(id);
  }
  entrypoints.setup({ panels: { [PANEL_ID]: panel }, commands: COMMANDS });
}

// Registering the entrypoint gives us the panel lifecycle hooks, but it must not
// be load-bearing: if the manifest UXP has cached disagrees with this file (the
// usual cause is UXP Developer Tools still holding an older manifest, since
// entrypoint IDs are read at Add Plugin time), setup() throws and the panel
// would otherwise sit there inert with no explanation.
try {
  register(true);
} catch (err) {
  const message = String((err && err.message) || err);
  // Commands are read at Add Plugin time exactly as panels are, so adding one
  // produces the same symptom with a different noun.
  if (/Could not find (panel|command)/i.test(message)) {
    // Report it once the DOM exists, then carry on and start anyway.
    setTimeout(() => fail(
      `This plugin's manifest is not the one InDesign loaded (${message}). ` +
      "In UXP Developer Tools, remove the plugin and add it again — entrypoint " +
      "changes are only picked up when the plugin is added, not on Reload.",
    ), 0);
  } else {
    // The flyout is the fragile half of that call and the commands are the
    // useful half, so give up the flyout rather than both. If setup() already
    // counted as called, this throws again and the original error stands.
    let recovered = false;
    try {
      register(false);
      recovered = true;
    } catch { /* nothing more to try; report what actually went wrong */ }
    setTimeout(() => fail(recovered
      ? `The panel flyout menu was refused (${message}), so it has been dropped. ` +
        "Its actions are still on the ⚙ button and under Plug-Ins ▸ Typst Math."
      : message), 0);
  }
}

// Start regardless of whether the entrypoint registered, so the panel is usable
// even when the lifecycle hook never fires.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
