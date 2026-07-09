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
export default function ShareResult({
  tool, out, project, user,
  force = false,
  label = 'Share',
  className = 'inline-flex items-center gap-1 rounded-md border border-brand-200 bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-700 hover:border-brand-400 hover:bg-brand-100',
}) {
  const [open, setOpen] = useState(false);
  if (!out || (!force && !isShareable(out))) return null;
  return (
    <>
      <button onClick={() => setOpen(true)} title="Create a branded image to share on social media" className={className}>
        <Share2 size={13} aria-hidden /> {label}
      </button>
      <ShareModal open={open} onClose={() => setOpen(false)} tool={tool} out={out} project={project} user={user} />
    </>
  );
}
