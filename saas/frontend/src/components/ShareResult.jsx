import { useState } from 'react';
import { Share2 } from 'lucide-react';
import ShareModal from './ShareModal.jsx';
import { isShareable } from '../lib/shareCard.js';

// A "Share" button + its modal — turns a tool result into a branded social card.
// `out` is the result envelope: { result, runId? }. When `out` carries a runId
// (a saved run) the modal additionally offers a public unfurl link; without one
// it stays fully client-side (download / copy image / caption / native share).
//
// `force` shows the button for hand-assembled summaries (e.g. dashboard pages)
// that isShareable() can't introspect from a raw tool payload.
// `snapshot` opts this result into public share links even without a saved run:
// the modal posts the compact summary and the server persists it on the share.
export default function ShareResult({
  tool, out, project, user,
  force = false,
  snapshot = false,
  label = 'Share',
  className = 'inline-flex items-center gap-1 rounded-md border border-brand-200 dark:border-brand-500/30 bg-brand-50 dark:bg-brand-500/10 px-2.5 py-1 text-xs font-semibold text-brand-700 dark:text-brand-300 hover:border-brand-400 hover:bg-brand-100 dark:hover:bg-brand-500/15',
}) {
  const [open, setOpen] = useState(false);
  if (!out || (!force && !isShareable(out))) return null;
  return (
    <>
      <button onClick={() => setOpen(true)} title="Create a branded image to share on social media" className={className}>
        <Share2 size={13} aria-hidden /> {label}
      </button>
      <ShareModal open={open} onClose={() => setOpen(false)} tool={tool} out={out} project={project} user={user} snapshot={snapshot} />
    </>
  );
}
