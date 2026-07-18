// Performance Marketing Audit renderers — ported from the agency monolith
// (index.html: renderPerformanceMarketing + renderPerformanceMarketingPro). Each
// function RETURNS a self-contained HTML string (inline styles + Font Awesome
// icons) that the PerformanceAudit page drops in via ReportHtml. The two
// deviations from the original: the pm-* CSS classes are inlined (so no global
// stylesheet is needed and ReportHtml can theme the colours for dark mode), and
// the Chart.js doughnut is replaced by a dependency-free inline-SVG doughnut
// (the SaaS ships no chart.js). Clickable budget tiles still re-cost the mix via
// a window.pmSelectBudget global installed by installPmGlobals().

export function _pmEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

const PM_PALETTE = ['#4f46e5','#0ea5e9','#14b8a6','#f59e0b','#ec4899','#8b5cf6'];

// Shared inline-style snippets (was pm-* CSS).
const S = {
  card: 'background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:20px 22px;margin-bottom:18px;box-shadow:0 1px 3px rgba(15,23,42,0.04);',
  title: 'font-size:0.78rem;font-weight:800;text-transform:uppercase;letter-spacing:0.06em;color:#4f46e5;display:flex;align-items:center;gap:8px;margin-bottom:14px;',
  sub: 'font-weight:500;text-transform:none;letter-spacing:0;color:#64748b;font-size:0.74rem;',
  callout: 'background:linear-gradient(135deg,#eef2ff,#e0f2fe);border:1px solid #c7d2fe;border-radius:12px;padding:16px 18px;font-size:0.9rem;line-height:1.6;color:#1e293b;',
  platMeta: 'font-size:0.8rem;color:#64748b;',
};

function _pmParseMoney(str){
  if(str == null) return null;
  const nums = String(str).replace(/,/g,'').match(/\d+(?:\.\d+)?/g);
  if(!nums || !nums.length) return null;
  const vals = nums.map(Number).filter(n=>!isNaN(n));
  if(!vals.length) return null;
  return Math.round(vals.reduce((a,b)=>a+b,0)/vals.length);
}
function _pmMoneyPrefix(range){
  const sample = range.recommended || range.conservative || range.aggressive || '';
  const m = String(sample).match(/^[^\d]*/);
  const pre = m ? m[0].trim() : '';
  if(pre) return pre;
  return range.currency ? range.currency + ' ' : '$';
}
function _pmFmtMoney(prefix, n){
  const sep = /[a-zA-Z]$/.test(prefix) ? ' ' : '';
  return prefix + sep + Math.round(n).toLocaleString('en-US');
}

// Interactive budget state, shared with the window.pmSelectBudget global so the
// budget-tier tiles can re-cost the per-platform figures after injection.
let pmBudgetState = null;

export function installPmGlobals(){
  if (typeof window === 'undefined') return;
  window._pmFmtMoney = _pmFmtMoney;
  window.pmSelectBudget = function(tier){
    const b = pmBudgetState;
    if(!b || !b.totals[tier]) return;
    b.selected = tier;
    const ids = { conservative:'pmTileConservative', recommended:'pmTileRecommended', aggressive:'pmTileAggressive' };
    Object.keys(ids).forEach(t=>{
      const el = document.getElementById(ids[t]);
      if(!el) return;
      const on = t === tier;
      el.style.boxShadow = on ? '0 0 0 3px rgba(79,70,229,0.45)' : 'none';
      el.style.transform = on ? 'translateY(-2px)' : 'none';
    });
    const total = b.totals[tier];
    b.platsPct.forEach((p,i)=>{
      const span = document.getElementById('pm-plat-budget-'+i);
      if(span) span.textContent = p.pct + '% · ' + _pmFmtMoney(b.prefix, total * p.pct/100);
    });
    const hint = document.getElementById('pmMixTotalHint');
    if(hint) hint.textContent = 'on ' + _pmFmtMoney(b.prefix, total) + '/mo · ' + tier;
  };
}

// Called by the page after the rendered HTML is in the DOM, to apply the default
// tier's highlight + figures (mirrors the original's post-render pmSelectBudget).
export function pmApplyInteractive(){
  if (typeof window === 'undefined' || !pmBudgetState) return;
  window.pmSelectBudget?.(pmBudgetState.selected);
}

// Dependency-free SVG doughnut for the channel mix. segs: [{name,pct,color}].
function pmDoughnut(segs){
  const R = 52, C = 2 * Math.PI * R, cx = 60, cy = 60, sw = 16;
  let acc = 0;
  const rings = segs.map(s => {
    const dash = (s.pct / 100) * C;
    const ring = `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${s.color}" stroke-width="${sw}" stroke-dasharray="${dash.toFixed(2)} ${(C - dash).toFixed(2)}" stroke-dashoffset="${(-acc).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"></circle>`;
    acc += dash;
    return ring;
  }).join('');
  return `<svg viewBox="0 0 120 120" width="180" height="180" role="img" aria-label="Channel budget split">
      <circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="#eef2ff" stroke-width="${sw}"></circle>
      ${rings}
    </svg>`;
}

export function renderPerfMarketing(d){
  const esc = _pmEsc;
  const plats = Array.isArray(d.platform_recommendations) ? d.platform_recommendations : [];
  const range = d.estimated_budget_range || {};
  const opps  = Array.isArray(d.opportunities) ? d.opportunities : [];
  const wins  = Array.isArray(d.quick_wins) ? d.quick_wins : [];
  const watch = Array.isArray(d.watch_outs) ? d.watch_outs : [];
  const talk  = Array.isArray(d.sales_talking_points) ? d.sales_talking_points : [];

  let html = '';

  if(d.executive_summary){
    html += `<div style="${S.card}"><div style="${S.title}"><i class="fas fa-lightbulb"></i> The opportunity</div>
      <div style="${S.callout}">${esc(d.executive_summary)}</div></div>`;
  }

  const pmTotals = { conservative:_pmParseMoney(range.conservative), recommended:_pmParseMoney(range.recommended), aggressive:_pmParseMoney(range.aggressive) };
  const pmInteractive = !!(pmTotals.conservative || pmTotals.recommended || pmTotals.aggressive);
  const pmPrefix = _pmMoneyPrefix(range);

  if(range.conservative || range.recommended || range.aggressive){
    const tile = (tier, label, color, border, bg) => {
      const clickable = pmInteractive && pmTotals[tier];
      const id = 'pmTile' + tier.charAt(0).toUpperCase() + tier.slice(1);
      return `<div id="${id}" ${clickable?`onclick="pmSelectBudget('${tier}')" role="button" tabindex="0" title="Re-cost the channel mix at this budget"`:''} style="border:1px solid ${border};border-radius:12px;padding:14px;text-align:center;${bg?`background:${bg};`:''}${clickable?'cursor:pointer;transition:box-shadow .15s,transform .15s;':''}"><div style="font-size:0.7rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;">${label}</div><div style="font-size:1.45rem;font-weight:800;margin-top:4px;color:${color};">${esc(range[tier]||'—')}</div></div>`;
    };
    html += `<div style="${S.card}"><div style="${S.title}"><i class="fas fa-coins"></i> Estimated monthly budget ${range.currency ? '· '+esc(range.currency) : ''} ${pmInteractive?`<span style="${S.sub}">— click a tier to re-cost the mix below</span>`:''}</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;">
        ${tile('conservative','Conservative','#16a34a','#bbf7d0','')}
        ${tile('recommended','Recommended','#4f46e5','#c7d2fe','#eef2ff')}
        ${tile('aggressive','Aggressive','#d97706','#fde68a','')}
      </div>
      ${range.rationale ? `<p style="${S.platMeta}margin:12px 0 0;">${esc(range.rationale)}</p>`:''}</div>`;
  }

  if(plats.length){
    const cards = plats.map((p,i)=>{
      const suit = ['High','Medium','Low'].includes(p.suitability) ? p.suitability : 'Medium';
      const suitStyle = { High:'background:#f0fdf4;color:#16a34a;border:1px solid #bbf7d0;', Medium:'background:#fffbeb;color:#d97706;border:1px solid #fde68a;', Low:'background:#fef2f2;color:#dc2626;border:1px solid #fecaca;' }[suit];
      const pct = Math.max(0, Math.min(100, parseInt(p.budget_share_pct,10)||0));
      let amountTxt = p.monthly_budget ? ' · '+esc(p.monthly_budget) : '';
      if(pmInteractive && pmTotals.recommended) amountTxt = ' · '+_pmFmtMoney(pmPrefix, pmTotals.recommended * pct/100);
      return `<div style="border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px;">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <span style="width:11px;height:11px;border-radius:50%;flex:0 0 auto;display:inline-block;background:${PM_PALETTE[i%PM_PALETTE.length]}"></span>
          <span style="font-weight:800;font-size:0.98rem;">${esc(p.platform)}</span>
          <span style="font-size:0.68rem;font-weight:800;padding:2px 9px;border-radius:20px;text-transform:uppercase;letter-spacing:0.04em;${suitStyle}">${suit}</span>
          ${p.budget_share_pct!=null ? `<span id="pm-plat-budget-${i}" style="margin-left:auto;font-weight:800;color:#4f46e5;">${pct}%${amountTxt}</span>`:''}
        </div>
        ${p.primary_objective ? `<div style="${S.platMeta}margin-top:8px;"><b style="color:#334155;">Objective:</b> ${esc(p.primary_objective)}</div>`:''}
        ${p.rationale ? `<div style="${S.platMeta}margin-top:4px;"><b style="color:#334155;">Why:</b> ${esc(p.rationale)}</div>`:''}
        ${p.expected_outcome ? `<div style="${S.platMeta}margin-top:4px;"><b style="color:#334155;">Expect:</b> ${esc(p.expected_outcome)}</div>`:''}
      </div>`;
    }).join('');
    const segs = plats.map((p,i)=>({ name:p.platform, pct:parseInt(p.budget_share_pct,10)||0, color:PM_PALETTE[i%PM_PALETTE.length] })).filter(s=>s.pct>0);
    html += `<div style="${S.card}"><div style="${S.title}"><i class="fas fa-layer-group"></i> Recommended channel mix <span style="${S.sub}">budget split sums to 100%${pmInteractive?' · <span id="pmMixTotalHint"></span>':''}</span></div>
      <div style="display:flex;gap:20px;flex-wrap:wrap;align-items:center;">
        <div style="flex:0 0 180px;margin:0 auto;">${segs.length?pmDoughnut(segs):''}</div>
        <div style="display:grid;grid-template-columns:1fr;gap:12px;flex:1;min-width:280px;">${cards}</div>
      </div></div>`;
  }

  if(opps.length){
    html += `<div style="${S.card}"><div style="${S.title}"><i class="fas fa-magnifying-glass-chart"></i> Opportunities</div>
      ${opps.map(o=>`<div style="border-left:4px solid #4f46e5;background:#fafafe;border-radius:0 10px 10px 0;padding:11px 14px;margin-bottom:10px;"><div style="font-weight:800;font-size:0.9rem;">${esc(o.title)}</div>${o.insight?`<div style="font-size:0.84rem;color:#64748b;margin:3px 0;">${esc(o.insight)}</div>`:''}${o.recommended_action?`<div style="font-size:0.84rem;color:#0369a1;font-weight:600;"><i class="fas fa-arrow-right" style="font-size:0.7rem;"></i> ${esc(o.recommended_action)}</div>`:''}</div>`).join('')}</div>`;
  }

  if(wins.length || watch.length){
    html += `<div style="${S.card}"><div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
      <div style="border:1px solid #bbf7d0;background:#f4fdf8;border-radius:12px;padding:12px 15px;"><div style="font-size:0.95rem;font-weight:800;color:#16a34a;display:flex;align-items:center;gap:8px;margin:0 0 12px;"><i class="fas fa-bolt"></i> Quick wins</div><ul style="list-style:none;margin:0;padding:0;">${wins.map(w=>`<li style="display:flex;gap:10px;align-items:flex-start;padding:9px 0;font-size:0.86rem;line-height:1.5;border-top:1px solid rgba(15,23,42,0.06);"><i class="fas fa-circle-check" style="margin-top:3px;color:#16a34a;font-size:0.82rem;"></i><span>${esc(w)}</span></li>`).join('')}</ul></div>
      <div style="border:1px solid #fecaca;background:#fef7f7;border-radius:12px;padding:12px 15px;"><div style="font-size:0.95rem;font-weight:800;color:#dc2626;display:flex;align-items:center;gap:8px;margin:0 0 12px;"><i class="fas fa-triangle-exclamation"></i> Watch-outs</div><ul style="list-style:none;margin:0;padding:0;">${watch.map(w=>`<li style="display:flex;gap:10px;align-items:flex-start;padding:9px 0;font-size:0.86rem;line-height:1.5;border-top:1px solid rgba(15,23,42,0.06);"><i class="fas fa-triangle-exclamation" style="margin-top:3px;color:#dc2626;font-size:0.82rem;"></i><span>${esc(w)}</span></li>`).join('')}</ul></div>
    </div></div>`;
  }

  if(talk.length){
    html += `<div style="${S.card}"><div style="${S.title}"><i class="fas fa-comments"></i> Sales talking points</div>
      <ol style="list-style:none;margin:0;padding:0;counter-reset:pmtalk;">${talk.map(t=>`<li style="display:flex;gap:12px;align-items:flex-start;padding:11px 0;font-size:0.88rem;line-height:1.55;border-top:1px solid #f1f5f9;"><span style="flex:0 0 auto;width:22px;height:22px;border-radius:50%;background:linear-gradient(135deg,#4f46e5,#0ea5e9);color:#fff;font-size:0.72rem;font-weight:800;display:flex;align-items:center;justify-content:center;">•</span><span>${esc(t)}</span></li>`).join('')}</ol></div>`;
  }

  // Record interactive state for window.pmSelectBudget (applied by pmApplyInteractive()).
  if(pmInteractive){
    pmBudgetState = {
      totals: pmTotals,
      prefix: pmPrefix,
      platsPct: plats.map(p=>({ name:p.platform, pct: Math.max(0, Math.min(100, parseInt(p.budget_share_pct,10)||0)) })),
      selected: pmTotals.recommended ? 'recommended' : (pmTotals.conservative ? 'conservative' : 'aggressive'),
    };
  } else { pmBudgetState = null; }

  return html;
}

export function renderPerfMarketingPro(d){
  const esc = _pmEsc;
  pmBudgetState = null;
  const metrics = Array.isArray(d.key_metrics) ? d.key_metrics : [];
  const diag    = Array.isArray(d.diagnosis) ? d.diagnosis : [];
  const causes  = Array.isArray(d.root_causes) ? d.root_causes : [];
  const plan    = Array.isArray(d.action_plan) ? d.action_plan : [];
  const escal   = d.escalation || {};
  const internalList = Array.isArray(escal.handle_internally) ? escal.handle_internally : [];
  const escalateList = Array.isArray(escal.escalate_to_specialist) ? escal.escalate_to_specialist : [];

  const statusColor = s => ({ok:'#16a34a',good:'#16a34a',warning:'#d97706',bad:'#dc2626',critical:'#dc2626'})[String(s||'').toLowerCase()] || '#64748b';
  const statusLabel = s => { const k=String(s||'').toLowerCase(); return ({ok:'OK',good:'Good',warning:'Warning',bad:'Poor',critical:'Critical'})[k] || (s||'—'); };
  const prioColor   = p => ({high:'#dc2626',medium:'#d97706',low:'#64748b'})[String(p||'').toLowerCase()] || '#64748b';
  const healthColor = h => { const k=String(h||'').toLowerCase(); return k.includes('critical')?'#dc2626':k.includes('need')?'#d97706':k.includes('healthy')?'#16a34a':'#4f46e5'; };

  let html = '';

  if(d.executive_summary || d.overall_health){
    html += `<div style="${S.card}"><div style="${S.title}"><i class="fas fa-stethoscope"></i> Diagnosis summary
      ${d.overall_health?`<span style="margin-left:auto;background:${healthColor(d.overall_health)};color:#fff;font-size:12px;font-weight:700;padding:4px 12px;border-radius:20px;">${esc(d.overall_health)}</span>`:''}</div>
      ${d.executive_summary?`<div style="${S.callout}">${esc(d.executive_summary)}</div>`:''}</div>`;
  }

  if(metrics.length){
    html += `<div style="${S.card}"><div style="${S.title}"><i class="fas fa-gauge-high"></i> Key metrics vs benchmark</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;">
      ${metrics.map(m=>`<div style="border:1px solid #e2e8f0;border-top:3px solid ${statusColor(m.status)};border-radius:8px;padding:12px;">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#64748b;">${esc(m.label)}</div>
        <div style="font-size:20px;font-weight:800;color:${statusColor(m.status)};margin:2px 0;">${esc(m.value)}</div>
        ${m.benchmark?`<div style="font-size:11px;color:#94a3b8;">vs ${esc(m.benchmark)}</div>`:''}
        ${m.note?`<div style="font-size:11px;color:#475569;margin-top:4px;">${esc(m.note)}</div>`:''}
      </div>`).join('')}
      </div></div>`;
  }

  if(diag.length){
    html += `<div style="${S.card}"><div style="${S.title}"><i class="fas fa-microscope"></i> Diagnosis by area</div>
      ${diag.map(a=>`<div style="border-left:3px solid ${statusColor(a.status)};background:#f8fafc;border-radius:0 8px 8px 0;padding:10px 14px;margin-bottom:10px;">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span style="font-weight:700;">${esc(a.area)}</span>
          <span style="background:${statusColor(a.status)};color:#fff;font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;text-transform:uppercase;">${statusLabel(a.status)}</span>
          ${a.priority?`<span style="margin-left:auto;font-size:11px;font-weight:700;color:${prioColor(a.priority)};">${esc(a.priority)} priority</span>`:''}
        </div>
        ${a.finding?`<div style="font-size:13px;color:#1e293b;margin-top:6px;">${esc(a.finding)}</div>`:''}
        ${a.evidence?`<div style="font-size:12px;color:#64748b;margin-top:3px;"><b>Evidence:</b> ${esc(a.evidence)}</div>`:''}
        ${a.recommendation?`<div style="font-size:12px;color:#4f46e5;margin-top:4px;"><i class="fas fa-arrow-right" style="font-size:0.7rem;"></i> ${esc(a.recommendation)}</div>`:''}
      </div>`).join('')}</div>`;
  }

  if(causes.length){
    html += `<div style="${S.card}"><div style="${S.title}"><i class="fas fa-diagram-project"></i> Likely root cause(s)</div>
      <ul style="margin:0;padding-left:18px;">${causes.map(c=>`<li style="margin-bottom:6px;font-size:0.88rem;">${esc(c)}</li>`).join('')}</ul></div>`;
  }

  if(plan.length){
    html += `<div style="${S.card}"><div style="${S.title}"><i class="fas fa-list-check"></i> Action plan</div>
      ${plan.map(p=>`<div style="border-left:4px solid #4f46e5;background:#fafafe;border-radius:0 10px 10px 0;padding:11px 14px;margin-bottom:10px;display:flex;gap:10px;align-items:flex-start;">
        <span style="background:${prioColor(p.priority)};color:#fff;font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;white-space:nowrap;margin-top:2px;">${esc(p.priority||'—')}</span>
        <div style="flex:1;">
          <div style="font-weight:800;font-size:0.9rem;">${esc(p.action)}</div>
          <div style="${S.platMeta}">${p.owner?`<b style="color:#334155;">Owner:</b> ${esc(p.owner)}`:''}${p.expected_impact?`  ·  <b style="color:#334155;">Impact:</b> ${esc(p.expected_impact)}`:''}</div>
        </div>
      </div>`).join('')}</div>`;
  }

  if(internalList.length || escalateList.length){
    html += `<div style="${S.card}"><div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
      <div><div style="font-size:0.95rem;font-weight:800;color:#16a34a;display:flex;align-items:center;gap:8px;margin:0 0 12px;"><i class="fas fa-user-check"></i> Handle internally</div>
        <ul style="margin:0;padding-left:18px;">${internalList.length?internalList.map(x=>`<li style="margin-bottom:6px;font-size:0.88rem;">${esc(x)}</li>`).join(''):'<li>—</li>'}</ul></div>
      <div><div style="font-size:0.95rem;font-weight:800;color:#dc2626;display:flex;align-items:center;gap:8px;margin:0 0 12px;"><i class="fas fa-arrow-up-right-dots"></i> Escalate to senior media buyer</div>
        <ul style="margin:0;padding-left:18px;">${escalateList.length?escalateList.map(x=>`<li style="margin-bottom:6px;font-size:0.88rem;"><b>${esc(x.issue)}</b> — ${esc(x.reason)}</li>`).join(''):'<li>None — within CSM scope</li>'}</ul></div>
    </div></div>`;
  }

  return html;
}

// Currency options for the Starter form's output-currency selector.
export const PM_CURRENCIES = [
  'SGD (S$)', 'USD (US$)', 'MYR (RM)', 'EUR (€)', 'GBP (£)', 'AUD (A$)', 'HKD (HK$)',
  'INR (₹)', 'IDR (Rp)', 'THB (฿)', 'PHP (₱)', 'VND (₫)', 'JPY (¥)', 'CNY (¥)',
  'AED (AED)', 'SAR (SAR)', 'CAD (C$)', 'NZD (NZ$)',
];

// Bare domain from a competitor textarea line ("acme.com — ranks for…" → acme.com).
export function pmDomainFromLine(line){
  let d = String(line||'').split('—')[0].split(' - ')[0].trim();
  d = d.replace(/^https?:\/\//i,'').replace(/^www\./i,'').split('/')[0].split('?')[0].trim().toLowerCase();
  return d;
}
