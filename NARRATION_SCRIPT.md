# DigiMetrics by MediaOne — Guided Tour Narration Script

**Audience:** Clients & potential investors
**Use:** Voiceover / live presenter script to run alongside the driver.js guided tours in `index.html`
**Running sample brand:** Extra Space Asia (Singapore self-storage, `extraspaceasia.com.sg`) — the same demo data baked into every tour, so the narration and the on-screen numbers always match.

**Format of each tool block**
- **How to use it** — 2–3 lines walking through what you input, what you click, and what comes back. This tracks the driver.js steps as they highlight on screen.
- `▸ The edge:` — 1–2 lines on what MediaOne does here that the tools clients already pay for cannot.

**The five edges to keep hammering** *(land at least one in every section)*
1. **One platform, every discipline** — competitors are single-lane point tools (Ahrefs, SEMrush, Hootsuite, Supermetrics). We're SEO + Social + Paid + GEO + reporting in one pane.
2. **Built by an agency, not a software vendor** — MediaOne runs real campaigns daily, so the platform ships things vendors never think to build: time-to-rank forecasts, pricing quotes, pitch-ready media plans.
3. **AI-native, and ahead on GEO** — legacy tools are bolting AI on; we built it in and already ship a full Generative-Engine-Optimisation suite.
4. **We aggregate best-of-breed data, we don't fight it** — Ahrefs, SE Ranking, GA4, Search Console and every ad network in one view. Clients keep what they trust; we make it one screen.
5. **Analysis becomes deliverables** — audits, quotes and reports come out client-ready and branded.

**Conventions**
- `[STAGE]` = what's on screen / which tour step is highlighted.
- Spelling is British (matches the in-app copy: "optimisation", "centre").
- Approx. runtime read straight through: **20–24 min**. Each discipline is self-contained — present any subset.

---

## 0. COLD OPEN — The MediaOne Thesis (≈60 sec)

> *[STAGE: Landing on the dashboard, full nav bar visible.]*
>
> "Every marketing team in this market runs the same broken stack — Ahrefs for backlinks, SEMrush for keywords, separate logins for Google Ads, Meta, GA4, Search Console, something else for social. A dozen tools, a dozen bills, none of them talking to each other.
>
> MediaOne is a working agency that got tired of that, so we built the platform we wished existed — DigiMetrics. Every discipline an agency runs — search, social, paid media, and the new frontier of AI search — in one command centre, pointed at one client.
>
> The difference: the point-tools were built by software companies guessing at how agencies work. This was built by the agency. Let me show you, using a real Singapore brand — Extra Space Asia — so every number is live, not a mock-up."

---

## 1. THE CONTROL CENTRE — Navigation (≈90 sec)
*Pairs with `initNavTour()`*

> *[STAGE: Highlight `#navbar`.]*
> "This top bar is the whole platform in one strip — a pill for each discipline (SEO, Social, GEO, Paid Media), the experience-mode selector, and your account. Click any pill to reveal that discipline's tools below.
> ▸ The edge: a client would normally need four separate products to cover this one toolbar."

> *[STAGE: Highlight `#seoNavItem`.]*
> "Click **SEO** and the organic-search tools fan out — keyword research, rank tracking, technical audits, on-page, schema. Pick a tool card and its panel opens beneath.
> ▸ The edge: this section alone matches Ahrefs *and* SEMrush — and it's one pill of five."

> *[STAGE: Highlight `#smmNavItem`.]*
> "**Social** opens the strategy and content engine — Strategy House, Content Pillars, and AI generators for captions and replies. Same click-to-open pattern as every discipline.
> ▸ The edge: social usually lives in a separate tool like Hootsuite; here it shares the same client and reporting."

> *[STAGE: Highlight `#geoNavItem`.]*
> "**GEO — Generative Engine Optimisation** opens the tools that get a brand cited by ChatGPT, Gemini and Perplexity. As search shifts to a single AI answer, this is the new page one.
> ▸ The edge: our biggest lead — the legacy SEO tools have almost nothing here; MediaOne ships a full GEO suite."

> *[STAGE: Highlight `#semNavItem`.]*
> "**Paid Media** connects Google Ads, Meta, LinkedIn, TikTok and GA4 — authorise once and live spend and conversions flow in.
> ▸ The edge: clients pay Supermetrics just to *aggregate* this; we aggregate it and act on it in the same place."

> *[STAGE: Highlight `#othersNavItem`.]*
> "**Others** holds the cross-discipline kit — Search Console, personas, media planning, landing-page audits, pricing quotes, the tender builder.
> ▸ The edge: pricing quotes and tenders — no analytics tool ships these, because no software vendor sits in an agency's sales pipeline. MediaOne does."

> *[STAGE: Highlight `#cockpitNavItem`.]*
> "And the **Cockpit** toggle opens a single live dashboard across every channel and client. We'll finish there.
> ▸ The edge: the cross-channel rollup no single-discipline tool can produce."

> *[STAGE: Highlight `#modeSelectorNavItem`.]*
> "Use the **mode selector** to switch between Basic, Intermediate and Advanced — it expands or hides tools to match the user. Your choice is saved automatically.
> ▸ The edge: the same platform scales from day-one user to power user with no retraining — where enterprise tools overwhelm newcomers and drive churn."

---

## 2. SEO — Organic Search (≈6–7 min)
*Tours: Strategy Engine, Keyword Analysis, Time to Rank, Keyword Mapping, Crawler Simulator, Technical SEO, On-Page, Schema, Rank Checker, Anchor Cleaner, Backlinks Explorer, Domain Analysis, GSC, SE Ranking, Ahrefs*

> "SEO is where the established players are strongest, so this is where we prove the platform — strategy, research, audit, fix, track, all in one product."

**AI Strategy Engine** *(`initStrategyEngineTour`)*
> "Drop in a domain and click Generate — it reads the whole site and returns a full SEO strategy: priorities, quick wins, and a phased roadmap. For Extra Space Asia it instantly recognises the self-storage vertical and tailors the plan to it.
> ▸ The edge: Ahrefs and SEMrush hand you raw data and leave the thinking to you. We start with the strategy — the agency's actual job — done."

**Keyword Analysis** *(`initKeywordAnalysisTour`)*
> "Enter a domain or a few seed keywords and run it. You get four tabs at once — similar keywords, terms you already rank for, keywords pulled from a competitor's page, and the live SERP — each one tagged with search intent and difficulty.
> ▸ The edge: the standalone tools make you stitch four reports together; we return them in one view, intent-scored and ready to act on."

**Time to Rank** *(card tool)*
> "Enter a keyword and your domain — it returns an evidence-based time-to-rank estimate, typically three to six months for a competitive term, faster for long-tail.
> ▸ The edge: no mainstream SEO tool forecasts this. It exists because an agency knows it's the question that wins or loses the first meeting."

**Keyword Mapping** *(`initKeywordMappingTour`)*
> "Feed it your keyword list and it maps each term to the page that should own it, flagging cannibalisation where two pages compete and gaps where a page is missing.
> ▸ The edge: the data tools dump keyword lists; we hand back an executable content blueprint — this page, this keyword, this intent."

**Google Crawler Simulator** *(`initCrawlerSimulatorTour`)*
> "Enter the site and run the crawl — it walks the site as Googlebot does and reports what the search engine actually sees: broken links, redirect chains, blocked pages, indexation issues.
> ▸ The edge: a dedicated crawler like Screaming Frog is another desktop tool to buy and run; here it's native, feeding the same report as everything else."

**Technical SEO** *(`initTechnicalSeoTour`)*
> "Run the audit and it returns a scored health report — Core Web Vitals, Lighthouse, GTmetrix and page speed — with the exact slow or broken pages named and a severity badge on each finding so you fix the red items first.
> ▸ The edge: we fuse multiple industry data sources into one scored audit, instead of making you open three tabs and reconcile them yourself."

**On-Page Optimisation** *(`initOnPageOptimisationTour`)*
> "Give it a URL and its target keyword — it grades the page and returns a prioritised checklist: titles, headings, meta, internal links, content depth, each item specific enough for a junior exec to execute.
> ▸ The edge: competitors tell you the score is 64; we tell you the eight changes that make it 90, and who can do each one."

**Schema Generator** *(`initSchemaGeneratorTour`)*
> "Pick the schema type and enter the details — it outputs valid structured-data markup ready to paste, no developer and no hand-coding.
> ▸ The edge: most platforms diagnose missing schema and stop there; we generate the fix, removing the developer bottleneck that usually kills the task."

**Rank Checker** *(`initRankCheckerTour`)*
> "Add your keywords and location, and it tracks positions over time, charting movement and flagging drops.
> ▸ The edge: a standalone rank tracker is a product clients buy on its own — here it's one tool of forty, feeding the same client report."

**Anchor Text Cleaner** *(`initAnchorTextCleanerTour`)*
> "Run it on a domain and it analyses your inbound anchor text, flagging an unnatural profile — too many exact-match anchors — and suggesting which links to disavow or rebalance.
> ▸ The edge: this is hard-won agency penalty-prevention know-how encoded as a tool, the kind the data vendors leave entirely to your expertise."

**Backlinks Explorer** *(`initBacklinksExplorerTour`)*
> *[STAGE: Headline metrics card.]*
> "Enter a domain, pick the scope (whole domain, host, or single URL), and click Analyse. For Extra Space Asia it pulls 1,667 backlinks from 602 referring domains, DR 49, spam score 2, and flags 24 broken links — then lets you drill into six views: overview, referring domains, anchor text, all backlinks, broken links, and a year-long history trend.
> ▸ The edge: this is Ahrefs-grade capability clients pay hundreds a month for — built in, beside every other discipline, on one screen."

**Domain Analysis** *(`initPageDomainTour`)*
> "Type any domain for a fast top-line read — authority, key metadata, overall health — the thirty-second look you take on a sales call or to size up a competitor.
> ▸ The edge: built for the agency's *sales* motion, not just delivery — a use case generic tools don't even consider."

**Google Search Console integration** *(`initGscTour`)*
> "Connect the client's Search Console once and their first-party Google data flows in — impressions, clicks, queries, indexing — across tabs for insights, URL inspection, sitemaps and indexing.
> ▸ The edge: we combine first-party Google data with third-party estimates in one place; most tools give you only one side and leave you to reconcile."

**SE Ranking & Ahrefs integrations** *(`initSeRankingTour`, `initAhrefsTour`)*
> "Authorise SE Ranking or Ahrefs and their data flows straight into the platform, enriched and combined with everything else — no copy-paste between tools.
> ▸ The edge: we don't ask anyone to abandon the tools they trust; we sit on top and make them one screen — adopting MediaOne is a low-risk *yes*, not a rip-and-replace."

---

## 3. GEO — AI Search Visibility (≈3.5 min)
*Tours: AI Discovery, AI Mentions, llms.txt, GEO On-Page, Forensic Audit*
*(The section that most separates MediaOne from the field — give it room.)*

> "When someone asks ChatGPT 'where should I store my furniture in Singapore?' — does it name your client? The incumbents have almost no answer to that. We built a whole discipline around it."

**AI Discovery Audit** *(`initAiDiscoveryTour`)*
> "Enter a brand and run the audit — it checks how visible the brand is across ChatGPT, Gemini and Perplexity, and what those assistants actually say about it.
> ▸ The edge: legacy SEO platforms are only beginning to acknowledge AI search; MediaOne already audits it as a standard deliverable."

**AI Mentions** *(`initAiMentionsTour`)*
> "Add the keywords or topics you care about and it tracks, term by term, whether the AI assistants cite your brand — and charts how that's trending.
> ▸ The edge: it's rank tracking for AI answers. The first agencies to *measure* this win the accounts, and MediaOne can measure it today."

**llms.txt Generator** *(`initLlmsTour`)*
> "Enter the site and it generates a ready-to-publish `llms.txt` file — the emerging standard that tells AI crawlers what your site is and what to surface.
> ▸ The edge: first-mover infrastructure — we hand clients the file that gets them cited while their competitors don't know it exists."

**GEO On-Page Optimisation** *(`initGeoOnPageTour`)*
> "Give it a page and it returns GEO-specific recommendations — how to structure the content so language models prefer to quote and cite it.
> ▸ The edge: optimising for the AI answer, not just the blue link — a craft the established tools have no product for yet."

**GEO + SEO Forensic Audit** *(`initForensicAuditTour`)*
> "Enter a target URL and client name, let it auto-fill, then run — eight guided steps score the site on *both* traditional SEO and GEO (domain authority, mobile page speed, llms.txt presence) and auto-generate a prioritised, client-ready recommendations report.
> ▸ The edge: there's no comparable single audit that grades old-world and new-world search together. This is the report that wins the GEO pitch — and only MediaOne produces it."

---

## 4. SOCIAL MEDIA (≈3 min)
*Tours: Social Strategy House, Content Pillars, Caption Generator, Response Generator, Social Report*

> "Social normally lives in its own disconnected tool. Here it's part of the same client picture as search and paid."

**Social Media Strategy House** *(`initSmsTour`)*
> "Work through the canvas — objectives, audiences, channels, message — and it frames the entire social plan in one structured view before a single post goes out.
> ▸ The edge: scheduling tools help you *post*; they don't help you decide what to post or why. We start where the strategy does."

**Content Pillar Framework** *(`initPillarTour`)*
> "Define your brand's core themes and it organises content into strategic pillars, each mapped back to business goals, so the calendar is coherent instead of random.
> ▸ The edge: it brings the same strategic rigour to social that our SEO side brings to keywords — the agency mindset, encoded."

**Caption Generator** *(`initContentGenTour`)*
> "Give it the post context and platform, and it drafts on-brand captions in seconds, in the brand's voice.
> ▸ The edge: it's AI generation tuned to the pillars and strategy already in the platform — not a generic chatbot in a separate window with no context."

**Response Generator** *(`initResponseGenTour`)*
> "Paste in a comment or DM and it drafts an on-tone reply, keeping voice consistent even at high volume.
> ▸ The edge: most social suites stop at publishing; we cover the engagement layer too, and the AI already knows the brand."

**Social Media Audit & Report Analyser** *(`initSocialMediaReportTour`)*
> "Upload or connect the performance data and it reads the numbers back as a plain-language narrative — what's working, what isn't, and what to do next.
> ▸ The edge: it interprets the metrics the way an account manager would in the meeting, instead of just charting them like every dashboard tool."

---

## 5. PAID MEDIA / SEM (≈3 min)
*Tours: Google Ads, GA4, Meta, LinkedIn, TikTok, Performance Marketing, SEM Benchmark, SEM Gen*

> "Every major ad network, one platform, live data — and on the same screen as the organic and social work."

**Google Ads** *(`initGoogleAdsTour`)*
> "Connect the account and it pulls live spend, then diagnoses it — surfacing AI-driven recommendations to cut waste and lift ROAS, specific down to the campaign and keyword.
> ▸ The edge: reporting connectors show you the spend; we tell you what to *do* about it."

**Google Analytics 4 (GA4)** *(`initGa4Tour`)*
> "Connect GA4 and it ties ad spend back to real conversions, with audit, funnel and real-time views layered on top of the raw data.
> ▸ The edge: GA4 is notoriously hard to read; we make it usable and connect it to the campaigns driving it, in one tool."

**Meta, LinkedIn & TikTok Ads** *(`initMetaAdsTour`, `initLinkedInAdsTour`, `initTikTokAdsTour`)*
> "Authorise each network and it pulls performance with the same diagnostics and recommendations — Facebook, Instagram, LinkedIn and TikTok, one client, one screen.
> ▸ The edge: managing these natively means four ad managers and four logins; we unify them and sit them beside the client's SEO and social."

**Performance Marketing Audit** *(`initPerformanceMarketingTour`)*
> "Run it across the connected channels and it grades overall PPC efficiency — where budget works and where it leaks — as one executive read rather than per-platform stats.
> ▸ The edge: a true cross-network efficiency view no single ad platform can give, because each one only sees its own spend."

**SEM Benchmark** *(`initSemBenchmarkTour`)*
> "Enter the client and competitors and it shows how their paid search stacks up — the context that turns a flat report into a sales conversation.
> ▸ The edge: competitive paid benchmarking, built into the same place you manage the campaigns."

**SEM Analysis & Generation** *(`initSemTour`)*
> "Feed it the keywords and intent and it writes the ad copy — headlines and descriptions ready to ship — straight from the analysis.
> ▸ The edge: from diagnosis to ready-to-launch ad copy in one tool; competitors hand you data and leave the writing to you."

---

## 6. OTHERS — Cross-Channel & Commercial Toolkit (≈3 min)
*Tours: Competitors, Persona, Media Plan, Content Optimiser, Landing Page Audit, Pricing Quote, WorkDuo*
*(The clearest proof the platform was built by an agency, not a vendor.)*

**Competitors Identifier** *(`initCompetitorsTour`)*
> "Enter the client's domain and it auto-discovers and profiles who actually competes for the same search and audience — not who they assume.
> ▸ The edge: competitor discovery as an automated step that feeds straight into the keyword and content tools beside it."

**Persona Generator** *(`initPersonaTour`)*
> "Give it the brand and product and it builds buyer personas in minutes — motivations, objections, channels.
> ▸ The edge: persona work usually lives in a slide deck nobody updates; here it's a live input the content tools can actually use."

**Media Plan** *(`initMediaPlanTour`)*
> "Enter the brief and budget and it generates an execution-ready, MediaOne-style media plan — channels, budgets, timelines — the document that wins the pitch.
> ▸ The edge: this is MediaOne's own planning format, productised. No analytics vendor ships a pitch-winning media plan, because none of them have had to win a pitch."

**AI Content Optimiser / Checker** *(`initAiContentOptimiserTour`)*
> "Give it a topic or URL and it runs the whole content line — decides optimise vs rewrite, compares you against the pages ranking above you, builds an outline, generates the draft, checks compliance, and even translates it, with eighteen specialist AI agents under the hood.
> ▸ The edge: rivals offer a 'content score'; we run the entire production line, benchmarked against the pages actually beating you."

**Landing Page Audit** *(`initLandingPageAuditTour`)*
> "Drop in a landing-page URL and it scores conversion readiness — the elements that turn earned traffic into actual conversions.
> ▸ The edge: most tools stop at getting the click; we follow it to the conversion, where the client's revenue is."

**Pricing Quote** *(`initPricingQuoteTour`)*
> "Select the services and scope and it generates a costed, presentable client quote on the spot.
> ▸ The edge: no marketing-analytics product does pricing, because none of them sit in an agency's sales process. MediaOne does — every day."

**WorkDuo AI Visibility** *(`initWorkDuoTour`)*
> "Connect WorkDuo and it adds another layer of competitive AI-visibility intelligence on top of our own GEO suite.
> ▸ The edge: even our integrations point at the AI-search frontier the incumbents are still ignoring."

---

## 7. THE COCKPIT — The Payoff (≈2.5 min)
*Pairs with `initCockpitTour()`*

> *[STAGE: Open Cockpit, full card grid visible.]*
> "Everything we've just seen rolls up here. The Cockpit answers the one question an agency owner asks every morning: *what needs my attention today?*"

> *[STAGE: Walk the cards.]*
> "Each card is a live channel: SEO campaign trajectory, Google Ads and Meta recommendations, cross-network paid intel — spend, CPA, ROAS — Search Console and GA4 rollups, AI Visibility for GEO, NPS for client sentiment, and a Performance Intelligence summary that fuses every source into one read. Click any card to drill in; export any view to CSV for the client deck."

> *[STAGE: Expand a card / export CSV.]*
> "▸ The edge — and land this hardest: this view is structurally impossible for a single-discipline tool to build. Ahrefs can't show paid. Hootsuite can't show rankings. A reporting connector can chart but can't *act*. The Cockpit only exists because everything underneath it is one platform — and it's the screen that keeps clients renewing, because the value is visible every single day."

---

## 8. CLOSE — For Investors (≈60 sec)

> *[STAGE: Back to full dashboard.]*
>
> "So — what makes this defensible. Three things.
>
> First, **scope.** Forty-plus tools across SEO, social, paid and AI search in one platform. Every competitor is a point tool in one lane; replicating all five lanes *and* unifying them is years of work.
>
> Second, **provenance.** Built by MediaOne, a working agency, so it encodes what software vendors never think to build — time-to-rank forecasts, pricing quotes, tender responses, pitch-ready media plans. You can't reverse-engineer that from outside the agency.
>
> Third, **timing.** Search is moving to AI answers, and we already ship a full GEO suite while the incumbents are still retrofitting.
>
> The thesis is simple: one platform, one subscription, one screen — for an industry still paying a dozen bills for tools that don't talk to each other. That's the consolidation play, and MediaOne is the team positioned to run it. Let's talk about where it goes next."

---

## Appendix — Tool → Tour Quick Map (for the operator)

| Discipline | Tool | Tour function |
|---|---|---|
| — | Navigation / welcome | `initNavTour` |
| — | Experience modes | `initModeTour` |
| — | Account menu | `initAccountTour` |
| SEO | AI Strategy Engine | `initStrategyEngineTour` |
| SEO | Keyword Analysis | `initKeywordAnalysisTour` |
| SEO | Keyword Mapping | `initKeywordMappingTour` |
| SEO | Crawler Simulator | `initCrawlerSimulatorTour` |
| SEO | Technical SEO | `initTechnicalSeoTour` |
| SEO | On-Page Optimisation | `initOnPageOptimisationTour` |
| SEO | Schema Generator | `initSchemaGeneratorTour` |
| SEO | Rank Checker | `initRankCheckerTour` |
| SEO | Anchor Text Cleaner | `initAnchorTextCleanerTour` |
| SEO | Backlinks Explorer | `initBacklinksExplorerTour` |
| SEO | Domain Analysis | `initPageDomainTour` |
| SEO | Search Console | `initGscTour` |
| SEO | SE Ranking | `initSeRankingTour` |
| SEO | Ahrefs | `initAhrefsTour` |
| GEO | AI Discovery Audit | `initAiDiscoveryTour` |
| GEO | AI Mentions | `initAiMentionsTour` |
| GEO | llms.txt Generator | `initLlmsTour` |
| GEO | GEO On-Page | `initGeoOnPageTour` |
| GEO | Forensic Audit | `initForensicAuditTour` |
| SMM | Strategy House | `initSmsTour` |
| SMM | Content Pillars | `initPillarTour` |
| SMM | Caption Generator | `initContentGenTour` |
| SMM | Response Generator | `initResponseGenTour` |
| SMM | Social Report Analyser | `initSocialMediaReportTour` |
| SEM | Google Ads | `initGoogleAdsTour` |
| SEM | GA4 | `initGa4Tour` |
| SEM | Meta Ads | `initMetaAdsTour` |
| SEM | LinkedIn Ads | `initLinkedInAdsTour` |
| SEM | TikTok Ads | `initTikTokAdsTour` |
| SEM | Performance Marketing | `initPerformanceMarketingTour` |
| SEM | SEM Benchmark | `initSemBenchmarkTour` |
| SEM | SEM Analysis & Gen | `initSemTour` |
| Others | Competitors Identifier | `initCompetitorsTour` |
| Others | Persona Generator | `initPersonaTour` |
| Others | Media Plan | `initMediaPlanTour` |
| Others | AI Content Optimiser | `initAiContentOptimiserTour` |
| Others | Landing Page Audit | `initLandingPageAuditTour` |
| Others | WorkDuo | `initWorkDuoTour` |
| Cockpit | Cockpit dashboard | `initCockpitTour` |

*Sequential playback of all available tours is driven by `runSequentialTours()` (gated by which tools are visible in the current experience mode).*
