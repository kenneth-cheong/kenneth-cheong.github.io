import { useEffect, useMemo, useState } from 'react';
import { Download, Copy, Share2, X as XIcon, Image as ImageIcon, Globe, Link2, Loader2, ExternalLink, FileDown } from 'lucide-react';
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
export default function ShareModal({ open, onClose, tool, out, project, user, snapshot = false, onDownloadPdf, tldr = '' }) {
  const [format, setFormat] = useState('square');
  const [shareUrl, setShareUrl] = useState('');
  const [snapShareId, setSnapShareId] = useState(''); // shareId of a minted snapshot (dashboard tools)
  const [linking, setLinking] = useState(false);
  // A result can be published to a public link if it's a saved run OR a
  // dashboard snapshot (which the server persists on the share itself).
  const publishable = !!(out?.runId || snapshot);
  const summary = useMemo(
    () => (open ? buildShareSummary(tool, out, project, user) : null),
    [open, tool, out, project, user],
  );
  const f = FORMATS[format];
  const svg = useMemo(() => (summary ? renderCardSvg(summary, format) : ''), [summary, format]);
  // The minted link (…/s/:id) is the social-unfurl entry point; the report page
  // (…/share/:id) is the same run rendered in full. Both resolve the same share.
  const reportUrl = shareUrl ? shareUrl.replace('/s/', '/share/') : '';

  useEffect(() => {
    if (!open) return;
    setShareUrl(''); setSnapShareId(''); // a fresh open never leaks the previous run's link
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
  // Share to a platform with the IMAGE attached: web composers can't take a
  // file, so we ensure a public link first (auto-minted, redacted) — the
  // platform then unfurls the card image from the link's OG tags, with the
  // caption prefilled. The window is opened synchronously (before the await) so
  // the popup isn't blocked, then redirected once the link is ready.
  // Mint the public link. Saved runs mint by runId; dashboard snapshots post the
  // compact summary and the server persists it on the share. Returns { url }.
  const mint = async () => {
    if (out?.runId) return api.shareRun(out.runId, undefined, tldr);
    const r = await api.shareRun('snap', {
      toolId: tool.id, toolName: tool.name, result: out.result, target: project?.domain || '',
    }, tldr);
    if (r.shareId) setSnapShareId(r.shareId);
    return r;
  };

  const onSocial = async (key) => {
    const w = window.open('about:blank', '_blank', 'width=600,height=640');
    let url = shareUrl;
    if (!url && publishable) {
      setLinking(true);
      try { const r = await mint(); url = r.url; setShareUrl(url); }
      catch { /* no link — fall back to caption + generic CTA link */ }
      finally { setLinking(false); }
    }
    const target = socialIntents(summary, url)[key];
    if (w) { try { w.opener = null; } catch { /* ignore */ } w.location.replace(target); }
    else window.open(target, '_blank', 'noopener'); // popup blocked → best effort
  };

  const onCreateLink = async () => {
    setLinking(true);
    try { const { url } = await mint(); setShareUrl(url); toast('Public link created', 'success'); }
    catch (e) { toast(`Could not create link — ${e?.message || 'please try again'}`, 'error'); }
    finally { setLinking(false); }
  };
  const onRevoke = async () => {
    setLinking(true);
    try { await api.revokeShare(out?.runId || 'snap', snapShareId || undefined); setShareUrl(''); setSnapShareId(''); toast('Public link revoked', 'success'); }
    catch { toast('Could not revoke link', 'error'); }
    finally { setLinking(false); }
  };

  const btn = 'inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold transition';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" onClick={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-surface shadow-xl sm:flex-row" onClick={(e) => e.stopPropagation()}>
        {/* Preview */}
        <div className="flex flex-1 items-center justify-center bg-sunken p-5">
          <img
            src={svgToDataUrl(svg)}
            alt="Share card preview"
            className="max-h-[60vh] w-auto rounded-lg border border-line shadow-sm"
            style={{ aspectRatio: `${f.w} / ${f.h}` }}
          />
        </div>

        {/* Controls */}
        <div className="flex w-full shrink-0 flex-col gap-4 p-5 sm:w-72">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-base font-bold text-heading"><ImageIcon size={18} className="text-brand-600 dark:text-brand-400" /> Share result</h3>
            <button onClick={onClose} className="rounded-md p-1 text-faint hover:bg-sunken hover:text-dim" aria-label="Close"><XIcon size={18} /></button>
          </div>

          <div>
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">Format</div>
            <div className="grid grid-cols-1 gap-1.5">
              {Object.values(FORMATS).map((opt) => (
                <button key={opt.id} onClick={() => setFormat(opt.id)}
                  className={`rounded-lg border px-3 py-1.5 text-left text-sm font-medium ${format === opt.id ? 'border-brand-500 bg-brand-50 dark:bg-brand-500/10 text-brand-700 dark:text-brand-300' : 'border-line text-dim hover:border-brand-300 dark:hover:border-brand-500/40'}`}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button onClick={onDownload} className={`${btn} bg-brand-600 text-white hover:bg-brand-700`}><Download size={15} /> Download image</button>
            <button onClick={onCopyImage} className={`${btn} border border-line text-body hover:border-brand-300 dark:hover:border-brand-500/40`}><Copy size={15} /> Copy image</button>
            <button onClick={onShare} className={`${btn} col-span-2 border border-line text-body hover:border-brand-300 dark:hover:border-brand-500/40`}><Share2 size={15} /> Share…</button>
            {/* The full branded report as a PDF (not the card image). Close first
                so the dialog isn't on screen when the print sheet opens. */}
            {onDownloadPdf && (
              <button onClick={() => { onClose(); onDownloadPdf(); }} className={`${btn} col-span-2 border border-line text-body hover:border-brand-300 dark:hover:border-brand-500/40`}><FileDown size={15} /> Download report (PDF)</button>
            )}
          </div>

          <div>
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">Post to</div>
            <div className="grid grid-cols-4 gap-1.5">
              {[['X', 'x'], ['in', 'linkedin'], ['f', 'facebook'], ['WA', 'whatsapp']].map(([label, key]) => (
                <button key={key} onClick={() => onSocial(key)} disabled={linking}
                  className="rounded-lg border border-line py-2 text-sm font-bold text-dim hover:border-brand-300 dark:hover:border-brand-500/40 hover:text-brand-600 dark:hover:text-brand-400 disabled:opacity-50">{label}</button>
              ))}
            </div>
            <button onClick={() => copyText(summary.caption)} className="mt-2 w-full rounded-lg border border-line py-1.5 text-xs font-medium text-muted hover:border-brand-300 dark:hover:border-brand-500/40 hover:text-brand-600 dark:hover:text-brand-400">
              Copy caption + hashtags
            </button>
          </div>

          {/* Public link (opt-in). Saved runs or dashboard snapshots. Two views
              of one share: the report page to send people, and the /s/ link the
              social buttons post (it unfurls the card, then opens the report). */}
          {publishable && (
            <div className="rounded-lg border border-line bg-raised/60 p-3">
              <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
                <Globe size={13} /> Public link
              </div>
              {shareUrl ? (
                <>
                  <div className="mt-2 text-[11px] font-semibold text-muted">Report link — send this to view the full report</div>
                  <div className="mt-1 flex items-center gap-1.5">
                    <input readOnly value={reportUrl} className="min-w-0 flex-1 truncate rounded-md border border-line bg-surface px-2 py-1 text-xs text-dim" />
                    <button onClick={() => copyText(reportUrl)} className="shrink-0 rounded-md border border-line p-1.5 text-muted hover:border-brand-300 dark:hover:border-brand-500/40 hover:text-brand-600 dark:hover:text-brand-400" title="Copy report link"><Link2 size={14} /></button>
                    <a href={reportUrl} target="_blank" rel="noreferrer" className="shrink-0 rounded-md border border-line p-1.5 text-muted hover:border-brand-300 dark:hover:border-brand-500/40 hover:text-brand-600 dark:hover:text-brand-400" title="Open report in a new tab"><ExternalLink size={14} /></a>
                  </div>
                  <div className="mt-2.5 text-[11px] font-semibold text-muted">Social link — unfurls the card when posted</div>
                  <div className="mt-1 flex items-center gap-1.5">
                    <input readOnly value={shareUrl} className="min-w-0 flex-1 truncate rounded-md border border-line bg-surface px-2 py-1 text-xs text-dim" />
                    <button onClick={() => copyText(shareUrl)} className="shrink-0 rounded-md border border-line p-1.5 text-muted hover:border-brand-300 dark:hover:border-brand-500/40 hover:text-brand-600 dark:hover:text-brand-400" title="Copy social link"><Link2 size={14} /></button>
                  </div>
                  <button onClick={onRevoke} disabled={linking} className="mt-2.5 text-[11px] font-medium text-red-500 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-50">Revoke link</button>
                </>
              ) : (
                <>
                  <button onClick={onCreateLink} disabled={linking} className={`${btn} mt-2 w-full border border-brand-200 dark:border-brand-500/30 bg-brand-50 dark:bg-brand-500/10 text-brand-700 dark:text-brand-300 hover:bg-brand-100 dark:hover:bg-brand-500/15 disabled:opacity-60`}>
                    {linking ? <Loader2 size={15} className="animate-spin" /> : <Globe size={15} />} Create public link
                  </button>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-faint">Anyone with the link can view the full report — including the site it’s about. Unfurls the card on social; revoke any time.</p>
                </>
              )}
            </div>
          )}

          <p className="text-[11px] leading-relaxed text-faint">
            {publishable
              ? 'Posting to a platform creates a public link so the card image unfurls automatically, with your caption. On mobile, “Share…” attaches the image file directly.'
              : 'Social buttons open the composer with your caption — attach the downloaded image to finish the post.'}
          </p>
        </div>
      </div>
    </div>
  );
}
