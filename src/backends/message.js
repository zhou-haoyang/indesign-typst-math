/**
 * Getting our payload out of a UXP webview message.
 *
 * UXP does not hand `event.data` over verbatim, and the wrapper it uses carries
 * its own `type`, so any parser that keys off `type` alone silently drops every
 * message — the panel sees hundreds of events and understands none of them.
 *
 * Rather than encode one guess about the envelope, search for our payload:
 * parse strings, and descend through the usual wrapper properties until
 * something we recognise turns up. Kept free of UXP imports so it can be tested
 * directly (tools/test-messages.mjs).
 */

/** Message types this plugin sends between panel and webview. */
const OURS = new Set(["ready", "result"]);

const WRAPPER_KEYS = ["data", "detail", "message", "payload", "body", "value"];
const MAX_DEPTH = 5;

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractMessage(raw, depth = 0) {
  if (raw == null || depth > MAX_DEPTH) return null;
  if (typeof raw === "string") {
    const parsed = safeParse(raw);
    return parsed ? extractMessage(parsed, depth + 1) : null;
  }
  if (typeof raw !== "object") return null;
  if (typeof raw.type === "string" && OURS.has(raw.type)) return raw;

  for (const key of WRAPPER_KEYS) {
    let child;
    try {
      child = raw[key];
    } catch {
      continue; // exotic host objects can throw on property access
    }
    if (child === undefined || child === raw) continue;
    const found = extractMessage(child, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Describe an unreadable event well enough to fix the parsing from a screenshot. */
function describeEvent(event) {
  const describe = (value) => {
    if (value === null || value === undefined) return String(value);
    if (typeof value === "string") {
      return `string(${value.length}) ${JSON.stringify(value.slice(0, 160))}`;
    }
    if (typeof value !== "object") return `${typeof value} ${String(value).slice(0, 60)}`;
    let keys = "?";
    try { keys = Object.keys(value).join(","); } catch { /* exotic proxy */ }
    let json = "";
    try { json = JSON.stringify(value).slice(0, 200); } catch { json = "(not serialisable)"; }
    return `object keys=[${keys}] ${json}`;
  };

  let eventKeys = "?";
  try {
    const own = Object.keys(event);
    const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(event) || {});
    eventKeys = [...new Set([...own, ...proto])].slice(0, 20).join(",");
  } catch { /* ignore */ }

  return `data=${describe(event && event.data)} · event keys=[${eventKeys}]`;
}

module.exports = { extractMessage, describeEvent };
