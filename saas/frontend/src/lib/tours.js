// ─────────────────────────────────────────────────────────────────────────
// Guided product tours (driver.js).
//
// Two kinds of tour:
//   • PLATFORM tour  — runs on the dashboard, walks the whole workspace
//                      (search, categories, projects, credits, nav, assistant).
//   • TOOL tour      — runs on a tool page, walks every visible input field
//                      (auto-generated from the catalog schema), the run button,
//                      then ends on a REAL example of what that tool returns.
//
// Targets are `[data-tour="…"]` / `[data-tour-field="…"]` attributes sprinkled
// across Layout / Dashboard / ToolRunner. Steps whose target isn't on-screen are
// dropped, so the same tour works on mobile and across conditional fields.
// ─────────────────────────────────────────────────────────────────────────
import { driver } from 'driver.js';
import 'driver.js/dist/driver.css';
import { CREDIT_COSTS, PLANS, CATEGORY_META } from '@shared/catalog.mjs';

// ── driver.js base config (brand-themed via the .dm-tour popover class) ──────
function run(steps, { onDone } = {}) {
  const usable = safeSteps(steps);
  if (!usable.length) return;
  const d = driver({
    showProgress: true,
    animate: true,
    overlayOpacity: 0.6,
    stagePadding: 6,
    stageRadius: 10,
    popoverClass: 'dm-tour',
    nextBtnText: 'Next →',
    prevBtnText: '← Back',
    doneBtnText: 'Got it',
    progressText: '{{current}} / {{total}}',
    steps: usable,
    onDestroyed: () => onDone?.(),
  });
  d.drive();
  return d;
}

// Keep only steps with no element (centered cards) or a visible on-screen target.
function safeSteps(steps) {
  return steps.filter((s) => {
    if (!s.element) return true;
    const el = typeof s.element === 'string' ? document.querySelector(s.element) : s.element;
    return el && el.offsetParent !== null;
  });
}

// ── tiny HTML builders for the example payloads ──────────────────────────────
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const note = (s) => `<p class="dm-ex-note">${s}</p>`;
const lead = (s) => `<p class="dm-ex-lead">${s}</p>`;
const chips = (items) =>
  `<div class="dm-ex-stats">${items
    .map(([l, v, t]) => `<div class="dm-ex-stat${t ? ` t-${t}` : ''}"><span>${l}</span><b>${v}</b></div>`)
    .join('')}</div>`;
const table = (cols, rows) =>
  `<div class="dm-ex-scroll"><table class="dm-ex-tbl"><thead><tr>${cols
    .map((c) => `<th>${c}</th>`)
    .join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
    .join('')}</tbody></table></div>`;
const code = (s, name) =>
  `<div class="dm-ex-codewrap">${name ? `<div class="dm-ex-codebar">${name}</div>` : ''}<pre class="dm-ex-code">${esc(s)}</pre></div>`;
const badge = (t, tone) => `<span class="dm-ex-badge t-${tone || 'slate'}">${t}</span>`;
const card = (title, body) => `<div class="dm-ex-card"><b>${title}</b><div>${body}</div></div>`;

// ── REAL example outputs, one per tool ───────────────────────────────────────
// Grounded in the catalog's worked example (Extra Space Asia / "self storage
// singapore") and the actual result shapes the tools return.
export const OUTPUT_EXAMPLES = {
  // ── SEO ────────────────────────────────────────────────────────────────────
  'keyword-analysis':
    lead('A sortable table — volume, ranking difficulty, CPC and search intent for every keyword.') +
    table(
      ['Keyword', 'Volume', 'Diff.', 'CPC', 'Intent'],
      [
        ['self storage singapore', '5,700', badge('28', 'green'), 'S$5.21', badge('Commercial', 'blue')],
        ['storage units', '2,300', badge('41', 'amber'), 'S$3.80', badge('Commercial', 'blue')],
        ['cheap storage', '1,000', badge('22', 'green'), 'S$2.40', badge('Transactional', 'blue')],
      ]
    ) +
    note('Export the full list as CSV — green difficulty = easiest wins.'),

  'rank-checker':
    lead('Your live SERP position for each keyword × location, with a position-history sparkline.') +
    chips([['self storage singapore', '#4', 'green'], ['storage units', '#11', 'amber'], ['cheap storage', '#27', 'red']]) +
    note('📍 <b>Current position: #4</b> for extraspaceasia.com.sg in Singapore — up 3 spots in 28 days.'),

  'time-to-rank':
    lead('A realistic forecast of how long each keyword takes to reach page one, from its difficulty and your authority.') +
    table(
      ['Keyword', 'Volume', 'Diff.', 'Time to rank'],
      [
        ['storage units singapore', '5,700', badge('28', 'green'), badge('3–6 months', 'green')],
        ['self storage singapore', '5,700', badge('28', 'amber'), badge('6–9 months', 'amber')],
        ['climate controlled storage', '4,348', badge('46', 'red'), badge('9–12 months', 'red')],
      ]
    ),

  'anchor-cleaner':
    lead('Every internal anchor on the page, flagged where the text is over-optimised, generic or broken.') +
    table(
      ['Anchor text', 'Issue', 'Fix'],
      [
        ['"self storage self storage"', badge('Over-optimised', 'red'), 'Vary to "browse storage units"'],
        ['"click here"', badge('Generic', 'amber'), 'Describe the destination'],
        ['"personal-storage"', badge('Broken (404)', 'red'), 'Update or remove link'],
      ]
    ),

  'technical-seo':
    lead('A multi-page crawl with every issue grouped by severity.') +
    chips([['Pages crawled', '10'], ['Issues', '23', 'amber'], ['Critical', '3', 'red'], ['Avg load', '2.4s']]) +
    table(
      ['Issue', 'Pages', 'Severity'],
      [
        ['Missing meta description', '6', badge('High', 'red')],
        ['Title > 60 chars', '4', badge('Medium', 'amber')],
        ['Image missing alt text', '11', badge('Low', 'green')],
      ]
    ),

  onpage:
    lead('Element-by-element rewrite suggestions benchmarked against the pages currently outranking you.') +
    table(
      ['Element', 'Current', 'Suggested'],
      [
        ['Title', 'Storage | Extra Space', 'Self Storage Singapore — Units from S$39/mo | Extra Space Asia'],
        ['H1', 'Our Storage', 'Affordable Self Storage Units in Singapore'],
        ['Meta', '—', 'Climate-controlled self storage across 14 Singapore locations…'],
      ]
    ),

  competitors:
    lead('Who else ranks for your keywords, and how much of your keyword set they share.') +
    table(
      ['Competitor', 'Shared keywords', 'Avg. position'],
      [
        ['storefriendly.com.sg', '142', '#6'],
        ['lockandstore.com', '98', '#9'],
        ['workandstore.sg', '61', '#12'],
      ]
    ),

  backlinks:
    lead('A full link-profile audit — totals, authority, dofollow split and your top referring domains.') +
    chips([['Backlinks', '84,417'], ['Ref. domains', '3,929'], ['Dofollow', '71%', 'green'], ['Domain rank', '58']]) +
    table(
      ['Referring domain', 'Links', 'Type'],
      [
        ['businesstimes.com.sg', '34', badge('Dofollow', 'green')],
        ['sgsme.sg', '21', badge('Dofollow', 'green')],
        ['directory.sg', '120', badge('Nofollow', 'slate')],
      ]
    ),

  schema:
    lead('Valid, copy-paste JSON-LD that earns rich snippets — built visually, no code.') +
    code(
      `<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "LocalBusiness",
  "name": "Acme Storage",
  "url": "https://acme.sg",
  "telephone": "+65 6555 5555",
  "address": "1 Main St, Singapore",
  "priceRange": "$$"
}
</script>`,
      'JSON-LD · validated ✓'
    ),

  'strategy-engine':
    lead('Auto-generated keyword strategies with a prioritised, ready-to-action SEO plan (★ = recommended).') +
    table(
      ['Strategy', 'Focus', 'Target keywords'],
      [
        ['★ Capture high-intent local demand', 'Service pages', 'self storage singapore, storage units…'],
        ['Own the "cheap storage" cluster', 'Comparison content', 'cheap storage, affordable storage…'],
        ['Build business-storage authority', 'Blog + case studies', 'business storage, document storage…'],
      ]
    ),

  // ── Content ─────────────────────────────────────────────────────────────────
  caption:
    lead('Platform-tuned caption variations, ready to paste — with hooks, emojis and hashtags.') +
    card(
      'Instagram · Variation 1',
      'Your stuff deserves better than “under the bed” 🛏️➡️📦 New climate-controlled units just dropped — cool, dry, and yours from S$39/mo. Tap to claim yours.<br><span class="dm-ex-muted">#SelfStorage #SingaporeLiving #DeclutterYourLife</span>'
    ) +
    note('Generate up to 5 variations per run, each in your chosen tone + language.'),

  'content-writer':
    lead('A rewritten, SEO-tuned draft plus findings from the 18-agent QA suite.') +
    chips([['Readability', 'Grade 7', 'green'], ['Keyword use', 'Good', 'green'], ['Issues fixed', '6', 'amber']]) +
    `<div class="dm-ex-list"><b>QA agents flagged:</b><ul>
      <li>${badge('Fact', 'amber')} "cheapest in Singapore" — unverifiable superlative, softened.</li>
      <li>${badge('Tone', 'blue')} 2 sentences too formal for the brand voice — rewritten.</li>
      <li>${badge('SEO', 'green')} Added internal link to /personal-storage/.</li>
    </ul></div>`,

  'content-check':
    lead('A scored proof-read — grammar, readability, keyword coverage and compliance.') +
    chips([['Grammar', '3 fixes', 'amber'], ['Readability', 'Grade 6', 'green'], ['Keyword', 'Present', 'green']]) +
    `<div class="dm-ex-list"><ul>
      <li>${badge('Grammar', 'red')} “store you're items” → “store <b>your</b> items”.</li>
      <li>${badge('Style', 'amber')} “alot” → “a lot”.</li>
      <li>${badge('Compliance', 'blue')} Removed unqualified “guaranteed cheapest” claim.</li>
    </ul></div>`,

  pillars:
    lead('A content-pillar map — themes, subtopics and angles that keep your social cohesive.') +
    card('Pillar 1 · Smart Living', 'Decluttering tips · Small-space hacks · Seasonal storage<br><span class="dm-ex-muted">Angle: aspirational, practical, save-and-share</span>') +
    card('Pillar 2 · Behind the Brand', 'Facility tours · Security tech · Team stories<br><span class="dm-ex-muted">Angle: trust + transparency</span>'),

  // ── AI Visibility (GEO) ──────────────────────────────────────────────────────
  'ai-discovery':
    lead('Whether AI assistants actually cite you when users ask buying questions in your category.') +
    chips([['AI Visibility', '42 / 100', 'amber'], ['Prompts tested', '12'], ['Citations', '5', 'green']]) +
    table(
      ['Assistant', 'Mentions you?', 'Cited as source'],
      [
        ['ChatGPT', badge('Yes', 'green'), badge('✓', 'green')],
        ['Perplexity', badge('Yes', 'green'), badge('✓', 'green')],
        ['Gemini', badge('No', 'red'), badge('—', 'slate')],
      ]
    ),

  'ai-mentions':
    lead('How often your brand surfaces across AI chatbots, and the share of voice vs competitors.') +
    table(
      ['Brand', 'Mention rate', 'Share of voice'],
      [
        ['Extra Space Asia', '58%', badge('Leader', 'green')],
        ['StorHub', '47%', badge('Strong', 'blue')],
        ['Lock+Store', '21%', badge('Trailing', 'amber')],
      ]
    ),

  'llms-txt':
    lead('A readiness check, then a spec-compliant llms.txt + llms-full.txt you can download.') +
    chips([['llms.txt found', 'No', 'red'], ['AI bots allowed', 'Yes', 'green'], ['Key pages', '8', 'green']]) +
    code(
      `# Extra Space Asia
> Climate-controlled self storage across 14 Singapore locations.

## Core pages
- [Personal storage](/personal-storage/): Units from S$39/mo
- [Business storage](/business-storage/): Document & inventory storage
- [Locations](/locations/): 14 sites islandwide`,
      'llms.txt'
    ),

  'geo-onpage':
    lead('Content rewrites engineered to get your page picked up and cited by AI answers.') +
    `<div class="dm-ex-list"><b>For the prompt “Where can I find self storage in Singapore?”:</b><ul>
      <li>${badge('Add', 'green')} A direct one-sentence answer near the top (AI loves extractable claims).</li>
      <li>${badge('Add', 'green')} A pricing + locations table — structured data AI can quote.</li>
      <li>${badge('Fix', 'amber')} Replace “the best” with verifiable specifics (14 locations, S$39/mo).</li>
    </ul></div>`,

  'forensic-audit':
    lead('A deep SEO + GEO audit with a single health score and a prioritised fix list.') +
    chips([['Health score', '74 / 100', 'amber'], ['SSL', 'OK', 'green'], ['Speed', '2.4s', 'amber'], ['llms.txt', 'Missing', 'red']]) +
    table(
      ['Fix', 'Area', 'Priority'],
      [
        ['Add llms.txt + structured data', 'GEO', badge('Critical', 'red')],
        ['Compress 11 hero images', 'Speed', badge('High', 'amber')],
        ['Earn 3 more authority links', 'Off-page', badge('Medium', 'blue')],
      ]
    ),

  // ── Strategy ─────────────────────────────────────────────────────────────────
  persona:
    lead('Up to 10 research-backed audience personas built from a single URL.') +
    card('Relocating Renter · “Mei, 29”', 'Goals: store furniture between leases · Pains: short notice, tight budget<br><span class="dm-ex-muted">Channels: Google Search, Instagram · Trigger: moving date set</span>') +
    card('SME Owner · “Raj, 41”', 'Goals: free up office space · Pains: document security, access hours<br><span class="dm-ex-muted">Channels: LinkedIn, Google · Trigger: office downsize</span>'),

  'media-plan':
    lead('A channel mix with budget allocation, auto-generated personas and a funnel.') +
    table(
      ['Channel', 'Budget', 'Goal', 'Est. result'],
      [
        ['Google Search', 'S$3,200 (40%)', 'Capture intent', '~210 leads'],
        ['Performance Max', 'S$2,400 (30%)', 'Scale + retarget', '~140 leads'],
        ['Meta', 'S$1,600 (20%)', 'Awareness', '~180k reach'],
        ['LinkedIn', 'S$800 (10%)', 'B2B storage', '~25 leads'],
      ]
    ),

  'landing-audit':
    lead('A conversion read on the page — clarity, speed, trust and SEO readiness, with fixes.') +
    chips([['Conversion score', '68 / 100', 'amber'], ['Clarity', 'Good', 'green'], ['Speed', 'Slow', 'red'], ['Trust', 'Weak', 'amber']]) +
    `<div class="dm-ex-list"><ul>
      <li>${badge('High', 'red')} Primary CTA below the fold — move “Reserve a unit” up.</li>
      <li>${badge('Med', 'amber')} No pricing visible — add “from S$39/mo”.</li>
      <li>${badge('Med', 'amber')} Add reviews/trust badges near the form.</li>
    </ul></div>`,

  'sem-copy':
    lead('Ready-to-ship ad copy — headlines, descriptions and sitelinks for your chosen format.') +
    `<div class="dm-ex-list"><b>Google Search · Headlines</b><ul>
      <li>Self Storage From S$39/mo</li>
      <li>14 Locations Islandwide</li>
      <li>Climate-Controlled & Secure</li>
    </ul><b>Descriptions</b><ul>
      <li>Free up space today. Clean, dry, 24/7-access units across Singapore. Reserve online in 2 minutes.</li>
    </ul></div>`,

  'perf-marketing':
    lead('A paid-media plan — channel mix, budget split and the biggest opportunities.') +
    chips([['Suggested budget', 'S$6,000/mo'], ['Channels', '3'], ['Est. CPL', 'S$28', 'green']]) +
    table(
      ['Channel', 'Split', 'Why'],
      [
        ['Google Search', '55%', 'High-intent “invisalign singapore” demand'],
        ['Meta', '30%', 'Visual before/after, broad awareness'],
        ['Performance Max', '15%', 'Fill remarketing + Maps'],
      ]
    ),

  // ── Integrations (your own connected Google data) ────────────────────────────
  gsc:
    lead('Live Google Search Console data — clicks, impressions, CTR and average position.') +
    table(
      ['Query', 'Clicks', 'Impr.', 'CTR', 'Pos.'],
      [
        ['business storage', '467', '8,663', '5.4%', '13.2'],
        ['wine storage', '456', '4,644', '9.8%', '27.3'],
        ['self storage singapore', '252', '6,818', '3.7%', '9.7'],
      ]
    ) +
    note('Break down by query, page, country or device — costs 0 credits (it’s your own data).'),

  ga4:
    lead('Your GA4 traffic — sessions, users, engagement and conversions by channel.') +
    table(
      ['Channel', 'Sessions', 'Users', 'Conv.'],
      [
        ['Organic Search', '12,430', '9,880', '186'],
        ['Paid Search', '4,210', '3,540', '142'],
        ['Direct', '3,090', '2,700', '54'],
      ]
    ),

  'google-ads':
    lead('Your Google Ads performance — spend, clicks, conversions and cost per acquisition.') +
    table(
      ['Campaign', 'Spend', 'Clicks', 'Conv.', 'CPA'],
      [
        ['Search — Brand', 'S$1,240', '2,310', '188', 'S$6.60'],
        ['Search — Storage', 'S$3,480', '4,020', '154', 'S$22.60'],
        ['Pmax — Leads', 'S$2,100', '5,640', '96', 'S$21.90'],
      ]
    ),
};

// ── Per-tool intros ("what & when to use it") ────────────────────────────────
export const TOOL_INTRO = {
  'keyword-analysis': 'Find out what people actually search for — volume, how hard it is to rank, and buying intent. Start here before writing anything.',
  'rank-checker': 'Check exactly where you sit in Google for a keyword, in a specific location. Re-run weekly to watch positions move.',
  'time-to-rank': 'Set realistic expectations: roughly how many months a keyword will take to hit page one given its difficulty.',
  'anchor-cleaner': 'Audit a page’s internal links for over-optimised, generic or broken anchor text that can hurt rankings.',
  'technical-seo': 'Crawl a site for the technical issues Google cares about — broken tags, missing metadata and performance.',
  onpage: 'Get element-by-element rewrites (title, headings, meta, content) benchmarked against the pages outranking you.',
  competitors: 'Discover who shares your keywords and how you stack up — the starting map for any SEO strategy.',
  backlinks: 'Audit any domain’s link profile — totals, authority, dofollow split and the sites linking to it.',
  schema: 'Build valid JSON-LD structured data visually to win rich snippets. No data is fetched — it’s a builder.',
  'strategy-engine': 'The flagship: feed it your business and it returns prioritised keyword strategies and an action plan.',
  caption: 'Generate platform-tuned social captions in your brand voice. Free on every plan — a great first run.',
  'content-writer': 'Write a new draft or optimise existing copy, then run an 18-agent QA suite over it for facts, tone and SEO.',
  'content-check': 'Proof-read copy for grammar, readability, keyword use and compliance — with brand-guide and reference support.',
  pillars: 'Generate a content-pillar framework — themes, subtopics and angles that keep your social cohesive.',
  'ai-discovery': 'See whether ChatGPT, Gemini and Perplexity cite you when users ask buying questions in your category.',
  'ai-mentions': 'Track how often your brand is mentioned across AI chatbots, and your share of voice vs competitors.',
  'llms-txt': 'Check your site’s AI-readiness and generate a spec-compliant llms.txt so AI tools understand your content.',
  'geo-onpage': 'Rewrite a page so AI answers pick it up and cite it — the on-page side of AI visibility.',
  'forensic-audit': 'A deep, all-in-one SEO + GEO audit with a single health score and a prioritised fix list. The big one (50 credits).',
  persona: 'Turn a single URL into up to 10 research-backed audience personas for targeting and messaging.',
  'media-plan': 'Generate a full channel mix and budget allocation, with auto-personas and a funnel, from a brief.',
  'landing-audit': 'Score a landing page on conversion potential — clarity, speed, trust and SEO — with concrete fixes.',
  'sem-copy': 'Extract USPs from a URL and generate ready-to-ship ad copy for Google, Meta or LinkedIn.',
  'perf-marketing': 'Get a paid-media plan: channel mix, budget split and the biggest opportunities for a campaign.',
  gsc: 'Pull your own Google Search Console data — clicks, impressions, CTR and position. Costs 0 credits.',
  ga4: 'Pull your own GA4 analytics — sessions, users, engagement and conversions. Costs 0 credits.',
  'google-ads': 'Pull your own Google Ads performance — spend, clicks, conversions and CPA. Costs 0 credits.',
};

// ── Auto field hints (from the catalog schema) ───────────────────────────────
function fieldHint(field) {
  const bits = [];
  if (field.required) bits.push('<b>Required.</b>');
  switch (field.type) {
    case 'tags':
      bits.push('Add several — press Enter or comma between entries. Paste a list with the link below.');
      break;
    case 'select':
      bits.push(`Choose from: ${(field.options || []).slice(0, 6).join(', ')}${(field.options || []).length > 6 ? '…' : ''}.`);
      break;
    case 'url':
      bits.push('Paste a full URL, including <code>https://</code>.');
      break;
    case 'textarea':
      bits.push('Free text — the more context you give, the sharper the result.');
      break;
    case 'number':
      bits.push(field.default ? `Defaults to ${field.default}.` : 'A number.');
      break;
    default:
      break;
  }
  if (field.placeholder) bits.push(`<span class="dm-ex-muted">e.g. ${esc(field.placeholder).split('\n')[0]}</span>`);
  return bits.join('<br>') || 'Fill this in.';
}

// ── Tool tour ────────────────────────────────────────────────────────────────
export function startToolTour(tool, fields) {
  const meta = CATEGORY_META[tool.category] || { icon: '•' };
  const cost = CREDIT_COSTS[tool.cost] ?? 0;
  const steps = [];

  steps.push({
    popover: {
      title: `${meta.icon} ${tool.name}`,
      description:
        `<p class="dm-ex-lead">${TOOL_INTRO[tool.id] || tool.desc}</p>` +
        `<p class="dm-ex-note">${tool.category} · ${cost === 0 ? 'free to run' : `${cost} credit${cost > 1 ? 's' : ''} per run`}${tool.slow ? ' · ~30–150s' : ''}</p>`,
    },
  });

  // One step per visible field, auto-described from the schema.
  for (const f of fields) {
    steps.push({
      element: `[data-tour-field="${f.name}"]`,
      popover: { title: f.label, description: fieldHint(f), side: 'right', align: 'start' },
    });
  }

  steps.push({
    element: '[data-tour="tool-actions"]',
    popover: {
      title: 'Cost & a worked example',
      description:
        `${cost === 0 ? 'This tool is <b>free</b> to run.' : `Each run costs <b>${cost} credit${cost > 1 ? 's' : ''}</b>.`} ` +
        'Click <b>“Try an example”</b> to auto-fill the form with a realistic input so you can see it work instantly.',
      side: 'top',
      align: 'start',
    },
  });

  steps.push({
    element: '[data-tour="tool-run"]',
    popover: {
      title: tool.slow ? 'Run it (give it a moment)' : 'Run it',
      description: tool.slow
        ? 'Hit run — this tool calls live data + AI, so it takes ~30–150s. You’ll see live progress while it works.'
        : 'Hit run. Results appear right below, ready to copy, export to CSV or print.',
      side: 'top',
      align: 'end',
    },
  });

  steps.push({
    popover: {
      title: '📤 What you get back',
      description: OUTPUT_EXAMPLES[tool.id] || lead('A clean, formatted report you can copy, export to CSV or print as a white-label PDF.'),
    },
  });

  run(steps, { onDone: () => markSeen(`tool:${tool.id}`) });
}

// ── Platform tour (runs on the dashboard) ────────────────────────────────────
export function startPlatformTour() {
  const steps = [
    {
      popover: {
        title: '👋 Welcome to Digimetrics',
        description:
          lead('27 marketing tools across SEO, Content, AI Visibility, Strategy and your own Google data — in one workspace.') +
          note('This 60-second tour shows you around. You can replay it any time from the <b>?</b> in the top bar.'),
      },
    },
    { element: '[data-tour="search"]', popover: { title: 'Find any tool', description: 'Search by name or what it does — e.g. “backlinks”, “captions”, “ai”.', side: 'bottom', align: 'start' } },
    { element: '[data-tour="categories"]', popover: { title: 'Browse by category', description: 'Filter the grid: 🔍 SEO · ✍️ Content · 🤖 AI Visibility · 🎯 Strategy · 🔗 Integrations.', side: 'bottom', align: 'start' } },
    {
      element: 'main a[href^="/tool/"]',
      popover: {
        title: 'Every tool is a card',
        description:
          'The badge shows its credit cost (green = free). A 🔒 pill means it unlocks on a higher plan — but you still get one real preview run on locked tools. Click a card to open it.',
        side: 'right',
        align: 'start',
      },
    },
    { element: '[data-tour="project-selector"]', popover: { title: 'Projects', description: 'Group every run + data source under one site. Switch the active project here — runs are saved to it.', side: 'bottom', align: 'end' } },
    { element: '[data-tour="credits"]', popover: { title: 'Your credits', description: `Most tools spend credits per run. Your plan refills monthly (${PLANS.starter.monthlyCredits.toLocaleString()} on Starter, ${PLANS.pro.monthlyCredits.toLocaleString()} on Pro). Click to see usage.`, side: 'bottom', align: 'end' } },
    { element: '[data-tour="nav-/tracking"]', popover: { title: 'Rank tracking', description: 'Add keywords and we’ll track their Google positions over time — no need to re-run by hand.', side: 'bottom', align: 'start' } },
    { element: '[data-tour="nav-/integrations"]', popover: { title: 'Connect your Google data', description: 'One click connects Search Console, GA4 and Google Ads. Those tools then cost 0 credits — it’s your data.', side: 'bottom', align: 'start' } },
    { element: '[data-tour="nav-/history"]', popover: { title: 'History', description: 'Every run is saved here. Re-open any result, or re-run it with one click.', side: 'bottom', align: 'start' } },
    { element: '[data-tour="assistant"]', popover: { title: 'AI assistant', description: 'Ask it anything — it can see your account context, explain a result, or recommend the right tool.', side: 'bottom', align: 'end' } },
    { element: '[data-tour="account-menu"]', popover: { title: 'Account, billing & support', description: 'Your plan, usage, pricing and support tickets live in here.', side: 'bottom', align: 'end' } },
    {
      popover: {
        title: '🚀 You’re set',
        description:
          lead('Open any tool and click <b>“Tour”</b> next to its name for a guided, field-by-field walkthrough — ending on a real example of what it returns.') +
          note('Tip: <b>Caption Generator</b> and <b>Keyword Analysis</b> are free — great first runs.'),
      },
    },
  ];
  run(steps, { onDone: () => markSeen('platform') });
}

// ── "seen" flags so auto-start fires at most once ────────────────────────────
const KEY = (id) => `dm_tour_seen_${id}`;
export function hasSeen(id) {
  try { return localStorage.getItem(KEY(id)) === '1'; } catch { return true; }
}
export function markSeen(id) {
  try { localStorage.setItem(KEY(id), '1'); } catch { /* ignore */ }
}
