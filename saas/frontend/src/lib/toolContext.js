// Out-of-band channel for the tool the user is actively filling in, so Monty
// (the ChatDrawer) can read the LIVE field values without sharing a React tree
// with ToolRunner. ToolRunner publishes a snapshot on every change; the chat
// reads it at the moment a message is sent. Cleared when the tool page unmounts.
//
// Why not a context/store: the chat lives in Layout, above the routed page, so a
// plain module-level snapshot is the simplest reliable bridge — no provider
// plumbing, and pageContext() reads it synchronously at send time.

let snapshot = null; // { toolId, tabLabel, values } | null

/** ToolRunner: publish the tool the user is looking at + their current entries. */
export function setActiveTool(next) {
  snapshot = next && next.toolId ? next : null;
}

/** ToolRunner: clear on unmount. Guarded so a late-unmounting old page can't
 *  wipe the snapshot a newly-mounted tool just published. */
export function clearActiveTool(toolId) {
  if (!toolId || snapshot?.toolId === toolId) snapshot = null;
}

/** ChatDrawer: read the current snapshot (or null). */
export function getActiveTool() {
  return snapshot;
}
