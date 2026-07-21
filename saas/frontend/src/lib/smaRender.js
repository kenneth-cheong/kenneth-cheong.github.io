// Social Media Audit renderers — ported verbatim from the agency monolith
// (index.html: renderSMAScorecard + renderSocialAudit). They build self-contained
// HTML strings (inline styles + Font Awesome icons) that the SocialAudit page
// drops in via dangerouslySetInnerHTML, so the scorecard looks identical to the
// agency app. The only change from the originals: instead of writing to a fixed
// DOM node, each function RETURNS its HTML string.
//
// Requires Font Awesome 6 (loaded in index.html) for the fab/fas icons, and the
// global `smaTogglePostsGrid` (installed by installSmaGlobals) for the opt-in
// competitor-posts toggle baked into the scorecard markup.

export function _pmEsc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// Toggle competitor post grids (opt-in show/hide in the SMA scorecard). Exposed
// on window because the scorecard markup wires it via an inline onclick.
export function installSmaGlobals(){
  if (typeof window === 'undefined') return;
  window._pmEsc = _pmEsc;
  window.smaTogglePostsGrid = function(btn, id){
    const el = document.getElementById(id);
    if(!el) return;
    const show = el.style.display === 'none';
    el.style.display = show ? 'block' : 'none';
    btn.innerHTML = show
      ? '<i class="fas fa-eye-slash"></i> Hide competitor posts'
      : '<i class="fas fa-images"></i> Show competitor posts';
  };
}

// Plain-English definitions for the social scorecard's metrics, mirroring the
// app-wide GLOSSARY. Keyed by the exact metric label used below (case-sensitive
// first, lower-case fallback). smaTip() turns a match into a small "i" icon
// whose native title reveals the explanation on hover.
const SMA_GLOSSARY = {
  'Overall score': 'An overall 0–100 grade for this brand’s social presence, blending reach, consistency, engagement and profile quality.',
  'Followers': 'The number of accounts that follow this profile.',
  'Growth (30d)': 'Followers gained (or lost) in the last 30 days — momentum, not just size.',
  'Engagement rate': 'Likes, comments and shares as a % of audience — how much people interact, not just how many follow.',
  'Eng. rate': 'Likes, comments and shares as a % of audience — how much people interact, not just how many follow.',
  'Posts / week': 'How many times this profile posts in a typical week.',
  'Posts/wk': 'How many times this profile posts in a typical week.',
  'Days since last post': 'How long since the last post — a freshness and consistency signal.',
  'Last post': 'How long since the last post — a freshness and consistency signal.',
  'Avg likes': 'The average number of likes per post.',
  'Avg video views': 'The average number of views per video post.',
  'Mix (v / i / c)': 'The split of recent posts across video / image / carousel formats.',
  'complete': 'How fully the profile is filled in — bio, links, photo and contact details.',
  'Brand consistency': 'How cohesive the look, voice and themes are across posts (0–100).',
  'Design quality': 'An expert read of layout, typography and visual polish (0–100).',
  'Branded search': 'How many people search your brand name each month — a real-world demand signal.',
  'Web mentions': 'How often your brand is talked about across the web.',
  'Google rating': 'Your average star rating on Google Business Profile (review count in brackets).',
};

function smaTip(label){
  const def = SMA_GLOSSARY[label] || SMA_GLOSSARY[String(label || '').toLowerCase()];
  if(!def) return '';
  const t = String(def).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return ` <i class="fas fa-circle-info sma-tip" title="${t}"></i>`;
}

export function renderSMAScorecard(d){
            const esc = (window._pmEsc) || (s => String(s==null?'':s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])));
            const arr = x => Array.isArray(x) ? x : [];
            const num = x => (x==null||x==='') ? '—' : (typeof x==='number' ? x.toLocaleString() : esc(x));
            const healthColor = h => { const k=String(h||'').toLowerCase(); return k.includes('under')?'#dc2626':k.includes('develop')?'#d97706':k.includes('strong')?'#16a34a':'#4f46e5'; };
            const statusColor = s => ({good:'#16a34a',warn:'#d97706',bad:'#dc2626'})[s] || '#64748b';
            const statusBg    = s => ({good:'#f0fdf4',warn:'#fffbeb',bad:'#fef2f2'})[s] || '#f8fafc';
            const statusIcon  = s => ({good:'fa-circle-check',warn:'fa-circle-exclamation',bad:'fa-circle-xmark'})[s] || 'fa-circle-minus';
            const prioColor   = p => ({high:'#dc2626',medium:'#d97706',low:'#64748b'})[String(p||'').toLowerCase()] || '#64748b';
            const prioBg      = p => ({high:'#fef2f2',medium:'#fffbeb',low:'#f8fafc'})[String(p||'').toLowerCase()] || '#f8fafc';
            const prioIcon    = p => ({high:'fa-circle-arrow-up',medium:'fa-circle-arrow-right',low:'fa-circle-arrow-down'})[String(p||'').toLowerCase()] || 'fa-circle';
            const platformIcon  = p => ({'instagram':'fa-instagram','facebook':'fa-facebook','tiktok':'fa-tiktok','linkedin':'fa-linkedin','youtube':'fa-youtube','twitter':'fa-x-twitter','x':'fa-x-twitter'})[String(p||'').toLowerCase()] || 'fa-globe';
            const platformColor = p => ({'instagram':'#e1306c','facebook':'#1877f2','tiktok':'#010101','linkedin':'#0077b5','youtube':'#ff0000','twitter':'#000000','x':'#000000'})[String(p||'').toLowerCase()] || '#4f46e5';
            const typeIcon  = t => ({video:'fa-video',image:'fa-image',carousel:'fa-images'})[t] || 'fa-image';
            const typeColor = t => ({video:'#7c3aed',image:'#0891b2',carousel:'#d97706'})[t] || '#64748b';

            // Visual thumbnail grid of recent posts. CDN images often block hotlinking
            // via Referer, so we strip it (referrerpolicy) and fall back to a type-icon
            // placeholder (with caption snippet) when an image fails or is missing.
            const postsGrid = posts => {
                const items = arr(posts).filter(p => p && (p.image || p.text)).slice(0,21);
                if(!items.length) return '';
                const cells = items.map(p => {
                    const stats = [
                        p.likes!=null?`<span style="display:inline-flex;align-items:center;gap:3px;"><i class="fas fa-heart"></i>${num(p.likes)}</span>`:'',
                        p.comments!=null?`<span style="display:inline-flex;align-items:center;gap:3px;"><i class="fas fa-comment"></i>${num(p.comments)}</span>`:'',
                        p.views!=null?`<span style="display:inline-flex;align-items:center;gap:3px;"><i class="fas fa-eye"></i>${num(p.views)}</span>`:''
                    ].filter(Boolean).join('');
                    const tColor = typeColor(p.type), tIcon = typeIcon(p.type);
                    const ph = `<div class="sma-ph" style="display:${p.image?'none':'flex'};position:absolute;inset:0;align-items:center;justify-content:center;flex-direction:column;gap:6px;background:${tColor}12;color:${tColor};">
                        <i class="fas ${tIcon}" style="font-size:22px;"></i>
                        ${p.text?`<div style="font-size:10px;color:#94a3b8;padding:0 8px;text-align:center;line-height:1.3;max-height:46px;overflow:hidden;">${esc(String(p.text).slice(0,80))}</div>`:''}
                    </div>`;
                    const img = p.image
                        ? `<img src="${esc(p.image)}" referrerpolicy="no-referrer" loading="lazy" onerror="this.style.display='none';var ph=this.parentElement.querySelector('.sma-ph');if(ph)ph.style.display='flex';" style="width:100%;height:100%;object-fit:cover;display:block;">`
                        : '';
                    const inner = `<div style="position:relative;aspect-ratio:1;border-radius:8px;overflow:hidden;background:#f1f5f9;border:1px solid #e2e8f0;">
                        ${img}${ph}
                        <div style="position:absolute;top:6px;right:6px;background:rgba(0,0,0,.55);color:#fff;width:22px;height:22px;border-radius:6px;display:flex;align-items:center;justify-content:center;"><i class="fas ${tIcon}" style="font-size:10px;"></i></div>
                        ${stats?`<div style="position:absolute;left:0;right:0;bottom:0;padding:16px 7px 5px;background:linear-gradient(transparent,rgba(0,0,0,.72));color:#fff;font-size:11px;font-weight:600;display:flex;gap:9px;flex-wrap:wrap;">${stats}</div>`:''}
                    </div>`;
                    return p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener" style="text-decoration:none;display:block;">${inner}</a>` : inner;
                }).join('');
                return `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:8px;">${cells}</div>`;
            };
            const postPlatformBlock = (plat, handle, posts) => {
                const grid = postsGrid(posts);
                if(!grid) return '';
                const pColor = platformColor(plat), pIcon = platformIcon(plat);
                return `<div style="margin-bottom:18px;">
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
                        <i class="fab ${pIcon}" style="color:${pColor};font-size:15px;"></i>
                        <span style="font-weight:700;font-size:13px;color:#1e293b;text-transform:capitalize;">${esc(plat)}</span>
                        ${handle?`<span style="font-size:11px;color:#94a3b8;">${esc(handle)}</span>`:''}
                        <span style="font-size:11px;color:#94a3b8;margin-left:auto;">${arr(posts).length} posts</span>
                    </div>
                    ${grid}
                </div>`;
            };

            // Compact creative verdict (design / colour / style) for a competitor.
            const compCreativeBlock = cr => {
                if(!cr) return '';
                const cp = cr.colour_palette || {}, dq = cr.design_quality || {}, bc = cr.brand_consistency || {};
                const hasAny = cr.visual_style || cr.tone_of_voice || arr(cp.dominant).length || cp.notes
                    || dq.score!=null || dq.layout || bc.score!=null || arr(cr.recommendations).length || arr(cr.content_themes).length;
                if(!hasAny) return '';
                const pill = (label, val) => {
                    if(val==null) return '';
                    const c = val>=75?'#16a34a':val>=50?'#d97706':'#dc2626';
                    return `<span style="display:inline-flex;align-items:center;gap:5px;background:${c}14;color:${c};font-size:11px;font-weight:700;padding:3px 10px;border-radius:12px;">${label} ${esc(val)}/100</span>`;
                };
                const cohColor = {'consistent':'#16a34a','mostly consistent':'#d97706','inconsistent':'#dc2626'}[String(cp.coherence||'').toLowerCase()] || '#64748b';
                let inner = '';
                if(dq.score!=null || bc.score!=null){
                    inner += `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:9px;">${pill('Design',dq.score)}${pill('Consistency',bc.score)}</div>`;
                }
                if(cr.visual_style){
                    inner += `<div style="font-size:12.5px;color:#374151;line-height:1.5;margin-bottom:8px;"><b style="color:#0891b2;">Style:</b> ${esc(cr.visual_style)}</div>`;
                }
                if(arr(cp.dominant).length || cp.notes){
                    inner += `<div style="margin-bottom:8px;">
                        <span style="font-size:11px;font-weight:700;color:#7c3aed;"><i class="fas fa-droplet"></i> Colour:</span>
                        ${arr(cp.dominant).map(c=>`<span style="display:inline-block;background:#ede9fe;color:#5b21b6;font-size:10px;font-weight:600;padding:2px 8px;border-radius:10px;margin:0 3px 3px 0;">${esc(c)}</span>`).join('')}
                        ${cp.coherence?`<span style="font-size:10px;font-weight:700;color:${cohColor};text-transform:uppercase;">${esc(cp.coherence)}</span>`:''}
                        ${cp.notes?`<div style="font-size:12px;color:#64748b;line-height:1.5;margin-top:3px;">${esc(cp.notes)}</div>`:''}
                    </div>`;
                }
                if(arr(cr.content_themes).length){
                    inner += `<div style="margin-bottom:8px;">${chips(cr.content_themes.slice(0,4),'#eef2ff','#4338ca')}</div>`;
                }
                if(arr(cr.recommendations).length){
                    inner += `<div style="font-size:11px;font-weight:700;color:#16a34a;margin-bottom:4px;"><i class="fas fa-lightbulb"></i> Ideas to learn from / beat</div>${bullets(cr.recommendations.slice(0,3),'#16a34a','fa-chevron-right')}`;
                }
                return `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:13px 15px;margin:-6px 0 18px;">
                    <div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin-bottom:9px;"><i class="fas fa-wand-magic-sparkles"></i> Creative read</div>
                    ${inner}
                </div>`;
            };

            const card = (title, icon, inner) => `
                <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:20px 22px;margin-bottom:16px;box-shadow:0 1px 4px rgba(0,0,0,.04);">
                    <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
                        <div style="width:32px;height:32px;background:#eef2ff;border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                            <i class="fas ${icon}" style="color:#4f46e5;font-size:14px;"></i>
                        </div>
                        <div style="font-weight:700;font-size:14px;color:#1e293b;">${title}</div>
                    </div>
                    ${inner}
                </div>`;

            const chips = (items, bg, col) => arr(items).map(x=>`<span style="display:inline-block;background:${bg};color:${col};font-size:11px;font-weight:600;padding:3px 10px;border-radius:14px;margin:0 4px 5px 0;border:1px solid rgba(0,0,0,.06);">${esc(x)}</span>`).join('');

            const bullets = (items, color, icon) => `<ul style="margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:7px;">
                ${arr(items).map(x=>`<li style="display:flex;align-items:flex-start;gap:8px;font-size:13px;color:#374151;line-height:1.5;">
                    <i class="fas ${icon||'fa-circle-dot'}" style="color:${color||'#4f46e5'};font-size:10px;margin-top:4px;flex-shrink:0;"></i>
                    <span>${esc(x)}</span></li>`).join('')}
            </ul>`;

            let html = '';

            // Audit summary with score circle
            if(d.executive_summary || d.overall_health || d.overall_score!=null){
                const hc = healthColor(d.overall_health);
                const score = d.overall_score!=null ? `
                    <div style="text-align:center;background:${hc}18;border:2px solid ${hc}40;border-radius:50%;width:74px;height:74px;display:flex;flex-direction:column;align-items:center;justify-content:center;flex-shrink:0;">
                        <div style="font-size:24px;font-weight:800;color:${hc};line-height:1;">${esc(d.overall_score)}</div>
                        <div style="font-size:10px;color:#94a3b8;font-weight:600;">/100${smaTip('Overall score')}</div>
                    </div>` : '';
                const health = d.overall_health ? `<span style="background:${hc};color:#fff;font-size:12px;font-weight:700;padding:4px 14px;border-radius:20px;">${esc(d.overall_health)}</span>` : '';
                html += `<div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:20px 22px;margin-bottom:16px;box-shadow:0 1px 4px rgba(0,0,0,.04);">
                    <div style="display:flex;align-items:flex-start;gap:16px;">
                        ${score}
                        <div style="flex:1;">
                            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px;">
                                <div style="font-weight:700;font-size:15px;color:#1e293b;">Audit summary</div>
                                ${health}
                            </div>
                            ${d.executive_summary?`<div style="background:#eef2ff;border-left:3px solid #4f46e5;border-radius:0 6px 6px 0;padding:12px 14px;color:#374151;font-size:13px;line-height:1.6;">${esc(d.executive_summary)}</div>`:''}
                        </div>
                    </div>
                </div>`;
            }

            // Platform breakdown with brand colors and icons
            if(arr(d.platforms).length){
                const cells = d.platforms.map(p=>{
                    const cm = p.content_mix || {};
                    const pc = p.profile_completeness || {};
                    const pColor = platformColor(p.platform);
                    const pIcon  = platformIcon(p.platform);
                    if(!p.found) return `<div style="border:1px solid #fecaca;background:#fef2f2;border-radius:10px;padding:14px;">
                        <div style="display:flex;align-items:center;gap:8px;font-weight:700;text-transform:capitalize;margin-bottom:4px;">
                            <i class="fab ${pIcon}" style="color:${pColor};font-size:16px;"></i>${esc(p.platform)}</div>
                        <div style="font-size:12px;color:#dc2626;">No public profile found for <b>${esc(p.handle||'—')}</b></div></div>`;
                    const compl = pc.score!=null ? pc.score : null;
                    const complColor = compl==null?'#94a3b8':compl>=80?'#16a34a':compl>=50?'#d97706':'#dc2626';
                    const gr = p.followers_growth_30d;
                    const stat = (lbl,val,vc)=>`<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid #f1f5f9;">
                        <span style="font-size:12px;color:#64748b;">${lbl}${smaTip(lbl)}</span>
                        <b style="font-size:12px;color:${vc||'#1e293b'};">${val}</b></div>`;
                    return `<div style="border:1px solid #e2e8f0;border-radius:10px;padding:14px;display:flex;flex-direction:column;">
                        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
                            <div style="display:flex;align-items:center;gap:10px;">
                                <div style="width:36px;height:36px;background:${pColor}18;border-radius:9px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                                    <i class="fab ${pIcon}" style="color:${pColor};font-size:17px;"></i>
                                </div>
                                <div>
                                    <div style="font-weight:700;text-transform:capitalize;font-size:13px;color:#1e293b;">${esc(p.platform)}</div>
                                    <div style="font-size:11px;color:#94a3b8;">${esc(p.handle||'')}</div>
                                </div>
                            </div>
                            ${compl!=null?`<div style="text-align:right;">
                                <div style="font-size:19px;font-weight:800;color:${complColor};line-height:1;">${compl}%</div>
                                <div style="font-size:10px;color:#94a3b8;">complete${smaTip('complete')}</div>
                            </div>`:''}
                        </div>
                        ${stat('Followers', num(p.followers))}
                        ${gr!=null?stat('Growth (30d)', (gr>=0?'+':'')+num(gr), gr>0?'#16a34a':gr<0?'#dc2626':'#64748b'):''}
                        ${stat('Engagement rate', p.engagement_rate!=null?p.engagement_rate+'%':'—', p.engagement_rate>3?'#16a34a':p.engagement_rate>1?'#d97706':'#dc2626')}
                        ${stat('Posts / week', num(p.posts_per_week))}
                        ${stat('Days since last post', num(p.days_since_last_post))}
                        ${stat('Avg likes', num(p.avg_likes))}
                        ${p.avg_video_views!=null?stat('Avg video views', num(p.avg_video_views)):''}
                        ${stat('Mix (v / i / c)', `${cm.video||0} / ${cm.image||0} / ${cm.carousel||0}`)}
                        ${arr(p.top_hashtags).length?`<div style="margin-top:10px;padding-top:8px;border-top:1px solid #f1f5f9;">${chips(p.top_hashtags.slice(0,5),'#f1f5f9','#475569')}</div>`:''}
                    </div>`;
                }).join('');
                html += card('Platform breakdown','fa-share-nodes',
                    `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(215px,1fr));gap:14px;">${cells}</div>`);
            }

            // Recent posts grid (brand) — visual thumbnails per platform
            const brandPostBlocks = arr(d.platforms).filter(p=>p.found && arr(p.posts).length)
                .map(p=>postPlatformBlock(p.platform, p.handle, p.posts)).join('');
            if(brandPostBlocks){
                html += card('Recent posts','fa-table-cells', brandPostBlocks);
            }

            // Content & creative — themes, tone of voice, visual style, consistency
            const cr = d.creative || {};
            if(cr.tone_of_voice || cr.visual_style || arr(cr.content_themes).length || arr(cr.content_pillars).length || arr(cr.recommendations).length || (cr.brand_consistency && cr.brand_consistency.score!=null)){
                const bcons = cr.brand_consistency || {};
                const cScore = bcons.score!=null ? bcons.score : null;
                const cColor = cScore==null?'#94a3b8':cScore>=75?'#16a34a':cScore>=50?'#d97706':'#dc2626';
                const scoreCircle = cScore!=null ? `
                    <div style="text-align:center;background:${cColor}18;border:2px solid ${cColor}40;border-radius:50%;width:64px;height:64px;display:flex;flex-direction:column;align-items:center;justify-content:center;flex-shrink:0;">
                        <div style="font-size:21px;font-weight:800;color:${cColor};line-height:1;">${esc(cScore)}</div>
                        <div style="font-size:9px;color:#94a3b8;font-weight:600;">/100</div>
                    </div>` : '';
                const textPanel = (icon, label, val, accent) => val ? `
                    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-left:3px solid ${accent};border-radius:0 8px 8px 0;padding:12px 14px;">
                        <div style="display:flex;align-items:center;gap:6px;font-size:11px;font-weight:700;color:${accent};text-transform:uppercase;letter-spacing:.4px;margin-bottom:5px;"><i class="fas ${icon}"></i> ${label}</div>
                        <div style="font-size:13px;color:#374151;line-height:1.55;">${esc(val)}</div>
                    </div>` : '';
                let crInner = '';
                // consistency header
                if(cScore!=null || bcons.notes){
                    crInner += `<div style="display:flex;align-items:center;gap:14px;margin-bottom:14px;">
                        ${scoreCircle}
                        <div style="flex:1;">
                            <div style="font-size:12px;font-weight:700;color:#1e293b;margin-bottom:3px;">Brand consistency${smaTip('Brand consistency')}</div>
                            <div style="font-size:13px;color:#64748b;line-height:1.55;">${esc(bcons.notes||'How cohesive the look, voice and themes are across posts.')}</div>
                        </div>
                    </div>`;
                }
                crInner += `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin-bottom:14px;">
                    ${textPanel('fa-comment-dots','Tone of voice',cr.tone_of_voice,'#7c3aed')}
                    ${textPanel('fa-palette','Visual style',cr.visual_style,'#0891b2')}
                </div>`;
                // Colour palette
                const cp = cr.colour_palette || {};
                if(cp.notes || arr(cp.dominant).length){
                    const coherenceColor = {'consistent':'#16a34a','mostly consistent':'#d97706','inconsistent':'#dc2626'}[String(cp.coherence||'').toLowerCase()] || '#64748b';
                    crInner += `<div style="background:#faf5ff;border:1px solid #e9d5ff;border-radius:10px;padding:14px;margin-bottom:12px;">
                        <div style="display:flex;align-items:center;gap:6px;font-size:12px;font-weight:700;color:#7c3aed;margin-bottom:10px;"><i class="fas fa-droplet"></i> Colour palette</div>
                        ${arr(cp.dominant).length ? `<div style="margin-bottom:8px;">${arr(cp.dominant).map(c=>`<span style="display:inline-block;background:#ede9fe;color:#5b21b6;font-size:11px;font-weight:600;padding:3px 10px;border-radius:14px;margin:0 4px 4px 0;">${esc(c)}</span>`).join('')}</div>` : ''}
                        ${cp.coherence ? `<div style="margin-bottom:6px;"><span style="font-size:11px;font-weight:700;color:${coherenceColor};text-transform:uppercase;letter-spacing:.4px;">${esc(cp.coherence)}</span></div>` : ''}
                        ${cp.notes ? `<div style="font-size:13px;color:#374151;line-height:1.55;">${esc(cp.notes)}</div>` : ''}
                    </div>`;
                }
                // Design quality
                const dq = cr.design_quality || {};
                if(dq.score!=null || dq.layout || dq.typography){
                    const dqScore = dq.score!=null ? dq.score : null;
                    const dqColor = dqScore==null?'#94a3b8':dqScore>=75?'#16a34a':dqScore>=50?'#d97706':'#dc2626';
                    crInner += `<div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;padding:14px;margin-bottom:12px;">
                        <div style="display:flex;align-items:flex-start;gap:14px;">
                            ${dqScore!=null ? `<div style="text-align:center;background:${dqColor}18;border:2px solid ${dqColor}40;border-radius:50%;width:56px;height:56px;display:flex;flex-direction:column;align-items:center;justify-content:center;flex-shrink:0;">
                                <div style="font-size:18px;font-weight:800;color:${dqColor};line-height:1;">${esc(dqScore)}</div>
                                <div style="font-size:9px;color:#94a3b8;font-weight:600;">/100</div>
                            </div>` : ''}
                            <div style="flex:1;">
                                <div style="font-size:12px;font-weight:700;color:#0369a1;margin-bottom:6px;"><i class="fas fa-pen-ruler"></i> Design quality${smaTip('Design quality')}</div>
                                ${dq.layout ? `<div style="font-size:12px;font-weight:600;color:#64748b;margin-bottom:2px;">Layout &amp; whitespace</div><div style="font-size:13px;color:#374151;margin-bottom:8px;line-height:1.5;">${esc(dq.layout)}</div>` : ''}
                                ${dq.template_use ? `<div style="margin-bottom:6px;"><span style="font-size:11px;font-weight:700;background:#e0f2fe;color:#0369a1;padding:2px 9px;border-radius:10px;">${esc(dq.template_use)}</span></div>` : ''}
                                ${dq.typography ? `<div style="font-size:12px;font-weight:600;color:#64748b;margin-bottom:2px;">Typography</div><div style="font-size:13px;color:#374151;line-height:1.5;">${esc(dq.typography)}</div>` : ''}
                            </div>
                        </div>
                    </div>`;
                }
                if(arr(cr.content_themes).length){
                    crInner += `<div style="margin-bottom:12px;"><div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin-bottom:7px;">Recurring themes</div>${chips(cr.content_themes,'#eef2ff','#4338ca')}</div>`;
                }
                if(arr(cr.content_pillars).length){
                    crInner += `<div style="margin-bottom:12px;"><div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin-bottom:7px;">Content pillars</div>${chips(cr.content_pillars,'#f0fdf4','#15803d')}</div>`;
                }
                if(arr(cr.standout_observations).length){
                    crInner += `<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:14px;margin-bottom:12px;">
                        <div style="display:flex;align-items:center;gap:6px;font-size:12px;font-weight:700;color:#d97706;margin-bottom:10px;"><i class="fas fa-eye"></i> What stands out</div>
                        ${bullets(cr.standout_observations,'#d97706','fa-chevron-right')}</div>`;
                }
                if(arr(cr.recommendations).length){
                    crInner += `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:14px;margin-bottom:12px;">
                        <div style="display:flex;align-items:center;gap:6px;font-size:12px;font-weight:700;color:#16a34a;margin-bottom:10px;"><i class="fas fa-lightbulb"></i> Creative recommendations</div>
                        ${bullets(cr.recommendations,'#16a34a','fa-chevron-right')}</div>`;
                }
                const footBits = [];
                if(cr.posts_analyzed!=null) footBits.push(`${cr.posts_analyzed} captions`);
                if(cr.images_analyzed!=null) footBits.push(`${cr.images_analyzed} images`);
                if(footBits.length) crInner += `<div style="font-size:11px;color:#94a3b8;display:flex;align-items:center;gap:6px;"><i class="fas fa-robot"></i> Analysed ${footBits.join(' + ')} from recent posts${cr.images_analyzed===0?' — imagery unavailable, read from captions only':''}.</div>`;
                html += card('Content &amp; creative','fa-wand-magic-sparkles', crInner);
            }

            // Indicators table with status badges
            if(arr(d.indicators).length){
                const rows = d.indicators.map((i,idx)=>`<tr style="background:${idx%2===0?'#fff':'#f9fafb'};">
                    <td style="padding:9px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#1e293b;">${esc(i.label)}</td>
                    <td style="padding:9px 12px;border-bottom:1px solid #f1f5f9;">
                        <span style="display:inline-flex;align-items:center;gap:5px;background:${statusBg(i.status)};color:${statusColor(i.status)};font-size:12px;font-weight:700;padding:3px 10px;border-radius:20px;white-space:nowrap;">
                            <i class="fas ${statusIcon(i.status)}" style="font-size:10px;"></i>${esc(i.value)}</span></td>
                    <td style="padding:9px 12px;border-bottom:1px solid #f1f5f9;font-size:11px;color:#94a3b8;white-space:nowrap;">${esc(i.source)}</td>
                </tr>`).join('');
                html += card('Indicators','fa-list-check',
                    `<div style="overflow-x:auto;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
                        <table style="width:100%;border-collapse:collapse;">
                            <thead><tr style="background:#1e293b;text-align:left;">
                                <th style="padding:9px 12px;font-size:11px;color:#f1f5f9;text-transform:uppercase;letter-spacing:.5px;font-weight:700;">Indicator</th>
                                <th style="padding:9px 12px;font-size:11px;color:#f1f5f9;text-transform:uppercase;letter-spacing:.5px;font-weight:700;">Value</th>
                                <th style="padding:9px 12px;font-size:11px;color:#f1f5f9;text-transform:uppercase;letter-spacing:.5px;font-weight:700;">Source</th>
                            </tr></thead>
                            <tbody>${rows}</tbody>
                        </table>
                    </div>`);
            }

            // Competitor benchmark table with platform icons
            if(arr(d.competitors).length){
                const rows = d.competitors.map((c,idx)=>`<tr style="background:${idx%2===0?'#fff':'#f9fafb'};">
                    <td style="padding:9px 12px;border-bottom:1px solid #f1f5f9;font-weight:600;font-size:13px;">${esc(c.name||c.handle)}</td>
                    <td style="padding:9px 12px;border-bottom:1px solid #f1f5f9;">
                        <span style="display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;color:${platformColor(c.platform)};">
                            <i class="fab ${platformIcon(c.platform)}"></i>${esc(c.platform)}</span></td>
                    <td style="padding:9px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;">${num(c.followers)}</td>
                    <td style="padding:9px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;">${c.engagement_rate!=null?c.engagement_rate+'%':'—'}</td>
                    <td style="padding:9px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;">${num(c.posts_per_week)}</td>
                    <td style="padding:9px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;">${num(c.days_since_last_post)}</td>
                    <td style="padding:9px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;">${num(c.avg_likes)}</td>
                </tr>`).join('');
                html += card('Competitor benchmark','fa-people-arrows',
                    `<div style="overflow-x:auto;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
                        <table style="width:100%;border-collapse:collapse;font-size:13px;">
                            <thead><tr style="background:#1e293b;text-align:left;">
                                <th style="padding:9px 12px;font-size:11px;color:#f1f5f9;text-transform:uppercase;letter-spacing:.5px;font-weight:700;">Competitor</th>
                                <th style="padding:9px 12px;font-size:11px;color:#f1f5f9;text-transform:uppercase;letter-spacing:.5px;font-weight:700;">Platform</th>
                                <th style="padding:9px 12px;font-size:11px;color:#f1f5f9;text-transform:uppercase;letter-spacing:.5px;font-weight:700;">Followers${smaTip('Followers')}</th>
                                <th style="padding:9px 12px;font-size:11px;color:#f1f5f9;text-transform:uppercase;letter-spacing:.5px;font-weight:700;">Eng. rate${smaTip('Eng. rate')}</th>
                                <th style="padding:9px 12px;font-size:11px;color:#f1f5f9;text-transform:uppercase;letter-spacing:.5px;font-weight:700;">Posts/wk${smaTip('Posts/wk')}</th>
                                <th style="padding:9px 12px;font-size:11px;color:#f1f5f9;text-transform:uppercase;letter-spacing:.5px;font-weight:700;">Last post${smaTip('Last post')}</th>
                                <th style="padding:9px 12px;font-size:11px;color:#f1f5f9;text-transform:uppercase;letter-spacing:.5px;font-weight:700;">Avg likes${smaTip('Avg likes')}</th>
                            </tr></thead>
                            <tbody>${rows}</tbody>
                        </table>
                    </div>`);
            }

            // Competitor analysis — who each competitor IS (what they do, sell,
            // target, how they position) and what they TALK ABOUT (topics owned,
            // pillars, messaging/tone, how they engage). The tables below cover
            // performance; this covers the qualitative half of the audit.
            const cprofs = arr(d.competitor_profiles).filter(p=>p && (p.what_they_do || p.positioning || p.messaging_tone || arr(p.content_pillars).length));
            if(cprofs.length){
                const pfLabel = t=>`<div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;">${t}</div>`;
                const pfText  = (t,v)=>v?`<div style="margin-bottom:10px;">${pfLabel(t)}<div style="font-size:12.5px;color:#374151;line-height:1.55;">${esc(v)}</div></div>`:'';
                const pfChips = (t,items,bg,col)=>arr(items).length?`<div style="margin-bottom:10px;">${pfLabel(t)}${chips(items,bg,col)}</div>`:'';
                const pfList  = (t,items,color)=>arr(items).length?`<div style="margin-bottom:10px;">${pfLabel(t)}${bullets(items,color,'fa-chevron-right')}</div>`:'';
                const pblocks = cprofs.map(p=>{
                    const icons = arr(p.platforms).map(pl=>`<i class="fab ${platformIcon(pl)}" style="color:${platformColor(pl)};font-size:14px;"></i>`).join('');
                    const conf = {high:'#16a34a',medium:'#d97706',low:'#dc2626'}[String(p.confidence||'').toLowerCase()];
                    return `<div style="border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;margin-bottom:12px;">
                        <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap;">
                            <div style="font-weight:700;font-size:13.5px;color:#1e293b;">${esc(p.name||'Competitor')}</div>
                            <span style="display:inline-flex;gap:7px;align-items:center;">${icons}</span>
                            ${conf?`<span style="margin-left:auto;background:${conf}14;color:${conf};font-size:10px;font-weight:700;padding:2px 9px;border-radius:10px;text-transform:uppercase;letter-spacing:.4px;">${esc(p.confidence)} confidence</span>`:''}
                        </div>
                        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:18px;">
                            <div>
                                <div style="display:flex;align-items:center;gap:6px;font-size:12px;font-weight:700;color:#4f46e5;margin-bottom:10px;"><i class="fas fa-building"></i> Brand overview</div>
                                ${pfText('What they do', p.what_they_do)}
                                ${pfChips('Products &amp; services', p.products_services, '#eef2ff', '#4338ca')}
                                ${pfText('Target audience', p.target_audience)}
                                ${pfText('Positioning', p.positioning)}
                                ${pfList('Key differentiators', p.differentiators, '#4f46e5')}
                            </div>
                            <div>
                                <div style="display:flex;align-items:center;gap:6px;font-size:12px;font-weight:700;color:#0891b2;margin-bottom:10px;"><i class="fas fa-comments"></i> Content &amp; conversation</div>
                                ${pfChips('Conversations they own', p.topics_owned, '#ecfeff', '#0e7490')}
                                ${pfChips('Content pillars &amp; themes', p.content_pillars, '#f0fdf4', '#15803d')}
                                ${pfText('Messaging &amp; tone of voice', p.messaging_tone)}
                                ${pfText('How they engage their audience', p.audience_engagement)}
                            </div>
                        </div>
                    </div>`;
                }).join('');
                html += card('Competitor analysis','fa-id-card-clip',
                    `<div style="font-size:12px;color:#64748b;margin-bottom:14px;">Who each competitor is — what they do, sell, target and stand for — and the conversations, pillars, messaging and engagement style behind their social. Inferred from their bios, captions, hashtags and account metrics.</div>${pblocks}`);
            }

            // What competitors are doing
            const compsWithContent = arr(d.competitors).filter(c=>arr(c.top_posts).length || (c.content_mix && (c.content_mix.video||c.content_mix.image||c.content_mix.carousel)) || arr(c.top_hashtags).length);
            if(compsWithContent.length){
                const blocks = compsWithContent.map(c=>{
                    const cm = c.content_mix || {};
                    const pColor = platformColor(c.platform);
                    const pIcon  = platformIcon(c.platform);
                    const posts = arr(c.top_posts).map(p=>{
                        const cap = p.text ? esc(p.text) : '<span style="color:#94a3b8;font-style:italic;">(no caption)</span>';
                        const stats = [
                            p.likes!=null?`<span style="display:inline-flex;align-items:center;gap:3px;"><i class="fas fa-heart" style="color:#e11d48;font-size:10px;"></i>${num(p.likes)}</span>`:'',
                            p.comments!=null?`<span style="display:inline-flex;align-items:center;gap:3px;"><i class="fas fa-comment" style="color:#64748b;font-size:10px;"></i>${num(p.comments)}</span>`:'',
                            p.views!=null?`<span style="display:inline-flex;align-items:center;gap:3px;"><i class="fas fa-eye" style="color:#64748b;font-size:10px;"></i>${num(p.views)}</span>`:''
                        ].filter(Boolean).join(' · ');
                        const inner = `<div style="display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px solid #f1f5f9;">
                            <div style="width:28px;height:28px;background:${typeColor(p.type)}18;border-radius:6px;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px;">
                                <i class="fas ${typeIcon(p.type)}" style="color:${typeColor(p.type)};font-size:11px;"></i>
                            </div>
                            <div style="flex:1;">
                                <div style="font-size:12px;color:#334155;line-height:1.5;">${cap}</div>
                                ${stats?`<div style="display:flex;gap:10px;flex-wrap:wrap;font-size:11px;color:#64748b;margin-top:4px;">${stats}</div>`:''}</div></div>`;
                        return p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener" style="text-decoration:none;display:block;">${inner}</a>` : inner;
                    }).join('');
                    return `<div style="border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;margin-bottom:12px;">
                        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
                            <div style="width:36px;height:36px;background:${pColor}18;border-radius:9px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                                <i class="fab ${pIcon}" style="color:${pColor};font-size:17px;"></i>
                            </div>
                            <div>
                                <div style="font-weight:700;font-size:13px;color:#1e293b;">${esc(c.name||c.platform)}</div>
                                <div style="font-size:11px;color:#94a3b8;text-transform:capitalize;">${esc(c.platform)}</div>
                            </div>
                            <div style="margin-left:auto;display:flex;gap:6px;flex-wrap:wrap;">
                                ${cm.video?`<span style="background:#7c3aed18;color:#7c3aed;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;">${cm.video}v</span>`:''}
                                ${cm.image?`<span style="background:#0891b218;color:#0891b2;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;">${cm.image}i</span>`:''}
                                ${cm.carousel?`<span style="background:#d9740618;color:#d97706;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;">${cm.carousel}c</span>`:''}
                            </div>
                        </div>
                        ${arr(c.top_hashtags).length?`<div style="margin-bottom:10px;">${chips(c.top_hashtags.slice(0,6),'#f1f5f9','#475569')}</div>`:''}
                        ${posts?`<div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;">Top posts</div>${posts}`:''}
                    </div>`;
                }).join('');
                html += card('What competitors are doing','fa-binoculars', blocks);
            }

            // Competitor recent-posts grids — opt-in show/hide toggle
            const compsWithPosts = arr(d.competitors).filter(c=>arr(c.posts).length);
            if(compsWithPosts.length){
                const cblocks = compsWithPosts.map(c=>postPlatformBlock(c.platform, (c.name||c.handle), c.posts) + compCreativeBlock(c.creative)).join('');
                html += card('Competitor posts','fa-table-cells-large',
                    `<div style="font-size:12px;color:#64748b;margin-bottom:12px;">See each competitor's actual recent posts plus an AI read of their design, colour scheme and style.</div>
                     <button type="button" onclick="smaTogglePostsGrid(this,'smaCompPostsGrid')" style="border:1px solid #c7d2fe;background:#eef2ff;color:#4338ca;font-weight:700;font-size:12px;padding:7px 14px;border-radius:8px;cursor:pointer;"><i class="fas fa-images"></i> Show competitor posts</button>
                     <div id="smaCompPostsGrid" style="display:none;margin-top:16px;">${cblocks}</div>`);
            }

            // You vs competitors — coloured panels
            const ci = d.competitor_insights || {};
            if(arr(ci.doing_better).length || arr(ci.content_gaps).length || arr(ci.tactics_to_copy).length){
                html += card('You vs competitors','fa-chess',
                    `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;">
                        <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:14px;">
                            <div style="display:flex;align-items:center;gap:6px;font-size:12px;font-weight:700;color:#dc2626;margin-bottom:10px;">
                                <i class="fas fa-triangle-exclamation"></i> They do better</div>
                            ${bullets(ci.doing_better,'#dc2626','fa-chevron-right')}</div>
                        <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:14px;">
                            <div style="display:flex;align-items:center;gap:6px;font-size:12px;font-weight:700;color:#d97706;margin-bottom:10px;">
                                <i class="fas fa-magnifying-glass"></i> Content gaps</div>
                            ${bullets(ci.content_gaps,'#d97706','fa-chevron-right')}</div>
                        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:14px;">
                            <div style="display:flex;align-items:center;gap:6px;font-size:12px;font-weight:700;color:#16a34a;margin-bottom:10px;">
                                <i class="fas fa-lightbulb"></i> Tactics to copy</div>
                            ${bullets(ci.tactics_to_copy,'#16a34a','fa-chevron-right')}</div>
                    </div>`);
            }

            // Brand health — big metric tiles
            const bh = d.brand_health || {};
            if(bh.branded_search_volume!=null || bh.gbp_rating!=null || bh.web_mentions!=null){
                const bhTile = (icon, label, value, color) => `
                    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;display:flex;align-items:center;gap:14px;">
                        <div style="width:44px;height:44px;background:${color}18;border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                            <i class="fas ${icon}" style="color:${color};font-size:20px;"></i>
                        </div>
                        <div>
                            <div style="font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.4px;margin-bottom:2px;">${label}${smaTip(label)}</div>
                            <div style="font-size:22px;font-weight:800;color:#1e293b;line-height:1.2;">${value}</div>
                        </div>
                    </div>`;
                html += card('Brand health','fa-heart-pulse',
                    `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;">
                        ${bh.branded_search_volume!=null?bhTile('fa-magnifying-glass','Branded search',num(bh.branded_search_volume),'#4f46e5'):''}
                        ${bh.web_mentions!=null?bhTile('fa-at','Web mentions',num(bh.web_mentions),'#0891b2'):''}
                        ${bh.gbp_rating!=null?bhTile('fa-star','Google rating',`${esc(bh.gbp_rating)} <span style="font-size:14px;color:#94a3b8;font-weight:600;">(${num(bh.gbp_reviews)})</span>`,'#d97706'):''}
                    </div>`);
            }

            // Social listening — brand mentions & sentiment across web + social
            const sl = d.social_listening;
            if(sl && sl.enabled !== false){
                const s = sl.summary || {};
                const sent = s.sentiment || {};
                const pos = +sent.positive || 0, neg = +sent.negative || 0, neu = +sent.neutral || 0;
                const totSent = pos + neg + neu;
                const pct = x => totSent ? Math.round(x / totSent * 100) : 0;
                const hasAny = s.total_mentions != null || totSent > 0 || arr(sl.mentions).length
                    || Object.values(sl.platforms || {}).some(p => arr(p.results).length);
                if(hasAny){
                    const slTile = (icon,label,value,color)=>`
                        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;display:flex;align-items:center;gap:14px;">
                            <div style="width:44px;height:44px;background:${color}18;border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                                <i class="fas ${icon}" style="color:${color};font-size:20px;"></i></div>
                            <div><div style="font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.4px;margin-bottom:2px;">${label}</div>
                                <div style="font-size:22px;font-weight:800;color:#1e293b;line-height:1.2;">${value}</div></div>
                        </div>`;
                    const sentBadge = x => {
                        const m = {positive:['#16a34a','#16a34a18'],negative:['#dc2626','#dc262618'],neutral:['#64748b','#64748b18']}[x];
                        return m?`<span style="background:${m[1]};color:${m[0]};font-size:10px;font-weight:700;padding:1px 7px;border-radius:9px;text-transform:capitalize;">${x}</span>`:'';
                    };
                    let inner = `<div style="font-size:12px;color:#64748b;margin-bottom:14px;">Brand mentions and sentiment across the open web, blogs, forums, Reddit and X${sl.note?` — <span style="color:#b45309;">${esc(sl.note)}</span>`:''}.</div>`;
                    if(arr(sl.terms).length)
                        inner += `<div style="margin-bottom:14px;"><span style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin-right:8px;">Tracking</span>${chips(sl.terms,'#eef2ff','#4338ca')}</div>`;
                    if(s.total_mentions != null)
                        inner += `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:16px;">${slTile('fa-at','Web mentions',num(s.total_mentions),'#0891b2')}</div>`;
                    if(totSent > 0)
                        inner += `<div style="margin-bottom:16px;">
                            <div style="display:flex;justify-content:space-between;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;"><span>Sentiment of mentions</span><span>${num(totSent)} analysed</span></div>
                            <div style="display:flex;height:14px;border-radius:7px;overflow:hidden;border:1px solid #e2e8f0;">
                                <div style="width:${pct(pos)}%;background:#16a34a;"></div><div style="width:${pct(neu)}%;background:#cbd5e1;"></div><div style="width:${pct(neg)}%;background:#dc2626;"></div></div>
                            <div style="display:flex;gap:14px;margin-top:6px;font-size:12px;color:#475569;flex-wrap:wrap;">
                                <span><span style="color:#16a34a;font-weight:700;">●</span> Positive ${pct(pos)}%</span>
                                <span><span style="color:#94a3b8;font-weight:700;">●</span> Neutral ${pct(neu)}%</span>
                                <span><span style="color:#dc2626;font-weight:700;">●</span> Negative ${pct(neg)}%</span></div>
                        </div>`;
                    if(arr(s.top_domains).length)
                        inner += `<div style="margin-bottom:16px;"><div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Where it's being mentioned</div>${chips(s.top_domains.slice(0,8),'#f1f5f9','#475569')}</div>`;
                    const mentions = arr(sl.mentions).slice(0,10).map(m=>`
                        <div style="border:1px solid #e2e8f0;border-radius:10px;padding:10px 12px;">
                            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:3px;">
                                <a href="${esc(m.url)}" target="_blank" rel="noopener" style="font-size:13px;font-weight:600;color:#4338ca;text-decoration:none;">${esc(m.title||m.url||'')}</a>${sentBadge(m.sentiment)}</div>
                            <div style="font-size:11px;color:#94a3b8;margin-bottom:4px;">${esc(m.domain||'')}${m.date?' · '+esc(String(m.date).slice(0,10)):''}</div>
                            ${m.snippet?`<div style="font-size:12px;color:#475569;line-height:1.4;">${esc(m.snippet)}</div>`:''}
                        </div>`).join('');
                    if(mentions)
                        inner += `<div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin:4px 0 8px;">Recent mentions</div><div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px;">${mentions}</div>`;
                    const platIcon = {reddit:'fab fa-reddit',twitter:'fab fa-x-twitter',forums:'fas fa-comments'};
                    const platsHtml = Object.entries(sl.platforms||{}).map(([key,obj])=>{
                        const results = arr(obj.results); if(!results.length) return '';
                        const rows = results.slice(0,6).map(r=>`<li style="margin-bottom:8px;"><a href="${esc(r.url)}" target="_blank" rel="noopener" style="font-size:12px;font-weight:600;color:#4338ca;text-decoration:none;">${esc(r.title||r.url||'')}</a>${r.snippet?`<div style="font-size:11px;color:#94a3b8;line-height:1.4;">${esc(r.snippet)}</div>`:''}</li>`).join('');
                        return `<div style="margin-bottom:14px;"><div style="font-size:12px;font-weight:700;color:#334155;margin-bottom:6px;"><i class="${platIcon[key]||'fas fa-globe'}"></i> ${esc(obj.label||key)} <span style="color:#94a3b8;font-weight:500;">(${results.length})</span></div><ul style="list-style:none;padding:0;margin:0;">${rows}</ul></div>`;
                    }).join('');
                    if(platsHtml)
                        inner += `<div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin:4px 0 10px;">On social &amp; forums</div>${platsHtml}`;
                    html += card('Social listening — mentions &amp; sentiment','fa-satellite-dish', inner);
                }
            }

            // Strengths & gaps — coloured panels with icons
            if(arr(d.strengths).length || arr(d.gaps).length){
                html += card('Strengths &amp; gaps','fa-scale-balanced',
                    `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;">
                        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:16px;">
                            <div style="display:flex;align-items:center;gap:7px;font-size:12px;font-weight:700;color:#15803d;margin-bottom:12px;">
                                <i class="fas fa-circle-check"></i> Strengths</div>
                            ${bullets(d.strengths,'#15803d','fa-check')}</div>
                        <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:16px;">
                            <div style="display:flex;align-items:center;gap:7px;font-size:12px;font-weight:700;color:#b91c1c;margin-bottom:12px;">
                                <i class="fas fa-circle-exclamation"></i> Gaps</div>
                            ${bullets(d.gaps,'#b91c1c','fa-xmark')}</div>
                    </div>`);
            }

            // Action plan — priority-coloured cards
            if(arr(d.action_plan).length){
                html += card('Action plan','fa-list-check',
                    `<div style="display:flex;flex-direction:column;gap:10px;">
                        ${d.action_plan.map(p=>`
                            <div style="display:flex;gap:12px;align-items:flex-start;background:${prioBg(p.priority)};border:1px solid ${prioColor(p.priority)}28;border-radius:10px;padding:12px 14px;">
                                <i class="fas ${prioIcon(p.priority)}" style="color:${prioColor(p.priority)};font-size:17px;margin-top:1px;flex-shrink:0;"></i>
                                <div style="flex:1;">
                                    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px;">
                                        <span style="font-size:13px;color:#1e293b;font-weight:600;">${esc(p.action)}</span>
                                        <span style="background:${prioColor(p.priority)};color:#fff;font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;text-transform:uppercase;">${esc(p.priority||'—')}</span>
                                    </div>
                                    ${p.expected_impact?`<div style="font-size:12px;color:#64748b;"><b style="color:#475569;">Impact:</b> ${esc(p.expected_impact)}</div>`:''}</div>
                            </div>`).join('')}
                    </div>`);
            }

            return html || '<div style="color:#64748b;font-size:13px;">No audit data returned.</div>';
}

export function renderSocialAudit(d){
            const esc = _pmEsc;
            const arr = x => Array.isArray(x) ? x : [];
            const cs = d.current_state || {};
            const healthColor = h => { const k=String(h||'').toLowerCase(); return k.includes('under')?'#dc2626':k.includes('develop')?'#d97706':k.includes('strong')?'#16a34a':'#4f46e5'; };
            const prioColor = p => ({high:'#dc2626',medium:'#d97706',low:'#64748b'})[String(p||'').toLowerCase()] || '#64748b';
            const card = (title, icon, inner, extra) => `<div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px 18px;margin-bottom:14px;">
                <div style="display:flex;align-items:center;gap:8px;font-weight:700;font-size:14px;color:#1e293b;margin-bottom:10px;"><i class="fas ${icon}" style="color:#4f46e5;"></i> ${title}${extra||''}</div>${inner}</div>`;
            const chips = (items, bg, col) => arr(items).map(x=>`<span style="display:inline-block;background:${bg};color:${col};font-size:12px;font-weight:600;padding:3px 10px;border-radius:14px;margin:0 6px 6px 0;">${esc(x)}</span>`).join('');
            const bullets = items => `<ul style="margin:0;padding-left:18px;color:#374151;font-size:13px;line-height:1.6;">${arr(items).map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`;

            let html = '';

            if(d.executive_summary || d.overall_health){
                html += card('Audit summary','fa-clipboard-check',
                    d.executive_summary?`<div style="background:#eef2ff;border-left:3px solid #4f46e5;border-radius:6px;padding:12px 14px;color:#1e293b;font-size:13px;">${esc(d.executive_summary)}</div>`:'',
                    d.overall_health?`<span style="margin-left:auto;background:${healthColor(d.overall_health)};color:#fff;font-size:12px;font-weight:700;padding:4px 12px;border-radius:20px;">${esc(d.overall_health)}</span>`:'');
            }

            if(cs.summary || arr(cs.active_platforms).length || arr(cs.strengths).length || arr(cs.gaps).length){
                let inner = cs.summary?`<div style="font-size:13px;color:#374151;margin-bottom:10px;">${esc(cs.summary)}</div>`:'';
                if(arr(cs.active_platforms).length) inner += `<div style="margin-bottom:8px;"><span style="font-size:12px;color:#64748b;font-weight:600;">Active platforms:</span><br>${chips(cs.active_platforms,'#e0e7ff','#3730a3')}</div>`;
                inner += `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-top:6px;">
                    <div><div style="font-size:12px;font-weight:700;color:#16a34a;margin-bottom:4px;">Strengths</div>${bullets(cs.strengths)}</div>
                    <div><div style="font-size:12px;font-weight:700;color:#dc2626;margin-bottom:4px;">Gaps</div>${bullets(cs.gaps)}</div>
                </div>`;
                html += card('Current state','fa-chart-simple', inner);
            }

            if(arr(d.competitor_comparison).length){
                const rows = d.competitor_comparison.map(c=>`<tr>
                    <td style="padding:8px 10px;font-weight:600;border-bottom:1px solid #eef;vertical-align:top;">${esc(c.competitor)}</td>
                    <td style="padding:8px 10px;border-bottom:1px solid #eef;vertical-align:top;color:#dc2626;">${esc(c.doing_better)}</td>
                    <td style="padding:8px 10px;border-bottom:1px solid #eef;vertical-align:top;color:#16a34a;">${esc(c.opportunity)}</td>
                </tr>`).join('');
                html += card('Competitor comparison','fa-people-arrows',
                    `<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:13px;">
                        <thead><tr style="text-align:left;color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.4px;">
                            <th style="padding:6px 10px;">Competitor</th><th style="padding:6px 10px;">Doing better</th><th style="padding:6px 10px;">Opportunity for client</th></tr></thead>
                        <tbody>${rows}</tbody></table></div>`);
            }

            if(arr(d.missing_content_types).length){
                html += card('Missing content types','fa-puzzle-piece', `<div>${chips(d.missing_content_types,'#fef3c7','#92400e')}</div>`);
            }

            if(arr(d.recommended_platforms).length){
                html += card('Recommended platforms','fa-bullhorn',
                    arr(d.recommended_platforms).map(p=>`<div style="padding:8px 0;border-bottom:1px solid #f1f5f9;"><b>${esc(p.platform)}</b> — <span style="color:#475569;">${esc(p.why)}</span></div>`).join(''));
            }

            if(arr(d.content_pillars).length){
                html += card('Content pillars','fa-layer-group',
                    `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;">
                    ${d.content_pillars.map(p=>`<div style="border:1px solid #e2e8f0;border-left:3px solid #4f46e5;border-radius:8px;padding:10px 12px;">
                        <div style="font-weight:700;font-size:13px;">${esc(p.pillar)}</div>
                        ${p.rationale?`<div style="font-size:12px;color:#64748b;margin:3px 0 6px;">${esc(p.rationale)}</div>`:''}
                        ${arr(p.formats).length?chips(p.formats,'#f1f5f9','#475569'):''}
                    </div>`).join('')}</div>`);
            }

            if(d.posting_cadence){
                html += card('Posting cadence','fa-calendar-days', `<div style="font-size:13px;color:#374151;">${esc(d.posting_cadence)}</div>`);
            }

            // Pro-depth sections
            const proPairs = [
                ['campaign_angles','Campaign angles','fa-lightbulb', true],
                ['social_seo','Social SEO','fa-magnifying-glass', true],
                ['blog_to_social','Blog-to-social repurposing','fa-recycle', true],
                ['creative_improvements','Creative improvements','fa-wand-magic-sparkles', true],
                ['metrics_read','What the analytics show','fa-gauge-high', true],
            ];
            proPairs.forEach(([key,title,icon])=>{ if(arr(d[key]).length) html += card(title, icon, bullets(d[key])); });

            if(d.organic_paid_integration){
                html += card('Organic + paid integration','fa-arrows-to-circle', `<div style="font-size:13px;color:#374151;">${esc(d.organic_paid_integration)}</div>`);
            }

            if(arr(d.action_plan).length){
                html += card('Action plan','fa-list-check',
                    d.action_plan.map(p=>`<div style="display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px solid #f1f5f9;">
                        <span style="background:${prioColor(p.priority)};color:#fff;font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;white-space:nowrap;margin-top:2px;">${esc(p.priority||'—')}</span>
                        <div style="flex:1;"><div style="font-size:13px;color:#1e293b;font-weight:600;">${esc(p.action)}</div>
                        <div style="font-size:12px;color:#64748b;">${p.owner?`<b>Owner:</b> ${esc(p.owner)}`:''}${p.expected_impact?`  ·  <b>Impact:</b> ${esc(p.expected_impact)}`:''}</div></div>
                    </div>`).join(''));
            }

            return html;
}
