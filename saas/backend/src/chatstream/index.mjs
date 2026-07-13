// Streaming assistant chat — a Lambda RESPONSE_STREAM Function URL that calls
// the Anthropic Messages API (Haiku) with stream:true and forwards text deltas
// to the browser token-by-token. Auth + credits are verified in-handler (the
// Function URL is public). Charges ai_chat + persists the thread after the
// stream completes. The frontend falls back to the buffered /chat if this fails.
import { getUser, totalCredits, spendCredits, saveConversation } from '../lib/dynamo.mjs';
import { verify } from '../lib/jwt.mjs';
import { buildChatSystem, sanitizePageContext } from '../lib/assistant.mjs';
import { CREDIT_COSTS } from '../../../shared/catalog.mjs';

const KEY = process.env.ANTHROPIC_KEY;
const MODEL = 'claude-haiku-4-5';
const COST = CREDIT_COSTS.ai_chat ?? 2;
const clamp = (s, n) => String(s ?? '').slice(0, n);
const aws = globalThis.awslambda;

export const handler = aws.streamifyResponse(async (event, responseStream) => {
  // Helper for short non-streamed JSON replies (auth/credit errors) — wraps the
  // raw stream exactly once, so it must only be used on an early return.
  const json = (statusCode, obj) => {
    const rs = aws.HttpResponseStream.from(responseStream, { statusCode, headers: { 'Content-Type': 'application/json' } });
    rs.write(JSON.stringify(obj));
    rs.end();
  };

  // ── Pre-flight: auth, credits, body (no stream opened yet) ──
  const auth = event.headers?.authorization || event.headers?.Authorization || '';
  let claims;
  try { claims = verify(auth.replace(/^Bearer\s+/i, '')); if (claims.typ === 'refresh') throw new Error('wrong token'); }
  catch { return json(401, { error: 'Unauthorized' }); }

  const user = await getUser(claims.sub);
  if (!user) return json(401, { error: 'User not found' });
  if (totalCredits(user) < COST) return json(402, { error: "You're out of credits — top up or upgrade to keep chatting." });

  let body = {};
  try { body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : (event.body || '{}')); } catch { /* ignore */ }
  const incoming = (Array.isArray(body.messages) ? body.messages : []).slice(-50)
    .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: clamp(m.content, 8000) }));
  // Anthropic requires the first turn to be 'user' — drop the leading greeting.
  const msgs = [...incoming];
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  if (!msgs.length) return json(400, { error: 'Nothing to send.' });

  const conversationId = body.conversationId || `${new Date().toISOString()}#${Math.random().toString(36).slice(2, 8)}`;
  const query = [...msgs].reverse().find((m) => m.role === 'user')?.content || '';
  const pageContext = sanitizePageContext(body.context, clamp);
  const system = await buildChatSystem(user, query, pageContext);

  // ── Stream ──
  const rs = aws.HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'x-conversation-id': conversationId },
  });
  let full = '';
  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 700, stream: true, system, messages: msgs }),
    });
    if (!upstream.ok || !upstream.body) {
      console.error('anthropic_status', upstream.status);
      rs.write('Sorry — the assistant is unavailable right now. Please try again.');
      rs.end();
      return;
    }
    const reader = upstream.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let ev; try { ev = JSON.parse(payload); } catch { continue; }
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          full += ev.delta.text;
          rs.write(ev.delta.text);
        }
      }
    }
    rs.end();
  } catch (e) {
    console.error('chatstream_error', e.message);
    try { if (!full) rs.write('Sorry — the assistant ran into an error. Please try again.'); rs.end(); } catch { /* already closed */ }
    return;
  }

  // Charge + persist after delivery (best-effort — the user already has the reply).
  if (full.trim()) {
    try { await spendCredits({ userId: user.userId, cost: COST, action: 'chat', tool: 'chatbot' }); } catch (e) { console.error('chat_spend', e.message); }
    try {
      const thread = [...incoming, { role: 'assistant', content: full }].slice(-60).map((m) => ({ role: m.role, content: clamp(m.content, 4000) }));
      await saveConversation({ userId: user.userId, conversationId, messages: thread });
    } catch (e) { console.error('chat_save', e.message); }
  }
});
