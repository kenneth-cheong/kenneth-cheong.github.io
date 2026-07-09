// ── ShareFn: server-rendered share cards + public share links ────────────────
// Renders branded PNG cards from a saved run using the SAME generator as the
// frontend (shared/shareCard.mjs), rasterised with resvg-wasm + an embedded
// brand font — so the card is pixel-identical to the in-app preview. WASM +
// font assets are copied next to this handler by scripts/build.mjs.
//
// Routes (one Lambda, mixed auth):
//   GET  /me/runs/{runId}/card          authed  — full card PNG (Layer 2)
//   POST /me/runs/{runId}/share         authed  — mint/return public link
//   POST /me/runs/{runId}/share/revoke  authed  — revoke the public link
//   GET  /s/{shareId}                    public — OG landing page (HTML)
//   GET  /s/{shareId}/card.png           public — REDACTED card PNG
//
// Public cards are auto-redacted (no client domain/identifier) per the opt-in +
// redact privacy model.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Resvg, initWasm } from '@resvg/resvg-wasm';
import { getRun, createShare, getShare, revokeShare, setRunShareId } from '../lib/dynamo.mjs';
import { buildShareSummary, renderCardSvg, FORMATS, CTA_HOST, CTA_URL } from '../../../shared/shareCard.mjs';
import { claims, json } from '../lib/http.mjs';

const APP_ORIGIN = process.env.APP_ORIGIN || '*';
const cors = (origin) => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
});

const asset = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)));

// One-time per container: load the WASM runtime and the brand fonts.
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await initWasm(asset('./index_bg.wasm'));
      return [asset('./PlusJakartaSans-Regular.ttf'), asset('./PlusJakartaSans-Bold.ttf')];
    })();
  }
  return ready;
}

// Render a saved run to a PNG buffer in the given format. `redact` strips the
// client domain/identifier (public cards).
async function renderRun(run, format, redact) {
  const fontBuffers = await init();
  const f = FORMATS[format] || FORMATS.square;
  const summary = buildShareSummary(
    { id: run.tool, name: run.toolName || run.tool },
    { result: run.result || {} },
    { name: null, domain: run.target || '' },
    {},
    { redact },
  );
  const svg = renderCardSvg(summary, f.id);
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: f.w * 2 }, // 2× for crisp retina/social output
    font: { fontBuffers, defaultFontFamily: 'Plus Jakarta Sans', loadSystemFonts: false },
  });
  return { png: resvg.render().asPng(), summary };
}

const pngResponse = (png, origin, cacheable) => ({
  statusCode: 200,
  headers: {
    'Content-Type': 'image/png',
    'Cache-Control': cacheable ? 'public, max-age=86400' : 'private, max-age=86400',
    ...cors(origin),
  },
  isBase64Encoded: true,
  body: Buffer.from(png).toString('base64'),
});

const htmlEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const htmlResponse = (statusCode, html) => ({
  statusCode,
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=3600', ...cors('*') },
  body: html,
});

// Public landing page with OpenGraph/Twitter meta so the link unfurls into the
// card on LinkedIn/X/WhatsApp, plus a visible CTA back to the product.
function ogPage({ summary, imageUrl, pageUrl }) {
  const title = `${summary.headline} · Digimetrics`;
  const statBit = summary.stat && summary.stat !== '✓' ? ` — ${summary.statLabel}: ${summary.stat}` : '';
  const desc = `${summary.headline}${statBit}. Run your own free SEO & AI-visibility report at ${CTA_HOST}.`;
  const T = htmlEsc(title), D = htmlEsc(desc), I = htmlEsc(imageUrl), U = htmlEsc(pageUrl);
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${T}</title><meta name="description" content="${D}">
<meta property="og:type" content="website"><meta property="og:title" content="${T}">
<meta property="og:description" content="${D}"><meta property="og:image" content="${I}">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:url" content="${U}"><meta property="og:site_name" content="Digimetrics">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${T}">
<meta name="twitter:description" content="${D}"><meta name="twitter:image" content="${I}">
<style>
  :root{--brand:#2563eb}
  *{box-sizing:border-box}
  body{margin:0;font-family:'Plus Jakarta Sans',Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f1f5f9;color:#0f172a;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
  .wrap{max-width:680px;text-align:center}
  .card{width:100%;border-radius:16px;box-shadow:0 12px 40px rgba(2,6,23,.12);display:block}
  h1{font-size:22px;margin:28px 0 6px}
  p{color:#475569;margin:0 0 22px}
  a.cta{display:inline-block;background:linear-gradient(135deg,#2563eb,#1e40af);color:#fff;text-decoration:none;font-weight:700;padding:14px 26px;border-radius:30px}
  .foot{margin-top:18px;font-size:13px;color:#94a3b8}
</style></head>
<body><div class="wrap">
  <img class="card" src="${I}" alt="${T}" width="1200" height="630">
  <h1>Want results like this for your site?</h1>
  <p>This report was generated with Digimetrics — SEO, GEO &amp; AI-visibility tools.</p>
  <a class="cta" href="${htmlEsc(CTA_URL)}">Run your own free audit →</a>
  <div class="foot">${htmlEsc(CTA_HOST)}</div>
</div></body></html>`;
}

// Public share links should be branded (platform.digimetrics.ai), NOT the raw
// execute-api host the request happens to arrive on — otherwise social unfurls
// show the ugly AWS domain. Gated on PUBLIC_SHARE_ORIGIN: only flip it on once
// platform.digimetrics.ai/s/* is reverse-proxied to this API (Amplify rewrite),
// so the branded URL resolves back here. Unset ⇒ current request-host behaviour.
const baseUrl = (event) =>
  process.env.PUBLIC_SHARE_ORIGIN ||
  `https://${event.requestContext?.domainName || event.headers?.host || CTA_HOST}`;

export async function handler(event) {
  const method = event.requestContext?.http?.method || 'GET';
  const path = event.rawPath || event.requestContext?.http?.path || '';
  if (method === 'OPTIONS') return { statusCode: 204, headers: cors(APP_ORIGIN), body: '' };

  try {
    // ── Public routes (no auth) ──────────────────────────────────────────────
    if (path.startsWith('/s/')) {
      const shareId = event.pathParameters?.shareId;
      const share = shareId ? await getShare(shareId) : null;
      const gone = !share || share.revoked;

      if (path.endsWith('/card.png')) {
        if (gone) return json(404, { error: 'Not found' });
        const run = await getRun(share.userId, share.runId);
        if (!run) return json(404, { error: 'Not found' });
        const fmt = event.queryStringParameters?.format;
        const { png } = await renderRun(run, FORMATS[fmt] ? fmt : 'wide', true);
        return pngResponse(png, '*', true);
      }
      // OG landing page
      if (gone) return htmlResponse(404, '<!doctype html><meta charset="utf-8"><title>Link unavailable</title><body style="font-family:system-ui;text-align:center;padding:60px;color:#475569">This share link is no longer available.</body>');
      const run = await getRun(share.userId, share.runId);
      if (!run) return htmlResponse(404, '<!doctype html><meta charset="utf-8"><body>Not found</body>');
      const { summary } = await renderRun(run, 'wide', true);
      const base = baseUrl(event);
      return htmlResponse(200, ogPage({
        summary,
        imageUrl: `${base}/s/${shareId}/card.png?format=wide`,
        pageUrl: `${base}/s/${shareId}`,
      }));
    }

    // ── Authed routes ────────────────────────────────────────────────────────
    const userId = claims(event)?.userId;
    if (!userId) return json(401, { error: 'Unauthorized' });
    const runId = event.pathParameters?.runId ? decodeURIComponent(event.pathParameters.runId) : null;
    if (!runId) return json(400, { error: 'Missing runId' });

    // Revoke the public link.
    if (path.endsWith('/share/revoke')) {
      const run = await getRun(userId, runId);
      if (run?.shareId) { await revokeShare(run.shareId, userId).catch(() => {}); await setRunShareId(userId, runId, null); }
      return json(200, { ok: true });
    }

    // Mint (or return the existing) public link — idempotent per run.
    if (path.endsWith('/share')) {
      const run = await getRun(userId, runId);
      if (!run) return json(404, { error: 'Run not found' });
      let shareId = run.shareId || null;
      const existing = shareId ? await getShare(shareId) : null;
      if (!existing || existing.revoked) {
        shareId = randomBytes(9).toString('base64url'); // ~12-char unguessable id
        await createShare({ userId, runId, shareId });
        await setRunShareId(userId, runId, shareId);
      }
      return json(200, { shareId, url: `${baseUrl(event)}/s/${shareId}` });
    }

    // Default: the authed full-resolution card (Layer 2).
    const run = await getRun(userId, runId);
    if (!run) return json(404, { error: 'Run not found' });
    const fmt = event.queryStringParameters?.format;
    const { png } = await renderRun(run, FORMATS[fmt] ? fmt : 'square', false);
    return pngResponse(png, APP_ORIGIN, false);
  } catch (err) {
    console.error('share handler failed', err);
    return json(500, { error: 'Share request failed' });
  }
}
