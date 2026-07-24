// ─────────────────────────────────────────────────────────────────────────
// Guided product tours (driver.js).
//
// Two kinds of tour:
//   • PLATFORM tour  — runs on the dashboard, walks the whole workspace
//                      (search, categories, projects, credits, nav, assistant).
//   • TOOL tour      — runs on a tool page. It PRE-FILLS the form with a real
//                      worked example (Asana / asana.com) and renders a real,
//                      fully-formatted result on the page — exactly what a user
//                      sees after running it themselves — then walks every input,
//                      the run button and the live result. Leaving the tour
//                      (Done, ✕, Esc or clicking away) CLEARS the form + result.
//
// The example data is curated to look like a genuine run and flows through the
// app's real <Result> renderer (sections / rows / text / code), not a static
// popover. Targets are `[data-tour="…"]` / `[data-tour-field="…"]` attributes
// across Layout / Dashboard / ToolRunner. Steps whose target isn't on-screen are
// dropped, so the same tour works on mobile and across conditional fields.
// ─────────────────────────────────────────────────────────────────────────
import { driver } from 'driver.js';
import 'driver.js/dist/driver.css';
import { PLANS, TOOLS, CREDIT_COSTS, isSchedulable, etaLabel } from '@shared/catalog.mjs';

// ── driver.js base config (brand-themed via the .dm-tour popover class) ──────
function run(steps, { onDone } = {}) {
  const usable = safeSteps(steps);
  if (!usable.length) { onDone?.(); return; }
  // Run onDone exactly once, on whichever way the tour ends.
  let finished = false;
  const finish = () => { if (finished) return; finished = true; onDone?.(); };
  const d = driver({
    showProgress: true,
    animate: true,
    smoothScroll: true,
    overlayOpacity: 0.6,
    stagePadding: 6,
    stageRadius: 10,
    popoverClass: 'dm-tour',
    nextBtnText: 'Next →',
    prevBtnText: '← Back',
    doneBtnText: 'Got it',
    progressText: '{{current}} / {{total}}',
    steps: usable,
    // driver.js v1.4 only fires `onDestroyed` when a step element is active at
    // teardown — clicking "Got it" on the final (centered) step destroys WITHOUT
    // it, so cleanup would silently never run. `onDestroyStarted` fires on every
    // exit path (Done, ✕, Esc, overlay click); we run the cleanup there and tear
    // down ourselves. `onDestroyed` is kept as a belt-and-braces fallback.
    onDestroyStarted: () => { finish(); d.destroy(); },
    onDestroyed: () => finish(),
  });
  d.drive();
  return d;
}

// Keep only steps with no element (centered cards) or a visible on-screen target.
// `element` may be a string selector, a DOM node, or a function returning a node
// (used for the live-result step, which only exists after the example renders).
function safeSteps(steps) {
  return steps.filter((s) => {
    if (!s.element) return true;
    const el = typeof s.element === 'function' ? s.element()
      : typeof s.element === 'string' ? document.querySelector(s.element)
      : s.element;
    return el && el.offsetParent !== null;
  });
}

// ── tiny HTML builders for popover copy (NOT result data) ────────────────────
const note = (s) => `<p class="dm-ex-note">${s}</p>`;
const lead = (s) => `<p class="dm-ex-lead">${s}</p>`;

// ── REAL example results, one per tool ───────────────────────────────────────
// These are result objects in the exact shape the tools return ({ source, rows,
// sections, text, … }). The tour injects them into the page so the renderer
// (tables, stat gauges, pass/fail rows, code cards, charts) draws them just like
// a real run. Grounded in a single coherent worked example: Asana / asana.com.
//
// The data-driven tools below (keyword-analysis, rank-checker, time-to-rank,
// competitors, backlinks, page-analysis, ai-discovery, ai-mentions, forensic-
// audit) are populated with REAL, live figures pulled from the platform's data
// layer for asana.com (US database) — search volumes, difficulties, SERP
// positions, backlink profile, AI-search citations, etc. The purely generative
// tools (caption, content, persona, ad copy, strategy…) show a representative
// worked example, since their output is freshly written by the model each run.
// The integration tools (gsc/ga4/google-ads/meta-ads/linkedin-ads) show a
// representative shape — a tour can't reach into a stranger's connected account.
const stats = (title, items) => ({ type: 'stats', title, items });
const cards = (title, items, note) => ({ type: 'cards', title, note, items });
const list = (title, items, tone) => ({ type: 'list', title, items, tone });
const callout = (text) => ({ type: 'callout', text });
const heading = (text) => ({ type: 'heading', text });
const codeBlock = (filename, content) => ({ type: 'code', filename, content });

const SAMPLE_RESULTS = {
  // ── SEO ────────────────────────────────────────────────────────────────────
  'keyword-analysis': {
    result: {
      source: 'live',
      rows: [
        { Keyword: 'project management software', Volume: '74,000', Difficulty: '94', CPC: '$8.96', Intent: 'Informational' },
        { Keyword: 'kanban board', Volume: '33,100', Difficulty: '94', CPC: '$5.87', Intent: 'Informational' },
        { Keyword: 'task management software', Volume: '14,800', Difficulty: '92', CPC: '$12.63', Intent: 'Informational' },
        { Keyword: 'free project management software', Volume: '2,400', Difficulty: '75', CPC: '$9.83', Intent: 'Informational' },
        { Keyword: 'gantt chart maker', Volume: '1,800', Difficulty: '67', CPC: '$4.50', Intent: 'Informational' },
        { Keyword: 'work management', Volume: '720', Difficulty: '21', CPC: '$8.08', Intent: 'Informational' },
        { Keyword: 'team collaboration software', Volume: '80', Difficulty: '48', CPC: '$6.60', Intent: 'Informational' },
      ],
    },
  },

  'rank-checker': {
    result: {
      source: 'live',
      sections: [
        stats('asana.com · United States', [
          { label: 'Keywords', value: '5' }, { label: 'Avg position', value: '5.6', tone: 'amber' },
          { label: 'Top 3', value: '2', tone: 'green' }, { label: 'On page 1', value: '4', tone: 'green' },
        ]),
        { type: 'chart', title: 'Position history · "swot analysis"', data: [
          { date: '2026-05-24', position: 9 }, { date: '2026-05-31', position: 9 },
          { date: '2026-06-07', position: 8 }, { date: '2026-06-14', position: 7 },
          { date: '2026-06-21', position: 6 }, { date: '2026-06-28', position: 5 },
          { date: '2026-07-05', position: 4 },
        ] },
      ],
      rows: [
        { Keyword: 'team building activities', Position: '1', URL: 'https://asana.com/resources/team-building-games', Change: '+2' },
        { Keyword: 'asana pricing', Position: '1', URL: 'https://asana.com/pricing', Change: '0' },
        { Keyword: 'swot analysis', Position: '4', URL: 'https://asana.com/resources/swot-analysis', Change: '+5' },
        { Keyword: 'smart goals', Position: '10', URL: 'https://asana.com/resources/smart-goals', Change: '-2' },
        { Keyword: 'performance improvement plan', Position: '12', URL: 'https://asana.com/resources/performance-improvement-plan-template', Change: '+31' },
      ],
    },
  },

  'time-to-rank': {
    result: {
      source: 'live',
      sections: [
        callout('Forecast based on asana.com’s current authority (Authority Score 95) and each keyword’s ranking difficulty. Higher-difficulty terms take longer to reach page one, even for a strong domain.'),
      ],
      rows: [
        { Keyword: 'work management', Volume: '720', Difficulty: '21', 'Time to rank': '2–3 months' },
        { Keyword: 'team collaboration software', Volume: '80', Difficulty: '48', 'Time to rank': '4–6 months' },
        { Keyword: 'gantt chart maker', Volume: '1,800', Difficulty: '67', 'Time to rank': '6–9 months' },
        { Keyword: 'free project management software', Volume: '2,400', Difficulty: '75', 'Time to rank': '9–12 months' },
        { Keyword: 'task management software', Volume: '14,800', Difficulty: '92', 'Time to rank': '12–18 months' },
        { Keyword: 'kanban board', Volume: '33,100', Difficulty: '94', 'Time to rank': '18–24 months' },
      ],
    },
  },

  'anchor-cleaner': {
    result: {
      source: 'live',
      sections: [
        stats('asana.com/features', [
          { label: 'Anchors found', value: '38' }, { label: 'Flagged', value: '7', tone: 'amber' },
          { label: 'Broken', value: '2', tone: 'red' }, { label: 'Over-optimised', value: '3', tone: 'amber' },
        ]),
      ],
      rows: [
        { 'Anchor text': '"project management software" ×9', Issue: 'Over-optimised', Fix: 'Vary the wording — e.g. "see how it works", "explore features"' },
        { 'Anchor text': '"click here"', Issue: 'Generic', Fix: 'Describe the destination — "compare Asana plans"' },
        { 'Anchor text': '"read more"', Issue: 'Generic', Fix: 'Use the target page’s title' },
        { 'Anchor text': '/pricing-2023', Issue: 'Broken (404)', Fix: 'Update the link to /pricing' },
      ],
    },
  },

  'technical-seo': {
    result: {
      source: 'live',
      sections: [
        stats('Crawl summary · asana.com', [
          { label: 'Pages crawled', value: '10' }, { label: 'Issues', value: '23', tone: 'amber' },
          { label: 'Critical', value: '3', tone: 'red' }, { label: 'Avg load', value: '1.8s', tone: 'green' },
        ]),
      ],
      rows: [
        { Issue: 'Missing meta description', Pages: '6', Severity: 'High' },
        { Issue: 'Duplicate H1 on page', Pages: '2', Severity: 'High' },
        { Issue: 'Title over 60 characters', Pages: '4', Severity: 'Medium' },
        { Issue: 'Slow largest-contentful-paint', Pages: '3', Severity: 'Medium' },
        { Issue: 'Image missing alt text', Pages: '14', Severity: 'Low' },
      ],
    },
  },

  onpage: {
    result: {
      source: 'live',
      sections: [
        callout('Element-by-element rewrites for asana.com/features, benchmarked against the three pages currently ranking top-3 for “project management software”.'),
      ],
      rows: [
        { Element: 'Title', Current: 'Features • Asana', Suggested: 'Project Management Software to Keep Teams On Track | Asana' },
        { Element: 'H1', Current: 'Features', Suggested: 'Everything Your Team Needs to Manage Work in One Place' },
        { Element: 'Meta description', Current: '—', Suggested: 'Plan, track and manage work with Asana — from daily tasks to strategic goals. See why 150,000+ teams hit their deadlines. Start free.' },
        { Element: 'Content depth', Current: '420 words', Suggested: 'Expand to ~900 words; add a comparison table and an FAQ block' },
      ],
    },
  },

  competitors: {
    result: {
      source: 'live',
      sections: [
        stats('Top domains competing for “project management software”', [
          { label: 'Competing domains', value: '500+' }, { label: 'Top rival’s shared keywords', value: '182,715' },
        ]),
      ],
      rows: [
        { Competitor: 'atlassian.com', 'Shared keywords': '182,715', 'Their keywords': '1,007,125', 'Est. traffic/mo': '759,172' },
        { Competitor: 'clickup.com', 'Shared keywords': '156,645', 'Their keywords': '745,718', 'Est. traffic/mo': '136,821' },
        { Competitor: 'smartsheet.com', 'Shared keywords': '145,888', 'Their keywords': '543,018', 'Est. traffic/mo': '552,360' },
        { Competitor: 'projectmanager.com', 'Shared keywords': '130,771', 'Their keywords': '320,571', 'Est. traffic/mo': '189,285' },
        { Competitor: 'monday.com', 'Shared keywords': '123,159', 'Their keywords': '375,456', 'Est. traffic/mo': '186,073' },
        { Competitor: 'wrike.com', 'Shared keywords': '108,839', 'Their keywords': '241,185', 'Est. traffic/mo': '99,540' },
      ],
    },
  },

  backlinks: {
    result: {
      source: 'live',
      sections: [
        stats('Link profile · asana.com', [
          { label: 'Backlinks', value: '2.9M' }, { label: 'Ref. domains', value: '115,922' },
          { label: 'Dofollow', value: '81%', tone: 'green' }, { label: 'Domain rank', value: '95', tone: 'green' },
        ]),
      ],
      rows: [
        { 'Referring domain': 'apps.apple.com', 'Domain rank': '100', Links: '51', Type: 'Dofollow' },
        { 'Referring domain': 'blog.cloudflare.com', 'Domain rank': '100', Links: '12', Type: 'Dofollow' },
        { 'Referring domain': 'business.adobe.com', 'Domain rank': '100', Links: '7', Type: 'Dofollow' },
        { 'Referring domain': 'community.shopify.com', 'Domain rank': '100', Links: '4', Type: 'Nofollow' },
        { 'Referring domain': 'fr.wikipedia.org', 'Domain rank': '100', Links: '1', Type: 'Nofollow' },
      ],
    },
  },

  'page-analysis': {
    result: {
      source: 'live',
      sections: [
        stats('Site snapshot · asana.com', [
          { label: 'Authority score', value: '95', tone: 'green' },
          { label: 'Backlinks', value: '2.9M', tone: 'green' },
          { label: 'Ref. domains', value: '115,922' },
          { label: 'Organic keywords', value: '537,894', tone: 'green' },
          { label: 'Monthly traffic', value: '314,554', tone: 'green' },
          { label: 'HTTPS / SSL', value: 'Valid', tone: 'green' },
        ]),
        list('Where its US rankings sit (organic positions)', [
          'Top 1–5: 153,740',
          'Position 6–10: 74,730',
          'Position 11–20: 100,289',
          'Position 21–50: 201,339',
        ]),
      ],
    },
  },

  schema: {
    result: {
      text: JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'Organization',
        name: 'Asana',
        url: 'https://asana.com',
        logo: 'https://asana.com/logo.png',
        sameAs: ['https://www.linkedin.com/company/asana', 'https://twitter.com/asana'],
        contactPoint: { '@type': 'ContactPoint', contactType: 'customer support', email: 'support@asana.com' },
      }, null, 2),
    },
  },

  'strategy-engine': {
    result: {
      sections: [
        heading('SEO Strategy · asana.com'),
        callout('Three prioritised keyword strategies for a work-management platform, with the highest-impact play highlighted. Each maps to a content type and a target cluster.'),
        cards('Recommended strategies', [
          { title: 'Capture high-intent product demand', badge: 'Top pick', badgeTone: 'green', barPct: 90,
            lines: [{ label: 'Focus', value: 'Feature & use-case pages' }, { label: 'Targets', value: 'project management software, task management software' }, { label: 'Est. impact', value: '+18% organic in 2 quarters' }] },
          { title: 'Own the "free / template" cluster', barPct: 70,
            lines: [{ label: 'Focus', value: 'Templates & free-tool pages' }, { label: 'Targets', value: 'free project management software, kanban board template' }] },
          { title: 'Build work-management authority', barPct: 55,
            lines: [{ label: 'Focus', value: 'Pillar guides + thought leadership' }, { label: 'Targets', value: 'work management, team collaboration' }] },
        ]),
        { type: 'table', title: 'Prioritised action plan', columns: ['Action', 'Priority', 'Effort'], rows: [
          { Action: 'Publish a "project management software" pillar page', Priority: 'Critical', Effort: 'High' },
          { Action: 'Build 12 use-case + industry template pages', Priority: 'High', Effort: 'Medium' },
          { Action: 'Earn 20 referring domains via an original data study', Priority: 'Medium', Effort: 'High' },
        ] },
      ],
    },
  },

  // ── Content ─────────────────────────────────────────────────────────────────
  caption: {
    result: {
      text: [
        '━━━ Variation 1 ━━━',
        'Catch your whole team up in seconds ⚡ Asana’s new AI project summaries turn a week of updates into one clear recap — so you spend less time in status meetings and more time doing the work. ✅',
        '#ProjectManagement #Teamwork #WorkSmarter #Asana',
        '',
        '━━━ Variation 2 ━━━',
        'Still writing status updates by hand? 😮‍💨 Let Asana AI summarise project progress for you — what shipped, what’s blocked, what’s next. Your team stays aligned without the busywork.',
        '#Productivity #AIatWork #TeamManagement',
        '',
        '━━━ Variation 3 ━━━',
        'From scattered updates to one source of truth 🎯 New: AI-powered project summaries in Asana. Try it free and give your team back their focus.',
        '#WorkManagement #GetItDone #Asana',
      ].join('\n'),
    },
  },

  'content-writer': {
    result: {
      sections: [
        stats('Optimised draft · quality checks', [
          { label: 'Readability', value: 'Grade 7', tone: 'green' }, { label: 'Keyword use', value: 'Good', tone: 'green' },
          { label: 'Issues fixed', value: '6', tone: 'amber' }, { label: 'Checks run', value: '8' },
        ]),
        callout('Rewritten opening: “Asana is a leading project management software that helps teams plan, track and manage work in one place — from a single to-do list to a company-wide initiative.”'),
        list('What the quality checks flagged & fixed', [
          'Fact-check — softened “the #1 project management tool” to “a leading project management software” (unverifiable superlative).',
          'Tone — 2 sentences made less formal to match the brand voice.',
          'SEO — added the target keyword to the first paragraph and an internal link to /templates.',
          'Readability — split 3 long sentences; reading grade 11 → 7.',
        ]),
      ],
    },
  },

  'content-check': {
    result: {
      sections: [
        stats('Proof-read score', [
          { label: 'Grammar', value: '3 fixes', tone: 'amber' }, { label: 'Readability', value: 'Grade 6', tone: 'green' },
          { label: 'Keyword', value: 'Present', tone: 'green' }, { label: 'Compliance', value: '1 flag', tone: 'amber' },
        ]),
        list('Issues found', [
          'Grammar — “you’re team’s work” → “your team’s work”.',
          'Spelling — “alot” → “a lot”.',
          'Compliance — removed the unverifiable “guaranteed cheapest plans” claim.',
        ]),
      ],
    },
  },

  pillars: {
    result: {
      sections: [
        cards('Content pillar framework', [
          { title: 'Pillar 1 · Work Smarter', body: 'Productivity tips · Remote & async work · Team workflows. Angle: aspirational, practical, save-and-share.' },
          { title: 'Pillar 2 · Inside Asana', body: 'Feature deep-dives · Customer stories · Team culture. Angle: trust + transparency.' },
          { title: 'Pillar 3 · The Future of Work', body: 'AI at work · Cross-functional collaboration · Industry trends. Angle: thought leadership.' },
        ]),
      ],
    },
  },

  // ── AI Visibility (GEO) ──────────────────────────────────────────────────────
  'ai-discovery': {
    result: {
      source: 'live',
      sections: [
        stats('AI search visibility · Asana · United States', [
          { label: 'Brand mentions', value: '122,574', tone: 'green' },
          { label: 'Citations', value: '68,697', tone: 'green' },
          { label: 'Avg position in AI answers', value: '4.1', tone: 'green' },
          { label: 'AI traffic opportunity', value: '58,044' },
        ]),
        list('Does each AI assistant cite asana.com when users ask buying questions?', [
          '✓ Google AI Overviews — names Asana and links asana.com (avg position 6.1)',
          '✓ ChatGPT — names Asana and cites asana.com',
          '✓ Gemini — names Asana and cites asana.com',
          '✓ Perplexity — names Asana and cites asana.com',
        ]),
      ],
    },
  },

  'ai-mentions': {
    result: {
      source: 'live',
      sections: [
        stats('Brand mentions across AI engines · Asana', [
          { label: 'Total mentions', value: '122,574', tone: 'green' },
          { label: 'Avg position', value: '4.1', tone: 'green' },
        ]),
        list('Mentions by AI engine (last 30 days)', [
          'Google AI Overview: 68,902',
          'ChatGPT: 31,624',
          'Gemini: 6,072',
          'Perplexity: 411',
        ]),
      ],
    },
  },

  'llms-txt': {
    result: {
      source: 'live',
      sections: [
        stats('AI-readiness · asana.com', [
          { label: 'llms.txt found', value: 'No', tone: 'red' }, { label: 'AI bots allowed', value: 'Yes', tone: 'green' },
          { label: 'Key pages', value: '8', tone: 'green' },
        ]),
        codeBlock('llms.txt', [
          '# Asana',
          '> Work management platform that helps teams orchestrate work, from daily tasks to cross-functional strategic initiatives.',
          '',
          '## Core pages',
          '- [Features](https://asana.com/features): Tasks, timelines, boards, workflows & reporting',
          '- [Pricing](https://asana.com/pricing): Free, Starter, Advanced & Enterprise plans',
          '- [Templates](https://asana.com/templates): 200+ ready-to-use project templates',
          '- [Integrations](https://asana.com/apps): Connects with Slack, Google, Microsoft & 200+ apps',
        ].join('\n')),
      ],
    },
  },

  'geo-onpage': {
    result: {
      source: 'live',
      sections: [
        callout('For the prompt “What is the best project management tool for small teams?” — rewrites that make asana.com/features easy for AI answers to extract and cite.'),
        list('Recommended rewrites', [
          'Add a one-sentence answer up top: “Asana is a work management platform that helps small teams plan, track and manage work in one place.” (AI loves extractable claims.)',
          'Add an Asana-vs-alternatives comparison table — structured data AI can quote directly.',
          'Replace vague “powerful features” with specifics: timelines, boards, workflows, 200+ integrations.',
          'Add an FAQ block answering the exact buying questions users ask AI.',
        ]),
      ],
    },
  },

  'forensic-audit': {
    result: {
      source: 'live',
      sections: [
        stats('Health score · asana.com', [
          { label: 'Health score', value: '82 / 100', tone: 'green' }, { label: 'Authority score', value: '95', tone: 'green' },
          { label: 'Backlinks', value: '2.9M', tone: 'green' }, { label: 'llms.txt', value: 'Missing', tone: 'red' },
        ]),
      ],
      rows: [
        { Fix: 'Add llms.txt + Organization structured data', Area: 'GEO', Priority: 'Critical' },
        { Fix: 'Add FAQ schema to high-traffic resource pages', Area: 'SEO', Priority: 'High' },
        { Fix: 'Compress hero images to improve load time', Area: 'Speed', Priority: 'Medium' },
      ],
    },
  },

  // ── Strategy ─────────────────────────────────────────────────────────────────
  persona: {
    result: {
      sections: [
        cards('Audience personas', [
          { title: 'Priya · Operations Lead, 31', badge: 'Primary', badgeTone: 'blue',
            lines: [{ label: 'Goals', value: 'Ship cross-team projects on time' }, { label: 'Pains', value: 'Scattered tools, endless status meetings' }],
            body: 'Channels: LinkedIn, Product Hunt · Trigger: team grows past 10 people.' },
          { title: 'David · Marketing Director, 43',
            lines: [{ label: 'Goals', value: 'Visibility across every campaign' }, { label: 'Pains', value: 'Missed deadlines, no single source of truth' }],
            body: 'Channels: Google Search, LinkedIn · Trigger: quarterly planning crunch.' },
          { title: 'Mei · IT / Procurement Manager, 38',
            lines: [{ label: 'Goals', value: 'Secure, compliant tooling teams adopt' }, { label: 'Pains', value: 'Shadow IT, seat sprawl' }],
            body: 'Channels: G2, vendor demos · Trigger: company-wide rollout review.' },
        ]),
      ],
    },
  },

  'media-plan': {
    result: {
      sections: [
        stats('Media plan · $8,000 / month', [
          { label: 'Channels', value: '4' }, { label: 'Est. trials', value: '~480 / mo', tone: 'green' },
          { label: 'Blended CPL', value: '$17', tone: 'green' },
        ]),
        { type: 'table', columns: ['Channel', 'Budget', 'Goal', 'Est. result'], rows: [
          { Channel: 'Google Search', Budget: '$3,200 (40%)', Goal: 'Capture high intent', 'Est. result': '~260 trials' },
          { Channel: 'Performance Max', Budget: '$2,400 (30%)', Goal: 'Scale + retarget', 'Est. result': '~180 trials' },
          { Channel: 'LinkedIn', Budget: '$1,600 (20%)', Goal: 'B2B reach (role + size)', 'Est. result': '~40 demos' },
          { Channel: 'Meta', Budget: '$800 (10%)', Goal: 'Awareness', 'Est. result': '~210k reach' },
        ] },
      ],
    },
  },

  'landing-audit': {
    result: {
      source: 'live',
      sections: [
        stats('Conversion read · asana.com/features', [
          { label: 'Conversion score', value: '68 / 100', tone: 'amber' }, { label: 'Clarity', value: 'Good', tone: 'green' },
          { label: 'Speed', value: 'Fast', tone: 'green' }, { label: 'Trust', value: 'Weak', tone: 'amber' },
        ]),
        list('Top fixes', [
          'Primary CTA sits below the fold — move “Start free” into the hero.',
          'No social proof near the form — add customer logos or the “85% of Fortune 100” stat.',
          'Three competing CTAs dilute the action — lead with one clear next step.',
        ]),
      ],
    },
  },

  'sem-copy': {
    result: {
      sections: [
        heading('Google Search ad copy · Asana'),
        list('Headlines', [
          'Asana — Manage Projects Free',
          'Trusted by 85% of Fortune 100',
          'Plan, Track & Hit Every Deadline',
          'From To-Dos to Big Goals',
        ]),
        list('Descriptions', [
          'Plan, track and manage work in one place. Start free — no credit card. See why 150,000+ teams choose Asana.',
          'Turn strategy into action. Timelines, boards and workflows your whole team will actually use.',
        ]),
        list('Sitelinks', ['Templates', 'Pricing', 'Integrations', 'Product Tour']),
      ],
    },
  },

  'perf-marketing': {
    result: {
      sections: [
        stats('Paid-media plan · Asana', [
          { label: 'Suggested budget', value: '$6,000/mo' }, { label: 'Channels', value: '3' },
          { label: 'Est. CPL', value: '$34', tone: 'green' },
        ]),
        { type: 'table', columns: ['Channel', 'Split', 'Why'], rows: [
          { Channel: 'Google Search', Split: '50%', Why: 'High-intent “project management software” demand' },
          { Channel: 'LinkedIn', Split: '30%', Why: 'Precise B2B targeting by role + company size' },
          { Channel: 'Performance Max', Split: '20%', Why: 'Remarketing + incremental reach' },
        ] },
      ],
    },
  },

  // ── Integrations (your own connected Google data) ────────────────────────────
  gsc: {
    result: {
      source: 'live',
      sections: [
        stats('Search Console · last 28 days', [
          { label: 'Clicks', value: '34,210', delta: '+8.4%', deltaTone: 'green' },
          { label: 'Impressions', value: '1.21M', delta: '+5.1%', deltaTone: 'green' },
          { label: 'Avg CTR', value: '5.1%' }, { label: 'Avg position', value: '6.8', delta: '-0.6', deltaTone: 'green' },
        ]),
        { type: 'chart', title: 'Clicks & impressions', series: [
          { label: 'Clicks', color: '#2563eb', points: [
            { date: '2026-03', value: 27800 }, { date: '2026-04', value: 30100 }, { date: '2026-05', value: 34210 }] },
          { label: 'Impressions', color: '#0891b2', points: [
            { date: '2026-03', value: 1010000 }, { date: '2026-04', value: 1140000 }, { date: '2026-05', value: 1210000 }] },
        ] },
      ],
      rows: [
        { Query: 'asana login', Clicks: '18640', Impressions: '24100', CTR: '77.3%', Position: '1.0' },
        { Query: 'project management software', Clicks: '4210', Impressions: '92400', CTR: '4.6%', Position: '3.2' },
        { Query: 'task management', Clicks: '2980', Impressions: '51200', CTR: '5.8%', Position: '5.1' },
        { Query: 'kanban board', Clicks: '1740', Impressions: '38900', CTR: '4.5%', Position: '7.4' },
      ],
    },
  },

  ga4: {
    result: {
      source: 'live',
      sections: [
        stats('GA4 · last 28 days', [
          { label: 'Sessions', value: '855,600', delta: '+6.2%', deltaTone: 'green' },
          { label: 'Users', value: '688,900' }, { label: 'Engagement', value: '61%', tone: 'green' },
          { label: 'Conversions', value: '19,260', delta: '+11%', deltaTone: 'green' },
        ]),
      ],
      rows: [
        { Channel: 'Organic Search', Sessions: '412300', Users: '318900', Conversions: '5840' },
        { Channel: 'Direct', Sessions: '286100', Users: '240500', Conversions: '9210' },
        { Channel: 'Paid Search', Sessions: '92400', Users: '78200', Conversions: '3120' },
        { Channel: 'Referral', Sessions: '64800', Users: '51300', Conversions: '1090' },
      ],
    },
  },

  'google-ads': {
    result: {
      source: 'live',
      sections: [
        stats('Google Ads · last 28 days', [
          { label: 'Spend', value: '$34,220' }, { label: 'Conversions', value: '10,140', tone: 'green' },
          { label: 'Blended CPA', value: '$3.37', tone: 'green' }, { label: 'Clicks', value: '145,000' },
        ]),
      ],
      rows: [
        { Campaign: 'Search — Brand', Spend: '$4,120', Clicks: '38400', Conversions: '6210', CPA: '$0.66' },
        { Campaign: 'PMax — Free Trial', Spend: '$11,200', Clicks: '64500', Conversions: '2090', CPA: '$5.36' },
        { Campaign: 'Search — PM Software', Spend: '$18,900', Clicks: '42100', Conversions: '1840', CPA: '$10.27' },
      ],
    },
  },

  'meta-ads': {
    result: {
      source: 'live',
      sections: [
        stats('Meta Ads · last 28 days', [
          { label: 'Spend', value: '$12,480' }, { label: 'Conversions', value: '3,640', tone: 'green' },
          { label: 'Blended CPA', value: '$3.43', tone: 'green' }, { label: 'Reach', value: '1.4M' },
        ]),
      ],
      rows: [
        { Campaign: 'Retargeting — Website', Spend: '$3,210', Clicks: '21,400', Conversions: '1,980', CPA: '$1.62' },
        { Campaign: 'Prospecting — Lookalike 1%', Spend: '$5,870', Clicks: '34,800', Conversions: '1,090', CPA: '$5.39' },
        { Campaign: 'Awareness — Reels', Spend: '$3,400', Clicks: '18,900', Conversions: '570', CPA: '$5.96' },
      ],
    },
  },

  'linkedin-ads': {
    result: {
      source: 'live',
      sections: [
        stats('LinkedIn Ads · last 28 days', [
          { label: 'Spend', value: '$9,750' }, { label: 'Leads', value: '214', tone: 'green' },
          { label: 'Cost per lead', value: '$45.56', tone: 'green' }, { label: 'CTR', value: '0.61%' },
        ]),
      ],
      rows: [
        { Campaign: 'Sponsored — Whitepaper', Spend: '$4,300', Clicks: '2,140', Leads: '128', CPL: '$33.59' },
        { Campaign: 'Lead Gen — Demo Request', Spend: '$3,650', Clicks: '1,510', Leads: '62', CPL: '$58.87' },
        { Campaign: 'Message Ads — Webinar', Spend: '$1,800', Clicks: '640', Leads: '24', CPL: '$75.00' },
      ],
    },
  },
};

export function sampleResultFor(toolId) {
  return SAMPLE_RESULTS[toolId] || null;
}

// ── Per-tool one-line blurb for the live-result step ─────────────────────────
// Written for beginners: plain words, and any metric named here is glossed
// inline (fuller definitions live in the ⓘ tooltips the result itself shows).
const OUTPUT_BLURB = {
  'keyword-analysis': 'One row per search term — monthly searches (Volume), how hard page 1 is (Difficulty), what advertisers pay per click (CPC) and why people search it (Intent). Green difficulty = easiest wins.',
  'rank-checker': 'Your live Google position for each keyword (1 = the top result), with a chart of how the headline term has moved over time.',
  'time-to-rank': 'A months-range estimate per keyword — how long reaching Google’s first page will realistically take.',
  'anchor-cleaner': 'Every link on the page, flagged where its clickable text is repetitive, vague or broken — each with a suggested fix.',
  'technical-seo': 'Every issue the crawl found, grouped by how serious it is — start at the top.',
  onpage: 'Element by element: what your page says now vs the suggested rewrite.',
  'page-analysis': 'The site at a glance — its trust score, links from other sites, Google traffic and where its rankings sit.',
  competitors: 'Who ranks for the same searches as you, how many keywords they own and their estimated monthly traffic.',
  backlinks: 'Totals up top, then who links to the site — with each linking site’s strength (Domain rank, 100 = strongest).',
  schema: 'Valid, copy-paste code with a one-click “Test in Google” link — built from a form, no coding.',
  'strategy-engine': 'Prioritised strategies (top pick highlighted) plus a ready-to-action plan.',
  caption: 'Caption options in copyable cards — hooks, emojis and hashtags included.',
  'content-writer': 'The improved, search-tuned draft plus everything the quality checks found and fixed.',
  'content-check': 'A scored proof-read — grammar, readability, keyword coverage and risky claims.',
  pillars: 'Your content themes, each with subtopics and angles to post about.',
  'ai-discovery': 'Engine by engine: does ChatGPT / Gemini / Perplexity actually mention you — and link your site — when buyers ask?',
  'ai-mentions': 'Mentions per AI engine, plus your average position inside their answers.',
  'llms-txt': 'A readiness check plus a ready-to-upload llms.txt you can copy or download.',
  'geo-onpage': 'Concrete rewrites that make the page easy for AI answers to quote and cite.',
  'forensic-audit': 'One health score for the whole site, then the fix list in priority order.',
  persona: 'Customer profiles — goals, frustrations, favourite channels and what triggers them to buy.',
  'media-plan': 'A channel-by-channel budget with the results to expect from each.',
  'landing-audit': 'A conversion score for the page with the top fixes in priority order.',
  'sem-copy': 'Ready-to-paste headlines, descriptions and sitelinks for your chosen ad platform.',
  'perf-marketing': 'A paid-ads plan — channel mix, budget split and the biggest opportunities.',
  gsc: 'Your live search stats — clicks, impressions (times you appeared), CTR (the % who clicked) and position — with a trend chart. 0 credits, it’s your own data.',
  ga4: 'Your traffic by channel — visits, visitors, engagement and conversions (sign-ups or sales). 0 credits.',
  'google-ads': 'Spend, clicks and conversions campaign by campaign, plus what each conversion cost you (CPA). 0 credits.',
  'meta-ads': 'Your Facebook & Instagram results — spend, conversions and cost per result, by campaign. 0 credits.',
  'linkedin-ads': 'Your LinkedIn results — spend, leads and cost per lead, by campaign. 0 credits.',
};

// ── Per-tool intros ("what & when to use it") ────────────────────────────────
// Beginner-first: any term of art is defined inline the first time it appears,
// using the same wording as the app-wide GLOSSARY so the product speaks with
// one voice. Keep each to 1–2 short sentences.
export const TOOL_INTRO = {
  'keyword-analysis': 'Keywords are the things people type into Google. See how many people search a term each month (volume), how hard page 1 is (difficulty) and whether searchers want to buy or just learn (intent). Start here before writing anything.',
  'rank-checker': 'Check exactly where your site appears in Google for a keyword — 1 means the top result — in a specific country or city. Re-run weekly to watch positions move.',
  'time-to-rank': 'Set realistic expectations: roughly how many months a keyword will take to reach Google’s first page, given how competitive it is.',
  'anchor-cleaner': 'Anchor text is the clickable wording of a link. Audit a page for anchors that are repetitive, vague (“click here”) or broken — all of which can hurt rankings.',
  'technical-seo': 'Crawls a site the way Google does and lists what’s broken or missing behind the scenes — titles, descriptions, speed — most serious first.',
  onpage: 'Compares your page with the pages currently beating it in Google, then suggests exact rewrites — title, headings, description and content.',
  'page-analysis': 'A fast health snapshot of any site: its 0–100 trust score (domain authority), links from other sites (backlinks), Google traffic and technical basics — in one view.',
  competitors: 'See who you’re really up against in Google — the sites ranking for the same searches as you, and how much traffic they get. The starting map for any SEO plan.',
  backlinks: 'Backlinks are links from other websites to yours — Google treats them as votes of confidence. See who links to any site, and how strong those votes are.',
  schema: 'Structured data is extra code that helps Google show rich results for you (stars, FAQs, business info). Build it by filling in a form — no coding, and nothing is fetched.',
  'strategy-engine': 'The flagship: describe your business and get prioritised keyword strategies plus a step-by-step action plan.',
  caption: 'Generate ready-to-post social captions in your brand voice. Free on every plan — a great first run.',
  'content-writer': 'Write a new draft or improve existing copy — then a QA crew of up to 18 agents (you pick the depth) checks facts, tone, readability and SEO.',
  'content-check': 'Paste any copy for a proof-read: grammar, spelling, readability, keyword use and risky claims — with fixes. Supports brand guides and reference files.',
  pillars: 'Content pillars are the 3–4 themes all your posts hang off. Generate the framework — themes, subtopics, angles — so your feed feels planned, not random.',
  'ai-discovery': 'When people ask ChatGPT, Gemini or Perplexity “what’s the best…?” in your category, do they mention you? Check whether AI assistants recommend and link to your site.',
  'ai-mentions': 'Track how often AI chatbots mention your brand — and your share of voice, i.e. how often it’s you rather than a competitor.',
  'llms-txt': 'llms.txt is a small file that tells AI tools what your site is about — like a menu for AI. Check your readiness and generate a ready-to-upload file.',
  'geo-onpage': 'Rewrite a page so AI assistants can easily quote and cite it in their answers — the AI-era side of SEO.',
  'forensic-audit': 'The deep, everything-at-once audit: classic Google SEO plus AI visibility, boiled down to one health score and a ranked fix list. The big one — run it when you want the full picture, not a spot check.',
  persona: 'Personas are profiles of your typical customers. Paste one URL and get up to 10 — their goals, frustrations, favourite channels and what makes them buy.',
  'media-plan': 'Give it a budget and a goal; get a full advertising plan — which channels, how much on each, and the results to expect.',
  'landing-audit': 'Scores a page on how well it turns visitors into customers — clarity, speed, trust and SEO — with concrete fixes.',
  'sem-copy': 'Paste a URL and get ready-to-ship ad text for Google, Meta or LinkedIn — it pulls out your selling points first.',
  'perf-marketing': 'A second opinion on your paid ads: the right channel mix, budget split and the biggest opportunities for a campaign.',
  gsc: 'Your own Google Search Console data — how often Google shows you (impressions) and how many people click. Tabs at the top switch between Search Insights, URL Inspection, Sitemaps and Indexing. Costs 0 credits — it’s your data.',
  ga4: 'Your own Google Analytics — visits, visitors, and how many turn into sign-ups or sales (conversions). Costs 0 credits.',
  'google-ads': 'Your own Google Ads performance — spend, clicks, conversions and what each conversion cost (CPA). Costs 0 credits.',
  'meta-ads': 'Your own Facebook & Instagram Ads — spend, conversions and cost per result. Costs 0 credits.',
  'linkedin-ads': 'Your own LinkedIn Ads — spend, leads and cost per lead. Costs 0 credits.',
};

// ── Auto field hints (from the catalog schema) ───────────────────────────────
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function fieldHint(field) {
  const bits = [];
  if (field.required) bits.push('<b>Required.</b>');
  switch (field.type) {
    case 'tags':
      bits.push('Add several — press Enter or comma between entries. Paste a list with the link below.');
      break;
    case 'select':
      bits.push(`Pick from the list — long lists (locations, languages) are searchable, just start typing.`);
      break;
    case 'segmented':
      bits.push('Pick a mode first — it decides which fields appear below (each option explains itself).');
      break;
    case 'multiselect':
      bits.push('Tick as many as you like.');
      break;
    case 'date':
      bits.push('Pick a date — these appear when you choose a “Custom” range.');
      break;
    case 'url':
      bits.push('Paste the page’s full web address, including <code>https://</code>.');
      break;
    case 'textarea':
      bits.push('Free text — write it like you’d explain it to a colleague. The more context, the sharper the result.');
      break;
    case 'number':
      bits.push(field.default ? `Defaults to ${field.default}.` : 'A number.');
      break;
    case 'account':
      bits.push('Pick a connected account — type to filter by name or ID. Connect accounts under Connect your data (account menu).');
      break;
    default:
      break;
  }
  if (field.placeholder) bits.push(`<span class="dm-ex-muted">e.g. ${escAttr(field.placeholder).split('\n')[0]}</span>`);
  return bits.join('<br>') || 'Fill this in.';
}

// ── Tool tour ────────────────────────────────────────────────────────────────
// `hooks.preview()`  — fill the form with the worked example + render its real
//                      result on the page (called before the walkthrough starts).
// `hooks.clear()`    — reset the form and remove the result (called on exit).
export function startToolTour(tool, fields, hooks = {}) {
  const steps = [];
  const cost = CREDIT_COSTS[tool?.cost] ?? 0;

  steps.push({
    popover: {
      title: tool.name,
      description:
        `<p class="dm-ex-lead">${TOOL_INTRO[tool.id] || tool.desc}</p>` +
        `<p class="dm-ex-note">${tool.category}${tool.slow ? ` · ~${etaLabel(tool)}` : ''}</p>` +
        note('We’ve filled the form with a real <b>asana.com</b> example and shown its result below. Nothing is running and <b>no credits are spent</b> while you look around — leaving the tour clears it all.'),
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
      title: 'Cost & one-click examples',
      description:
        `${cost === 0 ? 'This tool is <b>free</b> to run — it never touches your credits.' : `Each run costs <b>${cost} credit${cost > 1 ? 's' : ''}</b> from the monthly allowance in the top bar.`} ` +
        'Not sure what to type? Click <b>“Try an example”</b> any time and the form fills itself with a working example.',
      side: 'top',
      align: 'start',
    },
  });

  const scheduleNote = isSchedulable(tool)
    ? ' ' + note('See a <b>Schedule</b> button next to Run? It sets this tool to run by itself on a repeat (daily/weekly/monthly) with these inputs saved.')
    : '';
  steps.push({
    element: '[data-tour="tool-run"]',
    popover: {
      title: tool.slow ? 'Run it (give it a moment)' : 'Run it',
      description: (tool.slow
        ? `On your own data you’d hit run here — this tool calls live data + AI, so it takes ~${etaLabel(tool)} with live progress. We’ve pre-run the example for you ↓`
        : 'On your own data you’d hit run here. We’ve already run the example so you can see the output ↓') + scheduleNote,
      side: 'top',
      align: 'end',
    },
  });

  // The live result — the real rendered output on the page, not a popover mock.
  steps.push({
    element: () => document.querySelector('[data-tour="tool-result"]'),
    popover: {
      title: 'What you get back — live',
      description:
        lead(OUTPUT_BLURB[tool.id] || 'A clean, formatted report.') +
        note('This is the <b>real result</b>, exactly as your own runs will look. Spot a term you don’t know? Hover the little <b>ⓘ</b> beside any metric for a plain-English meaning.') +
        note('The bar above has <b>Explain this</b> (Monty breaks the whole thing down), <b>Copy</b>, <b>CSV</b>, <b>Print</b> (a white-label PDF) and <b>Share</b> (a branded image). Many tools finish with <b>recommendation cards</b> — tap “How do I do this?” and Monty walks you through it, so a finding turns into an action.'),
      side: 'top',
      align: 'start',
    },
  });

  steps.push({
    popover: {
      title: 'Confused by a result? Just ask',
      description:
        lead('<b>Right-click</b> any result, card or row and Monty, the AI assistant, will explain it in plain English — or tell you what to do about it.') +
        note('Want only one number or phrase explained? <b>Highlight just that text first</b>, then right-click — it’ll focus on exactly what you selected.'),
    },
  });

  steps.push({
    popover: {
      title: 'That’s the tour — your turn',
      description:
        lead('We’ll clear the example now. Pop in your own site and hit <b>Run</b> — experiment freely, anything that could change something live always asks you first.') +
        note('Replay this walkthrough any time from the <b>Tour</b> button next to the tool name.'),
    },
  });

  // Render the worked example + its result, wait a beat for React to paint so
  // the live-result step can find its target, then drive. Clear on exit.
  hooks.preview?.();
  setTimeout(() => {
    run(steps, { onDone: () => { markSeen(`tool:${tool.id}`); hooks.clear?.(); } });
  }, 120);
}

// ── Social Media Audit tour (bespoke page, not the generic ToolRunner) ────────
// Mirrors startToolTour: `hooks.preview()` pre-fills the brand/profile/competitor
// form with a real asana.com worked example and renders both result scorecards on
// the page (Phase 1 live data + Phase 2 strategy), so the walkthrough annotates a
// genuine run. `hooks.clear()` resets the whole form + both results on exit (Done,
// ✕, Esc or click-away). Steps whose target isn't on-screen are dropped.
export function startSocialAuditTour(tool, hooks = {}) {
  const cost = CREDIT_COSTS[tool?.cost] ?? 0;
  const steps = [
    {
      popover: {
        title: 'Social Media Audit',
        description:
          lead('Pulls live numbers from Instagram, TikTok, Facebook, LinkedIn &amp; YouTube — followers, engagement (how much people actually interact), posting habits — then builds the strategy: what to post, where, and what competitors do better.') +
          `<p class="dm-ex-note">${tool.category} · ~${etaLabel(tool)} (two phases)</p>` +
          note('We’ve filled this in with a real <b>asana.com</b> example and rendered the result below — nothing runs and <b>no credits are spent</b> while you look around.'),
      },
    },
    {
      element: '[data-tour="sma-brand"]',
      popover: {
        title: 'Brand & campaign',
        description:
          lead('Only the <b>brand name</b> is required — everything else is optional.') +
          note('Leave industry, goals and audience blank and AI fills them in before the audit — we’ve pre-filled them here so you can see the shape.'),
        side: 'bottom', align: 'start',
      },
    },
    {
      element: '[data-tour="sma-autofind"]',
      popover: {
        title: 'Auto-find details',
        description: 'One click asks AI to fill the campaign context <i>and</i> discover the brand’s social profiles + competitors — so you rarely type more than a name. Always confirm the handles it finds.',
        side: 'bottom', align: 'start',
      },
    },
    {
      element: '[data-tour="sma-profiles"]',
      popover: {
        title: 'Profiles to audit',
        description:
          lead('The social accounts whose live numbers get pulled in Phase 1.') +
          note('<b>Auto-find profiles</b> guesses them from the brand + website (badged <i>from site</i> / <i>from search</i>). Untick or edit any that look wrong before running.'),
        side: 'top', align: 'start',
      },
    },
    {
      element: '[data-tour="sma-competitors"]',
      popover: {
        title: 'Competitors (optional)',
        description: 'Add up to 3 rivals — they’re compared side-by-side to show what they do better and what’s worth copying. Auto-find suggests them, or add your own.',
        side: 'top', align: 'start',
      },
    },
    {
      element: '[data-tour="sma-listening"]',
      popover: {
        title: 'Social listening',
        description:
          lead('Scans the open web, blogs, forums &amp; news for brand mentions and reads the overall <b>sentiment</b>, then adds results from Reddit, X and SG forums.') +
          note('On by default. Add extra terms (product names, campaign hashtags) or untick a source you don’t care about — it surfaces as a “mentions &amp; sentiment” card in the scorecard.'),
        side: 'top', align: 'start',
      },
    },
    {
      element: '[data-tour="sma-context"]',
      popover: {
        title: 'Optional context',
        description: 'Paste notes or a content calendar, or attach briefs / brand guidelines (PDF, DOCX, TXT…). The text is read right in your browser and fed into the analysis — the more context, the sharper the audit.',
        side: 'top', align: 'start',
      },
    },
    {
      element: '[data-tour="sma-mode"]',
      popover: {
        title: 'Starter vs Pro',
        description:
          lead('<b>Starter</b> — the essentials: how the brand compares to competitors and what’s missing from its content.') +
          note('<b>Pro</b> adds fields for your exported analytics and goes deeper — content themes, campaign ideas, social SEO and creative fixes.'),
        side: 'top', align: 'start',
      },
    },
    {
      element: '[data-tour="sma-run"]',
      popover: {
        title: 'Run it (give it a moment)',
        description: `On your own data you’d hit run here — it costs <b>${cost} credits</b> and works in two phases (pull the live numbers → build the strategy), so it takes ~${etaLabel(tool)} with live progress. It keeps going even if you close the tab, and sends a notification when it’s done. We’ve pre-run the example so you can see the output ↓`,
        side: 'top', align: 'start',
      },
    },
    {
      element: () => document.querySelector('[data-tour="sma-results"]'),
      popover: {
        title: 'What you get back — live',
        description:
          lead('First a visual <b>scorecard</b> — live follower counts, engagement, posting habits and a side-by-side with competitors. Then the <b>strategy</b>: what to post, where, and the action plan in priority order.') +
          note('This is the <b>real rendered result</b>, exactly like your own run. Hover the little <b>ⓘ</b> beside any metric for a plain-English meaning — and <b>Share</b> your own runs as a branded image.'),
        side: 'top', align: 'start',
      },
    },
    {
      popover: {
        title: 'Confused by a result? Just ask',
        description:
          lead('<b>Right-click</b> any card or row and Monty, the AI assistant, explains it in plain English — or tells you what to do about it.') +
          note('Want one figure explained? <b>Highlight just that text first</b>, then right-click.'),
      },
    },
    {
      popover: {
        title: 'That’s the tour — your turn',
        description:
          lead('We’ll clear the example now. Type your brand name, hit <b>Auto-find</b>, confirm the profiles and run it — nothing changes on your accounts, it only reads.') +
          note('Replay this any time from the <b>Tour</b> button next to the title.'),
      },
    },
  ];

  hooks.preview?.();
  setTimeout(() => {
    run(steps, { onDone: () => { markSeen('tool:social-audit'); hooks.clear?.(); } });
  }, 120);
}

// ── Performance Marketing Audit (bespoke page) ───────────────────────────────
export function startPerfMarketingTour(tool, hooks = {}) {
  const cost = CREDIT_COSTS[tool?.cost] ?? 0;
  const steps = [
    {
      popover: {
        title: 'Performance Marketing Audit',
        description:
          lead('A paid-media plan for a prospect (<b>Starter</b>) or a full account-level diagnosis from your exported/connected data (<b>Pro</b>).') +
          `<p class="dm-ex-note">${tool.category} · ~${etaLabel(tool)}</p>`,
      },
    },
    {
      element: '[data-tour="pm-mode"]',
      popover: {
        title: 'Starter vs Pro',
        description:
          lead('<b>Starter</b> — channel mix, budget split &amp; opportunities from first-call inputs. No ad-account data needed.') +
          note('<b>Pro</b> reveals account-data fields and returns a 9-area diagnosis (tracking, structure, targeting, creative, budget, landing pages…).'),
        side: 'bottom', align: 'start',
      },
    },
    {
      element: '[data-tour="pm-autofill"]',
      popover: {
        title: 'Analyse & auto-fill',
        description: 'Enter the website and one click reads the site + researches the market to fill category, audience, objectives and competitors for you. Always review before running.',
        side: 'bottom', align: 'start',
      },
    },
    {
      element: '[data-tour="pm-budget"]',
      popover: {
        title: 'Currency, budget & objectives',
        description: 'Pick the output currency (every money figure comes back in it), an optional monthly budget (we suggest a range if blank), your goals and the platforms to consider.',
        side: 'top', align: 'start',
      },
    },
    {
      element: '[data-tour="pm-competitors"]',
      popover: {
        title: 'Competitors',
        description: 'One domain per line — we pull each rival’s Google paid keywords and Meta Ad Library activity and feed it into the analysis.',
        side: 'top', align: 'start',
      },
    },
    {
      element: '[data-tour="pm-pro"]',
      popover: {
        title: 'Account data (Pro)',
        description: 'Paste or upload your Google Ads / Meta / GA4 exports — or <b>Pull from connected accounts</b> to bring live data straight in from your Integrations.',
        side: 'top', align: 'start',
      },
    },
    {
      element: '[data-tour="pm-run"]',
      popover: {
        title: 'Run it',
        description: `On your own data you’d run here — it costs <b>${cost} credits</b> and takes ~${etaLabel(tool)}. Starter returns a budget split + channel-mix chart; Pro returns the account diagnosis.`,
        side: 'top', align: 'start',
      },
    },
    {
      popover: {
        title: 'That’s the tour',
        description: note('Replay it any time from the <b>Tour</b> button next to the title.'),
      },
    },
  ];
  hooks.preview?.();
  setTimeout(() => { run(steps, { onDone: () => { markSeen('tool:perf-marketing'); hooks.clear?.(); } }); }, 120);
}

// ── SEO Diagnostics (bespoke 5-step wizard) ──────────────────────────────────
export function startSeoDiagnosticsTour(tool, hooks = {}) {
  const steps = [
    {
      popover: {
        title: 'SEO Diagnostics',
        description:
          lead('A guided, five-step audit that turns your keywords + site into a <b>prioritised fix list</b>.') +
          `<p class="dm-ex-note">${tool.category} · ~${etaLabel(tool)}</p>`,
      },
    },
    {
      element: '[data-tour="sdx-stepper"]',
      popover: {
        title: 'Five steps',
        description: 'Target → flag under-performing keywords → add GA4/Search Console context → technical checks → diagnosis. Move with Next/Back; you can jump back to any completed step.',
        side: 'bottom', align: 'start',
      },
    },
    {
      element: '[data-tour="sdx-domain"]',
      popover: {
        title: 'Your domain',
        description: 'The site to diagnose. Use your current project’s domain in one click, and pick the market (location + language) for the live SERP check.',
        side: 'bottom', align: 'start',
      },
    },
    {
      popover: {
        title: 'Keywords → opportunity buckets',
        description:
          lead('In step 2 you paste keywords (with optional volume/position/change) and we bucket them: <b>low-hanging fruit</b>, <b>declining</b>, <b>page 2+</b>, <b>not ranking</b>.') +
          note('Tick the ones to diagnose — the live SERP check reads up to 8 of them to see who ranks above you.'),
      },
    },
    {
      popover: {
        title: 'Context + technical checks',
        description: 'Step 3 lets you paste GA4/Search Console data (optional, sharpens the plan). Step 4 runs page speed, performance grade, SSL, on-page, robots/llms.txt, backlinks and the live SERP landscape.',
      },
    },
    {
      popover: {
        title: 'Diagnosis & priority plan',
        description:
          lead('Step 5 gives a health score, the flagged keyword opportunities, the SERP landscape, a prioritised technical fix list and an AI action plan.') +
          note('Tables export to CSV, and you can Share the result. Replay this tour any time from the Tour button.'),
      },
    },
  ];
  hooks.preview?.();
  setTimeout(() => { run(steps, { onDone: () => { markSeen('tool:seo-diagnostics'); hooks.clear?.(); } }); }, 120);
}

// ── Dedicated-page tours (Site Health Check / Performance / Tracking) ────────
// Same contract as the tool tours: `hooks.preview()` renders a curated worked
// example through the page's real components, `hooks.clear()` removes it on any
// exit. Sample data lives here so every tour's demo speaks with one voice
// (asana.com, consistent with SAMPLE_RESULTS above).

// A finished Site Health Check for asana.com — consistent with the
// forensic-audit sample (health 82, DA 95, llms.txt missing).
export const SITE_AUDIT_SAMPLE = {
  url: 'https://asana.com',
  report: {
    score: 82,
    grade: 'B+',
    summary: 'asana.com is in good shape — strong authority and fast pages. The quickest wins: add the missing AI-readiness file (llms.txt) and write the six missing page descriptions.',
    areas: [
      { name: 'Technical health', status: 'good', score: 86, note: 'Fast pages; a few missing meta descriptions.' },
      { name: 'Page quality', status: 'good', score: 78, note: 'Clear layout and calls-to-action; add social proof near the sign-up form.' },
      { name: 'AI readiness', status: 'fair', score: 64, note: 'No llms.txt yet — AI assistants get no guide to the site.' },
    ],
    fixes: [
      { title: 'Add an llms.txt file', priority: 'high', why: 'Tells ChatGPT & co. what your site is about — quick to add, immediate AI-visibility win.' },
      { title: 'Write meta descriptions for 6 pages', priority: 'medium', why: 'These are your search-result snippets — missing ones cost clicks.' },
      { title: 'Move the “Start free” button above the fold', priority: 'low', why: 'Visitors shouldn’t have to scroll before they can act.' },
    ],
  },
};

export function startSiteAuditTour({ checks = 3 } = {}, hooks = {}) {
  const steps = [
    {
      popover: {
        title: 'Site Health Check',
        description:
          lead(`One click runs <b>${checks} specialist checks</b> on your site and turns them into a single plain-English report — a score out of 100 and what to fix first.`) +
          `<p class="dm-ex-note">~1–3 minutes</p>` +
          note('We’ve loaded a finished <b>asana.com</b> example below — nothing runs and <b>no credits are spent</b> while you look around.'),
      },
    },
    {
      element: '[data-tour="sha-url"]',
      popover: {
        title: 'Your website',
        description: 'Paste the full address, including <code>https://</code>. If you’ve picked a project, we fill this in for you.',
        side: 'bottom', align: 'start',
      },
    },
    {
      element: '[data-tour="sha-run"]',
      popover: {
        title: 'Run it',
        description: 'One click starts every check at once. It takes ~1–3 minutes with live progress — and always asks before spending credits.',
        side: 'bottom', align: 'end',
      },
    },
    {
      element: '[data-tour="sha-steps"]',
      popover: {
        title: 'The checks, live',
        description: 'Each check ticks off as it finishes. If one can’t run it’s simply skipped — your report is built from everything that succeeded.',
        side: 'top', align: 'start',
      },
    },
    {
      element: () => document.querySelector('[data-tour="sha-report"]'),
      popover: {
        title: 'Your report — live example',
        description:
          lead('The verdict in plain English: a <b>score out of 100</b>, how each area did, and a <b>“Do these next”</b> list sorted by priority.') +
          note('This is the real report layout, exactly like your own run — which you can <b>Share</b> as a branded image with the button above it.'),
        side: 'top', align: 'start',
      },
    },
    {
      popover: {
        title: 'Confused by a result? Just ask',
        description:
          lead('<b>Right-click</b> any card or fix and Monty, the AI assistant, explains it in plain English — or tells you what to do about it.') +
          note('Want one figure explained? <b>Highlight just that text first</b>, then right-click.'),
      },
    },
    {
      popover: {
        title: 'That’s the tour — your turn',
        description:
          lead('We’ll clear the example now. Pop in your site and hit <b>Run health check</b> — it reads your site, it never changes it.') +
          note('Replay this any time from the <b>Tour</b> button next to the title.'),
      },
    },
  ];
  hooks.preview?.();
  setTimeout(() => {
    run(steps, { onDone: () => { markSeen('tool:site-audit'); hooks.clear?.(); } });
  }, 120);
}

// Performance history for asana.com — one metric per group so the page shows
// its full grouped layout (labels chosen to match GLOSSARY so ⓘ tips appear).
const perfHist = (vals) => vals.map((value, i) => ({ date: ['2026-05-01', '2026-05-08', '2026-05-15', '2026-05-22', '2026-05-29', '2026-06-05', '2026-06-12'][i], value }));
export const PERFORMANCE_SAMPLE = [
  { tool: 'gsc', toolName: 'Search Console', target: 'https://asana.com', metricId: 'demo#gsc#clicks', label: 'Clicks', unit: '', dir: 'up', lastValue: 34210, history: perfHist([27800, 28900, 29400, 30800, 31900, 33050, 34210]) },
  { tool: 'gsc', toolName: 'Search Console', target: 'https://asana.com', metricId: 'demo#gsc#avgPosition', label: 'Avg position', unit: '', dir: 'down', lastValue: 6.8, history: perfHist([8.1, 7.9, 7.7, 7.4, 7.2, 7.0, 6.8]) },
  { tool: 'backlinks', toolName: 'Backlinks Explorer', target: 'asana.com', metricId: 'demo#backlinks#refDomains', label: 'Ref. domains', unit: '', dir: 'up', lastValue: 115922, history: perfHist([111400, 112300, 113100, 113900, 114600, 115300, 115922]) },
  { tool: 'ai-discovery', toolName: 'AI Discovery Audit', target: 'asana.com', metricId: 'demo#ai#mentions', label: 'Brand mentions', unit: '', dir: 'up', lastValue: 122574, history: perfHist([100500, 104800, 109200, 113100, 117400, 120100, 122574]) },
];

export function startPerformanceTour(hooks = {}) {
  const steps = [
    {
      popover: {
        title: 'Performance — your numbers over time',
        description:
          lead('Every tool you run under a project drops its headline numbers here, building charts over time — clicks, rankings, authority, AI visibility. Connected Google accounts refresh themselves daily.') +
          note('We’ve loaded an <b>asana.com</b> example below — it’s a preview, <b>no credits are spent</b>, and it clears when you leave the tour.'),
      },
    },
    {
      element: '[data-tour="perf-period"]',
      popover: {
        title: 'Pick your window',
        description: 'Zoom to the last 7, 28 or 90 days — every chart and trend arrow follows.',
        side: 'bottom', align: 'start',
      },
    },
    {
      element: '[data-tour="perf-group"]',
      popover: {
        title: 'One tile per number',
        description:
          lead('Each tile shows the latest value, a trend arrow — <b>green means moving the right way</b> (for some, like Avg position, lower is better) — and a mini chart.') +
          note('Not sure what a metric means? Hover the little <b>ⓘ</b> beside its name for a plain-English definition.'),
        side: 'top', align: 'start',
      },
    },
    {
      element: '[data-tour="perf-actions"]',
      popover: {
        title: 'Take it with you',
        description: '<b>Export CSV</b> downloads the full history for a spreadsheet; <b>Share</b> turns the headline numbers into a branded image.',
        side: 'bottom', align: 'end',
      },
    },
    {
      popover: {
        title: 'Confused by a number? Just ask',
        description:
          lead('<b>Right-click</b> any tile and Monty, the AI assistant, explains it in plain English — or tells you what to do about it.'),
      },
    },
    {
      popover: {
        title: 'That’s the tour',
        description:
          lead('We’ll clear the example now. This page fills up by itself as you run tools — put your key tools on a <b>Schedule</b> and it stays fresh without you lifting a finger.') +
          note('Replay this any time from the <b>Tour</b> button next to the title.'),
      },
    },
  ];
  hooks.preview?.();
  setTimeout(() => {
    run(steps, { onDone: () => { markSeen('tool:performance'); hooks.clear?.(); } });
  }, 120);
}

// Tracked keywords for asana.com — mirrors the rank-checker sample (same
// keywords/positions) so the whole product tells one story.
const trkHist = (positions, url) => positions.map((position, i) => ({ date: ['2026-05-01', '2026-05-08', '2026-05-15', '2026-05-22', '2026-05-29', '2026-06-05', '2026-06-12'][i], position, url }));
export const TRACKING_SAMPLE = [
  { trackId: 'demo-1', keyword: 'team building activities', domain: 'asana.com', lastPosition: 1, lastUrl: 'https://asana.com/resources/team-building-games', history: trkHist([3, 3, 2, 2, 1, 1, 1], 'https://asana.com/resources/team-building-games') },
  { trackId: 'demo-2', keyword: 'swot analysis', domain: 'asana.com', lastPosition: 4, lastUrl: 'https://asana.com/resources/swot-analysis', history: trkHist([9, 9, 8, 7, 6, 5, 4], 'https://asana.com/resources/swot-analysis') },
  { trackId: 'demo-3', keyword: 'smart goals', domain: 'asana.com', lastPosition: 10, lastUrl: 'https://asana.com/resources/smart-goals', history: trkHist([8, 8, 9, 9, 10, 10, 10], 'https://asana.com/resources/smart-goals') },
  { trackId: 'demo-4', keyword: 'performance improvement plan', domain: 'asana.com', lastPosition: 12, lastUrl: 'https://asana.com/resources/performance-improvement-plan-template', history: trkHist([43, 38, 30, 24, 18, 14, 12], 'https://asana.com/resources/performance-improvement-plan-template') },
];

export function startTrackingTour({ limit } = {}, hooks = {}) {
  const steps = [
    {
      popover: {
        title: 'Keyword tracking',
        description:
          lead('Pick the searches you care about and we check where you rank in Google — <b>position 1 is the top result</b> — every day, automatically, and chart the movement.') +
          `<p class="dm-ex-note">${limit ? `Your plan tracks up to ${limit} keywords.` : ''}</p>` +
          note('We’ve loaded an <b>asana.com</b> example below — it’s a preview, <b>no credits are spent</b>, and it clears when you leave the tour.'),
      },
    },
    {
      element: '[data-tour="trk-add"]',
      popover: {
        title: 'Add a keyword',
        description: 'Type one keyword — or <b>+ Add multiple</b> to paste a whole list. The domain comes from your project, and positions are checked the moment you add.',
        side: 'bottom', align: 'start',
      },
    },
    {
      element: '[data-tour="trk-actions"]',
      popover: {
        title: 'Keep it fresh',
        description: '<b>Refresh positions</b> re-checks right now. <b>Backfill history</b> pulls <i>past</i> rankings so your charts start full (it costs credits per keyword and always asks first). <b>Export CSV</b> and <b>Share</b> work like everywhere else.',
        side: 'bottom', align: 'end',
      },
    },
    {
      element: '[data-tour="trk-period"]',
      popover: {
        title: 'Pick your window',
        description: 'Zoom to the last 7, 28 or 90 days — or set an exact date range with <b>Custom</b>.',
        side: 'bottom', align: 'start',
      },
    },
    {
      element: '[data-tour="trk-summary"]',
      popover: {
        title: 'The headline read',
        description: 'How many keywords you track, your <b>average position</b>, how many sit in Google’s <b>top 10</b>, and your best rank — plus the combined trend over time.',
        side: 'top', align: 'start',
      },
    },
    {
      element: () => document.querySelector('[data-tour="trk-list"]'),
      popover: {
        title: 'One card per keyword',
        description:
          lead('Current position, movement since the start of the window (<b>▲ green = climbed</b> — lower numbers are better), the exact page that ranks, and the history chart.') +
          note('This is the real layout, exactly like your own tracking.'),
        side: 'top', align: 'start',
      },
    },
    {
      popover: {
        title: 'Confused by a chart? Just ask',
        description:
          lead('<b>Right-click</b> any card and Monty, the AI assistant, explains it in plain English — or tells you what to do about it.'),
      },
    },
    {
      popover: {
        title: 'That’s the tour — your turn',
        description:
          lead('We’ll clear the example now. Add your first keyword above — from then on it checks itself daily, no re-running needed.') +
          note('Replay this any time from the <b>Tour</b> button next to the title.'),
      },
    },
  ];
  hooks.preview?.();
  setTimeout(() => {
    run(steps, { onDone: () => { markSeen('tool:tracking'); hooks.clear?.(); } });
  }, 120);
}

// ── Platform tour (runs on the dashboard) ────────────────────────────────────
export function startPlatformTour() {
  const steps = [
    {
      popover: {
        title: 'Welcome to Digimetrics',
        description:
          lead(`${TOOLS.length} marketing tools in one workspace — SEO (getting found on Google), content writing, AI visibility (getting recommended by ChatGPT & co.) and your own Google data.`) +
          note('This tour takes about a minute — exit any time with <b>Esc</b>, replay it from the <b>?</b> in the top bar. Looking around never changes anything or spends credits.'),
      },
    },
    { element: '[data-tour="tools"]', popover: { title: 'All your tools live here', description: 'Every tool, grouped by job — <b>SEO</b> = rank on Google · <b>Content</b> = write things · <b>AI Visibility</b> = get mentioned by ChatGPT & co. · <b>Strategy</b> = plans & audits · <b>Integrations</b> = your own Google data. Click to open the catalogue and search by name or job. In the catalogue each tool shows its price per run — <b>green means free</b> — and a lock if it needs a higher plan (most locked tools still give you <b>one real preview run</b>).', side: 'right', align: 'start' } },
    { element: '[data-tour="pathway"]', popover: { title: 'Not sure where to start? Follow a plan', description: 'Pick a goal — more visitors, a healthier site, showing up in AI answers — and we turn it into a step-by-step plan: the exact tools to run, in order, ticking off as you go. Add one sentence about your business and hit <b>Personalise with AI</b> to tailor it. Prefer to explore on your own? Open <b>Tools</b> in the sidebar and browse the full catalogue.', side: 'top', align: 'start' } },
    { element: '[data-tour="plan-widget"]', popover: { title: 'Your plan follows you', description: 'Set a goal here and we turn it into a step-by-step plan. A progress bar then rides under the top nav on <b>every page</b> — it shows how far along you are and what to do next, with a <b>Start</b> button to jump straight in.', side: 'bottom', align: 'end' } },
    {
      element: 'main a[href^="/tool/"]',
      popover: {
        title: 'Open any tool from here',
        description:
          'Wherever you see a tool on your dashboard, it’s one click to open its own page. Every tool page has a <b>Tour</b> button that walks you through a real worked example — exactly like this — so it’s the fastest way to learn any tool you haven’t tried yet.',
        side: 'right',
        align: 'start',
      },
    },
    { element: '[data-tour="project-selector"]', popover: { title: 'Projects', description: 'A project is simply one website. Pick the active one here and every result is filed under it — and tools auto-fill its address so you type less.', side: 'bottom', align: 'end' } },
    { element: '[data-tour="credits"]', popover: { title: 'Your credits', description: `Credits are the app’s currency: most runs cost a few, free tools cost none. Your plan refills them every month (${PLANS.starter.monthlyCredits.toLocaleString()} on Starter, ${PLANS.pro.monthlyCredits.toLocaleString()} on Pro). Click to see where yours go.`, side: 'bottom', align: 'end' } },
    { element: '[data-tour="notifications"]', popover: { title: 'Notifications', description: 'Long runs (like the Social Media Audit) keep going server-side even if you close the tab — the ✅ lands here when the result is ready, along with scheduled-run and product updates.', side: 'bottom', align: 'end' } },
    { popover: { title: 'Rank tracking', description: 'Tell us which searches you care about and we’ll check your Google position for them automatically and chart it over time — no re-running by hand. Find it inside any project, or via the “Track a keyword” starter step.' } },
    { element: '[data-tour="account-menu"]', popover: { title: 'Connect your Google data', description: 'Open this menu and pick <b>Connect your data</b> — one click connects Search Console, Analytics and Google Ads. Those tools then cost <b>0 credits</b>: it’s your own data, pulled live.', side: 'bottom', align: 'end' } },
    { element: '[data-tour="nav-/projects"]', popover: { title: 'Projects & your runs', description: 'Everything you run is saved. Open <b>Projects</b> to manage your sites — and scroll down for <b>Runs</b>, where any past result can be re-opened or re-run with one click, no retyping.', side: 'bottom', align: 'start' } },
    { element: '[data-tour="nav-/schedules"]', popover: { title: 'Put tools on autopilot', description: 'Under <b>Schedules</b>, set almost any tool to re-run itself daily, weekly or monthly with your inputs saved. Each run lands in your history and shows <b>what changed</b> since last time. (The <b>Schedule</b> button on a tool does the same.)', side: 'bottom', align: 'start' } },
    { element: '[data-tour="assistant"]', popover: { title: 'Meet Monty, your AI assistant', description: 'Ask Monty anything — “what’s a backlink?”, “why did my traffic drop?”. He knows your account and the product, explains results, and can recommend and open the right tool for you. He’ll also pop up with timely tips as you work (you can turn that off in the chat panel).', side: 'bottom', align: 'end' } },
    {
      popover: {
        title: 'Ask about anything on screen',
        description:
          lead('<b>Right-click</b> any result, card or table row to ask Monty to explain it — or what to do about it.') +
          note('Only want one figure or phrase explained? <b>Highlight that text first</b>, then right-click, and it’ll explain just your selection.'),
      },
    },
    { element: '[data-tour="theme"]', popover: { title: 'Light or dark — your call', description: 'Cycle between light, dark and follow-your-system here. Every tool and report is styled for both.', side: 'bottom', align: 'end' } },
    { element: '[data-tour="account-menu"]', popover: { title: 'Account, billing & support', description: 'Your plan, usage, pricing and support tickets live in here.', side: 'bottom', align: 'end' } },
    {
      popover: {
        title: 'You’re set — start free',
        description:
          lead('Great first runs: <b>Caption Generator</b> and <b>Keyword Analysis</b> cost nothing, and the one-click <b>Site Health Check</b> scores your whole site.') +
          note('Every tool has a <b>Tour</b> button beside its name with a worked example. And whenever you’re unsure, ask Monty — no question is too basic.'),
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
