// Per-provider LLM usage metering (CloudWatch EMF).
//
// Emits one Embedded-Metric-Format line per model call into `Digimetrics/LLM`
// (dims Provider and Provider+Model), carrying the RAW token buckets each API
// reports — NOT a dollar figure. Cost is derived at read time from a single
// central rate table (see llmSpendByProvider in platform-usage.mjs), so prices
// live in one place, never go stale in 30 Lambda copies, and history can be
// recomputed. Same log-only mechanism as `Digimetrics/Usage` — no IAM.
//
// Buckets (so caching + server tools are priced correctly downstream):
//   InputTokens        — non-cached input (full input rate)
//   OutputTokens       — output
//   CacheReadTokens    — cache hits (Anthropic ~0.1x, DeepSeek/OpenAI cheaper)
//   CacheWriteTokens   — Anthropic cache creation (~1.25x); 0 elsewhere
//   WebSearchRequests  — Anthropic server-side web_search (billed per request)
//
// The Python Lambdas carry a copy of this shape (each `_emit_llm_metric` /
// `_llm_buckets`); keep the namespace, dimensions + metric names in sync.

/** Infer the provider label from a model id when not passed explicitly. */
export function providerOf(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('deepseek')) return 'deepseek';
  if (m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3')) return 'openai';
  if (m.includes('claude')) return 'claude';
  return 'other';
}

/**
 * Emit one `Digimetrics/LLM` EMF line for a completed model call. Pass the raw
 * token buckets from the response `usage`; cost is computed downstream.
 */
export function emitLlmMetric({
  provider, model, inputTokens = 0, outputTokens = 0,
  cacheReadTokens = 0, cacheWriteTokens = 0, webSearchRequests = 0, fn = '',
  source = 'saas', tool = '',
} = {}) {
  try {
    const n = (v) => Number(v) || 0;
    console.log(JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [{
          Namespace: 'Digimetrics/LLM',
          // Source joins the dimension sets so LLM spend splits per front-end
          // (saas vs index) the same way the run metric does.
          Dimensions: [['Provider'], ['Provider', 'Model'], ['Source'], ['Source', 'Provider']],
          Metrics: [
            { Name: 'Calls', Unit: 'Count' },
            { Name: 'InputTokens', Unit: 'Count' },
            { Name: 'OutputTokens', Unit: 'Count' },
            { Name: 'CacheReadTokens', Unit: 'Count' },
            { Name: 'CacheWriteTokens', Unit: 'Count' },
            { Name: 'WebSearchRequests', Unit: 'Count' },
          ],
        }],
      },
      Provider: provider || providerOf(model),
      Model: model || 'unknown',
      Source: source || 'unknown',
      fn,
      // Property, not a dimension: a Tool dimension would multiply metric
      // combinations (~40 tools x 2 sources) and cost more than it measures.
      tool,
      Calls: 1,
      InputTokens: n(inputTokens),
      OutputTokens: n(outputTokens),
      CacheReadTokens: n(cacheReadTokens),
      CacheWriteTokens: n(cacheWriteTokens),
      WebSearchRequests: n(webSearchRequests),
    }));
  } catch { /* metering is best-effort — never break a model call over a log */ }
}
