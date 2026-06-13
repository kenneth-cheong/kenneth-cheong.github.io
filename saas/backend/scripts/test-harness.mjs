// ─────────────────────────────────────────────────────────────────────────
// LOCAL TOOL TEST HARNESS  (dev-only — not part of the deployed backend)
//
//   node scripts/test-harness.mjs      → http://localhost:8080
//
// Runs the REAL metering adapters + composite orchestrators (callUpstream) from
// src/metering/index.mjs against the LIVE upstream Lambdas, with no auth / no
// credits / no tier gates. The form UI is generated from the shared catalog.
//
// Extras (mirrors product features, persisted to ./.harness-data/*.json):
//   • Run history   — every successful run is saved and re-openable.
//   • Chatbot       — side drawer backed by the live aiOptimiser (Claude).
//   • Support       — submit + list support tickets.
//
// ⚠️ Calls real public Lambdas — runs consume real API quota/cost. Slow tools
//    (crawl, AI visibility, backlinks) can take 30–150s.
// ─────────────────────────────────────────────────────────────────────────
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NM = path.join(HERE, '..', 'node_modules');

// index.mjs transitively imports the AWS SDK + jsonwebtoken (the Lambda layer in
// prod). The composites never call them, so satisfy the imports with tiny stubs
// if the real deps aren't installed. node_modules is gitignored.
function ensureStub(pkg, files) {
  const dir = path.join(NM, pkg);
  if (fs.existsSync(path.join(dir, 'package.json'))) return;
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
}
ensureStub('@aws-sdk/client-dynamodb', {
  'package.json': '{"name":"@aws-sdk/client-dynamodb","version":"0.0.0","type":"module","exports":"./index.mjs"}',
  'index.mjs': 'export class DynamoDBClient { constructor() {} }',
});
ensureStub('@aws-sdk/lib-dynamodb', {
  'package.json': '{"name":"@aws-sdk/lib-dynamodb","version":"0.0.0","type":"module","exports":"./index.mjs"}',
  'index.mjs': 'export const DynamoDBDocumentClient={from:()=>({send:async()=>({})})};export class GetCommand{}export class PutCommand{}export class UpdateCommand{}export class QueryCommand{}export class ScanCommand{}',
});
ensureStub('jsonwebtoken', {
  'package.json': '{"name":"jsonwebtoken","version":"0.0.0","main":"index.cjs"}',
  'index.cjs': 'module.exports={sign:()=>"x",verify:()=>({}),decode:()=>({})};',
});

// Dynamic import AFTER stubs exist (static imports would resolve too early).
const { TOOLS, CATEGORIES, inputsFor, CREDIT_COSTS, INTEGRATIONS } = await import('../../shared/catalog.mjs');
const { UPSTREAMS } = await import('../src/metering/upstreams.mjs');
const { integrationSummary } = await import('../../shared/connectors.mjs');
const { __test } = await import('../src/metering/index.mjs');

const PORT = 8080;
const splitItems = (v) => String(v || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ── Local persistence (single-user dev store) ────────────────────────────────
const DATA = path.join(HERE, '..', '.harness-data');
fs.mkdirSync(DATA, { recursive: true });
const RUNS = path.join(DATA, 'runs.json');
const TICKETS = path.join(DATA, 'tickets.json');
const load = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return []; } };
const saveAll = (f, arr) => fs.writeFileSync(f, JSON.stringify(arr, null, 2));
const prepend = (f, item) => { const a = load(f); a.unshift(item); saveAll(f, a.slice(0, 500)); return item; };

// ── Tool execution (mirrors the handler minus auth/credits/teaser) ───────────
async function runTool(toolId, body) {
  const tool = TOOLS.find((t) => t.id === toolId);
  if (!tool) throw new Error(`Unknown tool: ${toolId}`);
  body._email = 'tester@local';
  body.url = body.url || body.input;
  // Integration tools: if the browser passed a live Google access token (from
  // the Connect Google button), use it for a REAL API call; else seeded data.
  if (tool.integration) {
    body._integrations = {
      [tool.integration]: {
        connected: true,
        account: body.input || 'demo-account',
        accessToken: body.__googleToken || undefined,
        expiresAt: body.__googleExpiry || undefined,
      },
    };
    delete body.__googleToken; delete body.__googleExpiry;
  }
  if (tool.fanout) {
    const items = splitItems(body[tool.fanout]).slice(0, 50);
    if (!items.length) throw new Error('Add at least one keyword.');
    const rows = [];
    for (const item of items) {
      const r = await __test.callUpstream(tool, { ...body, [tool.fanout]: item });
      rows.push({ keyword: item, result: r?.text ?? r?.position ?? JSON.stringify(r) });
    }
    return { rows };
  }
  return __test.callUpstream(tool, body);
}

// ── Chatbot: proxy to the live aiOptimiser (content_freeform / Claude) ───────
async function chat(messages) {
  const history = (messages || []).slice(-10)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n');
  const userPrompt =
    'Reply ONLY with the assistant\'s next chat message. Hard rules: 2–4 short sentences max, ' +
    'plain conversational text, NO markdown, NO headings, NO tables, NO bullet lists, NO preamble.\n\n' +
    'You are the in-app support assistant for Digimetrics, a self-serve SEO + AI-content + ' +
    'AI-visibility SaaS (keyword research, rank tracking, technical/backlinks SEO, AI content, ' +
    'GEO/AI-visibility audits, ads & strategy). Be helpful and brief. If you cannot resolve the ' +
    'issue, suggest opening a support ticket.\n\n' +
    `The user's connected account data (use it to answer data questions):\n${INTEGRATIONS.map((p) => integrationSummary(p.id, 'demo-account')).join('\n')}\n\n` +
    `Conversation so far:\n${history}\n\nAssistant:`;
  const res = await fetch(UPSTREAMS.aiOptimiser, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'content_freeform', userPrompt }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`chat upstream ${res.status}`);
  let raw; try { raw = JSON.parse(text); } catch { raw = text; }
  if (raw && typeof raw === 'object' && raw.body !== undefined) {
    raw = typeof raw.body === 'string' ? JSON.parse(raw.body) : raw.body;
  }
  return (typeof raw === 'string' ? raw : (raw.result || raw.text || raw.content || '')) || '(no reply)';
}

const CATALOG = TOOLS.map((t) => ({
  id: t.id, name: t.name, category: t.category, desc: t.desc,
  minTier: t.minTier, slow: !!t.slow, cost: CREDIT_COSTS[t.cost] ?? 0,
  fields: inputsFor(t),
}));

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Digimetrics SaaS — tool test harness</title>
<style>
  :root{--b:#4f46e5}
  *{box-sizing:border-box} body{font:14px/1.5 system-ui,sans-serif;margin:0;background:#f8fafc;color:#0f172a}
  header{background:#0f172a;color:#fff;padding:12px 20px;display:flex;align-items:center;gap:16px}
  header b{font-size:16px} header .sp{flex:1}
  header button{background:#1e293b;color:#cbd5e1;border:0;border-radius:8px;padding:7px 12px;font:inherit;cursor:pointer}
  header button.on{background:var(--b);color:#fff}
  /* top nav: category pills + tool pills */
  #toolbar{background:#fff;border-bottom:1px solid #e2e8f0;padding:10px 20px;position:sticky;top:0;z-index:10}
  #cats{display:flex;flex-wrap:wrap;gap:6px}
  #cats button{background:#f1f5f9;color:#475569;border:0;border-radius:999px;padding:6px 14px;font:inherit;font-weight:600;cursor:pointer}
  #cats button.on{background:var(--b);color:#fff}
  #tools{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
  #tools button{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:6px 12px;font:inherit;cursor:pointer;color:#0f172a}
  #tools button:hover{border-color:var(--b)} #tools button.on{background:#eef2ff;border-color:var(--b);color:var(--b);font-weight:600}
  main{padding:24px 28px;max-width:980px;margin:0 auto}
  h1{margin:0 0 4px;font-size:20px} .desc{color:#475569;margin:0 0 6px}
  .meta{font-size:12px;color:#64748b;margin-bottom:16px}
  .pill{display:inline-block;background:#eef2ff;color:var(--b);border-radius:999px;padding:1px 8px;margin-right:6px;font-weight:600}
  label{display:block;margin:12px 0 4px;font-weight:600}
  input,textarea,select{width:100%;max-width:640px;padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px;font:inherit}
  textarea{min-height:70px}
  button.primary{margin-top:18px;background:var(--b);color:#fff;border:0;border-radius:8px;padding:10px 18px;font:inherit;font-weight:600;cursor:pointer}
  button.primary:disabled{opacity:.5}
  .out{margin-top:22px;max-width:840px} .card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:16px}
  pre{white-space:pre-wrap;word-break:break-word;margin:0}
  table{width:100%;border-collapse:collapse;font-size:13px} th{text-align:left;color:#64748b;padding:6px 8px} td{padding:6px 8px;border-top:1px solid #f1f5f9}
  .err{color:#b91c1c} .warn{background:#fffbeb;border:1px solid #fde68a;color:#92400e;padding:8px 12px;border-radius:8px;font-size:12px;margin-bottom:14px}
  .spin{display:inline-block;width:14px;height:14px;border:2px solid #fff;border-top-color:transparent;border-radius:50%;animation:s .7s linear infinite;vertical-align:-2px;margin-right:8px}
  @keyframes s{to{transform:rotate(360deg)}}
  .hrow{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:10px 14px;margin-bottom:8px;cursor:pointer;max-width:840px;display:flex;gap:12px;align-items:center}
  .hrow:hover{border-color:var(--b)} .hrow .t{font-weight:600} .hrow .s{color:#64748b;font-size:12px}
  /* chat drawer */
  /* page shifts left when chat opens, so chat sits BESIDE content (not over it) */
  #page{transition:margin-right .2s}
  body.chat-open #page{margin-right:380px}
  #chat{position:fixed;top:0;right:-380px;width:380px;height:100vh;background:#fff;border-left:1px solid #e2e8f0;box-shadow:-8px 0 24px rgba(0,0,0,.06);transition:right .2s;display:flex;flex-direction:column;z-index:20}
  #chat.open{right:0}
  #chat .ch{padding:12px 16px;background:#0f172a;color:#fff;font-weight:600;display:flex;align-items:center}
  #chat .ch .x{margin-left:auto;cursor:pointer;color:#94a3b8}
  #thread{flex:1;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:10px}
  .msg{padding:9px 12px;border-radius:12px;max-width:85%;white-space:pre-wrap}
  .msg.u{align-self:flex-end;background:var(--b);color:#fff;border-bottom-right-radius:3px}
  .msg.a{align-self:flex-start;background:#f1f5f9;color:#0f172a;border-bottom-left-radius:3px}
  #chatform{display:flex;gap:8px;padding:12px;border-top:1px solid #e2e8f0}
  #chatform input{flex:1} #chatform button{background:var(--b);color:#fff;border:0;border-radius:8px;padding:0 14px;cursor:pointer}
</style><script src="https://accounts.google.com/gsi/client" async defer></script></head><body>
<div id="page">
<header>
  <b>Digimetrics SaaS</b>
  <button id="b_tools" class="on" onclick="setView('tools')">Tools</button>
  <button id="b_history" onclick="setView('history')">History</button>
  <button id="b_support" onclick="setView('support')">Support</button>
  <span class="sp"></span>
  <button id="b_gconnect" onclick="connectGoogle()" title="Connect your Google account for live GSC / GA4 / Ads data">🔗 Connect Google</button>
  <button id="b_chat" onclick="toggleChat()">💬 Chat</button>
</header>
<div id="toolbar"><div id="cats"></div><div id="tools"></div></div>
<main id="main"></main>
</div>
<aside id="chat">
  <div class="ch">Support assistant <span class="x" onclick="toggleChat()">✕</span></div>
  <div id="thread"></div>
  <form id="chatform"><input id="chatinput" placeholder="Ask anything…" autocomplete="off"><button>Send</button></form>
</aside>
<script>
const CATALOG = ${JSON.stringify(CATALOG)};
const CATEGORIES = ${JSON.stringify(CATEGORIES)};
const cats = document.getElementById('cats'), toolsRow = document.getElementById('tools'), main = document.getElementById('main');
let current = null, view = 'tools', activeCat = CATEGORIES[0];

function buildCats(){
  cats.innerHTML='';
  for(const cat of CATEGORIES){
    const b=document.createElement('button'); b.textContent=cat;
    b.onclick=()=>{ setView('tools'); selectCat(cat); };
    b.classList.toggle('on', cat===activeCat); cats.appendChild(b);
  }
}
function selectCat(cat){
  activeCat=cat; buildCats(); toolsRow.innerHTML='';
  for(const t of CATALOG.filter(x=>x.category===cat)){
    const b=document.createElement('button'); b.textContent=t.name; b.dataset.id=t.id;
    b.onclick=()=>select(t.id); b.classList.toggle('on', current&&current.id===t.id); toolsRow.appendChild(b);
  }
}
function setView(v){
  view=v;
  for(const b of ['tools','history','support']) document.getElementById('b_'+b).classList.toggle('on', b===v);
  document.getElementById('toolbar').style.display = v==='tools' ? '' : 'none';
  if(v==='tools') render();
  else if(v==='history') renderHistory();
  else renderSupport();
}
function select(id){
  current = CATALOG.find(t=>t.id===id);
  activeCat = current.category;
  selectCat(activeCat);
  render();
}
function field(f, val){
  const id='f_'+f.name; const req=f.required?' <span style="color:#ef4444">*</span>':'';
  const v = val!==undefined ? val : (f.default||'');
  let ctl;
  if(f.type==='select') ctl='<select id="'+id+'">'+f.options.map(o=>'<option'+(o===v?' selected':'')+'>'+o+'</option>').join('')+'</select>';
  else if(f.type==='textarea'||f.type==='tags') ctl='<textarea id="'+id+'" placeholder="'+(f.placeholder||'')+'">'+escapeHtml(v)+'</textarea>'+(f.type==='tags'?'<div style="font-size:11px;color:#64748b">comma or newline separated</div>':'');
  else ctl='<input id="'+id+'" value="'+escapeHtml(v)+'" placeholder="'+(f.placeholder||'')+'">';
  return '<label>'+f.label+req+'</label>'+ctl;
}
function render(prefill, savedResult){
  const t=current; if(!t){ main.innerHTML='<p style="color:#64748b">Pick a tool from the left.</p>'; return; }
  main.innerHTML='<h1>'+t.name+'</h1><p class="desc">'+t.desc+'</p>'+
    '<div class="meta"><span class="pill">'+t.category+'</span><span class="pill">min: '+t.minTier+'</span>'+
    '<span class="pill">'+(t.cost?t.cost+' credits':'free')+'</span>'+(t.slow?'<span class="pill">slow ~30–150s</span>':'')+'</div>'+
    (t.slow?'<div class="warn">This tool polls a live upstream and can take 30–150 seconds. Calls consume real API quota.</div>':'')+
    '<form id="form">'+t.fields.map(f=>field(f, prefill&&prefill[f.name])).join('')+'<br><button id="run" class="primary" type="submit">Run tool</button></form>'+
    '<div class="out" id="out"></div>';
  document.getElementById('form').onsubmit=run;
  if(savedResult){ document.getElementById('out').innerHTML='<div style="font-size:12px;color:#64748b;margin-bottom:6px">re-opened from history</div>'+renderResult(savedResult); }
}
// ── Google OAuth (client-side token flow, exactly like index.html) ──
const G_CLIENT_ID='1080212071394-drtg41ou6bjm412teq626rf7dn8b41q6.apps.googleusercontent.com';
const G_SCOPES='https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/analytics.readonly https://www.googleapis.com/auth/adwords email';
let gTokenClient=null; window.__gToken=null; window.__gExpiry=0;
function connectGoogle(){
  if(!(window.google&&google.accounts&&google.accounts.oauth2)){ alert('Google library still loading — try again in a second.'); return; }
  if(!gTokenClient){
    gTokenClient=google.accounts.oauth2.initTokenClient({ client_id:G_CLIENT_ID, scope:G_SCOPES, callback:(resp)=>{
      if(resp&&resp.access_token){ window.__gToken=resp.access_token; window.__gExpiry=Date.now()+((resp.expires_in||3600)*1000);
        const b=document.getElementById('b_gconnect'); b.textContent='✓ Google connected'; b.classList.add('on');
      } else { alert('Google sign-in failed: '+(resp&&resp.error||'unknown')); }
    }, error_callback:(err)=>alert('Google sign-in error: '+(err&&err.type||'unknown')+'. Make sure this origin is an authorized JavaScript origin on the OAuth client.') });
  }
  gTokenClient.requestAccessToken({ prompt: window.__gToken?'':'consent' });
}
async function run(e){
  e.preventDefault();
  const btn=document.getElementById('run'), out=document.getElementById('out');
  const body={};
  for(const f of current.fields){ const el=document.getElementById('f_'+f.name); if(el) body[f.name]=el.value; }
  if(current.category==='Integrations'&&window.__gToken&&Date.now()<window.__gExpiry){
    body.__googleToken=window.__gToken; body.__googleExpiry=window.__gExpiry;
  }
  btn.disabled=true; btn.innerHTML='<span class="spin"></span>Running…'; out.innerHTML='';
  const t0=Date.now();
  try{
    const res=await fetch('/api/run/'+current.id,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const data=await res.json();
    const ms=((Date.now()-t0)/1000).toFixed(1);
    if(!res.ok||data.error){ out.innerHTML='<div class="card err">⚠ '+(data.error||('HTTP '+res.status))+'</div>'; }
    else out.innerHTML='<div style="font-size:12px;color:#64748b;margin-bottom:6px">ran in '+ms+'s · saved to History · sent: '+escapeHtml(JSON.stringify(data.sent))+'</div>'+renderResult(data.result);
  }catch(err){ out.innerHTML='<div class="card err">⚠ '+err.message+'</div>'; }
  btn.disabled=false; btn.textContent='Run tool';
}
function renderResult(r){
  if(!r) return '<div class="card">(empty)</div>';
  if(r.html) return '<div class="card">'+r.html+'</div>';
  if(r.rows&&r.rows.length){
    const cols=Object.keys(r.rows[0]);
    return '<div class="card"><table><thead><tr>'+cols.map(c=>'<th>'+c+'</th>').join('')+'</tr></thead><tbody>'+
      r.rows.map(row=>'<tr>'+cols.map(c=>'<td>'+escapeHtml(String(row[c]??''))+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';
  }
  if(r.text) return '<div class="card"><pre>'+escapeHtml(r.text)+'</pre></div>';
  return '<div class="card"><pre>'+escapeHtml(JSON.stringify(r,null,2))+'</pre></div>';
}
// ── History ──
async function renderHistory(){
  main.innerHTML='<h1>Run history</h1><p class="desc">Every successful tool run is saved here — click to re-open the result and inputs.</p><div id="hlist">Loading…</div>';
  const runs=await (await fetch('/api/runs')).json();
  const el=document.getElementById('hlist');
  if(!runs.length){ el.innerHTML='<p style="color:#64748b">No runs yet. Run a tool to see it here.</p>'; return; }
  el.innerHTML=runs.map(r=>'<div class="hrow" onclick="openRun(\\''+r.id+'\\')">'+
    '<div><div class="t">'+escapeHtml(r.toolName)+'</div><div class="s">'+new Date(r.ts).toLocaleString()+' · '+escapeHtml(r.preview||'')+'</div></div></div>').join('');
}
async function openRun(id){
  const r=await (await fetch('/api/runs/'+id)).json();
  setView('tools'); select(r.tool); render(r.inputs, r.result);
}
// ── Support ──
async function renderSupport(){
  main.innerHTML='<h1>Support</h1><p class="desc">Open a ticket and our team will follow up. Submitted tickets are listed below.</p>'+
    '<form id="tform" style="max-width:640px">'+
    '<label>Subject *</label><input id="t_subject" placeholder="Short summary">'+
    '<label>Email</label><input id="t_email" placeholder="you@example.com">'+
    '<label>Message *</label><textarea id="t_message" placeholder="Describe the issue…"></textarea>'+
    '<br><button id="t_submit" class="primary" type="submit">Submit ticket</button></form>'+
    '<div id="tmsg" style="margin-top:10px"></div><h1 style="margin-top:28px;font-size:16px">Your tickets</h1><div id="tlist">Loading…</div>';
  document.getElementById('tform').onsubmit=submitTicket;
  loadTickets();
}
async function submitTicket(e){
  e.preventDefault();
  const subject=document.getElementById('t_subject').value.trim();
  const message=document.getElementById('t_message').value.trim();
  const email=document.getElementById('t_email').value.trim();
  const msg=document.getElementById('tmsg');
  if(!subject||!message){ msg.innerHTML='<span class="err">Subject and message are required.</span>'; return; }
  const res=await fetch('/api/tickets',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subject,message,email})});
  const t=await res.json();
  msg.innerHTML='<span style="color:#16a34a">✓ Ticket '+t.id+' submitted.</span>';
  document.getElementById('tform').reset(); loadTickets();
}
async function loadTickets(){
  const list=await (await fetch('/api/tickets')).json();
  const el=document.getElementById('tlist');
  el.innerHTML=list.length?list.map(t=>'<div class="hrow"><div><div class="t">'+escapeHtml(t.subject)+' <span class="pill">'+t.status+'</span></div>'+
    '<div class="s">'+new Date(t.ts).toLocaleString()+(t.email?' · '+escapeHtml(t.email):'')+'</div>'+
    '<div style="margin-top:4px;color:#334155">'+escapeHtml(t.message)+'</div></div></div>').join(''):'<p style="color:#64748b">No tickets yet.</p>';
}
// ── Chat ──
const chatMsgs=[];
function toggleChat(){
  const c=document.getElementById('chat'); c.classList.toggle('open');
  const open=c.classList.contains('open');
  document.body.classList.toggle('chat-open', open);   // shifts #page beside the chat
  document.getElementById('b_chat').classList.toggle('on', open);
  if(open&&!chatMsgs.length){ pushMsg('a','Hi! I\\'m your Digimetrics assistant. Ask me about any tool, or how to get started.'); }
}
function pushMsg(role,content){
  chatMsgs.push({role:role==='u'?'user':'assistant',content});
  const th=document.getElementById('thread');
  const d=document.createElement('div'); d.className='msg '+role; d.textContent=content; th.appendChild(d);
  th.scrollTop=th.scrollHeight;
}
document.getElementById('chatform').onsubmit=async (e)=>{
  e.preventDefault();
  const inp=document.getElementById('chatinput'); const text=inp.value.trim(); if(!text) return;
  inp.value=''; pushMsg('u',text);
  const th=document.getElementById('thread');
  const wait=document.createElement('div'); wait.className='msg a'; wait.innerHTML='<span class="spin" style="border-color:#94a3b8;border-top-color:transparent"></span>…'; th.appendChild(wait); th.scrollTop=th.scrollHeight;
  try{
    const res=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:chatMsgs})});
    const data=await res.json(); wait.remove();
    if(data.error) pushMsg('a','⚠ '+data.error); else pushMsg('a',data.reply);
  }catch(err){ wait.remove(); pushMsg('a','⚠ '+err.message); }
};
function escapeHtml(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
select(CATALOG[0].id);
</script></body></html>`;

// ── HTTP ─────────────────────────────────────────────────────────────────────
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }
function readBody(req) {
  return new Promise((resolve) => { let r = ''; req.on('data', (c) => (r += c)); req.on('end', () => { try { resolve(r ? JSON.parse(r) : {}); } catch { resolve({}); } }); });
}
function previewOf(result) {
  if (!result) return '';
  if (result.text) return result.text.slice(0, 80);
  if (result.rows) return `${result.rows.length} rows`;
  if (result.html) return 'report';
  return '';
}

const server = http.createServer(async (req, res) => {
  const { method, url } = req;
  try {
    if (method === 'GET' && url === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(PAGE); }

    if (method === 'POST' && url.startsWith('/api/run/')) {
      const toolId = decodeURIComponent(url.slice('/api/run/'.length));
      const body = await readBody(req);
      const tool = TOOLS.find((t) => t.id === toolId);
      const result = await runTool(toolId, { ...body });
      const saved = prepend(RUNS, { id: uid(), tool: toolId, toolName: tool?.name || toolId, ts: Date.now(), inputs: body, result, preview: previewOf(result) });
      return json(res, 200, { tool: toolId, sent: { ...body, _email: 'tester@local' }, result, runId: saved.id });
    }
    if (method === 'GET' && url === '/api/runs') {
      return json(res, 200, load(RUNS).map((r) => ({ id: r.id, tool: r.tool, toolName: r.toolName, ts: r.ts, preview: r.preview })));
    }
    if (method === 'GET' && url.startsWith('/api/runs/')) {
      const id = decodeURIComponent(url.slice('/api/runs/'.length));
      const r = load(RUNS).find((x) => x.id === id);
      return r ? json(res, 200, r) : json(res, 404, { error: 'not found' });
    }
    if (method === 'POST' && url === '/api/chat') {
      const { messages } = await readBody(req);
      const reply = await chat(messages);
      return json(res, 200, { reply });
    }
    if (method === 'POST' && url === '/api/tickets') {
      const { subject, message, email } = await readBody(req);
      if (!subject || !message) return json(res, 400, { error: 'subject and message required' });
      const t = prepend(TICKETS, { id: 'TKT-' + uid().toUpperCase(), subject, message, email: email || '', status: 'open', ts: Date.now() });
      return json(res, 200, t);
    }
    if (method === 'GET' && url === '/api/tickets') return json(res, 200, load(TICKETS));

    res.writeHead(404); res.end('not found');
  } catch (err) {
    console.error('error', method, url, err);
    json(res, 500, { error: err.message });
  }
});
server.listen(PORT, () => console.log(`tool test harness → http://localhost:${PORT}  (history + chat + support enabled)`));
