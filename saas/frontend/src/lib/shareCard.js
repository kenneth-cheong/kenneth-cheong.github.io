// ── Share Cards (frontend) ───────────────────────────────────────────────────
// The card summary + SVG generator now lives in the shared module so the
// ShareFn Lambda renders byte-identical cards (Layer 2). This file re-exports
// those pure helpers and adds the browser-only bits: rasterise an SVG to a PNG
// Blob via <canvas> (no external fonts/images, so the canvas never taints),
// plus clipboard / download / native-share. See ShareModal.jsx for the UI.

export {
  FORMATS, CTA_HOST, CTA_URL,
  buildShareSummary, renderCardSvg, svgToDataUrl, socialIntents,
} from '@shared/shareCard.mjs';

export function svgToPngBlob(svg, w, h, scale = 1) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob returned null'))), 'image/png');
    };
    img.onerror = () => reject(new Error('SVG rasterisation failed'));
    // Re-import is cheap; avoids a circular import of the data-url helper.
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

export async function copyImageToClipboard(blob) {
  if (!window.ClipboardItem || !navigator.clipboard?.write) throw new Error('unsupported');
  await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })]);
}

export async function nativeShare(blob, summary) {
  const file = new File([blob], 'digimetrics-card.png', { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    await navigator.share({ files: [file], title: summary.headline, text: summary.caption });
    return true;
  }
  return false;
}
