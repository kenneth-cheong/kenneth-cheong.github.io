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
import { getRun, createShare, getShare, revokeShare, setRunShareId, setRunTldr } from '../lib/dynamo.mjs';
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

const safeJson = (s) => { try { return JSON.parse(s || '{}') || {}; } catch { return {}; } };

// Curated, display-safe view of a run's inputs for the public "report settings"
// strip. STRICT ALLOW-LIST (default-deny): only these keys ever surface — so a
// tool's free-text/content/pasted/connected-account fields (which live under
// other keys) can never leak onto a public page, even for tools written later.
// run.inputs is already stripped of `_`-prefixed keys + projectId at save time
// (publicInputs); this is the second, tighter gate. Values are capped and arrays
// joined; duplicate labels (country/countryCode) collapse to the first seen.
const SAFE_INPUT_LABELS = new Map([
  ['url', 'URL'], ['domain', 'Domain'], ['website', 'Website'], ['page', 'Page'],
  ['competitor', 'Competitor'], ['competitors', 'Competitors'],
  ['competitorUrl', 'Competitor URL'], ['competitorDomain', 'Competitor'],
  ['keyword', 'Keyword'], ['keywords', 'Keywords'], ['query', 'Query'],
  ['topic', 'Topic'], ['brand', 'Brand'], ['niche', 'Niche'], ['industry', 'Industry'],
  ['maxPages', 'Max pages'], ['maxDepth', 'Max depth'], ['depth', 'Depth'],
  ['limit', 'Limit'], ['count', 'Count'], ['device', 'Device'], ['strategy', 'Strategy'],
  ['country', 'Country'], ['countryCode', 'Country'], ['location', 'Location'],
  ['region', 'Region'], ['market', 'Market'], ['language', 'Language'], ['lang', 'Language'],
  ['period', 'Period'], ['range', 'Range'], ['dateRange', 'Date range'],
  ['breakdown', 'Breakdown'], ['mode', 'Mode'], ['engine', 'Engine'], ['searchEngine', 'Search engine'],
]);

function curateInputs(inputs) {
  if (!inputs || typeof inputs !== 'object') return [];
  const out = [];
  const seenLabels = new Set();
  for (const [key, label] of SAFE_INPUT_LABELS) {
    if (out.length >= 8) break;
    if (!(key in inputs) || seenLabels.has(label)) continue;
    let v = inputs[key];
    if (Array.isArray(v)) v = v.filter((x) => x != null && x !== '').join(', ');
    v = String(v ?? '').trim();
    if (!v) continue;
    seenLabels.add(label);
    out.push({ label, value: v.slice(0, 120) });
  }
  return out;
}

// Dashboard tools (Social/Site Audit, Performance, Tracking) have no saved run,
// so their Share button posts a compact stats "snapshot" that we persist on the
// share record itself. Accept ONLY a small stats-sections summary — strip
// everything else and cap sizes. (The renderer + OG page escape text anyway.)
const clip = (v, n) => String(v ?? '').slice(0, n);
const SNAP_TONES = new Set(['green', 'amber', 'red', 'orange', 'blue', 'slate']);
function sanitizeSnapshotResult(result) {
  const sections = Array.isArray(result?.sections) ? result.sections : null;
  if (!sections) return null;
  const out = [];
  for (const sec of sections.slice(0, 4)) {
    if (sec?.type !== 'stats' || !Array.isArray(sec.items)) continue;
    const items = [];
    for (const it of sec.items.slice(0, 8)) {
      const label = clip(it?.label, 60), value = clip(it?.value, 60);
      if (!label || !value) continue;
      const item = { label, value };
      if (SNAP_TONES.has(it?.tone)) item.tone = it.tone;
      items.push(item);
    }
    if (items.length) out.push({ type: 'stats', items });
  }
  return out.length ? { sections: out } : null;
}

// A run-shaped object for the renderer, sourced from either the embedded
// snapshot or the saved run the share points at.
async function runForShare(share) {
  if (share.snapshot) {
    const s = share.snapshot;
    return { tool: s.tool, toolName: s.toolName, result: s.result || {}, target: s.target || '', tldr: s.tldr || '' };
  }
  return share.runId ? getRun(share.userId, share.runId) : null;
}

const htmlEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const htmlResponse = (statusCode, html) => ({
  statusCode,
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=3600', ...cors('*') },
  body: html,
});

// Public landing page with OpenGraph/Twitter meta so the link unfurls into the
// card on LinkedIn/X/WhatsApp, plus a visible CTA back to the product.
// noindex: a share link is unlisted-by-token, not a public web page — it must
// not turn up in search results even though anyone with the link may open it.
function ogPage({ summary, imageUrl, pageUrl, reportUrl }) {
  const title = `${summary.headline} · Digimetrics`;
  const statBit = summary.stat && summary.stat !== '✓' ? ` — ${summary.statLabel}: ${summary.stat}` : '';
  const desc = `${summary.headline}${statBit}. Run your own free SEO & AI-visibility report at ${CTA_HOST}.`;
  const T = htmlEsc(title), D = htmlEsc(desc), I = htmlEsc(imageUrl), U = htmlEsc(pageUrl), R = htmlEsc(reportUrl);
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${T}</title><meta name="description" content="${D}">
<meta name="robots" content="noindex,nofollow">
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
  a.ghost{display:inline-block;margin-top:14px;color:#2563eb;text-decoration:none;font-weight:600;font-size:14px}
  .foot{margin-top:18px;font-size:13px;color:#94a3b8}
</style></head>
<body><div class="wrap">
  <a href="${R}"><img class="card" src="${I}" alt="${T}" width="1200" height="630"></a>
  <h1>View the full report</h1>
  <p>This report was generated with Digimetrics — SEO, GEO &amp; AI-visibility tools.</p>
  <a class="cta" href="${R}">Open the full report →</a>
  <a class="ghost" href="${htmlEsc(CTA_URL)}">Or run your own free audit</a>
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

      // The full public report body, consumed by the /share/:shareId SPA page.
      // Returns the run RESULT only — never `inputs`, which can carry API keys,
      // connected-account ids or other things the public was never meant to see.
      // Unredacted by design: a shared report is the whole report, domain and
      // all (the redacted PNG card remains the teaser for social unfurls).
      if (path.endsWith('/run.json')) {
        if (gone) return json(404, { error: 'Not found' });
        const run = await runForShare(share);
        if (!run) return json(404, { error: 'Not found' });
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300', ...cors('*') },
          body: JSON.stringify({
            run: {
              tool: run.tool,
              toolName: run.toolName || run.tool,
              target: run.target || '',
              ts: run.ts || null,
              // Plain-English summary, if the owner viewed the result before
              // sharing (persisted at mint time). Snapshot shares carry it inline.
              tldr: run.tldr || null,
              // Curated, allow-listed inputs for the "report settings" strip.
              // Raw `inputs` is NEVER returned — only this vetted subset.
              settings: curateInputs(run.inputs),
              result: run.result || {},
            },
          }),
        };
      }

      if (path.endsWith('/card.png')) {
        if (gone) return json(404, { error: 'Not found' });
        const run = await runForShare(share);
        if (!run) return json(404, { error: 'Not found' });
        const fmt = event.queryStringParameters?.format;
        // Unredacted: the report the card links to is fully public, so hiding the
        // domain on the teaser image bought no privacy — only a vaguer card.
        const { png } = await renderRun(run, FORMATS[fmt] ? fmt : 'wide', false);
        return pngResponse(png, '*', true);
      }
      // OG landing page
      if (gone) return htmlResponse(404, '<!doctype html><meta charset="utf-8"><title>Link unavailable</title><body style="font-family:system-ui;text-align:center;padding:60px;color:#475569">This share link is no longer available.</body>');
      const run = await runForShare(share);
      if (!run) return htmlResponse(404, '<!doctype html><meta charset="utf-8"><body>Not found</body>');
      const { summary } = await renderRun(run, 'wide', false);
      const base = baseUrl(event);
      return htmlResponse(200, ogPage({
        summary,
        imageUrl: `${base}/s/${shareId}/card.png?format=wide`,
        pageUrl: `${base}/s/${shareId}`,
        reportUrl: `${base}/share/${shareId}`,
      }));
    }

    // ── Authed routes ────────────────────────────────────────────────────────
    const userId = claims(event)?.userId;
    if (!userId) return json(401, { error: 'Unauthorized' });
    const runId = event.pathParameters?.runId ? decodeURIComponent(event.pathParameters.runId) : null;
    if (!runId) return json(400, { error: 'Missing runId' });

    // Revoke the public link. Snapshot shares carry no run, so the client sends
    // the shareId directly; run-backed shares are found via the run row.
    if (path.endsWith('/share/revoke')) {
      const sid = safeJson(event.body).shareId;
      if (sid) { await revokeShare(sid, userId).catch(() => {}); return json(200, { ok: true }); }
      const run = await getRun(userId, runId);
      if (run?.shareId) { await revokeShare(run.shareId, userId).catch(() => {}); await setRunShareId(userId, runId, null); }
      return json(200, { ok: true });
    }

    // Mint the public link. Two shapes:
    //  • run-backed: idempotent per run (reuses the run's existing shareId)
    //  • snapshot: the client posts a self-contained stats summary (dashboard
    //    tools with no saved run) which we embed on a fresh share record.
    if (path.endsWith('/share')) {
      const body = safeJson(event.body);
      // Optional plain-English summary the client generated when the result was
      // viewed — persisted so the public report can lead with it.
      const tldr = clip(body.tldr, 4000);
      const snap = body.snapshot;
      if (snap) {
        const result = sanitizeSnapshotResult(snap.result);
        if (!result) return json(400, { error: 'Invalid snapshot' });
        const shareId = randomBytes(9).toString('base64url');
        await createShare({
          userId, shareId,
          snapshot: { tool: clip(snap.toolId, 64) || 'report', toolName: clip(snap.toolName, 80) || 'Report', result, target: clip(snap.target, 200), tldr },
        });
        return json(200, { shareId, url: `${baseUrl(event)}/s/${shareId}` });
      }
      const run = await getRun(userId, runId);
      if (!run) return json(404, { error: 'Run not found' });
      // Save the summary on the run (best-effort) so a re-share keeps it too.
      if (tldr && tldr !== run.tldr) await setRunTldr(userId, runId, tldr).catch(() => {});
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
