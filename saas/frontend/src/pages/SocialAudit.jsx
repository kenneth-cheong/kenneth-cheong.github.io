import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { toolById, tierMeets, CREDIT_COSTS } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import { useProjects } from '../context/ProjectContext.jsx';
import { api, ApiError } from '../lib/api.js';
import ShareResult from '../components/ShareResult.jsx';
import ReportHtml from '../components/ReportHtml.jsx';
import { toast } from '../lib/ui.js';
import { Loader2, Wand2, Plus, X, Microscope, ScanSearch, Compass, AlertTriangle, Pencil, Check } from 'lucide-react';
import { renderSMAScorecard, renderSocialAudit, installSmaGlobals } from '../lib/smaRender.js';
import { extractFiles } from '../lib/extractFiles.js';
import { startSocialAuditTour, hasSeen, markSeen } from '../lib/tours.js';
// Bundled (not CDN) so the strict production CSP serves them from 'self'. FA's
// webfonts are emitted as hashed same-origin assets; scoping the import to this
// page keeps the icon font out of every other route's bundle.
import '@fortawesome/fontawesome-free/css/all.min.css';

const TOOL = toolById('social-audit');

const SHARE_TOOL = { id: 'social-audit', name: 'Social Media Audit' };
const SHARE_BTN = 'btn-ghost inline-flex items-center gap-1 text-sm';
const fmtCompact = (n) => {
  const a = Math.abs(n);
  if (a >= 1e6) return `${Math.round(n / 1e5) / 10}M`;
  if (a >= 1e3) return `${Math.round(n / 100) / 10}K`;
  return String(Math.round(n));
};
// Distil a finished audit job (its live scorecard + strategy) into a branded
// share card. Total following is the hero; no % values, so it stays a big
// number rather than a near-empty gauge ring.
function socialShareOut(job) {
  const plats = Array.isArray(job?.scorecard?.platforms) ? job.scorecard.platforms.filter((p) => p && p.found !== false) : [];
  if (!plats.length) return null;
  const followers = plats.reduce((s, p) => s + (Number(p.followers) || 0), 0);
  const growth = plats.reduce((s, p) => s + (Number(p.followers_growth_30d) || 0), 0);
  const comps = Array.isArray(job?.sca?.competitors) ? job.sca.competitors.length : 0;
  const items = [];
  if (followers) items.push({ label: 'Total following', value: fmtCompact(followers), tone: 'green' });
  items.push({ label: 'Platforms audited', value: String(plats.length) });
  if (growth) items.push({ label: 'New followers · 30d', value: `${growth >= 0 ? '+' : ''}${fmtCompact(growth)}`, tone: growth >= 0 ? 'green' : 'red' });
  if (comps) items.push({ label: 'Competitors analyzed', value: String(comps) });
  return { result: { sections: [{ type: 'stats', items }] } };
}

const SMA_PLATFORMS = [
  { key: 'instagram', label: 'Instagram', ph: '@handle' },
  { key: 'tiktok', label: 'TikTok', ph: '@handle' },
  { key: 'facebook', label: 'Facebook', ph: 'page name or URL' },
  { key: 'linkedin', label: 'LinkedIn', ph: 'company slug or URL' },
  { key: 'youtube', label: 'YouTube', ph: '@channel or URL' },
];
const COMP_PLATFORMS = ['instagram', 'tiktok', 'facebook', 'linkedin', 'youtube'];

// Pro-mode fields keyed by the exact payload key the strategy lambda expects.
const PRO_FIELDS = [
  { id: 'social_analytics', label: 'Social analytics exports', ph: 'Native platform analytics — reach, followers, growth, top posts…' },
  { id: 'meta_business_suite', label: 'Meta Business Suite data', ph: 'FB/IG reach, engagement, audience, best-performing content…' },
  { id: 'engagement_data', label: 'Engagement data', ph: 'Engagement rates by format/platform, saves, shares, comments…' },
  { id: 'content_calendar_samples', label: 'Content calendar samples', ph: 'Recent posts/topics/formats actually published…' },
  { id: 'creative_samples', label: 'Creative samples', ph: 'Describe or link current creatives — copy, visuals, video styles…' },
  { id: 'blog_performance', label: 'Blog performance', ph: 'Posting frequency, traffic, top blog topics…' },
  { id: 'ga4_content', label: 'GA4 content data', ph: 'Top landing pages, social referral traffic, content conversions…' },
];

// ── Guided-tour worked example (asana.com) ───────────────────────────────────
// A real, coherent run used by the tour: the form values it pre-fills, plus the
// two result payloads fed straight through the page's own renderers (Phase 1
// live scorecard + Phase 2 strategy audit), so the walkthrough annotates a
// genuine-looking result rather than a static mock. Grounded in the same
// asana.com worked example the rest of the product tours use.
const TOUR_EXAMPLE = {
  brand: 'Asana',
  domain: 'https://asana.com',
  industry: 'Work management software (B2B SaaS)',
  goals: 'Grow awareness with team leads; drive free-trial signups',
  audience: 'Operations & marketing leads at 50–500-person companies; productivity-minded, mostly US/UK, B2B.',
  plat: {
    instagram: { checked: true, handle: '@asana', source: 'website' },
    tiktok: { checked: true, handle: '@asana', source: 'search' },
    facebook: { checked: true, handle: 'Asana', source: 'website' },
    linkedin: { checked: true, handle: 'asana', source: 'website' },
    youtube: { checked: true, handle: '@asana', source: 'search' },
  },
  competitors: [
    { platform: 'instagram', handle: 'mondaydotcom', name: 'monday.com', source: 'search' },
    { platform: 'instagram', handle: 'clickup', name: 'ClickUp', source: 'search' },
    { platform: 'instagram', handle: 'trello', name: 'Trello', source: 'search' },
  ],
  calendars: 'Roughly 4 posts/wk on IG & LinkedIn, mostly product tips and customer stories. Light on video.',
  rfq: 'Wants to grow short-form video and benchmark against monday.com & ClickUp before committing budget.',
};

const TOUR_SCORECARD = {
  overall_score: 78,
  overall_health: 'Strong',
  executive_summary: 'Asana keeps a polished, consistent presence across five platforms with strong LinkedIn and Instagram engagement. Cadence is healthy, but short-form video is under-used versus ClickUp and monday.com, and Facebook engagement has gone flat.',
  platforms: [
    { platform: 'instagram', handle: '@asana', found: true, followers: 142000, followers_growth_30d: 1800, engagement_rate: 1.9, posts_per_week: 4, days_since_last_post: 1, avg_likes: 540, avg_video_views: 8200, content_mix: { video: 3, image: 8, carousel: 5 }, profile_completeness: { score: 95 }, top_hashtags: ['#workmanagement', '#productivity', '#teamwork', '#asana', '#futureofwork'], posts: [
      { type: 'carousel', text: '5 ways to run a calmer sprint planning 🧘', likes: 610, comments: 18 },
      { type: 'video', text: 'AI status updates in 30 seconds ⚡', likes: 880, comments: 31, views: 12400 },
      { type: 'image', text: 'Your Monday, but organised.', likes: 430, comments: 9 },
    ] },
    { platform: 'tiktok', handle: '@asana', found: true, followers: 18600, followers_growth_30d: 420, engagement_rate: 3.4, posts_per_week: 1, days_since_last_post: 9, avg_likes: 760, avg_video_views: 21000, content_mix: { video: 12, image: 0, carousel: 0 }, profile_completeness: { score: 80 }, top_hashtags: ['#worktok', '#productivity', '#corporatelife'], posts: [
      { type: 'video', text: 'POV: your to-do list finally makes sense', likes: 1900, comments: 64, views: 48000 },
    ] },
    { platform: 'facebook', handle: 'Asana', found: true, followers: 312000, followers_growth_30d: -200, engagement_rate: 0.4, posts_per_week: 3, days_since_last_post: 2, avg_likes: 90, content_mix: { video: 2, image: 6, carousel: 2 }, profile_completeness: { score: 90 }, top_hashtags: [] },
    { platform: 'linkedin', handle: 'asana', found: true, followers: 486000, followers_growth_30d: 5400, engagement_rate: 2.6, posts_per_week: 5, days_since_last_post: 1, avg_likes: 720, content_mix: { video: 4, image: 7, carousel: 6 }, profile_completeness: { score: 100 }, top_hashtags: ['#leadership', '#worktrends', '#productivity'] },
    { platform: 'youtube', handle: '@asana', found: true, followers: 54000, followers_growth_30d: 300, engagement_rate: 1.1, posts_per_week: 1, days_since_last_post: 6, avg_video_views: 9400, content_mix: { video: 8, image: 0, carousel: 0 }, profile_completeness: { score: 85 }, top_hashtags: [] },
  ],
  creative: {
    brand_consistency: { score: 88, notes: 'Strong, recognisable system — consistent coral/purple palette and rounded type across nearly every post.' },
    tone_of_voice: 'Friendly, calm and expert — practical productivity advice without jargon.',
    visual_style: 'Clean, lots of whitespace, brand-coral accents and simple iconography. Mixes product UI shots with illustrated tips.',
    colour_palette: { dominant: ['Coral', 'Deep purple', 'Off-white'], coherence: 'Consistent', notes: 'Coral CTA accent used consistently; backgrounds stay light and uncluttered.' },
    design_quality: { score: 84, layout: 'Generous whitespace and clear hierarchy; carousels follow a consistent cover → tips → CTA structure.', template_use: 'Templated carousels', typography: 'Single rounded sans, two weights — readable on mobile.' },
    content_themes: ['Productivity tips', 'Product features', 'Remote / async work', 'Customer stories'],
    content_pillars: ['Work smarter', 'Inside Asana', 'Future of work'],
    standout_observations: ['Carousels consistently outperform single images', 'AI-feature posts get ~1.6× the average engagement'],
    recommendations: ['Lean into short-form video — highest-engagement format but lowest volume', 'Repurpose top LinkedIn carousels to Instagram', 'Add captions/subtitles to every TikTok and Reel'],
    posts_analyzed: 42, images_analyzed: 30,
  },
  indicators: [
    { label: 'Posting consistency', value: 'Healthy (4–5 / wk)', status: 'good', source: 'Live profiles' },
    { label: 'Video share of mix', value: 'Low (~18%)', status: 'warn', source: 'Live profiles' },
    { label: 'TikTok cadence', value: '1 / wk', status: 'warn', source: 'TikTok' },
    { label: 'Facebook engagement', value: '0.4%', status: 'bad', source: 'Facebook' },
    { label: 'Profile completeness', value: '90% avg', status: 'good', source: 'Live profiles' },
  ],
  competitors: [
    { name: 'monday.com', handle: 'mondaydotcom', platform: 'instagram', followers: 165000, engagement_rate: 1.2, posts_per_week: 6, days_since_last_post: 1, avg_likes: 410, top_hashtags: ['#monday', '#workos', '#productivity'], content_mix: { video: 6, image: 5, carousel: 4 }, top_posts: [{ type: 'video', text: 'Automations that run your week for you', likes: 980, comments: 22, views: 33000 }] },
    { name: 'ClickUp', handle: 'clickup', platform: 'instagram', followers: 138000, engagement_rate: 1.6, posts_per_week: 7, days_since_last_post: 0, avg_likes: 520, top_hashtags: ['#clickup', '#productivity'], content_mix: { video: 9, image: 3, carousel: 3 }, top_posts: [{ type: 'video', text: 'One app to replace them all 👀', likes: 1500, comments: 48, views: 61000 }] },
    { name: 'Trello', handle: 'trello', platform: 'instagram', followers: 121000, engagement_rate: 0.9, posts_per_week: 3, days_since_last_post: 4, avg_likes: 300, content_mix: { video: 2, image: 6, carousel: 2 } },
  ],
  competitor_insights: {
    doing_better: ['ClickUp posts 7×/wk and leans heavily on short-form video', 'monday.com’s automation demos rack up high saves & shares'],
    content_gaps: ['Short-form “how-to” video', 'Behind-the-scenes / team culture', 'User-generated content & testimonials'],
    tactics_to_copy: ['ClickUp’s punchy sub-15s feature demos', 'monday.com’s bold, colour-blocked thumbnails'],
  },
  brand_health: { branded_search_volume: 201000, web_mentions: 48000, gbp_rating: 4.6, gbp_reviews: 1240 },
  strengths: ['Top-tier LinkedIn presence (486k, 2.6% ER)', 'Highly consistent brand system', 'Strong carousel performance'],
  gaps: ['Under-investing in short-form video', 'Facebook engagement near zero', 'TikTok cadence too low to compound'],
  action_plan: [
    { action: 'Triple short-form video output (Reels + TikTok)', priority: 'high', expected_impact: 'Highest-engagement format; closes the gap with ClickUp' },
    { action: 'Repurpose top LinkedIn carousels to Instagram weekly', priority: 'medium', expected_impact: 'More reach from proven content at low effort' },
    { action: 'Rethink or downscale Facebook', priority: 'low', expected_impact: 'Reallocate effort to higher-ROI platforms' },
  ],
};

const TOUR_SCA = {
  overall_health: 'Strong',
  executive_summary: 'Asana has a mature, well-branded social presence that over-indexes on static and long-form content. The biggest growth lever is short-form video, where competitors are pulling ahead. Tightening platform focus and a clear pillar structure will compound the existing strengths.',
  current_state: {
    summary: 'Active and consistent across five platforms, strongest on LinkedIn and Instagram. Video is under-represented relative to the category.',
    active_platforms: ['Instagram', 'TikTok', 'Facebook', 'LinkedIn', 'YouTube'],
    strengths: ['Consistent brand system', 'Strong LinkedIn thought leadership', 'Reliable posting cadence'],
    gaps: ['Low short-form video output', 'Weak Facebook engagement', 'TikTok under-utilised'],
  },
  competitor_comparison: [
    { competitor: 'ClickUp', doing_better: 'High-volume short-form video (7×/wk)', opportunity: 'Match video cadence with repurposed product clips' },
    { competitor: 'monday.com', doing_better: 'Shareable automation demos & bold thumbnails', opportunity: 'Launch a recurring “workflow of the week” demo series' },
    { competitor: 'Trello', doing_better: 'Lightweight, playful tone', opportunity: 'Add more personality to product posts' },
  ],
  missing_content_types: ['Short-form how-to video', 'Behind-the-scenes / culture', 'User-generated content', 'Founder / expert POV'],
  recommended_platforms: [
    { platform: 'Instagram + TikTok', why: 'Highest engagement upside; where the category’s attention is shifting' },
    { platform: 'LinkedIn', why: 'Your strongest channel for reaching decision-makers — keep investing' },
  ],
  content_pillars: [
    { pillar: 'Work smarter', rationale: 'Practical productivity tips that earn saves & shares', formats: ['Carousels', 'Short video', 'Infographics'] },
    { pillar: 'Inside Asana', rationale: 'Product features & customer stories that build trust', formats: ['Demos', 'Case-study Reels'] },
    { pillar: 'Future of work', rationale: 'Thought leadership that positions Asana as a category expert', formats: ['LinkedIn posts', 'Talking-head video'] },
  ],
  posting_cadence: 'Instagram 4–5×/wk (≥2 video), TikTok 3–4×/wk, LinkedIn 5×/wk, Facebook 2×/wk (repurposed). Aim for ~40% video within 90 days.',
  action_plan: [
    { action: 'Stand up a short-form video engine (2–3 clips/wk)', priority: 'high', owner: 'Social lead', expected_impact: 'Closes the video gap; lifts IG/TikTok reach' },
    { action: 'Define the 3-pillar calendar and batch a month ahead', priority: 'medium', owner: 'Content team', expected_impact: 'Consistency + a clearer brand narrative' },
    { action: 'Audit Facebook; cut or repurpose', priority: 'low', owner: 'Social lead', expected_impact: 'Reallocate time to higher-ROI channels' },
  ],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Default to DeepSeek unless the user has explicitly chosen Claude (mirrors the
// agency app's model switch, persisted under the same localStorage key).
const getLlmProvider = () => (localStorage.getItem('chatLlmProvider') === 'anthropic' ? 'anthropic' : 'deepseek');

// Browser-side text extraction for the optional context uploads — PDF via
// pdf.js, DOCX via mammoth, everything else read as text. Shared with the
// Content Optimiser's draft upload; see lib/extractFiles.js.

// Source badge shown next to an auto-discovered handle / competitor.
function SourceBadge({ source }) {
  if (!source) return null;
  const site = source === 'website';
  return (
    <span className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold"
      style={{ background: site ? '#dcfce7' : '#fef9c3', color: site ? '#166534' : '#854d0e' }}>
      {site ? 'from site' : 'from search'}
    </span>
  );
}

// Small inline status line (info / success / error tones) used under each
// auto-find button.
function Status({ s }) {
  if (!s?.text) return null;
  const tones = {
    info: 'bg-blue-50 dark:bg-blue-500/10 text-blue-800 dark:text-blue-300',
    ok: 'bg-amber-50 dark:bg-amber-500/10 text-amber-800 dark:text-amber-300',
    note: 'bg-sunken text-dim',
    err: 'bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-300',
  };
  return <div className={`mt-2 rounded-lg px-3 py-2 text-xs ${tones[s.tone] || tones.info}`}>{s.text}</div>;
}

export default function SocialAudit() {
  const { user, setCredits } = useAuth();
  const { active } = useProjects();
  const unlocked = TOOL && tierMeets(user.tier, TOOL.minTier);
  const cost = CREDIT_COSTS[TOOL?.cost] ?? 0;

  // ── Brand & campaign ──────────────────────────────────────────────────────
  const [brand, setBrand] = useState('');
  const [domain, setDomain] = useState(active?.domain || '');
  const [industry, setIndustry] = useState('');
  const [goals, setGoals] = useState('');
  const [audience, setAudience] = useState('');

  // ── Profiles (per-platform checkbox + handle + source badge) ──────────────
  const [plat, setPlat] = useState(() =>
    Object.fromEntries(SMA_PLATFORMS.map((p) => [p.key, { checked: true, handle: '', source: '' }])));
  const setPlatField = (key, patch) => setPlat((s) => ({ ...s, [key]: { ...s[key], ...patch } }));

  // ── Competitors (up to 3) ─────────────────────────────────────────────────
  const [competitors, setCompetitors] = useState([]); // {platform, handle, name, source}

  // ── Social listening ──────────────────────────────────────────────────────
  const [listenEnabled, setListenEnabled] = useState(true);
  const [listenKeywords, setListenKeywords] = useState('');
  const [listenSources, setListenSources] = useState(
    () => ({ web: true, reddit: true, twitter: true, forums: true }));

  // ── Optional context + uploads ────────────────────────────────────────────
  const [calendars, setCalendars] = useState('');
  const [rfq, setRfq] = useState('');
  const [smaFiles, setSmaFiles] = useState([]);

  // ── Mode + pro fields ─────────────────────────────────────────────────────
  const [mode, setMode] = useState('starter');
  const [proText, setProText] = useState(() => Object.fromEntries(PRO_FIELDS.map((f) => [f.id, ''])));
  const [proFiles, setProFiles] = useState(() => Object.fromEntries(PRO_FIELDS.map((f) => [f.id, []])));

  // ── Statuses / busy / results ─────────────────────────────────────────────
  const [suggestStatus, setSuggestStatus] = useState(null);
  const [discoverStatus, setDiscoverStatus] = useState(null);
  const [compStatus, setCompStatus] = useState(null);
  const [findingDetails, setFindingDetails] = useState(false);
  const [findingProfiles, setFindingProfiles] = useState(false);
  const [findingComps, setFindingComps] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadingText, setLoadingText] = useState('');
  const [error, setError] = useState('');
  const [scaError, setScaError] = useState('');
  const [nudge, setNudge] = useState(false); // highlight the empty brand field after an incomplete run attempt
  const [scorecardHtml, setScorecardHtml] = useState(null);
  const [scaHtml, setScaHtml] = useState(null);
  const [doneJob, setDoneJob] = useState(null); // finished audit → branded share card
  const [editingOut, setEditingOut] = useState(false); // inline-edit the rendered report before sharing/exporting
  const resultsRef = useRef(null);

  // Install the globals the scorecard markup wires via inline onclick.
  useEffect(() => { installSmaGlobals(); }, []);
  // Prefill the website from the active project once it loads.
  useEffect(() => { if (!domain && active?.domain) setDomain(active.domain); /* eslint-disable-next-line */ }, [active]);

  // Guided tour: pre-fill a real asana.com worked example + render both result
  // scorecards on the page, then walk the form field-by-field; clear it all on
  // exit (Done, ✕, Esc or click-away) so the form is the user's to fill in.
  function launchTour() {
    startSocialAuditTour(TOOL, {
      preview: () => {
        setBrand(TOUR_EXAMPLE.brand);
        setDomain(TOUR_EXAMPLE.domain);
        setIndustry(TOUR_EXAMPLE.industry);
        setGoals(TOUR_EXAMPLE.goals);
        setAudience(TOUR_EXAMPLE.audience);
        setPlat(() => Object.fromEntries(SMA_PLATFORMS.map((p) => [p.key, { ...(TOUR_EXAMPLE.plat[p.key] || { checked: false, handle: '', source: '' }) }])));
        setCompetitors(TOUR_EXAMPLE.competitors.map((c) => ({ ...c })));
        setCalendars(TOUR_EXAMPLE.calendars);
        setRfq(TOUR_EXAMPLE.rfq);
        setMode('starter');
        setSuggestStatus({ tone: 'ok', text: 'AI filled the campaign context. Review and edit if anything looks off, then Run Audit.' });
        setDiscoverStatus({ tone: 'ok', text: 'Found 5 profile(s). Confirm each is the correct account, then Run Audit.' });
        setCompStatus({ tone: 'ok', text: 'Found 3 competitor(s). Confirm each is correct before auditing.' });
        installSmaGlobals();
        setScorecardHtml(renderSMAScorecard(TOUR_SCORECARD));
        setScaHtml(renderSocialAudit(TOUR_SCA));
        setDoneJob({ scorecard: TOUR_SCORECARD, sca: TOUR_SCA });
      },
      clear: () => {
        setBrand(''); setDomain(active?.domain || ''); setIndustry(''); setGoals(''); setAudience('');
        setPlat(Object.fromEntries(SMA_PLATFORMS.map((p) => [p.key, { checked: true, handle: '', source: '' }])));
        setCompetitors([]);
        setCalendars(''); setRfq(''); setSmaFiles([]);
        setMode('starter');
        setSuggestStatus(null); setDiscoverStatus(null); setCompStatus(null);
        setError(''); setScaError('');
        setScorecardHtml(null); setScaHtml(null); setDoneJob(null);
      },
    });
  }

  // First time a user opens this tool, auto-run its guided tour once.
  useEffect(() => {
    if (!unlocked || hasSeen('tool:social-audit')) return;
    const t = setTimeout(() => {
      if (hasSeen('tool:social-audit')) return;
      markSeen('tool:social-audit');
      launchTour();
    }, 700);
    return () => clearTimeout(t);
    /* eslint-disable-next-line */
  }, [unlocked]);

  const onCredits = (res) => { if (typeof res?.creditsRemaining === 'number') setCredits(res.creditsRemaining, res.topupRemaining); };
  const gateError = (e) => {
    if (e instanceof ApiError && e.status === 402) return 'Out of credits — top up to run the audit.';
    if (e instanceof ApiError && e.status === 403) return `This tool needs the ${TOOL.minTier} plan.`;
    return e?.message || 'Something went wrong.';
  };

  // ── AI: suggest campaign context (returns the raw result; also fills blanks) ─
  async function suggestContext(force) {
    const b = brand.trim(), dm = domain.trim();
    if (!b && !dm) { setError('Enter a brand name first, then Auto-find.'); return null; }
    const res = await api.socialAudit({ action: 'suggest_context', brand_name: b, domain: dm });
    onCredits(res);
    const d = res.result || {};
    if (d.error) throw new Error(d.error);
    if (d.website && (force || !domain.trim())) setDomain(d.website);
    if (d.industry && (force || !industry.trim())) setIndustry(d.industry);
    if (d.target_audience && (force || !audience.trim())) setAudience(d.target_audience);
    if (d.campaign_goals && (force || !goals.trim())) setGoals(d.campaign_goals);
    return d;
  }

  // ── AI: discover the brand's social profiles → pre-fill handles ───────────
  async function discoverProfiles() {
    const b = brand.trim(), dm = domain.trim();
    if (!b && !dm) { setError('Enter a brand name and/or website first, then Auto-find.'); return; }
    setError('');
    setFindingProfiles(true);
    setDiscoverStatus({ tone: 'info', text: 'Looking up profiles…' });
    try {
      const res = await api.socialAudit({ action: 'discover', brand_name: b, domain: dm });
      onCredits(res);
      const d = res.result || {};
      if (d.error) throw new Error(d.error);
      const found = d.handles || {};
      let n = 0;
      setPlat((s) => {
        const next = { ...s };
        for (const p of SMA_PLATFORMS) {
          const hit = found[p.key];
          if (hit && hit.handle) { next[p.key] = { checked: true, handle: hit.handle, source: hit.source === 'website' ? 'website' : 'search' }; n++; }
        }
        return next;
      });
      setDiscoverStatus(n
        ? { tone: 'ok', text: `Found ${n} profile(s). Confirm each is the correct account (edit or untick any that are wrong), then Run Audit.` }
        : { tone: 'err', text: "Couldn't find profiles automatically. Enter the handles manually." });
    } catch (e) {
      setDiscoverStatus({ tone: 'err', text: 'Auto-find failed: ' + gateError(e) });
    } finally { setFindingProfiles(false); }
  }

  // ── AI: discover competitors → fill up to 3 rows ──────────────────────────
  async function discoverCompetitors() {
    const b = brand.trim(), dm = domain.trim();
    if (!b && !dm) { setError('Enter a brand name and/or website first, then Auto-find competitors.'); return; }
    setError('');
    setFindingComps(true);
    setCompStatus({ tone: 'info', text: 'Searching for competitors…' });
    try {
      const res = await api.socialAudit({ action: 'discover_competitors', brand_name: b, domain: dm, industry: industry.trim(), target_audience: audience.trim() });
      onCredits(res);
      const d = res.result || {};
      if (d.error) throw new Error(d.error);
      const rows = [];
      for (const comp of (d.competitors || [])) {
        if (rows.length >= 3) break;
        const entry = Object.entries(comp.handles || {})[0];
        if (entry) {
          const [platform, hit] = entry;
          rows.push({ platform, handle: hit.handle || '', name: comp.name || '', source: hit.source || 'search' });
        }
      }
      setCompetitors(rows);
      setCompStatus(rows.length
        ? { tone: 'ok', text: `Found ${rows.length} competitor(s). Confirm each is correct before auditing — edit or remove any that are wrong.` }
        : { tone: 'err', text: "Couldn't find competitors automatically. Add them manually." });
    } catch (e) {
      setCompStatus({ tone: 'err', text: 'Auto-find failed: ' + gateError(e) });
    } finally { setFindingComps(false); }
  }

  // ── "Auto-find details" — suggest context + discover profiles & competitors ─
  async function autoFindDetails() {
    setError('');
    setFindingDetails(true);
    setSuggestStatus({ tone: 'info', text: 'Asking AI to fill in the campaign context…' });
    try {
      const d = await suggestContext(false);
      setSuggestStatus(d ? { tone: 'ok', text: 'AI filled the campaign context. Review and edit if anything looks off, then Run Audit.' } : null);
    } catch (e) {
      setSuggestStatus({ tone: 'err', text: 'Suggest failed: ' + gateError(e) });
    } finally { setFindingDetails(false); }
    await Promise.allSettled([discoverProfiles(), discoverCompetitors()]);
  }

  // ── Run: the audit now runs entirely server-side ──────────────────────────
  // `start` kicks off a background job (live scrape → strategy → save → notify)
  // that completes even if this tab is closed; we only poll for live progress.
  async function runAudit() {
    if (!brand.trim()) {
      setNudge(true);
      const el = document.getElementById('sma-brand-input');
      el?.focus(); el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    setError(''); setScaError('');
    setScorecardHtml(null); setScaHtml(null); setDoneJob(null);
    setBusy(true);
    setLoadingText('Starting…');
    try {
      // Only brand is required — fill any blank context with AI before running.
      const ctx = { industry: industry.trim(), audience: audience.trim(), goals: goals.trim(), website: domain.trim() };
      if (!ctx.industry || !ctx.audience || !ctx.goals) {
        setLoadingText('Filling in the campaign context with AI…');
        try {
          const d = await suggestContext(false);
          if (d) {
            ctx.website = ctx.website || d.website || '';
            ctx.industry = ctx.industry || d.industry || '';
            ctx.audience = ctx.audience || d.target_audience || '';
            ctx.goals = ctx.goals || d.campaign_goals || '';
          }
        } catch { /* strategy still runs without it */ }
      }

      // Gather selected platforms + handles.
      const handles = {}, platforms = [];
      for (const p of SMA_PLATFORMS) {
        const row = plat[p.key];
        if (row.checked && row.handle.trim()) { handles[p.key] = row.handle.trim(); platforms.push(p.key); }
      }
      const comps = competitors
        .filter((c) => c.platform && c.handle.trim())
        .map((c) => ({ platform: c.platform, handle: c.handle.trim().replace(/^@/, ''), name: (c.name.trim() || c.handle.trim()) }));

      // Read additional-context files (browser-side) — and pro analytics files.
      let extra_context = '';
      if (smaFiles.length) {
        setLoadingText(`Reading ${smaFiles.length} file(s)…`);
        try { extra_context = await extractFiles(smaFiles); } catch { /* non-fatal */ }
      }

      // The strategy payload the background finalizer will run (same fields as
      // before, minus the live_social_data it splices in once the scrape lands).
      const strategy = {
        mode, provider: getLlmProvider(),
        client_website: ctx.website, brand_name: brand.trim(),
        industry: ctx.industry, target_audience: ctx.audience, campaign_goals: ctx.goals,
        social_profiles: platforms.map((p) => `${p} ${handles[p]}`).join('\n'),
        competitors: comps.map((c) => `${c.platform} ${c.handle}`).join('\n'),
        content_calendars: calendars.trim(), rfq_notes: rfq.trim(),
        extra_context,
      };
      if (mode === 'pro') {
        setLoadingText('Reading uploaded pro analytics files…');
        for (const f of PRO_FIELDS) {
          const typed = (proText[f.id] || '').trim();
          const fromFiles = await extractFiles(proFiles[f.id] || [], 12000, 30000);
          strategy[f.id] = [typed, fromFiles].filter(Boolean).join('\n\n');
        }
      }
      const social_listening = listenEnabled
        ? {
            enabled: true,
            keywords: listenKeywords.split(',').map((s) => s.trim()).filter(Boolean),
            sources: Object.entries(listenSources).filter(([, v]) => v).map(([k]) => k),
          }
        : { enabled: false };
      const scrape = platforms.length
        ? { brand_name: brand.trim(), domain: ctx.website, handles, platforms, competitors: comps, extra_context, social_listening }
        : { platforms: [], social_listening };

      // Hand the whole job to the server and poll it for progress.
      setLoadingText('Starting the audit on our servers…');
      const startRes = await api.socialAudit({ action: 'start', scrape, strategy });
      const jobId = startRes.result?.jobId;
      if (!jobId) throw new Error(startRes.result?.text || 'Could not start the audit.');

      let scorecardShown = false, done = null;
      for (let tries = 0; tries < 80 && !done; tries++) {
        await sleep(tries === 0 ? 1500 : 6000);
        const st = await api.socialAudit({ action: 'status', jobId });
        const job = st.result || {};
        if (job.status === 'scraping' || job.status === 'finalizing') {
          const pr = job.progress || {};
          setLoadingText(pr.total ? `Phase 1 of 2 — ${pr.done}/${pr.total} sources ready…` : 'Phase 1 of 2 — collecting live social data…');
        } else if (job.status === 'analyzing') {
          if (job.scorecard && !scorecardShown) { installSmaGlobals(); setScorecardHtml(renderSMAScorecard(job.scorecard)); scorecardShown = true; }
          setLoadingText('Phase 2 of 2 — generating strategy analysis…');
        } else if (job.status === 'done') {
          if (job.scorecard) { installSmaGlobals(); setScorecardHtml(renderSMAScorecard(job.scorecard)); }
          onCredits(job);
          if (!job.sca) throw new Error('No strategy data returned.');
          setScaHtml(renderSocialAudit(job.sca));
          setDoneJob(job);
          setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
          done = job;
        } else if (job.status === 'error') {
          throw new Error(job.error || 'The audit failed.');
        } else if (job.status === 'unknown') {
          throw new Error('We lost track of the audit job. Please try running it again.');
        }
      }
      // Tab-side timeout only — the job keeps running server-side and will land
      // in History with a notification when it finishes.
      if (!done) {
        setScaError('Still working — this audit is taking longer than usual. You can safely leave this page; we’ll send a notification and add it to your History as soon as it’s ready.');
      }
    } catch (e) {
      setScaError('Strategy analysis failed: ' + gateError(e));
      // 402 = never started (no credits); anything else = the audit failed after
      // starting, which the backend doesn't bill. Reassure the user either way.
      if (e instanceof ApiError && e.status === 402) toast('Out of credits — top up to finish.', 'error');
      else toast('Audit didn’t complete — no credits were charged.', 'error');
    } finally {
      setBusy(false);
      setLoadingText('');
    }
  }

  if (!unlocked) {
    return (
      <div className="mx-auto max-w-2xl">
        <h1 className="text-2xl font-bold">Social Media Audit</h1>
        <div className="card mt-6 p-6 text-center">
          <p className="text-dim">{TOOL?.desc}</p>
          <Link to="/pricing" className="btn-primary mt-4 inline-block">Upgrade to run a Social Media Audit</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl pb-12">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold">Social Media Audit</h1>
        <button
          type="button"
          onClick={launchTour}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-xs font-semibold text-dim hover:border-brand-300 dark:hover:border-brand-500/40 hover:text-brand-600 dark:hover:text-brand-400"
          title="Guided walkthrough with a real example"
        >
          <Compass size={14} aria-hidden /> Tour
        </button>
      </div>
      <p className="mt-1 text-dim">
        Pulls live profile &amp; engagement data from Instagram, TikTok, Facebook, LinkedIn &amp; YouTube,
        then generates a strategic content-gap &amp; competitor audit in one pass. Auto-find the brand's
        profiles, fill in the campaign context, and hit Run Audit.
      </p>

      {/* Brand & campaign */}
      <div className="card mt-6 p-5" data-tour="sma-brand">
        <h2 className="text-sm font-bold uppercase tracking-wide text-body">Brand &amp; campaign</h2>
        <p className="mt-1 text-xs text-faint">Only the brand name is required — leave the rest blank and AI will fill them in (you can edit before auditing).</p>
        <div className="mt-3 space-y-3">
          <div>
            <label htmlFor="sma-brand-input" className="block text-sm font-medium text-body">Brand name <span className="text-amber-500">*</span></label>
            <input id="sma-brand-input" className={`field mt-1${nudge ? ' !border-amber-400 !ring-4 !ring-amber-400/20' : ''}`} value={brand} onChange={(e) => { setNudge(false); setBrand(e.target.value); }} placeholder="e.g. MediaOne" disabled={busy} />
            {nudge && <p className="mt-1 text-xs font-semibold text-amber-600 dark:text-amber-400">Enter a brand name to run the audit.</p>}
          </div>
          <button type="button" onClick={autoFindDetails} disabled={busy || findingDetails}
            data-tour="sma-autofind" className="btn-ghost text-xs text-brand-700 dark:text-brand-300">
            {findingDetails ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />} Auto-find details
          </button>
          <Status s={suggestStatus} />
          <div>
            <label className="block text-sm font-medium text-body">Website</label>
            <input className="field mt-1" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="https://brand.com" disabled={busy} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-body">Industry</label>
              <input className="field mt-1" value={industry} onChange={(e) => setIndustry(e.target.value)} placeholder="e.g. Dental clinic, B2B SaaS" disabled={busy} />
            </div>
            <div>
              <label className="block text-sm font-medium text-body">Campaign goals</label>
              <input className="field mt-1" value={goals} onChange={(e) => setGoals(e.target.value)} placeholder="e.g. Build awareness, generate leads" disabled={busy} />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-body">Target audience</label>
            <textarea className="field mt-1" rows={2} value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="Describe the customers: age, location, intent, B2B/B2C…" disabled={busy} />
          </div>
        </div>
      </div>

      {/* Profiles */}
      <div className="card mt-4 p-5" data-tour="sma-profiles">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-bold uppercase tracking-wide text-body">Profiles to audit</h2>
          <button type="button" onClick={discoverProfiles} disabled={busy || findingProfiles} className="btn-ghost text-xs text-brand-700 dark:text-brand-300">
            {findingProfiles ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />} Auto-find profiles
          </button>
        </div>
        <Status s={discoverStatus} />
        <div className="mt-3 space-y-2.5">
          {SMA_PLATFORMS.map((p) => (
            <div key={p.key} className="flex items-center gap-3">
              <input type="checkbox" className="h-4 w-4 shrink-0" checked={plat[p.key].checked}
                onChange={(e) => setPlatField(p.key, { checked: e.target.checked })} disabled={busy} />
              <span className="w-24 shrink-0 text-sm font-semibold text-dim">{p.label}</span>
              <input className="field" value={plat[p.key].handle} placeholder={p.ph}
                onChange={(e) => setPlatField(p.key, { handle: e.target.value })} disabled={busy} />
              <SourceBadge source={plat[p.key].source} />
            </div>
          ))}
        </div>
      </div>

      {/* Competitors */}
      <div className="card mt-4 p-5" data-tour="sma-competitors">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-bold uppercase tracking-wide text-body">Competitors <span className="font-normal normal-case text-faint">(optional, up to 3)</span></h2>
          <button type="button" onClick={discoverCompetitors} disabled={busy || findingComps} className="btn-ghost text-xs text-brand-700 dark:text-brand-300">
            {findingComps ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />} Auto-find competitors
          </button>
        </div>
        <Status s={compStatus} />
        <div className="mt-3 space-y-2">
          {competitors.map((c, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <select className="field w-32 cursor-pointer" value={c.platform} disabled={busy}
                onChange={(e) => setCompetitors((s) => s.map((x, j) => (j === i ? { ...x, platform: e.target.value } : x)))}>
                {COMP_PLATFORMS.map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}
              </select>
              <input className="field flex-1" style={{ minWidth: 120 }} value={c.handle} placeholder="handle or URL" disabled={busy}
                onChange={(e) => setCompetitors((s) => s.map((x, j) => (j === i ? { ...x, handle: e.target.value } : x)))} />
              <input className="field w-32" value={c.name} placeholder="Name (optional)" disabled={busy}
                onChange={(e) => setCompetitors((s) => s.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <SourceBadge source={c.source} />
              <button type="button" className="text-faint hover:text-red-500" disabled={busy}
                onClick={() => setCompetitors((s) => s.filter((_, j) => j !== i))} aria-label="Remove competitor"><X size={16} /></button>
            </div>
          ))}
        </div>
        {competitors.length < 3 && (
          <button type="button" className="btn-ghost mt-2 text-xs" disabled={busy}
            onClick={() => setCompetitors((s) => [...s, { platform: 'instagram', handle: '', name: '', source: '' }])}>
            <Plus size={13} /> Add manually
          </button>
        )}
      </div>

      {/* Social listening */}
      <div className="card mt-4 p-5" data-tour="sma-listening">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-bold uppercase tracking-wide text-body">Social listening</h2>
          <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-semibold text-body">
            <input type="checkbox" checked={listenEnabled} disabled={busy}
              onChange={(e) => setListenEnabled(e.target.checked)} /> Include in audit
          </label>
        </div>
        <p className="mt-1 text-xs text-faint">
          Scans the open web, blogs, forums &amp; news for brand mentions and reads overall sentiment,
          then adds Google site-search results from Reddit, X and SG forums.
        </p>
        {listenEnabled && (
          <div className="mt-3">
            <label className="block text-sm font-medium text-body">Extra terms to track <span className="font-normal text-faint">(optional, comma-separated)</span></label>
            <input className="field mt-1" value={listenKeywords} disabled={busy}
              onChange={(e) => setListenKeywords(e.target.value)}
              placeholder="e.g. product names, campaign hashtags, founder name" />
            <div className="mt-3 flex flex-wrap gap-4 text-sm text-body">
              {[['web', 'Web, blogs, forums & news'], ['reddit', 'Reddit'], ['twitter', 'Twitter / X'], ['forums', 'HardwareZone & SG forums']].map(([k, label]) => (
                <label key={k} className="inline-flex cursor-pointer items-center gap-2">
                  <input type="checkbox" checked={!!listenSources[k]} disabled={busy}
                    onChange={(e) => setListenSources((s) => ({ ...s, [k]: e.target.checked }))} /> {label}
                </label>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Optional context */}
      <div className="card mt-4 p-5" data-tour="sma-context">
        <h2 className="text-sm font-bold uppercase tracking-wide text-body">Optional context</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <label className="block text-sm font-medium text-body">Existing content calendar</label>
            <textarea className="field mt-1" rows={3} value={calendars} onChange={(e) => setCalendars(e.target.value)} placeholder="Paste or describe the current content plan/cadence, if any" disabled={busy} />
          </div>
          <div>
            <label className="block text-sm font-medium text-body">RFQ / discussion notes</label>
            <textarea className="field mt-1" rows={3} value={rfq} onChange={(e) => setRfq(e.target.value)} placeholder="Pain points, priorities, constraints the prospect mentioned…" disabled={busy} />
          </div>
        </div>
        <div className="mt-3">
          <label className="block text-sm font-medium text-body">Additional context <span className="font-normal text-faint">(optional — briefs, brand guidelines)</span></label>
          <FileField files={smaFiles} setFiles={setSmaFiles} disabled={busy} accept=".pdf,.docx,.txt,.csv,.md"
            hint="PDF, DOCX, TXT, CSV or MD. Text is extracted in your browser and fed to the audit's analysis." />
        </div>
      </div>

      {/* Mode toggle */}
      <div className="card mt-4 p-5" data-tour="sma-mode">
        <div className="inline-flex overflow-hidden rounded-lg border border-brand-200 dark:border-brand-500/30">
          {['starter', 'pro'].map((m) => (
            <button key={m} type="button" onClick={() => setMode(m)} disabled={busy}
              className={`px-4 py-2 text-sm font-bold ${mode === m ? 'bg-brand-600 text-white' : 'bg-surface text-brand-700 dark:text-brand-300'}`}>
              {m === 'starter' ? 'Starter' : 'Pro'}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted">
          {mode === 'pro'
            ? 'Deeper audit using your exported analytics — adds content pillars, campaign angles, organic/paid integration, social SEO, blog-to-social repurposing and creative improvements.'
            : "Competitor & content-gap audit from first-call inputs — what the client does, what competitors do better, and what's missing."}
        </p>

        {mode === 'pro' && (
          <div className="mt-4 space-y-3 border-t border-hair pt-4">
            <p className="text-xs font-semibold text-muted">Analytics &amp; content data — paste what you have or upload files; leave the rest blank.</p>
            {PRO_FIELDS.map((f) => (
              <div key={f.id}>
                <label className="block text-sm font-medium text-body">{f.label}</label>
                <textarea className="field mt-1" rows={2} value={proText[f.id]} disabled={busy}
                  onChange={(e) => setProText((s) => ({ ...s, [f.id]: e.target.value }))} placeholder={f.ph} />
                <FileField files={proFiles[f.id]} setFiles={(updater) => setProFiles((s) => ({ ...s, [f.id]: typeof updater === 'function' ? updater(s[f.id]) : updater }))}
                  disabled={busy} accept=".pdf,.docx,.txt,.csv,.md,.xlsx" compact hint="Upload exports — PDF, DOCX, TXT, CSV or XLSX" />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Run */}
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button onClick={runAudit} disabled={busy} aria-disabled={busy || !brand.trim()} data-tour="sma-run" className={`btn-primary ${brand.trim() ? '' : 'opacity-60'}`}>
          {busy ? <Loader2 size={16} className="animate-spin" /> : (mode === 'pro' ? <Microscope size={16} /> : <ScanSearch size={16} />)}
          {busy ? 'Running…' : `Run Audit${mode === 'pro' ? ' (Pro)' : ''} · ${cost} cr`}
        </button>
        {!busy && !brand.trim() && (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
            <AlertTriangle size={13} aria-hidden /> Brand name is required
          </span>
        )}
        {busy && loadingText && <span className="text-sm text-muted"><Loader2 size={13} className="mr-1 inline animate-spin" />{loadingText}</span>}
      </div>
      {busy && (
        <p className="mt-3 text-sm text-dim">
          This keeps running on our servers even if you close the tab — you’ll get a notification and it lands in History. Stay on this page and the result appears below.
        </p>
      )}
      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {scaError && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{scaError}</p>}

      {/* Results — bespoke HTML scorecards (Font Awesome styled, ported 1:1). */}
      <div ref={resultsRef} data-tour="sma-results" className="mt-6 space-y-4">
        {doneJob && (
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setEditingOut((v) => !v)} className={SHARE_BTN}>
              {editingOut ? <><Check size={14} /> Done editing</> : <><Pencil size={14} /> Edit result</>}
            </button>
            <ShareResult tool={SHARE_TOOL} out={socialShareOut(doneJob)} project={active} user={user} force snapshot label="Share result" className={SHARE_BTN} />
          </div>
        )}
        <div
          contentEditable={editingOut}
          suppressContentEditableWarning
          className={editingOut ? 'rounded-lg outline outline-2 outline-brand-400 outline-offset-4' : ''}
        >
          {scorecardHtml && <ReportHtml html={scorecardHtml} className="" />}
          {scaHtml && <ReportHtml html={scaHtml} className="" />}
        </div>
      </div>
    </div>
  );
}

// File picker + removable chips. `setFiles` accepts a value or an updater fn.
function FileField({ files, setFiles, disabled, accept, hint, compact }) {
  const onPick = (e) => {
    const picked = Array.from(e.target.files || []);
    if (!picked.length) return;
    setFiles((prev) => {
      const existing = new Set((prev || []).map((f) => f.name));
      return [...(prev || []), ...picked.filter((f) => !existing.has(f.name))];
    });
    e.target.value = '';
  };
  return (
    <div className={compact ? 'mt-1.5' : 'mt-2'}>
      <input type="file" multiple accept={accept} onChange={onPick} disabled={disabled}
        className="block w-full text-xs text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-brand-50 dark:file:bg-brand-500/10 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-brand-700 dark:file:text-brand-300 hover:file:bg-brand-100 dark:hover:file:bg-brand-500/15" />
      {hint && <p className="mt-1 text-[11px] text-faint">{hint}</p>}
      {!!(files && files.length) && (
        <div className="mt-2 flex flex-wrap gap-2">
          {files.map((file, i) => (
            <span key={i} className="inline-flex items-center gap-1.5 rounded-full bg-brand-50 dark:bg-brand-500/10 px-2.5 py-1 text-xs font-semibold text-brand-800 dark:text-brand-300">
              {file.name}
              <button type="button" className="text-brand-500 hover:text-brand-700 dark:hover:text-brand-300" disabled={disabled}
                onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))} aria-label="Remove file"><X size={12} /></button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
