// ─────────────────────────────────────────────────────────────────────────
// Driver.js tour video recorder.
//
// Records a polished, nicely-paced video of each product tour against the
// local Vite dev server (http://localhost:5173). The saas app has no mock
// backend, so we stub the one call that gates the UI — GET /me — with a Pro
// demo user, and let every other (catch-guarded) API call fail harmlessly.
//
// Each tour is launched through its REAL UI trigger (the "?" help button for
// the platform tour, the "Tour" button for a tool tour), then driven by
// clicking driver.js's Next button with a dwell time scaled to how much text
// is on each step — so viewers get time to read without it dragging.
//
// Output: one .mp4 per tour in ./out (converted from Playwright's .webm via
// ffmpeg). Run with:  npm run record
// ─────────────────────────────────────────────────────────────────────────
import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, readdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
const TMP = path.join(HERE, '.tmp-video');

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const VIEWPORT = { width: 1440, height: 900 };

// Pro demo user — Pro tier so every recorded tool is unlocked. Onboarding flags
// are pre-satisfied so neither the consent gate nor the welcome overlay appears.
const DEMO_USER = {
  id: 'demo-user',
  email: 'demo@digimetrics.ai',
  name: 'Demo User',
  tier: 'pro',
  credits: 2000,
  isAdmin: false,
  pastDue: false,
  createdAt: '2025-01-01T00:00:00.000Z',
  onboarding: {
    acceptedTerms: true,
    acceptedTermsVersion: '2026-06-19', // must match shared/catalog.mjs TERMS_VERSION
    welcomed: true,
    seenPlatformTour: true,
  },
};

// Which tours to record: the platform tour + every tool that runs the generic
// tool tour. `social-audit` is excluded — it has a dedicated page (/social-audit)
// with no driver.js tour. Order matches the catalog grid. Add/remove freely.
const TOOL_IDS = [
  'keyword-analysis', 'rank-checker', 'time-to-rank', 'anchor-cleaner', 'technical-seo',
  'onpage', 'page-analysis', 'competitors', 'backlinks', 'schema',
  'caption', 'content-writer', 'content-check', 'pillars',
  'ai-discovery', 'ai-mentions', 'llms-txt', 'geo-onpage', 'forensic-audit',
  'persona', 'media-plan', 'landing-audit', 'sem-copy', 'perf-marketing',
  'strategy-engine',
  'gsc', 'ga4', 'google-ads', 'meta-ads', 'linkedin-ads',
];
const pad = (n) => String(n).padStart(2, '0');
const TOURS = [
  { kind: 'platform', name: '00-platform-tour' },
  ...TOOL_IDS.map((toolId, i) => ({ kind: 'tool', toolId, name: `${pad(i + 1)}-tool-${toolId}` })),
];

// ── pacing ───────────────────────────────────────────────────────────────────
// Dwell = base + per-character reading time, clamped. Text-heavy centred cards
// (intro / outro) naturally sit longer; short field steps move briskly.
const DWELL_MIN = 2200;
const DWELL_MAX = 5400;
const DWELL_BASE = 1100;
const DWELL_PER_CHAR = 26;
const STEP_SETTLE = 700;   // after each Next click: let the highlight move + scroll settle
const ENTER_SETTLE = 650;  // after the first popover appears, before we start reading

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dwellFor = (text) =>
  Math.min(DWELL_MAX, Math.max(DWELL_MIN, DWELL_BASE + (text?.length || 0) * DWELL_PER_CHAR));

async function isApiUrl(url) {
  return /execute-api|REPLACE\./.test(url);
}

// Stub the backend. Only /me matters; everything else returns an empty 200 so
// catch-guarded calls resolve quietly instead of hanging on a dead host.
async function installBackendStub(context) {
  await context.route(
    (url) => /execute-api|REPLACE\./.test(url.href),
    async (route) => {
      const u = new URL(route.request().url());
      const p = u.pathname;
      if (p.endsWith('/me') && route.request().method() === 'GET') {
        return route.fulfill({ json: { user: DEMO_USER } });
      }
      if (p.endsWith('/me/onboarding')) {
        return route.fulfill({ json: { onboarding: DEMO_USER.onboarding } });
      }
      return route.fulfill({ json: {} });
    }
  );
}

// Drive a running driver.js tour to completion, pacing each step by its text.
async function driveTour(page, label) {
  await page.waitForSelector('.driver-popover', { timeout: 15000 });
  await sleep(ENTER_SETTLE);

  for (let i = 0; i < 60; i++) {
    const popover = await page.$('.driver-popover');
    if (!popover) break;

    const text = await page
      .$eval('.driver-popover', (el) => el.innerText)
      .catch(() => '');
    await sleep(dwellFor(text));

    const next = await page.$('.driver-popover-next-btn');
    if (!next) break;
    await next.click();
    await sleep(STEP_SETTLE);
  }
  await sleep(900); // gentle tail so the final frame isn't cut abruptly
  console.log(`   ✓ drove ${label} through its steps`);
}

async function recordTour(browser, tour) {
  const videoDir = path.join(TMP, tour.name);
  await rm(videoDir, { recursive: true, force: true });
  await mkdir(videoDir, { recursive: true });

  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    recordVideo: { dir: videoDir, size: VIEWPORT },
  });
  await installBackendStub(context);
  // Logged-in (dm_access present → AuthContext fetches /me) + tours pre-marked
  // "seen" so nothing auto-starts; we launch each one deliberately below.
  await context.addInitScript(() => {
    localStorage.setItem('dm_access', 'demo-access-token');
    localStorage.setItem('dm_tour_seen_platform', '1');
    localStorage.setItem('dm_tour_seen_tool:any', '1');
  });

  const page = await context.newPage();
  const video = page.video();

  console.log(`▶ recording ${tour.name} …`);
  if (tour.kind === 'platform') {
    await page.goto(BASE_URL + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-tour="search"]', { timeout: 20000 });
    await sleep(1200); // let the dashboard grid finish painting
    await page.click('[data-tour="help"]'); // the "?" button → startPlatformTour()
  } else {
    await page.goto(BASE_URL + '/tool/' + tour.toolId, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-tour="tool-run"]', { timeout: 20000 });
    await sleep(1000);
    await page.getByRole('button', { name: 'Tour', exact: true }).click(); // launchTour()
  }

  await driveTour(page, tour.name);

  await context.close(); // finalises the .webm
  const webm = await video.path();
  return webm;
}

async function toMp4(webm, name) {
  const mp4 = path.join(OUT, `${name}.mp4`);
  await execFileP('ffmpeg', [
    '-y',
    '-i', webm,
    '-c:v', 'libx264',
    '-crf', '20',
    '-preset', 'slow',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    mp4,
  ]);
  return mp4;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });

  const made = [];
  try {
    for (const tour of TOURS) {
      try {
        const webm = await recordTour(browser, tour);
        const mp4 = await toMp4(webm, tour.name);
        made.push(mp4);
        console.log(`   → ${path.relative(process.cwd(), mp4)}`);
      } catch (err) {
        console.error(`   ✗ ${tour.name} failed: ${err.message}`);
      }
    }
  } finally {
    await browser.close();
    await rm(TMP, { recursive: true, force: true });
  }

  console.log(`\nDone. ${made.length}/${TOURS.length} tour videos in ${path.relative(process.cwd(), OUT)}/`);
  for (const m of made) console.log('  •', path.basename(m));
}

main().catch((e) => { console.error(e); process.exit(1); });
