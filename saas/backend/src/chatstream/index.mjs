// Streaming assistant chat — a Lambda RESPONSE_STREAM Function URL that calls
// the Anthropic Messages API (Haiku) with stream:true and forwards text deltas
// to the browser token-by-token. Auth + credits are verified in-handler (the
// Function URL is public). Charges ai_chat + persists the thread after the
// stream completes. The frontend falls back to the buffered /chat if this fails.
import { getUser, totalCredits, spendCredits, saveConversation } from '../lib/dynamo.mjs';
import { verify } from '../lib/jwt.mjs';
import { buildChatSystem } from '../lib/assistant.mjs';
import { CREDIT_COSTS } from '../../../shared/catalog.mjs';
import { emitLlmMetric } from '../lib/llm-metric.mjs';

const KEY = process.env.ANTHROPIC_KEY;
const MODEL = 'claude-haiku-4-5';
const COST = CREDIT_COSTS.ai_chat ?? 2;
// The system prompt tells Monty that deliverables override the length rule and to
// "write the full deliverable out". At 700 this was unsatisfiable: a "Do it for
// me" on something like "expand this page to 2,500 words" ran out of tokens and
// the stream simply stopped mid-sentence, which users reported as Monty
// "stopping abruptly". Chat is billed flat (ai_chat), so this trades a higher
// worst-case output cost for replies that actually finish.
const MAX_TOKENS = 2000;
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
  const pageContext = body.context && typeof body.context === 'object'
    ? { path: clamp(body.context.path, 120), toolId: clamp(body.context.toolId, 60) || null }
    : null;
  const system = await buildChatSystem(user, query, pageContext);

  // ── Stream ──
  const rs = aws.HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'x-conversation-id': conversationId },
  });
  let full = '';
  let truncated = false;
  // Token usage streams in on the message_start (input + cache buckets) and
  // message_delta (output) events; capture it to meter Claude spend in the
  // shared Digimetrics/LLM metric.
  let usageIn = 0;
  let usageOut = 0;
  let usageCacheRead = 0;
  let usageCacheWrite = 0;
  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, stream: true, system, messages: msgs }),
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
        // Every non-text event used to be dropped, so a length cut-off was
        // indistinguishable from a finished reply — the text just stopped and the
        // UI showed it as complete. Say so instead, and tell the user how to get
        // the rest, since we can't continue the message ourselves.
        if (ev.type === 'message_delta' && ev.delta?.stop_reason === 'max_tokens') truncated = true;
        // Anthropic emits input_tokens on message_start and cumulative
        // output_tokens on each message_delta — keep the latest of each.
        if (ev.type === 'message_start' && ev.message?.usage) {
          const mu = ev.message.usage;
          if (mu.input_tokens != null) usageIn = mu.input_tokens;
          if (mu.cache_read_input_tokens != null) usageCacheRead = mu.cache_read_input_tokens;
          if (mu.cache_creation_input_tokens != null) usageCacheWrite = mu.cache_creation_input_tokens;
        }
        if (ev.type === 'message_delta' && ev.usage?.output_tokens != null) usageOut = ev.usage.output_tokens;
      }
    }
    if (truncated) {
      const note = '\n\n---\n*That reply hit my length limit, so it stops mid-way. Reply “continue” and I’ll pick up from where I left off.*';
      full += note;
      rs.write(note);
    }
    rs.end();
  } catch (e) {
    console.error('chatstream_error', e.message);
    try { if (!full) rs.write('Sorry — the assistant ran into an error. Please try again.'); rs.end(); } catch { /* already closed */ }
    return;
  }

  // Per-provider LLM usage metric (Claude). Emitted for any real completion so
  // assistant-chat token spend rolls up alongside the tool AI calls.
  if (full.trim() || usageOut) emitLlmMetric({ provider: 'claude', model: MODEL, inputTokens: usageIn, outputTokens: usageOut, cacheReadTokens: usageCacheRead, cacheWriteTokens: usageCacheWrite, fn: 'chatstream', source: 'saas', tool: 'chatbot' });

  // Charge + persist after delivery (best-effort — the user already has the reply).
  if (full.trim()) {
    try { await spendCredits({ userId: user.userId, cost: COST, action: 'chat', tool: 'chatbot' }); } catch (e) { console.error('chat_spend', e.message); }
    try {
      const thread = [...incoming, { role: 'assistant', content: full }].slice(-60).map((m) => ({ role: m.role, content: clamp(m.content, 4000) }));
      await saveConversation({ userId: user.userId, conversationId, messages: thread });
    } catch (e) { console.error('chat_save', e.message); }
  }
});
