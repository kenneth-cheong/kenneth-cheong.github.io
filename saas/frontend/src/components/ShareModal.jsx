import { useEffect, useMemo, useState } from 'react';
import { Download, Copy, Share2, X as XIcon, Image as ImageIcon, Globe, Link2, Loader2 } from 'lucide-react';
import { toast, copyText } from '../lib/ui.js';
import { api } from '../lib/api.js';
import {
  FORMATS, buildShareSummary, renderCardSvg, svgToDataUrl, svgToPngBlob,
  downloadBlob, copyImageToClipboard, nativeShare, socialIntents,
} from '../lib/shareCard.js';

// Preview-and-share dialog for a tool result. The preview is an instant
// client-rendered SVG; the exported PNG prefers the server card (ShareFn,
// pixel-identical but with the embedded brand font) when the run was saved,
// falling back to client-side <canvas> rasterisation otherwise.
export default function ShareModal({ open, onClose, tool, out, project, user }) {
  const [format, setFormat] = useState('square');
  const [shareUrl, setShareUrl] = useState('');
  const [linking, setLinking] = useState(false);
  const summary = useMemo(
    () => (open ? buildShareSummary(tool, out, project, user) : null),
    [open, tool, out, project, user],
  );
  const f = FORMATS[format];
  const svg = useMemo(() => (summary ? renderCardSvg(summary, format) : ''), [summary, format]);

  useEffect(() => {
    if (!open) return;
    setShareUrl(''); // a fresh open never leaks the previous run's link
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || !summary) return null;

  // Server card when the run is saved; client raster as a fallback.
  const blob = async (scale = 2) => {
    if (out?.runId) {
      try { return await api.runCard(out.runId, format); }
      catch { /* fall back to client render */ }
    }
    return svgToPngBlob(svg, f.w, f.h, scale);
  };

  const onDownload = async () => {
    try { downloadBlob(await blob(2), `digimetrics-${tool.id}-${format}.png`); toast('Image downloaded', 'success'); }
    catch { toast('Could not generate image', 'error'); }
  };
  const onCopyImage = async () => {
    try { await copyImageToClipboard(await blob(2)); toast('Image copied — paste into your post', 'success'); }
    catch { toast('Copy image not supported here — use Download', 'error'); }
  };
  const onShare = async () => {
    try {
      const shared = await nativeShare(await blob(2), summary);
      if (!shared) { await onDownload(); toast('Saved — attach it to your post', 'info'); }
    } catch { /* user cancelled */ }
  };
  const intents = socialIntents(summary, shareUrl);
  const openIntent = (url) => window.open(url, '_blank', 'noopener,width=600,height=640');

  const onCreateLink = async () => {
    setLinking(true);
    try { const { url } = await api.shareRun(out.runId); setShareUrl(url); toast('Public link created', 'success'); }
    catch { toast('Could not create link', 'error'); }
    finally { setLinking(false); }
  };
  const onRevoke = async () => {
    setLinking(true);
    try { await api.revokeShare(out.runId); setShareUrl(''); toast('Public link revoked', 'success'); }
    catch { toast('Could not revoke link', 'error'); }
    finally { setLinking(false); }
  };

  const btn = 'inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold transition';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" onClick={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl sm:flex-row" onClick={(e) => e.stopPropagation()}>
        {/* Preview */}
        <div className="flex flex-1 items-center justify-center bg-slate-100 p-5">
          <img
            src={svgToDataUrl(svg)}
            alt="Share card preview"
            className="max-h-[60vh] w-auto rounded-lg border border-slate-200 shadow-sm"
            style={{ aspectRatio: `${f.w} / ${f.h}` }}
          />
        </div>

        {/* Controls */}
        <div className="flex w-full shrink-0 flex-col gap-4 p-5 sm:w-72">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-base font-bold text-slate-900"><ImageIcon size={18} className="text-brand-600" /> Share result</h3>
            <button onClick={onClose} className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="Close"><XIcon size={18} /></button>
          </div>

          <div>
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Format</div>
            <div className="grid grid-cols-1 gap-1.5">
              {Object.values(FORMATS).map((opt) => (
                <button key={opt.id} onClick={() => setFormat(opt.id)}
                  className={`rounded-lg border px-3 py-1.5 text-left text-sm font-medium ${format === opt.id ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-200 text-slate-600 hover:border-brand-300'}`}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button onClick={onDownload} className={`${btn} bg-brand-600 text-white hover:bg-brand-700`}><Download size={15} /> Download</button>
            <button onClick={onCopyImage} className={`${btn} border border-slate-200 text-slate-700 hover:border-brand-300`}><Copy size={15} /> Copy image</button>
            <button onClick={onShare} className={`${btn} col-span-2 border border-slate-200 text-slate-700 hover:border-brand-300`}><Share2 size={15} /> Share…</button>
          </div>

          <div>
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Post to</div>
            <div className="grid grid-cols-4 gap-1.5">
              {[['X', intents.x], ['in', intents.linkedin], ['f', intents.facebook], ['WA', intents.whatsapp]].map(([label, url]) => (
                <button key={label} onClick={() => openIntent(url)}
                  className="rounded-lg border border-slate-200 py-2 text-sm font-bold text-slate-600 hover:border-brand-300 hover:text-brand-600">{label}</button>
              ))}
            </div>
            <button onClick={() => copyText(summary.caption)} className="mt-2 w-full rounded-lg border border-slate-200 py-1.5 text-xs font-medium text-slate-500 hover:border-brand-300 hover:text-brand-600">
              Copy caption + hashtags
            </button>
          </div>

          {/* Public link (opt-in, auto-redacted). Only for saved runs. */}
          {out?.runId && (
            <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3">
              <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
                <Globe size={13} /> Public link
              </div>
              {shareUrl ? (
                <>
                  <div className="mt-2 flex items-center gap-1.5">
                    <input readOnly value={shareUrl} className="min-w-0 flex-1 truncate rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600" />
                    <button onClick={() => copyText(shareUrl)} className="shrink-0 rounded-md border border-slate-200 p-1.5 text-slate-500 hover:border-brand-300 hover:text-brand-600" title="Copy link"><Link2 size={14} /></button>
                  </div>
                  <button onClick={onRevoke} disabled={linking} className="mt-2 text-[11px] font-medium text-red-500 hover:text-red-600 disabled:opacity-50">Revoke link</button>
                </>
              ) : (
                <>
                  <button onClick={onCreateLink} disabled={linking} className={`${btn} mt-2 w-full border border-brand-200 bg-brand-50 text-brand-700 hover:bg-brand-100 disabled:opacity-60`}>
                    {linking ? <Loader2 size={15} className="animate-spin" /> : <Globe size={15} />} Create public link
                  </button>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">Shareable link that unfurls the card on social. Your domain is hidden on public cards.</p>
                </>
              )}
            </div>
          )}

          <p className="text-[11px] leading-relaxed text-slate-400">
            {shareUrl
              ? 'Social buttons now share your public link — it unfurls the card automatically.'
              : 'Tip: social buttons open the composer with your caption — attach the downloaded image to finish the post.'}
          </p>
        </div>
      </div>
    </div>
  );
}
