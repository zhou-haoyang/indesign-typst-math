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

// Registering the entrypoint gives us the panel lifecycle hooks, but it must not
// be load-bearing: if the manifest UXP has cached disagrees with this file (the
// usual cause is UXP Developer Tools still holding an older manifest, since
// entrypoint IDs are read at Add Plugin time), setup() throws and the panel
// would otherwise sit there inert with no explanation.
try {
  entrypoints.setup({
    panels: {
      [PANEL_ID]: {
        show() {
          boot();
        },
      },
    },
  });
} catch (err) {
  const message = String((err && err.message) || err);
  if (/Could not find panel/i.test(message)) {
    // Report it once the DOM exists, then carry on and start anyway.
    setTimeout(() => fail(
      `This plugin's manifest is not the one InDesign loaded (${message}). ` +
      "In UXP Developer Tools, remove the plugin and add it again — entrypoint " +
      "changes are only picked up when the plugin is added, not on Reload.",
    ), 0);
  } else {
    setTimeout(() => fail(message), 0);
  }
}

// Start regardless of whether the entrypoint registered, so the panel is usable
// even when the lifecycle hook never fires.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
