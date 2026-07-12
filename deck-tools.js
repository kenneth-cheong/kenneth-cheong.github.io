/* ═══════════════════════════════════════════════════════════════════════════
   deck-tools.js — shared slide-deck pipeline for the MediaOne AI chatbot
   Used by BOTH index.html (#aiChatbotPanel) and chatbot.html. Single source of
   truth for: ```slides JSON parsing (+ truncation salvage), the locked
   MediaOne brand normalisation, in-chat visual preview + fullscreen Present
   mode, light editing (reorder / delete / retitle / Edit-with-AI), .pptx
   export (PptxGenJS 4, slide masters, logo, speaker notes, native charts),
   Gamma prompt copy + Generate-in-Gamma (via monday Lambda), and
   Create-in-Google-Slides (GIS access token).

   Pages integrate via:
     DeckTools.init({ onEditWithAI, backendCall, getGoogleToken, openInEditor })
     DeckTools.scanAndRender(messageEl)  // inside their message post-processor
   Everything else (buttons, modal, exports) is self-contained.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';
    if (window.DeckTools) return;

    /* ── Config (pages override via DeckTools.init) ───────────────────────── */
    const cfg = {
        logoUrl: 'MO_Logo2.png',   // same-origin brand mark (721×721 blue tile)
        onEditWithAI: null,        // fn(deck, deckId) → prefill the chat input
        backendCall: null,         // async fn(action, data) → {ok,status,json} (monday Lambda)
        getGoogleToken: null,      // async fn() → Google access token w/ presentations scope
        openInEditor: null,        // fn(deck) → open deck in the Tender editor (index.html)
        gammaEnabled: true,
    };

    const esc = (s) => String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    /* ── Lazy CDN loaders ─────────────────────────────────────────────────── */
    const _scriptCache = {};
    function ensureScript(url, testFn) {
        if (testFn && testFn()) return Promise.resolve();
        if (!_scriptCache[url]) {
            _scriptCache[url] = new Promise((res, rej) => {
                const s = document.createElement('script');
                s.src = url; s.async = true;
                s.onload = () => res(); s.onerror = () => { delete _scriptCache[url]; rej(new Error('load failed: ' + url)); };
                document.head.appendChild(s);
            });
        }
        return _scriptCache[url];
    }
    const ensurePptx = () => ensureScript('https://cdn.jsdelivr.net/npm/pptxgenjs@4.0.1/dist/pptxgen.bundle.js', () => typeof window.PptxGenJS !== 'undefined');
    const ensureSortable = () => ensureScript('https://cdn.jsdelivr.net/npm/sortablejs@1.15.6/Sortable.min.js', () => typeof window.Sortable !== 'undefined');
    const ensureJsonRepair = () => ensureScript('https://cdn.jsdelivr.net/npm/jsonrepair@3.13.1/lib/umd/jsonrepair.min.js', () => !!(window.JSONRepair && window.JSONRepair.jsonrepair));

    /* ── Brand + schema constants ─────────────────────────────────────────── */
    // Locked MediaOne palette — the model supplies CONTENT only; brand is code-owned.
    const T = { primary: '1E3A8A', accent: 'F97316', text: '1E293B', muted: '64748B', bg: 'FFFFFF', band: 'EFF4FF', chip: 'FFF7ED', zebra: 'F8FAFC', line: 'E2E8F0', good: '10B981', bad: 'EF4444' };
    const FF = 'Barlow';
    const CSSF = "'Barlow','Segoe UI',Arial,sans-serif";

    const DECK_SLIDE_TYPES = new Set(['title', 'section', 'agenda', 'bullets', 'metrics', 'stats', 'pillars', 'twocol', 'table', 'quote', 'timeline', 'chart', 'closing']);
    const DECK_LIMITS = { stats: 4, metrics: 4, pillars: 5, bullets: 6, twocol: 6, agenda: 8, tableRows: 10, tableCols: 6, timeline: 6, notes: 2000, slides: 30 };
    // Synonyms the model reaches for, mapped to a rendered layout (keys alpha-only).
    const DECK_TYPE_ALIASES = {
        cover: 'title', hero: 'title', intro: 'title', opening: 'title', titleslide: 'title',
        thanks: 'closing', thankyou: 'closing', cta: 'closing', end: 'closing', outro: 'closing', contact: 'closing', conclusion: 'closing',
        divider: 'section', sectionheader: 'section', chapter: 'section', header: 'section',
        toc: 'agenda', contents: 'agenda', tableofcontents: 'agenda', outline: 'agenda',
        list: 'bullets', points: 'bullets', content: 'bullets', text: 'bullets', bullet: 'bullets', paragraph: 'bullets', summary: 'bullets', overview: 'bullets',
        kpi: 'metrics', kpis: 'metrics', numbers: 'metrics', results: 'metrics', metric: 'metrics',
        stat: 'stats', statistics: 'stats', proofpoints: 'stats', trackrecord: 'stats', achievements: 'stats',
        comparison: 'twocol', compare: 'twocol', versus: 'twocol', vs: 'twocol', twocolumn: 'twocol', columns: 'twocol', sidebyside: 'twocol',
        steps: 'pillars', process: 'pillars', strategy: 'pillars', phases: 'pillars', pillar: 'pillars', approach: 'pillars',
        roadmap: 'timeline', schedule: 'timeline', milestones: 'timeline', plan: 'timeline', gantt: 'timeline',
        testimonial: 'quote', quotes: 'quote', pullquote: 'quote',
        matrix: 'table', grid: 'table', pricing: 'table', datatable: 'table',
        graph: 'chart', data: 'chart', diagram: 'chart',
    };

    /* ── Normalisation (strict enforcement choke point) ───────────────────── */
    // Flatten an unrecognised (or data-less) slide into bullets so NOTHING is lost.
    function coerceSlideToBullets(s) {
        let bullets = [];
        for (const key of ['bullets', 'items', 'points', 'lines', 'content', 'list']) {
            if (Array.isArray(s[key])) {
                bullets = s[key].map(x => typeof x === 'string' ? x : (x && (x.text || x.label || x.title || x.value)) || '').filter(Boolean);
                if (bullets.length) break;
            }
        }
        if (!bullets.length) {
            bullets = Object.keys(s)
                .filter(k => k !== 'type' && k !== 'title' && k !== 'notes' && typeof s[k] === 'string' && s[k].trim())
                .map(k => s[k].trim());
        }
        const out = { type: 'bullets', title: typeof s.title === 'string' ? s.title : '', bullets: bullets.slice(0, DECK_LIMITS.bullets) };
        if (typeof s.notes === 'string' && s.notes.trim()) out.notes = s.notes.trim().slice(0, DECK_LIMITS.notes);
        return out;
    }

    function normalizeDeck(input) {
        const d = (input && typeof input === 'object') ? input : {};
        const title = typeof d.title === 'string' && d.title.trim() ? d.title.trim() : 'Presentation';
        const subtitle = typeof d.subtitle === 'string' ? d.subtitle.trim() : '';

        let slides = (Array.isArray(d.slides) ? d.slides : [])
            .filter(s => s && typeof s === 'object')
            .map(s => {
                // Styling is owned by the renderer — strip anything the model injected.
                ['color', 'background', 'bg', 'theme', 'accent', 'style', 'font', 'fontFace', 'css'].forEach(k => delete s[k]);
                const notes = (typeof s.notes === 'string' && s.notes.trim()) ? s.notes.trim().slice(0, DECK_LIMITS.notes) : null;

                let type = DECK_SLIDE_TYPES.has(s.type)
                    ? s.type
                    : DECK_TYPE_ALIASES[String(s.type || '').toLowerCase().replace(/[^a-z]/g, '')];

                // A content layout is only valid if its data field is present.
                const hasData = {
                    bullets: Array.isArray(s.bullets),
                    agenda: Array.isArray(s.items),
                    metrics: Array.isArray(s.metrics),
                    stats: Array.isArray(s.stats),
                    pillars: Array.isArray(s.pillars),
                    twocol: s.twocol && typeof s.twocol === 'object',
                    table: Array.isArray(s.rows),
                    quote: typeof s.quote === 'string' && s.quote.trim(),
                    timeline: Array.isArray(s.milestones),
                    chart: s.chart && typeof s.chart === 'object',
                };
                if (!type || (type in hasData && !hasData[type])) {
                    const c = coerceSlideToBullets(s);
                    if (notes) c.notes = notes;
                    return c;
                }

                s.type = type;
                if (notes) s.notes = notes; else delete s.notes;
                if (type === 'stats') s.stats = s.stats.slice(0, DECK_LIMITS.stats);
                if (type === 'metrics') s.metrics = s.metrics.slice(0, DECK_LIMITS.metrics);
                if (type === 'pillars') s.pillars = s.pillars.slice(0, DECK_LIMITS.pillars);
                if (type === 'bullets') s.bullets = s.bullets.slice(0, DECK_LIMITS.bullets);
                if (type === 'agenda') s.items = s.items.map(x => typeof x === 'string' ? x : (x && (x.text || x.title)) || '').filter(Boolean).slice(0, DECK_LIMITS.agenda);
                if (type === 'timeline') s.milestones = s.milestones.filter(m => m && typeof m === 'object').slice(0, DECK_LIMITS.timeline);
                if (type === 'quote') { s.quote = s.quote.trim().slice(0, 400); if (s.attribution != null) s.attribution = String(s.attribution).slice(0, 120); }
                if (type === 'table') {
                    s.columns = (Array.isArray(s.columns) ? s.columns : []).map(c => String(c ?? '')).slice(0, DECK_LIMITS.tableCols);
                    s.rows = s.rows.filter(Array.isArray).slice(0, DECK_LIMITS.tableRows)
                        .map(r => r.map(c => String(c ?? '')).slice(0, DECK_LIMITS.tableCols));
                }
                if (type === 'twocol') {
                    ['left', 'right'].forEach(side => {
                        if (s.twocol[side] && Array.isArray(s.twocol[side].items)) {
                            s.twocol[side].items = s.twocol[side].items.slice(0, DECK_LIMITS.twocol);
                        }
                    });
                }
                return s;
            });

        // Guarantee a title slide first and a closing slide last; cap total length.
        if (!slides.length || slides[0].type !== 'title') slides.unshift({ type: 'title', title, subtitle });
        if (slides[slides.length - 1].type !== 'closing') slides.push({ type: 'closing', title: 'Thank you', subtitle: '' });
        if (slides.length > DECK_LIMITS.slides) slides = slides.slice(0, DECK_LIMITS.slides - 1).concat([slides[slides.length - 1]]);

        const deck = { title, subtitle, theme: 'mediaone', slides };
        if (d._recovered) deck._recovered = true;
        return deck;
    }

    /* ── Parsing + truncation salvage ─────────────────────────────────────── */
    // Character scanner: recover every COMPLETE slide object from a truncated
    // ```slides block, then close the array/root so JSON.parse succeeds.
    function salvageDeckJson(txt) {
        const m = txt.match(/"slides"\s*:\s*\[/);
        if (!m) return null;
        const arrStart = m.index + m[0].length;
        let depth = 0, inStr = false, escp = false, lastComplete = -1;
        for (let i = arrStart; i < txt.length; i++) {
            const c = txt[i];
            if (inStr) { if (escp) escp = false; else if (c === '\\') escp = true; else if (c === '"') inStr = false; continue; }
            if (c === '"') { inStr = true; continue; }
            if (c === '{') depth++;
            else if (c === '}') { depth--; if (depth === 0) lastComplete = i; }
            else if (c === ']' && depth === 0) return null; // array closed properly — not a truncation
        }
        if (lastComplete < 0) return null;
        try {
            const p = JSON.parse(txt.slice(0, lastComplete + 1) + ']}');
            if (p && Array.isArray(p.slides) && p.slides.length) { p._recovered = true; return p; }
        } catch (e) { /* fall through */ }
        return null;
    }

    function parseDeckText(txt) {
        txt = String(txt || '').trim();
        if (!txt.startsWith('{')) return null;
        try {
            const p = JSON.parse(txt);
            return (p && Array.isArray(p.slides) && p.slides.length) ? p : null;
        } catch (e) { /* continue to repair paths */ }
        if (window.JSONRepair && window.JSONRepair.jsonrepair) {
            try {
                const p = JSON.parse(window.JSONRepair.jsonrepair(txt));
                if (p && Array.isArray(p.slides) && p.slides.length) { p._recovered = true; return p; }
            } catch (e) { /* continue */ }
        } else {
            ensureJsonRepair().catch(() => { }); // warm for future messages
        }
        return salvageDeckJson(txt);
    }

    /* ── Store ─────────────────────────────────────────────────────────────── */
    const _deckStore = {};
    let _deckCounter = 0;

    /* ── Injected styles (preview, present, editing) ──────────────────────── */
    function injectStyles() {
        if (document.getElementById('dk-styles')) return;
        const st = document.createElement('style');
        st.id = 'dk-styles';
        st.textContent = `
.deck-card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;margin:10px 0;overflow:hidden;font-family:${CSSF}}
.deck-card-head{display:flex;align-items:center;gap:10px;padding:14px 16px;background:linear-gradient(135deg,#1e3a8a,#2a4a9e);color:#fff}
.deck-card-head .deck-icon{font-size:1.25rem;opacity:.95}
.deck-card-head .deck-titles{flex:1;min-width:0}
.deck-card-head .deck-title{font-weight:700;font-size:.95rem;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.deck-card-head .deck-sub{font-size:.72rem;opacity:.85;margin-top:2px}
.dk-badge{font-size:.62rem;font-weight:700;letter-spacing:.04em;background:#f97316;color:#fff;border-radius:999px;padding:3px 8px;white-space:nowrap}
.deck-card-body{padding:12px 16px}
.deck-card-actions{display:flex;flex-wrap:wrap;gap:8px;padding:12px 16px 16px;border-top:1px solid #f1f5f9}
.deck-btn{flex:1 1 auto;display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:9px 12px;border-radius:9px;font-size:.82rem;font-weight:600;cursor:pointer;border:1px solid transparent;transition:.15s;font-family:inherit}
.deck-btn-primary{background:#1e3a8a;color:#fff}.deck-btn-primary:hover{background:#16306e}
.deck-btn-ghost{background:#fff;color:#1e3a8a;border-color:#c7d6f5}.deck-btn-ghost:hover{background:#eff4ff}
.deck-btn.copied{background:#10b981;color:#fff;border-color:transparent}
.deck-btn:disabled{opacity:.55;cursor:default}
.dk-thumbs{display:flex;gap:10px;overflow-x:auto;padding:4px 2px 8px;scroll-snap-type:x proximity}
.dk-thumb{position:relative;flex:0 0 auto;width:176px;height:99px;border:1px solid #dbe3ef;border-radius:8px;overflow:hidden;cursor:pointer;background:#fff;scroll-snap-align:start;transition:box-shadow .15s,border-color .15s}
.dk-thumb:hover{border-color:#1e3a8a;box-shadow:0 2px 10px rgba(30,58,138,.18)}
.dk-thumb-scale{width:1280px;height:720px;transform:scale(.1375);transform-origin:0 0;pointer-events:none}
.dk-thumb-n{position:absolute;left:5px;bottom:4px;background:rgba(15,23,42,.72);color:#fff;font-size:.6rem;font-weight:700;border-radius:5px;padding:1px 6px}
.dk-thumb-notes{position:absolute;right:5px;top:4px;font-size:.62rem;background:rgba(249,115,22,.92);color:#fff;border-radius:5px;padding:1px 5px}
.dk-editlist{list-style:none;margin:0;padding:0;max-height:340px;overflow-y:auto}
.dk-editlist li{display:flex;align-items:center;gap:8px;padding:7px 0;font-size:.9rem;color:#334155;border-bottom:1px solid #f1f5f9}
.dk-editlist li:last-child{border-bottom:none}
.dk-editlist .deck-num{flex:0 0 24px;height:24px;border-radius:6px;background:#eff4ff;color:#1e3a8a;font-size:.78rem;font-weight:700;display:flex;align-items:center;justify-content:center}
.dk-editlist .deck-kind{margin-left:auto;font-size:.72rem;color:#94a3b8;text-transform:uppercase;letter-spacing:.03em}
.dk-h{cursor:grab;color:#94a3b8;font-size:1rem;padding:0 2px;user-select:none}
.dk-t{flex:1;min-width:0;outline:none;border-radius:4px;padding:2px 4px}
.dk-t:focus{background:#eff4ff;box-shadow:inset 0 0 0 1px #c7d6f5}
.dk-x{border:none;background:none;color:#cbd5e1;font-size:1.05rem;font-weight:700;cursor:pointer;padding:0 4px;line-height:1}
.dk-x:hover{color:#ef4444}
.dk-status{font-size:.78rem;color:#334155;padding:8px 16px 0;display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.dk-status a{color:#1e3a8a;font-weight:600}
.dk-slide{width:1280px;height:720px;background:#fff;position:relative;font-family:${CSSF};color:#1e293b;overflow:hidden;box-sizing:border-box}
.dk-slide *{box-sizing:border-box;margin:0}
.dk-foot{position:absolute;left:0;right:0;bottom:0;height:18px;background:#1e3a8a}
.dk-conf{position:absolute;left:86px;bottom:30px;font-size:13px;color:#64748b;letter-spacing:.05em}
.dk-pagen{position:absolute;right:86px;bottom:30px;font-size:14px;color:#64748b}
.dk-mark{position:absolute;top:34px;right:86px;display:flex;align-items:center;gap:10px;font-weight:800;font-size:19px;color:#1e3a8a;letter-spacing:.02em}
.dk-mark img{width:40px;height:40px;border-radius:9px;display:block}
.dk-ht{position:absolute;top:78px;left:86px;right:300px;font-size:40px;font-weight:800;line-height:1.15;color:#1e293b}
.dk-hbar{position:absolute;top:138px;left:86px;width:104px;height:8px;background:#f97316;border-radius:4px}
.dk-content{position:absolute;top:180px;left:86px;right:86px;bottom:70px}
.dk-s-title{background:#1e3a8a;color:#fff}
.dk-s-title .dk-brand{position:absolute;top:44px;left:86px;display:flex;align-items:center;gap:12px;font-weight:800;font-size:22px;letter-spacing:.03em;color:#fff}
.dk-s-title .dk-brand img{width:46px;height:46px;border-radius:10px}
.dk-s-title .dk-bar{position:absolute;top:288px;left:86px;width:134px;height:11px;background:#fff;border-radius:5px}
.dk-s-title h1{position:absolute;top:322px;left:86px;right:120px;font-size:64px;font-weight:800;line-height:1.12}
.dk-s-title .dk-subt{position:absolute;top:472px;left:86px;right:120px;font-size:26px;opacity:.92}
.dk-s-title .dk-foot2{position:absolute;left:0;right:0;bottom:0;height:18px;background:rgba(255,255,255,.28)}
.dk-s-section{background:#eff4ff}
.dk-s-section .dk-bar{position:absolute;left:0;top:230px;width:34px;height:260px;background:#1e3a8a}
.dk-s-section h2{position:absolute;left:86px;top:312px;right:120px;font-size:48px;font-weight:800;color:#1e293b}
.dk-s-closing{background:#1e3a8a;color:#fff}
.dk-s-closing .dk-brand{position:absolute;top:44px;left:86px;font-weight:800;font-size:22px;letter-spacing:.03em}
.dk-s-closing h1{position:absolute;top:300px;left:86px;right:86px;font-size:56px;font-weight:800;text-align:center}
.dk-s-closing .dk-subt{position:absolute;top:412px;left:86px;right:86px;font-size:24px;text-align:center;opacity:.92}
.dk-bullets{list-style:none;padding:0;display:flex;flex-direction:column;gap:20px}
.dk-bullets li{position:relative;padding-left:34px;font-size:26px;line-height:1.35;color:#1e293b}
.dk-bullets li::before{content:'';position:absolute;left:2px;top:12px;width:12px;height:12px;border-radius:3px;background:#f97316}
.dk-agenda{display:flex;flex-direction:column;gap:16px;counter-reset:ag}
.dk-agenda div{display:flex;align-items:center;gap:16px;font-size:24px;font-weight:600;color:#1e293b}
.dk-agenda i{font-style:normal;flex:0 0 44px;height:44px;border-radius:10px;background:#eff4ff;color:#1e3a8a;font-weight:800;font-size:19px;display:flex;align-items:center;justify-content:center}
.dk-cards{display:flex;gap:26px;align-items:stretch;height:100%;padding-top:26px}
.dk-mcard{flex:1;background:#eff4ff;border-radius:14px;padding:34px 18px;text-align:center;align-self:flex-start}
.dk-mcard .v{font-size:46px;font-weight:800;color:#1e3a8a}
.dk-mcard .l{font-size:18px;color:#1e293b;margin-top:10px}
.dk-mcard .c{font-size:17px;font-weight:700;margin-top:8px}
.dk-scard{flex:1;background:#eff4ff;border-radius:14px;padding:0 16px 20px;text-align:center;border-top:10px solid #f97316;align-self:flex-start}
.dk-scard .n{font-size:14px;font-weight:800;color:#f97316;margin-top:12px;letter-spacing:.06em}
.dk-scard .v{font-size:40px;font-weight:800;color:#1e3a8a;margin-top:6px}
.dk-scard .l{font-size:16.5px;font-weight:700;margin-top:8px;color:#1e293b}
.dk-scard .d{font-size:13.5px;color:#64748b;margin-top:6px;line-height:1.35}
.dk-pill{display:flex;flex-direction:column;gap:16px;padding-top:8px}
.dk-pill div{display:flex;gap:18px;align-items:flex-start}
.dk-pill i{font-style:normal;flex:0 0 64px;height:58px;border-radius:10px;background:#fff7ed;color:#f97316;font-weight:800;font-size:23px;display:flex;align-items:center;justify-content:center}
.dk-pill b{display:block;font-size:21px;color:#1e3a8a}
.dk-pill span{display:block;font-size:16.5px;color:#334155;margin-top:3px;line-height:1.3}
.dk-2col{display:flex;gap:30px;height:100%;padding-top:6px}
.dk-2col>div{flex:1;min-width:0}
.dk-2col .h{font-size:17px;font-weight:700;padding:12px 16px;border-radius:8px;margin-bottom:16px}
.dk-2col .hl{background:#f1f5f9;color:#64748b}
.dk-2col .hr{background:#1e3a8a;color:#fff;border-left:8px solid #f97316}
.dk-2col ul{list-style:none;padding:0;display:flex;flex-direction:column;gap:13px}
.dk-2col li{position:relative;padding-left:24px;font-size:17.5px;line-height:1.35;color:#1e293b}
.dk-2col li::before{content:'';position:absolute;left:2px;top:9px;width:9px;height:9px;border-radius:2px;background:#f97316}
.dk-table{width:100%;border-collapse:collapse;font-size:17px}
.dk-table th{background:#1e3a8a;color:#f1f5f9;font-weight:700;text-align:left;padding:12px 16px}
.dk-table td{padding:11px 16px;border-bottom:1px solid #e2e8f0;color:#1e293b}
.dk-table tr:nth-child(even) td{background:#f8fafc}
.dk-quote .qm{position:absolute;top:150px;left:86px;font-size:150px;font-weight:800;color:#f97316;line-height:1;font-family:Georgia,serif}
.dk-quote .qt{position:absolute;top:270px;left:150px;right:150px;font-size:31px;font-style:italic;line-height:1.45;text-align:center;color:#1e293b}
.dk-quote .qa{position:absolute;top:520px;left:150px;right:150px;font-size:19px;font-weight:700;color:#1e3a8a;text-align:center}
.dk-tl{position:relative;height:100%;padding-top:40px}
.dk-tl .ln{position:absolute;top:150px;left:40px;right:40px;height:5px;background:#cbd5e1;border-radius:3px}
.dk-tl .cols{display:flex;height:100%}
.dk-tl .col{flex:1;position:relative;padding:0 10px;text-align:center}
.dk-tl .dot{position:absolute;top:141px;left:50%;transform:translateX(-50%);width:22px;height:22px;border-radius:50%;background:#f97316;border:5px solid #fff;box-shadow:0 0 0 2px #f97316}
.dk-tl .dt{position:absolute;top:88px;left:0;right:0;font-size:16.5px;font-weight:800;color:#1e3a8a}
.dk-tl .tt{position:absolute;top:190px;left:6px;right:6px;font-size:16.5px;font-weight:700;color:#1e293b;line-height:1.25}
.dk-tl .dd{position:absolute;top:250px;left:6px;right:6px;font-size:13.5px;color:#64748b;line-height:1.35}
.dk-chartwrap{display:flex;align-items:center;justify-content:center;height:100%}
.dk-pr-overlay{position:fixed;inset:0;z-index:99999;background:rgba(9,14,28,.94);display:flex;align-items:center;justify-content:center;flex-direction:column}
.dk-pr-stagebox{position:relative;box-shadow:0 20px 70px rgba(0,0,0,.55);border-radius:6px;overflow:hidden}
.dk-pr-bar{position:fixed;top:16px;right:20px;display:flex;gap:10px;align-items:center}
.dk-pr-count{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);color:#cbd5e1;font-size:.85rem;font-family:${CSSF};letter-spacing:.05em}
.dk-pr-btn{background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.25);color:#fff;border-radius:9px;padding:8px 14px;font-size:.85rem;font-weight:600;cursor:pointer;font-family:${CSSF}}
.dk-pr-btn:hover{background:rgba(255,255,255,.22)}
.dk-pr-nav{position:fixed;top:50%;transform:translateY(-50%);background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.22);color:#fff;width:46px;height:66px;border-radius:12px;font-size:1.5rem;cursor:pointer;display:flex;align-items:center;justify-content:center}
.dk-pr-nav:hover{background:rgba(255,255,255,.22)}
.dk-pr-notes{position:fixed;left:0;right:0;bottom:0;max-height:26vh;overflow-y:auto;background:rgba(10,16,32,.97);color:#e2e8f0;font-size:.9rem;line-height:1.5;padding:14px 26px 18px;border-top:2px solid #f97316;font-family:${CSSF};display:none}
.dk-pr-notes b{color:#f97316;display:block;margin-bottom:4px;font-size:.72rem;letter-spacing:.08em}
.dk-toast{position:fixed;bottom:26px;left:50%;transform:translateX(-50%);z-index:100001;background:#0f172a;color:#f1f5f9;font-size:.85rem;font-weight:600;padding:11px 20px;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.35);font-family:${CSSF};max-width:82vw;text-align:center}
@media (max-width:640px){.dk-thumb{width:144px;height:81px}.dk-thumb-scale{transform:scale(.1125)}}
`;
        document.head.appendChild(st);
    }

    function toast(msg, ms) {
        document.querySelectorAll('.dk-toast').forEach(t => t.remove());
        const t = document.createElement('div');
        t.className = 'dk-toast'; t.textContent = msg;
        document.body.appendChild(t);
        setTimeout(() => t.remove(), ms || 3200);
    }

    /* ── HTML slide renderer (1280×720 design space) ──────────────────────── */
    const kindLabel = { title: 'Title', section: 'Section', agenda: 'Agenda', bullets: 'Content', metrics: 'Metrics', stats: 'Stats', pillars: 'Pillars', twocol: 'Compare', table: 'Table', quote: 'Quote', timeline: 'Timeline', chart: 'Chart', closing: 'Closing' };

    function logoImgTag() {
        return cfg.logoUrl ? `<img src="${esc(cfg.logoUrl)}" alt="" onerror="this.remove()">` : '';
    }

    function chromeHTML(num) {
        return `<div class="dk-mark">${logoImgTag()}MEDIAONE</div>
                <div class="dk-conf">CONFIDENTIAL &amp; PROPRIETARY&nbsp;&nbsp;|&nbsp;&nbsp;MEDIAONE</div>
                ${num != null ? `<div class="dk-pagen">${num}</div>` : ''}
                <div class="dk-foot"></div>`;
    }
    function headingHTML(s) {
        return `<div class="dk-ht">${esc(s.title || '')}</div><div class="dk-hbar"></div>`;
    }

    function slideHTML(s, deck, i, deckId) {
        const num = i + 1;
        if (s.type === 'title') {
            return `<div class="dk-slide dk-s-title">
                <div class="dk-brand">${logoImgTag()}MEDIAONE</div><div class="dk-bar"></div>
                <h1>${esc(s.title || deck.title || 'Presentation')}</h1>
                ${(s.subtitle || deck.subtitle) ? `<div class="dk-subt">${esc(s.subtitle || deck.subtitle)}</div>` : ''}
                <div class="dk-foot2"></div></div>`;
        }
        if (s.type === 'section') {
            return `<div class="dk-slide dk-s-section"><div class="dk-bar"></div><h2>${esc(s.title || '')}</h2></div>`;
        }
        if (s.type === 'closing') {
            return `<div class="dk-slide dk-s-closing"><div class="dk-brand">MEDIAONE</div>
                <h1>${esc(s.title || 'Thank you')}</h1>
                ${s.subtitle ? `<div class="dk-subt">${esc(s.subtitle)}</div>` : ''}</div>`;
        }

        let inner = '';
        if (s.type === 'bullets') {
            inner = `<ul class="dk-bullets">${(s.bullets || []).map(b => `<li>${esc(b)}</li>`).join('')}</ul>`;
        } else if (s.type === 'agenda') {
            inner = `<div class="dk-agenda">${(s.items || []).map((it, j) => `<div><i>${j + 1}</i>${esc(it)}</div>`).join('')}</div>`;
        } else if (s.type === 'metrics') {
            inner = `<div class="dk-cards">${(s.metrics || []).map(m => {
                const up = m.change != null && !String(m.change).trim().startsWith('-');
                return `<div class="dk-mcard"><div class="v">${esc(m.value ?? '')}</div><div class="l">${esc(m.label ?? '')}</div>${m.change != null ? `<div class="c" style="color:${up ? '#10b981' : '#ef4444'}">${esc(m.change)}</div>` : ''}</div>`;
            }).join('')}</div>`;
        } else if (s.type === 'stats') {
            inner = `<div class="dk-cards">${(s.stats || []).map(m =>
                `<div class="dk-scard">${m.num ? `<div class="n">${esc(m.num)}</div>` : ''}<div class="v">${esc(m.value ?? '')}</div>${m.label ? `<div class="l">${esc(m.label)}</div>` : ''}${m.desc ? `<div class="d">${esc(m.desc)}</div>` : ''}</div>`
            ).join('')}</div>`;
        } else if (s.type === 'pillars') {
            inner = `<div class="dk-pill">${(s.pillars || []).map((p, j) =>
                `<div><i>${esc(p.num ?? j + 1)}</i><div><b>${esc(p.title ?? '')}</b>${p.desc ? `<span>${esc(p.desc)}</span>` : ''}</div></div>`
            ).join('')}</div>`;
        } else if (s.type === 'twocol') {
            const tw = s.twocol || {};
            const col = (side, cls, defTitle) => `<div><div class="h ${cls}">${esc((tw[side] && tw[side].title) || defTitle)}</div><ul>${(((tw[side] || {}).items) || []).map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
            inner = `<div class="dk-2col">${col('left', 'hl', 'Current Status')}${col('right', 'hr', 'MediaOne Strategy')}</div>`;
        } else if (s.type === 'table') {
            const head = (s.columns && s.columns.length) ? `<thead><tr>${s.columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>` : '';
            inner = `<table class="dk-table">${head}<tbody>${(s.rows || []).map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
        } else if (s.type === 'quote') {
            return `<div class="dk-slide dk-quote">${chromeHTML(num)}${s.title ? headingHTML(s) : ''}
                <div class="qm">“</div><div class="qt">${esc(s.quote || '')}</div>
                ${s.attribution ? `<div class="qa">— ${esc(s.attribution)}</div>` : ''}</div>`;
        } else if (s.type === 'timeline') {
            const ms = s.milestones || [];
            inner = `<div class="dk-tl"><div class="ln"></div><div class="cols">${ms.map(m =>
                `<div class="col"><div class="dt">${esc(m.date ?? '')}</div><div class="dot"></div><div class="tt">${esc(m.title ?? m.event ?? '')}</div>${m.desc ? `<div class="dd">${esc(m.desc)}</div>` : ''}</div>`
            ).join('')}</div></div>`;
        } else if (s.type === 'chart') {
            inner = `<div class="dk-chartwrap"><canvas width="1040" height="430" data-dk-chart="${esc(deckId)}:${i}"></canvas></div>`;
        }

        return `<div class="dk-slide">${chromeHTML(num)}${headingHTML(s)}<div class="dk-content">${inner}</div></div>`;
    }

    // Instantiate Chart.js charts on any canvases inside `root` (previews + present).
    function mountCharts(root) {
        if (!window.Chart) return;
        root.querySelectorAll('canvas[data-dk-chart]').forEach(cv => {
            if (cv._dkMounted) return;
            cv._dkMounted = true;
            const [deckId, idx] = String(cv.dataset.dkChart).split(':');
            const deck = _deckStore[deckId];
            const s = deck && deck.slides[+idx];
            if (!s || !s.chart) return;
            try {
                let cc = JSON.parse(JSON.stringify(s.chart));
                cc.options = Object.assign({}, cc.options, {
                    responsive: false, animation: false,
                    devicePixelRatio: 2,
                });
                new window.Chart(cv.getContext('2d'), cc);
            } catch (e) {
                const d = document.createElement('div');
                d.style.cssText = 'font-size:20px;color:#94a3b8';
                d.textContent = '[chart could not be rendered]';
                cv.replaceWith(d);
            }
        });
    }

    function destroyCharts(root) {
        if (!window.Chart || !root) return;
        root.querySelectorAll('canvas[data-dk-chart]').forEach(cv => {
            const inst = window.Chart.getChart && window.Chart.getChart(cv);
            if (inst) inst.destroy();
        });
    }

    /* ── Deck card ─────────────────────────────────────────────────────────── */
    function thumbsHTML(deck, deckId) {
        return deck.slides.map((s, i) => `
            <div class="dk-thumb" onclick="dkPresent('${deckId}',${i})" title="Slide ${i + 1} — click to present">
                <div class="dk-thumb-scale">${slideHTML(s, deck, i, deckId)}</div>
                <span class="dk-thumb-n">${i + 1}</span>
                ${s.notes ? '<span class="dk-thumb-notes" title="Has speaker notes">&#9998;</span>' : ''}
            </div>`).join('');
    }

    function editRowsHTML(deck) {
        return deck.slides.map((s, i) => `
            <li data-i="${i}">
                <span class="dk-h" title="Drag to reorder">&#8801;</span>
                <span class="deck-num">${i + 1}</span>
                <span class="dk-t" contenteditable="true" spellcheck="false">${esc(s.title || (s.type === 'section' ? '(section)' : 'Untitled'))}</span>
                <span class="deck-kind">${kindLabel[s.type] || 'Slide'}</span>
                <button class="dk-x" title="Delete slide">&times;</button>
            </li>`).join('');
    }

    function buildCard(deck, deckId) {
        const card = document.createElement('div');
        card.className = 'deck-card';
        card.id = deckId;
        const editorBtn = cfg.openInEditor ? `<button class="deck-btn deck-btn-ghost" onclick="dkOpenEditor('${deckId}')" title="Open this deck in the slide editor">&#9998; Open in editor</button>` : '';
        const gslidesBtn = cfg.getGoogleToken ? `<button class="deck-btn deck-btn-ghost" onclick="dkGoogleSlides('${deckId}', this)" title="Create an editable Google Slides deck in your Drive">&#9707; Google Slides</button>` : '';
        const gammaBtn = (cfg.gammaEnabled && cfg.backendCall) ? `<button class="deck-btn deck-btn-ghost" onclick="dkGammaGenerate('${deckId}', this)" title="Generate this deck with Gamma AI">&#10024; Generate in Gamma</button>` : '';
        const aiBtn = cfg.onEditWithAI ? `<button class="deck-btn deck-btn-ghost" onclick="dkEditAI('${deckId}')" title="Ask the assistant to revise this deck">&#129302; Edit with AI</button>` : '';
        card.innerHTML = `
            <div class="deck-card-head">
                <i class="fas fa-display deck-icon"></i>
                <div class="deck-titles">
                    <div class="deck-title">${esc(deck.title || 'Presentation')}</div>
                    <div class="deck-sub">${esc(deck.subtitle || '')}${deck.subtitle ? ' · ' : ''}${deck.slides.length} slides</div>
                </div>
                ${deck._recovered ? '<span class="dk-badge" title="The slides block was cut off mid-stream; complete slides were recovered.">RECOVERED</span>' : ''}
            </div>
            <div class="deck-card-body">
                <div class="dk-thumbs">${thumbsHTML(deck, deckId)}</div>
                <ul class="dk-editlist" style="display:none">${editRowsHTML(deck)}</ul>
            </div>
            <div class="dk-status" style="display:none"></div>
            <div class="deck-card-actions">
                <button class="deck-btn deck-btn-primary" onclick="dkPresent('${deckId}',0)" title="Present fullscreen">&#9654; Present</button>
                <button class="deck-btn deck-btn-primary" onclick="downloadDeckPptx('${deckId}', this)" title="Download this presentation as a .pptx file">&#8595; Download .pptx</button>
                ${gslidesBtn}
                <button class="deck-btn deck-btn-ghost" onclick="dkToggleEdit('${deckId}', this)" title="Reorder, retitle or delete slides">&#9998; Edit</button>
                ${aiBtn}
                ${gammaBtn}
                <button class="deck-btn deck-btn-ghost" onclick="copyGammaPrompt('${deckId}', this)" title="Copy a prompt to recreate this deck in Gamma">&#128203; Copy Gamma prompt</button>
                ${editorBtn}
            </div>`;
        return card;
    }

    function syncCard(deckId) {
        const deck = _deckStore[deckId];
        const card = document.getElementById(deckId);
        if (!deck || !card) return;
        const thumbs = card.querySelector('.dk-thumbs');
        destroyCharts(thumbs);
        thumbs.innerHTML = thumbsHTML(deck, deckId);
        mountCharts(thumbs);
        const list = card.querySelector('.dk-editlist');
        list.innerHTML = editRowsHTML(deck);
        wireEditList(deckId, list);
        const sub = card.querySelector('.deck-sub');
        if (sub) sub.textContent = (deck.subtitle ? deck.subtitle + ' · ' : '') + deck.slides.length + ' slides';
    }

    /* ── Scan + render (page entry point) ─────────────────────────────────── */
    function tryRenderSlideDeck(code) {
        const parsed = parseDeckText(code.textContent);
        if (!parsed) return false;
        try {
            const deck = normalizeDeck(parsed);
            const deckId = 'deck-' + (++_deckCounter) + '-' + Date.now();
            _deckStore[deckId] = deck;
            const card = buildCard(deck, deckId);
            const pre = code.closest('pre');
            (pre || code).replaceWith(card);
            mountCharts(card);
            return true;
        } catch (e) {
            console.warn('[DeckTools] render error:', e);
            return false;
        }
    }

    function scanAndRender(el) {
        if (!el) return 0;
        injectStyles();
        let n = 0;
        el.querySelectorAll('code.language-slides').forEach(code => {
            if (tryRenderSlideDeck(code)) n++;
            else console.warn('[DeckTools] Parse error on language-slides block');
        });
        // Fallback: ```json or bare blocks whose content is slides JSON
        el.querySelectorAll('code.language-json, pre > code:not([class])').forEach(code => {
            if (code.closest('.deck-card')) return;
            const txt = (code.textContent || '').trim();
            if (!txt.startsWith('{') || !txt.includes('"slides"')) return;
            if (tryRenderSlideDeck(code)) n++;
        });
        return n;
    }

    /* ── Present mode ─────────────────────────────────────────────────────── */
    const present = { deckId: null, idx: 0, overlay: null, keyHandler: null };

    function presentRender() {
        const deck = _deckStore[present.deckId];
        if (!deck || !present.overlay) return;
        const s = deck.slides[present.idx];
        const stage = present.overlay.querySelector('.dk-pr-stage');
        destroyCharts(stage);
        stage.innerHTML = slideHTML(s, deck, present.idx, present.deckId);
        mountCharts(stage);
        present.overlay.querySelector('.dk-pr-count').textContent = (present.idx + 1) + ' / ' + deck.slides.length;
        const notes = present.overlay.querySelector('.dk-pr-notes');
        notes.innerHTML = s.notes ? '<b>SPEAKER NOTES</b>' + esc(s.notes) : '<b>SPEAKER NOTES</b><span style="opacity:.6">None for this slide.</span>';
        presentScale();
    }
    function presentScale() {
        if (!present.overlay) return;
        const box = present.overlay.querySelector('.dk-pr-stagebox');
        const sc = Math.min((window.innerWidth - 130) / 1280, (window.innerHeight - 120) / 720);
        box.style.width = (1280 * sc) + 'px';
        box.style.height = (720 * sc) + 'px';
        const stage = present.overlay.querySelector('.dk-pr-stage');
        stage.style.transform = 'scale(' + sc + ')';
        stage.style.transformOrigin = '0 0';
    }
    function presentClose() {
        if (!present.overlay) return;
        destroyCharts(present.overlay);
        present.overlay.remove();
        present.overlay = null;
        document.removeEventListener('keydown', present.keyHandler, true);
        window.removeEventListener('resize', presentScale);
    }
    window.dkPresent = function (deckId, idx) {
        const deck = _deckStore[deckId];
        if (!deck) return;
        presentClose();
        present.deckId = deckId; present.idx = idx || 0;
        const ov = document.createElement('div');
        ov.className = 'dk-pr-overlay';
        ov.innerHTML = `
            <div class="dk-pr-stagebox"><div class="dk-pr-stage" style="width:1280px;height:720px"></div></div>
            <div class="dk-pr-bar">
                <button class="dk-pr-btn" data-a="notes" title="Toggle speaker notes (N)">&#9998; Notes</button>
                <button class="dk-pr-btn" data-a="close" title="Close (Esc)">&times; Close</button>
            </div>
            <button class="dk-pr-nav" data-a="prev" style="left:18px" title="Previous (←)">&#8249;</button>
            <button class="dk-pr-nav" data-a="next" style="right:18px" title="Next (→)">&#8250;</button>
            <div class="dk-pr-count"></div>
            <div class="dk-pr-notes"></div>`;
        ov.addEventListener('click', (e) => {
            const a = e.target.closest('[data-a]');
            if (!a) { if (e.target === ov) presentClose(); return; }
            const act = a.dataset.a;
            if (act === 'close') presentClose();
            if (act === 'prev') { present.idx = Math.max(0, present.idx - 1); presentRender(); }
            if (act === 'next') { present.idx = Math.min(deck.slides.length - 1, present.idx + 1); presentRender(); }
            if (act === 'notes') { const n = ov.querySelector('.dk-pr-notes'); n.style.display = n.style.display === 'block' ? 'none' : 'block'; }
        });
        present.keyHandler = (e) => {
            if (e.key === 'Escape') { presentClose(); e.stopPropagation(); }
            else if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') { present.idx = Math.min(deck.slides.length - 1, present.idx + 1); presentRender(); e.preventDefault(); }
            else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { present.idx = Math.max(0, present.idx - 1); presentRender(); e.preventDefault(); }
            else if (e.key.toLowerCase() === 'n') { const n = ov.querySelector('.dk-pr-notes'); n.style.display = n.style.display === 'block' ? 'none' : 'block'; }
        };
        document.addEventListener('keydown', present.keyHandler, true);
        window.addEventListener('resize', presentScale);
        document.body.appendChild(ov);
        present.overlay = ov;
        presentRender();
        // A layout/resize can land right as the overlay opens (e.g. panes settling);
        // re-fit once the browser has painted so the first slide is never mis-scaled.
        requestAnimationFrame(presentScale);
    };

    /* ── Editing ──────────────────────────────────────────────────────────── */
    function wireEditList(deckId, list) {
        const deck = _deckStore[deckId];
        if (!deck || !list) return;
        list.querySelectorAll('li').forEach(li => {
            const i = +li.dataset.i;
            li.querySelector('.dk-x').onclick = () => {
                if (deck.slides.length <= 1) { toast('A deck needs at least one slide.'); return; }
                deck.slides.splice(i, 1);
                syncCard(deckId);
            };
            const t = li.querySelector('.dk-t');
            t.onblur = () => {
                const v = t.textContent.trim();
                if (deck.slides[i]) deck.slides[i].title = v;
                syncCard(deckId);
            };
            t.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); t.blur(); } };
        });
        if (window.Sortable && !list._dkSortable) {
            list._dkSortable = new window.Sortable(list, {
                handle: '.dk-h', animation: 120,
                onEnd: (evt) => {
                    if (evt.oldIndex === evt.newIndex) return;
                    const moved = deck.slides.splice(evt.oldIndex, 1)[0];
                    deck.slides.splice(evt.newIndex, 0, moved);
                    list._dkSortable.destroy(); list._dkSortable = null;
                    syncCard(deckId);
                }
            });
        }
    }
    window.dkToggleEdit = async function (deckId, btn) {
        const card = document.getElementById(deckId);
        if (!card) return;
        const list = card.querySelector('.dk-editlist');
        const thumbs = card.querySelector('.dk-thumbs');
        const editing = list.style.display === 'none';
        if (editing) {
            try { await ensureSortable(); } catch (e) { /* still allow retitle/delete */ }
            list.style.display = 'block'; thumbs.style.display = 'none';
            btn.innerHTML = '&#10003; Done';
            wireEditList(deckId, list);
        } else {
            list.style.display = 'none'; thumbs.style.display = 'flex';
            btn.innerHTML = '&#9998; Edit';
            syncCard(deckId);
        }
    };
    window.dkDeleteSlide = function (deckId, i) { // kept for programmatic use
        const deck = _deckStore[deckId];
        if (!deck || deck.slides.length <= 1) return;
        deck.slides.splice(i, 1);
        syncCard(deckId);
    };
    window.dkEditAI = function (deckId) {
        const deck = _deckStore[deckId];
        if (deck && cfg.onEditWithAI) cfg.onEditWithAI(deck, deckId);
    };
    window.dkOpenEditor = function (deckId) {
        const deck = _deckStore[deckId];
        if (deck && cfg.openInEditor) cfg.openInEditor(JSON.parse(JSON.stringify(deck)));
    };

    /* ── PPTX export (PptxGenJS 4, masters + logo + notes) ────────────────── */
    let _logoData = null, _logoTried = false;
    async function getLogoData() {
        if (_logoTried) return _logoData;
        _logoTried = true;
        try {
            const r = await fetch(cfg.logoUrl);
            if (!r.ok) throw new Error(r.status);
            const blob = await r.blob();
            _logoData = await new Promise((res, rej) => {
                const fr = new FileReader();
                fr.onload = () => res(fr.result); fr.onerror = rej;
                fr.readAsDataURL(blob);
            });
        } catch (e) { _logoData = null; }
        return _logoData;
    }

    async function downloadDeckPptx(deckId, btn) {
        const deck = _deckStore[deckId];
        if (!deck) return;
        const orig = btn ? btn.innerHTML : '';
        if (btn) { btn.disabled = true; btn.innerHTML = '&#8987; Building…'; }
        try {
            await ensurePptx();
            const logo = await getLogoData();
            const t = { primary: T.primary, accent: T.accent, text: T.text, muted: T.muted, bg: T.bg, band: T.band };
            const pptx = new PptxGenJS();
            pptx.defineLayout({ name: 'WIDE', width: 13.333, height: 7.5 });
            pptx.layout = 'WIDE';
            pptx.author = 'MediaOne';
            pptx.company = 'MediaOne';
            pptx.title = deck.title || 'Presentation';
            const W = 13.333, H = 7.5, MX = 0.9;

            // Masters: brand chrome lives on the master, not on every slide.
            const markObjs = logo
                ? [{ image: { x: W - 1.42, y: 0.26, w: 0.44, h: 0.44, data: logo } },
                   { text: { text: 'MEDIAONE', options: { x: W - 3.1, y: 0.26, w: 1.6, h: 0.44, align: 'right', valign: 'middle', fontSize: 11, bold: true, color: t.primary, fontFace: FF } } }]
                : [{ text: { text: 'MEDIAONE', options: { x: W - 2.5, y: 0.2, w: 1.8, h: 0.45, fontSize: 11, bold: true, color: t.primary, fontFace: FF, align: 'right' } } }];
            pptx.defineSlideMaster({
                title: 'MO_CONTENT',
                background: { color: t.bg },
                objects: [
                    { rect: { x: 0, y: H - 0.18, w: '100%', h: 0.18, fill: { color: t.primary } } },
                    { text: { text: 'CONFIDENTIAL & PROPRIETARY  |  MEDIAONE', options: { x: MX, y: H - 0.62, w: 6, h: 0.35, fontSize: 8, color: t.muted, fontFace: FF } } },
                    ...markObjs,
                ],
                slideNumber: { x: W - 0.95, y: H - 0.62, w: 0.6, h: 0.35, align: 'right', fontSize: 9, color: t.muted, fontFace: FF },
            });
            pptx.defineSlideMaster({
                title: 'MO_DARK',
                background: { color: t.primary },
                objects: logo
                    ? [{ image: { x: MX, y: 0.32, w: 0.5, h: 0.5, data: logo } },
                       { text: { text: 'MEDIAONE', options: { x: MX + 0.62, y: 0.32, w: 3, h: 0.5, fontSize: 16, bold: true, color: 'FFFFFF', fontFace: FF, valign: 'middle' } } }]
                    : [{ text: { text: 'MEDIAONE', options: { x: MX, y: 0.35, w: 3.5, h: 0.5, fontSize: 16, bold: true, color: 'FFFFFF', fontFace: FF } } }],
            });

            deck.slides.forEach((s, i) => {
                let slide;
                if (s.type === 'title') {
                    slide = pptx.addSlide({ masterName: 'MO_DARK' });
                    slide.addShape(pptx.ShapeType.rect, { x: MX, y: 3.0, w: 1.4, h: 0.12, fill: { color: 'FFFFFF' } });
                    slide.addText(s.title || deck.title || 'Presentation', { x: MX, y: 3.3, w: W - 2 * MX, h: 1.6, fontSize: 44, bold: true, color: 'FFFFFF', align: 'left', fontFace: FF });
                    if (s.subtitle || deck.subtitle) slide.addText(s.subtitle || deck.subtitle, { x: MX, y: 4.9, w: W - 2 * MX, h: 0.8, fontSize: 18, color: 'FFFFFF', align: 'left', fontFace: FF });
                    slide.addShape(pptx.ShapeType.rect, { x: 0, y: H - 0.18, w: W, h: 0.18, fill: { color: 'FFFFFF', transparency: 20 } });
                } else if (s.type === 'section') {
                    slide = pptx.addSlide();
                    slide.background = { color: t.band };
                    slide.addShape(pptx.ShapeType.rect, { x: 0, y: H / 2 - 0.9, w: 0.35, h: 1.8, fill: { color: t.primary } });
                    slide.addText(s.title || '', { x: MX, y: H / 2 - 1.0, w: W - 2 * MX, h: 2.0, fontSize: 34, bold: true, color: t.text, valign: 'middle', fontFace: FF });
                } else if (s.type === 'closing') {
                    slide = pptx.addSlide({ masterName: 'MO_DARK' });
                    slide.addText(s.title || 'Thank you', { x: MX, y: H / 2 - 1.0, w: W - 2 * MX, h: 1.4, fontSize: 40, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle', fontFace: FF });
                    if (s.subtitle) slide.addText(s.subtitle, { x: MX, y: H / 2 + 0.3, w: W - 2 * MX, h: 0.8, fontSize: 18, color: 'FFFFFF', align: 'center', fontFace: FF });
                } else {
                    slide = pptx.addSlide({ masterName: 'MO_CONTENT' });
                    slide.addText(s.title || '', { x: MX, y: 0.55, w: W - 2 * MX - 2.0, h: 0.8, fontSize: 26, bold: true, color: t.text, fontFace: FF });
                    slide.addShape(pptx.ShapeType.rect, { x: MX, y: 1.35, w: 1.1, h: 0.07, fill: { color: t.accent } });
                    addContentToSlide(pptx, slide, s, t, W, H, MX);
                }
                if (s.notes) slide.addNotes(s.notes);
            });

            const safe = (deck.title || 'presentation').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'presentation';
            await pptx.writeFile({ fileName: safe + '.pptx' });
            if (btn) { btn.innerHTML = '&#10003; Downloaded'; btn.classList.add('copied'); setTimeout(() => { btn.innerHTML = orig; btn.classList.remove('copied'); btn.disabled = false; }, 1800); }
        } catch (e) {
            console.error('[DeckTools] pptx export failed:', e);
            toast('PPTX export failed: ' + (e.message || e));
            if (btn) { btn.innerHTML = orig; btn.disabled = false; }
        }
    }
    window.downloadDeckPptx = downloadDeckPptx;

    function addContentToSlide(pptx, slide, s, t, W, H, MX) {
        if (s.type === 'metrics' && Array.isArray(s.metrics)) {
            const cards = s.metrics.slice(0, 4);
            const gap = 0.4, totalW = W - 2 * MX;
            const cw = (totalW - gap * (cards.length - 1)) / cards.length;
            cards.forEach((m, j) => {
                const x = MX + j * (cw + gap);
                slide.addShape(pptx.ShapeType.roundRect, { x, y: 2.4, w: cw, h: 2.4, rectRadius: 0.12, fill: { color: t.band }, line: { color: t.band } });
                slide.addText(String(m.value ?? ''), { x, y: 2.7, w: cw, h: 1.0, align: 'center', fontSize: 34, bold: true, color: t.primary, fontFace: FF });
                slide.addText(String(m.label ?? ''), { x, y: 3.75, w: cw, h: 0.5, align: 'center', fontSize: 14, color: t.text, fontFace: FF });
                if (m.change) {
                    const up = !String(m.change).trim().startsWith('-');
                    slide.addText(String(m.change), { x, y: 4.25, w: cw, h: 0.4, align: 'center', fontSize: 13, bold: true, color: up ? T.good : T.bad, fontFace: FF });
                }
            });
            return;
        }
        if (s.type === 'chart' && s.chart) {
            try {
                const built = chartToPptx(pptx, s.chart, t);
                slide.addChart(built.type, built.data, built.opts);
            } catch (e) {
                slide.addText('[chart could not be rendered]', { x: MX, y: 3, w: W - 2 * MX, h: 0.5, fontSize: 14, color: t.muted, fontFace: FF });
            }
            return;
        }
        if (s.type === 'stats' && Array.isArray(s.stats)) {
            const cards = s.stats.slice(0, 4);
            const gap = 0.4, totalW = W - 2 * MX;
            const cw = (totalW - gap * (cards.length - 1)) / cards.length;
            cards.forEach((m, j) => {
                const x = MX + j * (cw + gap);
                slide.addShape(pptx.ShapeType.roundRect, { x, y: 2.0, w: cw, h: 3.0, rectRadius: 0.12, fill: { color: t.band }, line: { color: t.band } });
                slide.addShape(pptx.ShapeType.rect, { x, y: 2.0, w: cw, h: 0.1, fill: { color: t.accent } });
                if (m.num) slide.addText(String(m.num), { x, y: 2.12, w: cw, h: 0.3, align: 'center', fontSize: 11, bold: true, color: t.accent, fontFace: FF });
                slide.addText(String(m.value ?? ''), { x, y: 2.45, w: cw, h: 0.9, align: 'center', fontSize: 30, bold: true, color: t.primary, fontFace: FF });
                if (m.label) slide.addText(String(m.label), { x, y: 3.4, w: cw, h: 0.5, align: 'center', fontSize: 13, bold: true, color: t.text, fontFace: FF });
                if (m.desc) slide.addText(String(m.desc), { x, y: 3.9, w: cw, h: 0.65, align: 'center', fontSize: 11, color: t.muted, fontFace: FF });
            });
            return;
        }
        if (s.type === 'pillars' && Array.isArray(s.pillars)) {
            s.pillars.slice(0, 5).forEach((p, j) => {
                const y = 1.9 + j * 0.95;
                slide.addShape(pptx.ShapeType.rect, { x: MX, y, w: 0.7, h: 0.8, fill: { color: T.chip }, line: { color: T.chip } });
                slide.addText(String(p.num ?? j + 1), { x: MX, y, w: 0.7, h: 0.8, align: 'center', valign: 'middle', fontSize: 18, bold: true, color: t.accent, fontFace: FF });
                slide.addText(String(p.title ?? ''), { x: MX + 0.85, y: y + 0.05, w: W - 2 * MX - 0.85, h: 0.35, fontSize: 14, bold: true, color: t.primary, fontFace: FF });
                if (p.desc) slide.addText(String(p.desc), { x: MX + 0.85, y: y + 0.4, w: W - 2 * MX - 0.85, h: 0.42, fontSize: 11, color: t.text, fontFace: FF });
            });
            return;
        }
        if (s.type === 'twocol' && s.twocol) {
            const tw = s.twocol;
            const colW = (W - 2 * MX - 0.3) / 2;
            const lx = MX, rx = lx + colW + 0.3;
            slide.addShape(pptx.ShapeType.rect, { x: lx, y: 1.8, w: colW, h: 0.45, fill: { color: 'F1F5F9' }, line: { color: 'F1F5F9' } });
            slide.addText(String(tw.left?.title || 'Current Status'), { x: lx + 0.12, y: 1.8, w: colW - 0.2, h: 0.45, fontSize: 12, bold: true, color: '64748B', valign: 'middle', fontFace: FF });
            const lItems = (tw.left?.items || []).slice(0, 6);
            if (lItems.length) slide.addText(lItems.map(b => ({ text: String(b), options: { bullet: { code: '2022', indent: 14 }, color: t.text, fontSize: 13, paraSpaceAfter: 8, fontFace: FF } })), { x: lx, y: 2.35, w: colW, h: H - 3.1, valign: 'top' });
            slide.addShape(pptx.ShapeType.rect, { x: rx, y: 1.8, w: colW, h: 0.45, fill: { color: t.primary }, line: { color: t.primary } });
            slide.addShape(pptx.ShapeType.rect, { x: rx, y: 1.8, w: 0.06, h: 0.45, fill: { color: t.accent }, line: { color: t.accent } });
            slide.addText(String(tw.right?.title || 'MediaOne Strategy'), { x: rx + 0.15, y: 1.8, w: colW - 0.2, h: 0.45, fontSize: 12, bold: true, color: 'FFFFFF', valign: 'middle', fontFace: FF });
            const rItems = (tw.right?.items || []).slice(0, 6);
            if (rItems.length) slide.addText(rItems.map(b => ({ text: String(b), options: { bullet: { code: '2022', indent: 14 }, color: t.text, fontSize: 13, paraSpaceAfter: 8, fontFace: FF } })), { x: rx, y: 2.35, w: colW, h: H - 3.1, valign: 'top' });
            return;
        }
        if (s.type === 'table' && Array.isArray(s.rows)) {
            const rows = [];
            if (Array.isArray(s.columns) && s.columns.length) {
                rows.push(s.columns.map(c => ({ text: String(c), options: { bold: true, color: 'F1F5F9', fill: { color: t.primary }, fontSize: 12, fontFace: FF, valign: 'middle' } })));
            }
            s.rows.forEach((r, ri) => {
                rows.push(r.map(c => ({ text: String(c ?? ''), options: { fontSize: 11.5, color: t.text, fontFace: FF, fill: { color: ri % 2 ? 'FFFFFF' : T.zebra } } })));
            });
            slide.addTable(rows, { x: MX, y: 1.8, w: W - 2 * MX, border: { type: 'solid', color: T.line, pt: 0.5 }, autoPage: false, rowH: 0.42, valign: 'middle' });
            return;
        }
        if (s.type === 'quote' && s.quote) {
            slide.addText('“', { x: MX - 0.1, y: 1.45, w: 1.6, h: 1.6, fontSize: 96, bold: true, color: t.accent, fontFace: 'Georgia' });
            slide.addText(String(s.quote), { x: MX + 0.6, y: 2.6, w: W - 2 * MX - 1.2, h: 2.2, fontSize: 22, italic: true, color: t.text, align: 'center', valign: 'middle', fontFace: FF });
            if (s.attribution) slide.addText('— ' + String(s.attribution), { x: MX, y: 5.1, w: W - 2 * MX, h: 0.5, fontSize: 14, bold: true, color: t.primary, align: 'center', fontFace: FF });
            return;
        }
        if (s.type === 'timeline' && Array.isArray(s.milestones)) {
            const ms = s.milestones.slice(0, DECK_LIMITS.timeline);
            const n = ms.length || 1;
            const span = W - 2 * MX;
            const step = span / n;
            slide.addShape(pptx.ShapeType.rect, { x: MX + step / 2, y: 3.38, w: Math.max(span - step, 0.1), h: 0.05, fill: { color: 'CBD5E1' } });
            ms.forEach((m, j) => {
                const cx = MX + step * j + step / 2;
                slide.addShape(pptx.ShapeType.ellipse, { x: cx - 0.1, y: 3.3, w: 0.2, h: 0.2, fill: { color: t.accent }, line: { color: 'FFFFFF', width: 2 } });
                slide.addText(String(m.date ?? ''), { x: cx - step / 2 + 0.05, y: 2.75, w: step - 0.1, h: 0.4, align: 'center', fontSize: 12, bold: true, color: t.primary, fontFace: FF });
                slide.addText(String(m.title ?? m.event ?? ''), { x: cx - step / 2 + 0.05, y: 3.65, w: step - 0.1, h: 0.6, align: 'center', fontSize: 12.5, bold: true, color: t.text, fontFace: FF });
                if (m.desc) slide.addText(String(m.desc), { x: cx - step / 2 + 0.05, y: 4.25, w: step - 0.1, h: 1.15, align: 'center', fontSize: 10.5, color: t.muted, fontFace: FF });
            });
            return;
        }
        if (s.type === 'agenda' && Array.isArray(s.items)) {
            s.items.slice(0, DECK_LIMITS.agenda).forEach((it, j) => {
                const y = 1.85 + j * 0.62;
                slide.addShape(pptx.ShapeType.roundRect, { x: MX, y, w: 0.5, h: 0.5, rectRadius: 0.08, fill: { color: t.band }, line: { color: t.band } });
                slide.addText(String(j + 1), { x: MX, y, w: 0.5, h: 0.5, align: 'center', valign: 'middle', fontSize: 13, bold: true, color: t.primary, fontFace: FF });
                slide.addText(String(it), { x: MX + 0.7, y, w: W - 2 * MX - 0.7, h: 0.5, valign: 'middle', fontSize: 16, bold: true, color: t.text, fontFace: FF });
            });
            return;
        }
        // Default: bullets
        const bullets = Array.isArray(s.bullets) ? s.bullets : [];
        if (bullets.length) {
            slide.addText(
                bullets.map(b => ({ text: String(b), options: { bullet: { code: '2022', indent: 18 }, color: t.text, fontSize: 18, paraSpaceAfter: 12, fontFace: FF } })),
                { x: MX, y: 1.9, w: W - 2 * MX, h: H - 2.8, valign: 'top' }
            );
        }
    }

    // Convert a Chart.js config into PptxGenJS addChart(type, data, opts) args.
    // Handles bar/line/pie/doughnut + radar/scatter/area, horizontal + stacked bars.
    function chartToPptx(pptx, cc, t) {
        const W = 13.333, MX = 0.9;
        const kind = String(cc.type || 'bar').toLowerCase();
        const labels = cc.data?.labels || [];
        const datasets = cc.data?.datasets || [];
        const optsIn = cc.options || {};
        const horizontal = optsIn.indexAxis === 'y';
        const scales = optsIn.scales || {};
        const stacked = !!((scales.x && scales.x.stacked) || (scales.y && scales.y.stacked));
        const isArea = kind === 'line' && datasets.some(ds => ds && ds.fill);

        let ctype, data;
        const palette = [t.primary, t.accent, '93C5FD', 'FCA5A5', '6EE7B7', 'FCD34D', 'C4B5FD', 'F9A8D4'];
        const opts = {
            x: MX, y: 1.9, w: W - 2 * MX, h: 4.8,
            chartColors: palette,
            showLegend: datasets.length > 1,
            legendPos: 'b', legendColor: t.muted,
            legendFontFace: FF,
            showTitle: false,
            catAxisLabelColor: t.muted, valAxisLabelColor: t.muted,
            catAxisLabelFontSize: 10, valAxisLabelFontSize: 10,
            catAxisLabelFontFace: FF, valAxisLabelFontFace: FF,
        };

        if (kind === 'pie' || kind === 'doughnut' || kind === 'polararea') {
            ctype = kind === 'pie' || kind === 'polararea' ? pptx.ChartType.pie : pptx.ChartType.doughnut;
            data = [{ name: datasets[0]?.label || 'Series', labels, values: (datasets[0]?.data || []).map(Number) }];
            opts.showLegend = true;
            if (ctype === pptx.ChartType.doughnut) opts.holeSize = 55;
            return { type: ctype, data, opts };
        }
        if (kind === 'radar') {
            ctype = pptx.ChartType.radar;
            opts.radarStyle = 'standard';
            data = datasets.map(ds => ({ name: ds.label || 'Series', labels, values: (ds.data || []).map(Number) }));
            return { type: ctype, data, opts };
        }
        if (kind === 'scatter' || kind === 'bubble') {
            ctype = pptx.ChartType.scatter;
            const pts = datasets.map(ds => (ds.data || []).map(p => Array.isArray(p) ? { x: p[0], y: p[1] } : (p && typeof p === 'object' ? p : { x: 0, y: Number(p) || 0 })));
            const xs = pts[0] ? pts[0].map(p => Number(p.x) || 0) : [];
            data = [{ name: 'X', values: xs }].concat(datasets.map((ds, di) => ({ name: ds.label || 'Series ' + (di + 1), values: pts[di].map(p => Number(p.y) || 0) })));
            opts.lineSize = 0;
            return { type: ctype, data, opts };
        }
        if (isArea) ctype = pptx.ChartType.area;
        else if (kind === 'line') { ctype = pptx.ChartType.line; opts.lineSize = 2; opts.lineSmooth = true; }
        else {
            ctype = pptx.ChartType.bar;
            if (horizontal) opts.barDir = 'bar';
            if (stacked) { opts.barGrouping = 'stacked'; opts.barGapWidthPct = 60; }
        }
        data = datasets.map(ds => ({ name: ds.label || 'Series', labels, values: (ds.data || []).map(Number) }));
        return { type: ctype, data, opts };
    }

    /* ── Gamma: prompt copy + Generate API ────────────────────────────────── */
    const GAMMA_BRAND = 'Design: clean and modern on white backgrounds, generous whitespace, one idea per slide. Brand palette: deep navy (#1e3a8a) as the primary with a vivid orange (#f97316) accent. Typography: Barlow throughout. Add a small "MEDIAONE" wordmark to each slide. Use icons and simple visuals where helpful.';

    function slideOutlineLines(s) {
        const lines = [];
        if (s.type === 'title' || s.type === 'closing') {
            lines.push('# ' + (s.title || ''));
            if (s.subtitle) lines.push(s.subtitle);
        } else if (s.type === 'section') {
            lines.push('# ' + (s.title || '') + '  (section divider — large, minimal)');
        } else if (s.type === 'agenda') {
            lines.push('# ' + (s.title || 'Agenda'));
            (s.items || []).forEach((it, j) => lines.push((j + 1) + '. ' + it));
        } else if (s.type === 'metrics') {
            lines.push('# ' + (s.title || 'Key metrics'));
            (s.metrics || []).forEach(m => lines.push('- ' + [m.label, m.value, m.change ? '(' + m.change + ')' : ''].filter(Boolean).join(': ').replace(': (', ' (')));
            lines.push('Render these as large KPI stat cards.');
        } else if (s.type === 'stats') {
            lines.push('# ' + (s.title || 'Track Record'));
            (s.stats || []).forEach(m => lines.push('- ' + [m.num, m.value, m.label, m.desc].filter(Boolean).join(' — ')));
            lines.push('Render as a track-record stat card grid (number + big value + label + description).');
        } else if (s.type === 'pillars') {
            lines.push('# ' + (s.title || 'Strategy Pillars'));
            (s.pillars || []).forEach(p => lines.push('- ' + [p.num, p.title, p.desc].filter(Boolean).join(': ')));
            lines.push('Render as numbered strategy pillars.');
        } else if (s.type === 'twocol') {
            lines.push('# ' + (s.title || 'Comparison'));
            const tw = s.twocol || {};
            lines.push('Left column — ' + ((tw.left && tw.left.title) || 'Current Status') + ':');
            ((tw.left && tw.left.items) || []).forEach(x => lines.push('- ' + x));
            lines.push('Right column — ' + ((tw.right && tw.right.title) || 'Strategy') + ':');
            ((tw.right && tw.right.items) || []).forEach(x => lines.push('- ' + x));
            lines.push('Render as a two-column comparison.');
        } else if (s.type === 'table') {
            lines.push('# ' + (s.title || 'Data'));
            if (s.columns && s.columns.length) lines.push('| ' + s.columns.join(' | ') + ' |');
            (s.rows || []).forEach(r => lines.push('| ' + r.join(' | ') + ' |'));
            lines.push('Render as a clean data table with a navy header row.');
        } else if (s.type === 'quote') {
            lines.push('# ' + (s.title || 'Quote'));
            lines.push('> "' + (s.quote || '') + '"' + (s.attribution ? ' — ' + s.attribution : ''));
            lines.push('Render as a large pull-quote slide.');
        } else if (s.type === 'timeline') {
            lines.push('# ' + (s.title || 'Roadmap'));
            (s.milestones || []).forEach(m => lines.push('- ' + [m.date, m.title || m.event, m.desc].filter(Boolean).join(' — ')));
            lines.push('Render as a horizontal timeline with milestone dots.');
        } else if (s.type === 'chart') {
            lines.push('# ' + (s.title || 'Chart'));
            const c = s.chart || {}; const labs = c.data?.labels || [];
            (c.data?.datasets || []).forEach(ds => {
                lines.push('- ' + (ds.label || 'Series') + ': ' + (ds.data || []).map((v, k) => (labs[k] != null ? labs[k] + ' ' : '') + v).join(', '));
            });
            lines.push('Render as a ' + (c.type || 'bar') + ' chart.');
        } else {
            lines.push('# ' + (s.title || ''));
            (s.bullets || []).forEach(b => lines.push('- ' + b));
        }
        if (s.notes) lines.push('Speaker notes: ' + s.notes);
        return lines;
    }

    function gammaPromptFromDeck(deck) {
        const lines = [];
        lines.push('Create a polished, professional slide presentation.');
        lines.push('');
        if (deck.title) lines.push('Title: ' + deck.title);
        if (deck.subtitle) lines.push('Subtitle: ' + deck.subtitle);
        lines.push(GAMMA_BRAND);
        lines.push('');
        lines.push('Use this exact outline, one slide per "#" heading:');
        lines.push('');
        (deck.slides || []).forEach(s => { lines.push(...slideOutlineLines(s)); lines.push(''); });
        return lines.join('\n').trim();
    }

    function copyGammaPrompt(deckId, btn) {
        const deck = _deckStore[deckId];
        if (!deck) return;
        const prompt = gammaPromptFromDeck(deck);
        const done = () => {
            if (!btn) return;
            const o = btn.innerHTML;
            btn.innerHTML = '&#10003; Copied — paste into Gamma';
            btn.classList.add('copied');
            setTimeout(() => { btn.innerHTML = o; btn.classList.remove('copied'); }, 2200);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(prompt).then(done).catch(() => fallbackCopy(prompt, done));
        else fallbackCopy(prompt, done);
    }
    function fallbackCopy(text, done) {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); done(); } catch (e) { toast('Copy failed'); }
        ta.remove();
    }
    window.copyGammaPrompt = copyGammaPrompt;

    function gammaInputText(deck) {
        // One card per slide; '\n---\n' breaks pair with cardSplit:'inputTextBreaks'.
        const cards = (deck.slides || []).map(s => slideOutlineLines(s).join('\n'));
        return cards.join('\n---\n').slice(0, 390000);
    }

    function cardStatus(deckId, html) {
        const card = document.getElementById(deckId);
        if (!card) return;
        const st = card.querySelector('.dk-status');
        st.style.display = html ? 'flex' : 'none';
        st.innerHTML = html || '';
    }

    window.dkGammaGenerate = async function (deckId, btn) {
        const deck = _deckStore[deckId];
        if (!deck) return;
        if (!cfg.backendCall) { copyGammaPrompt(deckId, btn); return; }
        const orig = btn.innerHTML;
        btn.disabled = true; btn.innerHTML = '&#8987; Sending to Gamma…';
        try {
            const r = await cfg.backendCall('gamma_generate', {
                inputText: gammaInputText(deck),
                textMode: 'preserve',
                numCards: Math.min(deck.slides.length, 60),
                exportAs: 'pptx',
                title: deck.title || 'Presentation',
                cardSplit: 'inputTextBreaks',
                additionalInstructions: GAMMA_BRAND.slice(0, 4900),
            });
            if (r.status === 501 || (r.json && r.json.notConfigured)) {
                copyGammaPrompt(deckId, null);
                toast('Gamma API key not configured — copied the Gamma prompt to your clipboard instead.');
                btn.innerHTML = orig; btn.disabled = false;
                return;
            }
            if (!r.ok || !r.json || !r.json.generationId) {
                throw new Error((r.json && (r.json.message || r.json.error)) || ('Gamma error ' + r.status));
            }
            const gid = r.json.generationId;
            btn.innerHTML = '&#8987; Gamma is designing…';
            for (let i = 0; i < 40; i++) {
                await new Promise(res => setTimeout(res, 5000));
                const p = await cfg.backendCall('gamma_generation_status', { generationId: gid });
                const j = p.json || {};
                if (j.status === 'completed') {
                    const links = [];
                    if (j.gammaUrl) links.push(`<a href="${esc(j.gammaUrl)}" target="_blank" rel="noopener">&#10024; Open in Gamma</a>`);
                    if (j.exportUrl) links.push(`<a href="${esc(j.exportUrl)}" target="_blank" rel="noopener">&#8595; Download Gamma .pptx</a>`);
                    cardStatus(deckId, '<span style="font-weight:700;color:#10b981">Gamma deck ready:</span> ' + links.join(' &nbsp; '));
                    btn.innerHTML = '&#10003; Generated'; btn.classList.add('copied');
                    setTimeout(() => { btn.innerHTML = orig; btn.classList.remove('copied'); btn.disabled = false; }, 2500);
                    if (j.gammaUrl) window.open(j.gammaUrl, '_blank', 'noopener');
                    return;
                }
                if (j.status === 'failed') throw new Error((j.error && j.error.message) || 'Gamma generation failed');
            }
            throw new Error('Timed out waiting for Gamma (try again — the generation may still complete in your Gamma workspace).');
        } catch (e) {
            console.error('[DeckTools] gamma:', e);
            toast('Gamma: ' + (e.message || e));
            btn.innerHTML = orig; btn.disabled = false;
        }
    };

    /* ── Google Slides export ─────────────────────────────────────────────── */
    // Geometry: pptx layout is 13.333×7.5in; a Slides page is 720×405pt (10×5.625in)
    // → multiply pptx inches by 54 to get PT on the Slides canvas.
    const GS = { W: 720, H: 405, MX: 48 };
    function gsRGB(hex) {
        const h = hex.replace('#', '');
        return { red: parseInt(h.slice(0, 2), 16) / 255, green: parseInt(h.slice(2, 4), 16) / 255, blue: parseInt(h.slice(4, 6), 16) / 255 };
    }
    function GsB(pageId) { this.page = pageId; this.reqs = []; this.seq = 0; }
    GsB.prototype.id = function () { return this.page + '_e' + (this.seq++); };
    GsB.prototype.el = function (kind, x, y, w, h, extra) {
        const objectId = this.id();
        this.reqs.push({
            createShape: Object.assign({
                objectId, shapeType: kind,
                elementProperties: {
                    pageObjectId: this.page,
                    size: { width: { magnitude: w, unit: 'PT' }, height: { magnitude: h, unit: 'PT' } },
                    transform: { scaleX: 1, scaleY: 1, translateX: x, translateY: y, unit: 'PT' },
                },
            }, extra || {}),
        });
        return objectId;
    };
    GsB.prototype.rect = function (x, y, w, h, hex, round) {
        const id = this.el(round ? 'ROUND_RECTANGLE' : 'RECTANGLE', x, y, w, h);
        this.reqs.push({
            updateShapeProperties: {
                objectId: id,
                shapeProperties: { shapeBackgroundFill: { solidFill: { color: { rgbColor: gsRGB(hex) } } }, outline: { propertyState: 'NOT_RENDERED' } },
                fields: 'shapeBackgroundFill.solidFill.color,outline.propertyState',
            },
        });
        return id;
    };
    GsB.prototype.text = function (x, y, w, h, text, st) {
        st = st || {};
        const id = this.el('TEXT_BOX', x, y, w, h);
        if (!text) return id;
        this.reqs.push({ insertText: { objectId: id, text: String(text) } });
        const style = { fontFamily: FF, fontSize: { magnitude: st.size || 12, unit: 'PT' }, bold: !!st.bold, italic: !!st.italic, foregroundColor: { opaqueColor: { rgbColor: gsRGB(st.color || T.text) } } };
        this.reqs.push({ updateTextStyle: { objectId: id, textRange: { type: 'ALL' }, style, fields: 'fontFamily,fontSize,bold,italic,foregroundColor' } });
        const para = {};
        if (st.align) para.alignment = st.align;
        if (st.lineSpacing) para.lineSpacing = st.lineSpacing;
        if (st.spaceBelow) para.spaceBelow = { magnitude: st.spaceBelow, unit: 'PT' };
        if (Object.keys(para).length) {
            this.reqs.push({ updateParagraphStyle: { objectId: id, textRange: { type: 'ALL' }, style: para, fields: Object.keys(para).join(',') } });
        }
        if (st.bullets) this.reqs.push({ createParagraphBullets: { objectId: id, textRange: { type: 'ALL' }, bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' } });
        return id;
    };
    GsB.prototype.bg = function (hex) {
        this.reqs.push({
            updatePageProperties: {
                objectId: this.page,
                pageProperties: { pageBackgroundFill: { solidFill: { color: { rgbColor: gsRGB(hex) } } } },
                fields: 'pageBackgroundFill.solidFill.color',
            },
        });
    };
    GsB.prototype.chrome = function (num) {
        this.rect(0, GS.H - 9, GS.W, 9, T.primary);
        this.text(GS.MX, GS.H - 26, 260, 13, 'CONFIDENTIAL & PROPRIETARY  |  MEDIAONE', { size: 6.5, color: T.muted });
        this.text(GS.W - 74, GS.H - 26, 26, 13, String(num), { size: 7, color: T.muted, align: 'END' });
        this.text(GS.W - 124, 14, 76, 16, 'MEDIAONE', { size: 10, bold: true, color: T.primary, align: 'END' });
    };
    GsB.prototype.heading = function (title) {
        this.text(GS.MX, 24, GS.W - 2 * GS.MX - 90, 34, title || '', { size: 20, bold: true, color: T.text });
        this.rect(GS.MX, 66, 60, 4, T.accent);
    };
    GsB.prototype.table = function (x, y, w, columns, rows) {
        const nCols = Math.max(columns.length || (rows[0] || []).length, 1);
        const nRows = rows.length + (columns.length ? 1 : 0);
        if (!nRows) return;
        const tid = this.id();
        this.reqs.push({
            createTable: {
                objectId: tid,
                elementProperties: {
                    pageObjectId: this.page,
                    size: { width: { magnitude: w, unit: 'PT' }, height: { magnitude: Math.min(24 * nRows, 270), unit: 'PT' } },
                    transform: { scaleX: 1, scaleY: 1, translateX: x, translateY: y, unit: 'PT' },
                },
                rows: nRows, columns: nCols,
            },
        });
        const put = (r, c, txt, st) => {
            if (!txt) return;
            this.reqs.push({ insertText: { objectId: tid, cellLocation: { rowIndex: r, columnIndex: c }, text: String(txt) } });
            this.reqs.push({
                updateTextStyle: {
                    objectId: tid, cellLocation: { rowIndex: r, columnIndex: c }, textRange: { type: 'ALL' },
                    style: { fontFamily: FF, fontSize: { magnitude: st.size || 9, unit: 'PT' }, bold: !!st.bold, foregroundColor: { opaqueColor: { rgbColor: gsRGB(st.color || T.text) } } },
                    fields: 'fontFamily,fontSize,bold,foregroundColor',
                },
            });
        };
        if (columns.length) {
            this.reqs.push({
                updateTableCellProperties: {
                    objectId: tid,
                    tableRange: { location: { rowIndex: 0, columnIndex: 0 }, rowSpan: 1, columnSpan: nCols },
                    tableCellProperties: { tableCellBackgroundFill: { solidFill: { color: { rgbColor: gsRGB(T.primary) } } } },
                    fields: 'tableCellBackgroundFill.solidFill.color',
                },
            });
            columns.forEach((c, ci) => put(0, ci, c, { bold: true, color: 'F1F5F9', size: 9.5 }));
        }
        const off = columns.length ? 1 : 0;
        rows.forEach((r, ri) => r.forEach((cell, ci) => { if (ci < nCols) put(ri + off, ci, cell, { size: 9 }); }));
    };

    function buildGSlideRequests(deck) {
        const reqs = [];
        deck.slides.forEach((s, i) => {
            const pageId = 'dk_p' + i;
            reqs.push({ createSlide: { objectId: pageId, slideLayoutReference: { predefinedLayout: 'BLANK' } } });
            const b = new GsB(pageId);
            const num = i + 1;

            if (s.type === 'title') {
                b.bg(T.primary);
                b.text(GS.MX, 20, 200, 22, 'MEDIAONE', { size: 13, bold: true, color: 'FFFFFF' });
                b.rect(GS.MX, 158, 76, 6, 'FFFFFF');
                b.text(GS.MX, 172, GS.W - 2 * GS.MX, 66, s.title || deck.title || 'Presentation', { size: 31, bold: true, color: 'FFFFFF' });
                if (s.subtitle || deck.subtitle) b.text(GS.MX, 252, GS.W - 2 * GS.MX, 34, s.subtitle || deck.subtitle, { size: 14, color: 'FFFFFF' });
            } else if (s.type === 'section') {
                b.bg(T.band);
                b.rect(0, 152, 13, 100, T.primary);
                b.text(GS.MX, 172, GS.W - 2 * GS.MX, 60, s.title || '', { size: 26, bold: true, color: T.text });
            } else if (s.type === 'closing') {
                b.bg(T.primary);
                b.text(GS.MX, 20, 200, 22, 'MEDIAONE', { size: 13, bold: true, color: 'FFFFFF' });
                b.text(GS.MX, 165, GS.W - 2 * GS.MX, 52, s.title || 'Thank you', { size: 29, bold: true, color: 'FFFFFF', align: 'CENTER' });
                if (s.subtitle) b.text(GS.MX, 226, GS.W - 2 * GS.MX, 30, s.subtitle, { size: 13, color: 'FFFFFF', align: 'CENTER' });
            } else {
                b.bg(T.bg);
                b.chrome(num);
                b.heading(s.title);
                const cw = GS.W - 2 * GS.MX;
                if (s.type === 'bullets' && (s.bullets || []).length) {
                    b.text(GS.MX, 95, cw, 275, s.bullets.join('\n'), { size: 13, lineSpacing: 130, spaceBelow: 7, bullets: true });
                } else if (s.type === 'agenda' && (s.items || []).length) {
                    s.items.forEach((it, j) => {
                        const y = 95 + j * 34;
                        b.rect(GS.MX, y, 26, 26, T.band, true);
                        b.text(GS.MX, y + 5, 26, 16, String(j + 1), { size: 10, bold: true, color: T.primary, align: 'CENTER' });
                        b.text(GS.MX + 38, y + 4, cw - 38, 22, it, { size: 12.5, bold: true, color: T.text });
                    });
                } else if (s.type === 'metrics' && (s.metrics || []).length) {
                    const cards = s.metrics, gap = 22;
                    const cwd = (cw - gap * (cards.length - 1)) / cards.length;
                    cards.forEach((m, j) => {
                        const x = GS.MX + j * (cwd + gap);
                        b.rect(x, 120, cwd, 130, T.band, true);
                        b.text(x, 140, cwd, 40, String(m.value ?? ''), { size: 24, bold: true, color: T.primary, align: 'CENTER' });
                        b.text(x, 188, cwd, 22, String(m.label ?? ''), { size: 10.5, color: T.text, align: 'CENTER' });
                        if (m.change != null) b.text(x, 212, cwd, 20, String(m.change), { size: 10, bold: true, color: String(m.change).trim().startsWith('-') ? T.bad : T.good, align: 'CENTER' });
                    });
                } else if (s.type === 'stats' && (s.stats || []).length) {
                    const cards = s.stats, gap = 22;
                    const cwd = (cw - gap * (cards.length - 1)) / cards.length;
                    cards.forEach((m, j) => {
                        const x = GS.MX + j * (cwd + gap);
                        b.rect(x, 100, cwd, 168, T.band, true);
                        b.rect(x, 100, cwd, 6, T.accent);
                        if (m.num) b.text(x, 112, cwd, 16, String(m.num), { size: 8.5, bold: true, color: T.accent, align: 'CENTER' });
                        b.text(x, 130, cwd, 36, String(m.value ?? ''), { size: 21, bold: true, color: T.primary, align: 'CENTER' });
                        if (m.label) b.text(x, 172, cwd, 20, String(m.label), { size: 10, bold: true, color: T.text, align: 'CENTER' });
                        if (m.desc) b.text(x, 194, cwd, 62, String(m.desc), { size: 8.5, color: T.muted, align: 'CENTER' });
                    });
                } else if (s.type === 'pillars' && (s.pillars || []).length) {
                    s.pillars.forEach((p, j) => {
                        const y = 95 + j * 52;
                        b.rect(GS.MX, y, 38, 42, T.chip);
                        b.text(GS.MX, y + 11, 38, 20, String(p.num ?? j + 1), { size: 13, bold: true, color: T.accent, align: 'CENTER' });
                        b.text(GS.MX + 48, y + 2, cw - 48, 20, String(p.title ?? ''), { size: 11.5, bold: true, color: T.primary });
                        if (p.desc) b.text(GS.MX + 48, y + 22, cw - 48, 20, String(p.desc), { size: 9.5, color: T.text });
                    });
                } else if (s.type === 'twocol' && s.twocol) {
                    const tw = s.twocol, colW = (cw - 16) / 2, rx = GS.MX + colW + 16;
                    b.rect(GS.MX, 95, colW, 26, 'F1F5F9');
                    b.text(GS.MX + 7, 100, colW - 14, 17, String(tw.left?.title || 'Current Status'), { size: 9.5, bold: true, color: T.muted });
                    if ((tw.left?.items || []).length) b.text(GS.MX, 130, colW, 235, tw.left.items.join('\n'), { size: 9.5, lineSpacing: 125, spaceBelow: 5, bullets: true });
                    b.rect(rx, 95, colW, 26, T.primary);
                    b.rect(rx, 95, 4, 26, T.accent);
                    b.text(rx + 9, 100, colW - 18, 17, String(tw.right?.title || 'MediaOne Strategy'), { size: 9.5, bold: true, color: 'FFFFFF' });
                    if ((tw.right?.items || []).length) b.text(rx, 130, colW, 235, tw.right.items.join('\n'), { size: 9.5, lineSpacing: 125, spaceBelow: 5, bullets: true });
                } else if (s.type === 'table' && Array.isArray(s.rows)) {
                    b.table(GS.MX, 95, cw, s.columns || [], s.rows);
                } else if (s.type === 'quote' && s.quote) {
                    b.text(GS.MX, 78, 60, 60, '“', { size: 54, bold: true, color: T.accent });
                    b.text(GS.MX + 32, 140, cw - 64, 110, s.quote, { size: 15, italic: true, color: T.text, align: 'CENTER' });
                    if (s.attribution) b.text(GS.MX, 275, cw, 22, '— ' + s.attribution, { size: 10.5, bold: true, color: T.primary, align: 'CENTER' });
                } else if (s.type === 'timeline' && (s.milestones || []).length) {
                    const ms = s.milestones, step = cw / ms.length;
                    b.rect(GS.MX + step / 2, 182, Math.max(cw - step, 6), 3, 'CBD5E1');
                    ms.forEach((m, j) => {
                        const cx = GS.MX + step * j + step / 2;
                        b.text(cx - step / 2 + 3, 148, step - 6, 20, String(m.date ?? ''), { size: 9, bold: true, color: T.primary, align: 'CENTER' });
                        const dot = b.el('ELLIPSE', cx - 6, 177, 12, 12);
                        b.reqs.push({ updateShapeProperties: { objectId: dot, shapeProperties: { shapeBackgroundFill: { solidFill: { color: { rgbColor: gsRGB(T.accent) } } }, outline: { propertyState: 'NOT_RENDERED' } }, fields: 'shapeBackgroundFill.solidFill.color,outline.propertyState' } });
                        b.text(cx - step / 2 + 3, 200, step - 6, 30, String(m.title ?? m.event ?? ''), { size: 9, bold: true, color: T.text, align: 'CENTER' });
                        if (m.desc) b.text(cx - step / 2 + 3, 232, step - 6, 60, String(m.desc), { size: 8, color: T.muted, align: 'CENTER' });
                    });
                } else if (s.type === 'chart' && s.chart) {
                    // Native Slides charts need a linked Sheet; ship the data as an editable table instead.
                    const c = s.chart, labs = c.data?.labels || [], dss = c.data?.datasets || [];
                    const columns = [''].concat(labs.map(String)).slice(0, 9);
                    const rows = dss.slice(0, 8).map(ds => [ds.label || 'Series'].concat((ds.data || []).map(v => typeof v === 'object' && v ? (v.y ?? v.value ?? '') : v).map(String)).slice(0, 9));
                    b.table(GS.MX, 95, cw, columns, rows);
                    b.text(GS.MX, 95 + Math.min(24 * (rows.length + 1), 270) + 8, cw, 16, '(' + (c.type || 'bar') + ' chart data — the .pptx download renders this as a native chart)', { size: 8.5, italic: true, color: T.muted });
                }
            }
            reqs.push(...b.reqs);
        });
        return reqs;
    }

    window.dkGoogleSlides = async function (deckId, btn) {
        const deck = _deckStore[deckId];
        if (!deck) return;
        if (!cfg.getGoogleToken) { toast('Google sign-in is not available on this page.'); return; }
        const orig = btn.innerHTML;
        btn.disabled = true; btn.innerHTML = '&#8987; Creating…';
        // Open the tab synchronously so the popup blocker allows it.
        const tab = window.open('about:blank', '_blank');
        try {
            const token = await cfg.getGoogleToken();
            if (!token) throw new Error('Google authorisation was not granted.');
            const auth = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
            const createRes = await fetch('https://slides.googleapis.com/v1/presentations', {
                method: 'POST', headers: auth, body: JSON.stringify({ title: deck.title || 'Presentation' }),
            });
            const created = await createRes.json();
            if (!createRes.ok) throw new Error(created.error?.message || 'Slides create failed (' + createRes.status + ')');
            const pid = created.presentationId;
            const requests = [];
            if (created.slides && created.slides[0]) requests.push({ deleteObject: { objectId: created.slides[0].objectId } });
            requests.push(...buildGSlideRequests(deck));
            for (let i = 0; i < requests.length; i += 300) {
                const res = await fetch('https://slides.googleapis.com/v1/presentations/' + pid + ':batchUpdate', {
                    method: 'POST', headers: auth, body: JSON.stringify({ requests: requests.slice(i, i + 300) }),
                });
                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    throw new Error(err.error?.message || 'Slides batchUpdate failed (' + res.status + ')');
                }
            }
            const url = 'https://docs.google.com/presentation/d/' + pid + '/edit';
            if (tab && !tab.closed) tab.location = url; else window.open(url, '_blank', 'noopener');
            cardStatus(deckId, `<span style="font-weight:700;color:#10b981">Google Slides created:</span> <a href="${esc(url)}" target="_blank" rel="noopener">Open presentation</a>`);
            btn.innerHTML = '&#10003; Created'; btn.classList.add('copied');
            setTimeout(() => { btn.innerHTML = orig; btn.classList.remove('copied'); btn.disabled = false; }, 2500);
        } catch (e) {
            if (tab && !tab.closed) tab.close();
            console.error('[DeckTools] gslides:', e);
            toast('Google Slides: ' + (e.message || e));
            btn.innerHTML = orig; btn.disabled = false;
        }
    };

    /* ── Tender editor bridge (index.html) ────────────────────────────────── */
    // Convert a chatbot deck into the Tender editor's block-based slide model.
    // Returns plain {layout, theme, blocks:[{type, content}]} descriptors — the
    // Tender-side loader assigns real ids via TenderAI.Utils.
    function deckToTenderSlides(deck) {
        const ul = (items) => '<ul>' + (items || []).map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>';
        return (deck.slides || []).map(s => {
            const blocks = [];
            const push = (type, content) => blocks.push({ type, content });
            let theme = 'light';
            switch (s.type) {
                case 'title':
                    theme = 'dark';
                    push('title', { text: s.title || deck.title || 'Presentation' });
                    if (s.subtitle || deck.subtitle) push('rich_text', { html: '<p>' + esc(s.subtitle || deck.subtitle) + '</p>' });
                    break;
                case 'closing':
                    theme = 'dark';
                    push('title', { text: s.title || 'Thank you' });
                    if (s.subtitle) push('rich_text', { html: '<p>' + esc(s.subtitle) + '</p>' });
                    break;
                case 'section':
                    push('title', { text: s.title || '' });
                    break;
                case 'agenda':
                    push('title', { text: s.title || 'Agenda' });
                    push('rich_text', { html: '<ol>' + (s.items || []).map(x => '<li>' + esc(x) + '</li>').join('') + '</ol>' });
                    break;
                case 'metrics':
                    push('title', { text: s.title || 'Key metrics' });
                    push('kpi_cards', { items: (s.metrics || []).map(m => ({ label: m.label || '', value: m.value ?? '', subtext: m.change || '' })) });
                    break;
                case 'stats':
                    push('title', { text: s.title || 'Track record' });
                    push('stat_cards', { items: (s.stats || []).map(m => ({ num: m.num || '', value: m.value ?? '', label: m.label || '', desc: m.desc || '' })) });
                    break;
                case 'pillars':
                    push('title', { text: s.title || 'Strategy' });
                    push('pillars', { items: (s.pillars || []).map((p, j) => ({ num: p.num || String(j + 1).padStart(2, '0'), title: p.title || '', desc: p.desc || '' })) });
                    break;
                case 'twocol': {
                    const tw = s.twocol || {};
                    push('title', { text: s.title || 'Comparison' });
                    push('two_col', {
                        left: { title: (tw.left && tw.left.title) || 'Current Status', html: ul(tw.left && tw.left.items) },
                        right: { title: (tw.right && tw.right.title) || 'MediaOne Strategy', html: ul(tw.right && tw.right.items) },
                    });
                    break;
                }
                case 'table':
                    push('title', { text: s.title || 'Data' });
                    push('table', { headers: s.columns || [], rows: s.rows || [] });
                    break;
                case 'quote':
                    push('title', { text: s.title || '' });
                    push('callout', { label: s.attribution || 'Quote', text: s.quote || '', accent: 'blue' });
                    break;
                case 'timeline':
                    push('title', { text: s.title || 'Roadmap' });
                    push('timeline', { steps: (s.milestones || []).map(m => ({ date: m.date || '', event: [m.title || m.event, m.desc].filter(Boolean).join(' — ') })) });
                    break;
                case 'chart': {
                    push('title', { text: s.title || 'Chart' });
                    const opt = chartJsToECharts(s.chart);
                    if (opt) push('chart', { option: opt });
                    else push('table', { headers: [''].concat((s.chart?.data?.labels || []).map(String)), rows: (s.chart?.data?.datasets || []).map(ds => [ds.label || 'Series'].concat((ds.data || []).map(String))) });
                    break;
                }
                default:
                    push('title', { text: s.title || '' });
                    if ((s.bullets || []).length) push('rich_text', { html: ul(s.bullets) });
            }
            if (s.notes) push('callout', { label: 'Speaker notes', text: s.notes, accent: 'blue' });
            return { layout: 'standard', theme, blocks };
        });
    }

    // Minimal Chart.js → ECharts option conversion (Tender charts are ECharts).
    function chartJsToECharts(cc) {
        if (!cc || !cc.data) return null;
        const kind = String(cc.type || 'bar').toLowerCase();
        const labels = cc.data.labels || [];
        const dss = cc.data.datasets || [];
        const P = ['#1e3a8a', '#f97316', '#93c5fd', '#fca5a5', '#6ee7b7', '#fcd34d'];
        if (kind === 'pie' || kind === 'doughnut') {
            return {
                color: P, tooltip: { trigger: 'item' }, legend: { bottom: 0 },
                series: [{ type: 'pie', radius: kind === 'doughnut' ? ['45%', '70%'] : '70%', data: labels.map((l, i) => ({ name: String(l), value: Number((dss[0]?.data || [])[i]) || 0 })) }],
            };
        }
        if (kind === 'radar') {
            const max = Math.max(...dss.flatMap(ds => (ds.data || []).map(Number)), 1);
            return {
                color: P, legend: { bottom: 0 },
                radar: { indicator: labels.map(l => ({ name: String(l), max: max * 1.2 })) },
                series: [{ type: 'radar', data: dss.map(ds => ({ name: ds.label || 'Series', value: (ds.data || []).map(Number) })) }],
            };
        }
        if (kind !== 'bar' && kind !== 'line') return null;
        return {
            color: P, tooltip: { trigger: 'axis' }, legend: dss.length > 1 ? { bottom: 0 } : undefined,
            grid: { left: 40, right: 16, top: 24, bottom: dss.length > 1 ? 46 : 28 },
            xAxis: { type: 'category', data: labels.map(String) },
            yAxis: { type: 'value' },
            series: dss.map(ds => ({ name: ds.label || 'Series', type: kind, smooth: kind === 'line', areaStyle: (kind === 'line' && ds.fill) ? {} : undefined, data: (ds.data || []).map(Number) })),
        };
    }

    /* ── Sample deck (verification / demos) ───────────────────────────────── */
    function sampleDeck() {
        return normalizeDeck({
            title: 'DeckTools Smoke Test', subtitle: 'All 13 layouts · MediaOne theme',
            slides: [
                { type: 'title', title: 'DeckTools Smoke Test', subtitle: 'All 13 layouts · MediaOne theme', notes: 'Welcome everyone — this is the smoke-test deck.' },
                { type: 'agenda', title: 'Agenda', items: ['Track record', 'Headline results', 'Strategy', 'Roadmap', 'Investment'] },
                { type: 'section', title: 'Part 1 — Where we are' },
                { type: 'stats', title: 'Our Track Record', stats: [{ num: '01', value: '10+', label: 'Years', desc: 'International performance marketing' }, { num: '02', value: '3,000+', label: 'Clients', desc: 'Across diverse industries' }, { num: '03', value: '$50M+', label: 'Revenue', desc: 'Generated for clients' }, { num: '04', value: '12+', label: 'Awards', desc: 'International recognition' }] },
                { type: 'metrics', title: 'Headline results', metrics: [{ label: 'Sessions', value: '48.2K', change: '+18%' }, { label: 'Conversions', value: '1,120', change: '+9%' }, { label: 'CPA', value: '$24.10', change: '-7%' }], notes: 'CPA improvement driven by negative keyword pruning.' },
                { type: 'chart', title: 'Organic sessions trend', chart: { type: 'line', data: { labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'], datasets: [{ label: 'Sessions', data: [21000, 24500, 26800, 31200, 38900, 48200], fill: true, borderColor: '#1e3a8a', backgroundColor: 'rgba(30,58,138,.15)' }] } } },
                { type: 'bullets', title: 'What worked', bullets: ['Branded search up 22% after homepage refresh', 'Meta retargeting drove 31% of conversions', 'Email reactivation recovered 180 dormant accounts'] },
                { type: 'pillars', title: 'SEO Strategy', pillars: [{ num: '01', title: 'Technical Foundation', desc: 'Site speed, crawlability, Core Web Vitals' }, { num: '02', title: 'Content Strategy', desc: 'Keyword-mapped pillar + cluster model' }, { num: '03', title: 'Authority Building', desc: 'Targeted link acquisition and PR' }] },
                { type: 'twocol', title: 'Current vs Proposed', twocol: { left: { title: 'Current Status', items: ['Rankings plateaued', 'Thin category content', 'No structured data'] }, right: { title: 'MediaOne Strategy', items: ['Topical authority map', 'Programmatic category pages', 'Full schema rollout'] } } },
                { type: 'table', title: 'Keyword opportunities', columns: ['Keyword', 'Volume', 'Difficulty', 'Position'], rows: [['storage singapore', '12,000', '38', '7'], ['self storage price', '4,400', '24', '11'], ['storage unit rental', '2,900', '31', '14']] },
                { type: 'quote', title: '', quote: 'MediaOne took us from page 3 to the top of Google in five months — the pipeline impact was immediate.', attribution: 'Head of Growth, Extra Space Asia' },
                { type: 'timeline', title: 'Execution roadmap', milestones: [{ date: 'Jul 2026', title: 'Technical audit', desc: 'Fix crawl + CWV issues' }, { date: 'Aug 2026', title: 'Content sprint', desc: '12 pillar pages' }, { date: 'Oct 2026', title: 'Authority push', desc: 'Digital PR wave' }, { date: 'Dec 2026', title: 'Review', desc: 'KPI checkpoint' }] },
                { type: 'closing', title: 'Thank you', subtitle: 'hello@mediaone.co' },
            ],
        });
    }

    /* ── Public API ───────────────────────────────────────────────────────── */
    window.DeckTools = {
        version: '1.0.0',
        init(overrides) { Object.assign(cfg, overrides || {}); injectStyles(); },
        scanAndRender,
        tryRenderSlideDeck,
        normalizeDeck,
        parseDeckText,
        gammaPromptFromDeck,
        deckToTenderSlides,
        getDeck: (id) => _deckStore[id],
        storeDeck(deck) { const id = 'deck-' + (++_deckCounter) + '-' + Date.now(); _deckStore[id] = deck; return id; },
        sampleDeck,
        toast,
        _cfg: cfg,
    };
})();
