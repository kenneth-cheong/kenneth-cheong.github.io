// ─────────────────────────────────────────────────────────────────────────
// PROJECT PERFORMANCE METRICS — the single source of truth for which tools
// emit a trackable headline number and how to read it out of their result.
//
// Imported by the React frontend (the Performance page), the metering gateway
// (auto-snapshots a point after every run) and the metrics cron (re-pulls the
// free Google integrations daily). Keep it pure — no imports, no side effects.
//
// Each metric: { key, field, label, unit, dir }
//   key   — stable id used in the snapshot's metricId (`${projectId}#${tool}#${key}`)
//   field — where to read the value from a run result's `summary` object
//   unit  — '' | '%' | 'S$' (display suffix/prefix on the Performance page)
//   dir   — 'up'   = higher is better  (green when rising)
//           'down' = lower is better   (green when falling — rank, CPA, issues)
//           'neutral' = no good/bad polarity (spend)
// ─────────────────────────────────────────────────────────────────────────

export const TRACKED_METRICS = {
  // ── Google integrations (free pulls — captured on run AND by the daily cron) ─
  gsc: [
    { key: 'clicks', field: 'clicks', label: 'Clicks', unit: '', dir: 'up' },
    { key: 'impressions', field: 'impressions', label: 'Impressions', unit: '', dir: 'up' },
    { key: 'ctr', field: 'ctr', label: 'CTR', unit: '%', dir: 'up' },
    { key: 'avgPosition', field: 'avgPosition', label: 'Avg position', unit: '', dir: 'down' },
  ],
  ga4: [
    { key: 'sessions', field: 'sessions', label: 'Sessions', unit: '', dir: 'up' },
    { key: 'users', field: 'users', label: 'Users', unit: '', dir: 'up' },
    { key: 'engagedSessions', field: 'engagedSessions', label: 'Engaged sessions', unit: '', dir: 'up' },
    { key: 'conversions', field: 'conversions', label: 'Conversions', unit: '', dir: 'up' },
  ],
  'google-ads': [
    { key: 'cost', field: 'cost', label: 'Cost', unit: 'S$', dir: 'neutral' },
    { key: 'clicks', field: 'clicks', label: 'Clicks', unit: '', dir: 'up' },
    { key: 'conversions', field: 'conversions', label: 'Conversions', unit: '', dir: 'up' },
    { key: 'cpa', field: 'cpa', label: 'CPA', unit: 'S$', dir: 'down' },
  ],

  // ── Site health (captured when the user runs the audit) ─────────────────────
  'technical-seo': [
    { key: 'avgOnPageScore', field: 'avgOnPageScore', label: 'Avg on-page score', unit: '', dir: 'up' },
    { key: 'pagesWithIssues', field: 'pagesWithIssues', label: 'Pages with issues', unit: '', dir: 'down' },
  ],
  'forensic-audit': [
    { key: 'healthScore', field: 'healthScore', label: 'Health score', unit: '', dir: 'up' },
    { key: 'issues', field: 'issues', label: 'Issues', unit: '', dir: 'down' },
    { key: 'domainAuthority', field: 'domainAuthority', label: 'Domain authority', unit: '', dir: 'up' },
  ],
  'page-analysis': [
    { key: 'domainAuthority', field: 'domainAuthority', label: 'Domain authority', unit: '', dir: 'up' },
    { key: 'backlinks', field: 'backlinks', label: 'Backlinks', unit: '', dir: 'up' },
    { key: 'spamScore', field: 'spamScore', label: 'Spam score', unit: '%', dir: 'down' },
  ],

  // ── Authority ──────────────────────────────────────────────────────────────
  backlinks: [
    { key: 'backlinks', field: 'backlinks', label: 'Backlinks', unit: '', dir: 'up' },
    { key: 'referringDomains', field: 'referringDomains', label: 'Referring domains', unit: '', dir: 'up' },
    { key: 'domainRank', field: 'domainRank', label: 'Domain rank', unit: '', dir: 'up' },
    { key: 'spamScore', field: 'spamScore', label: 'Spam score', unit: '%', dir: 'down' },
  ],

  // ── AI Visibility ────────────────────────────────────────────────────────────
  'ai-discovery': [
    { key: 'geoReadiness', field: 'geoReadiness', label: 'GEO readiness', unit: '%', dir: 'up' },
  ],
  'ai-mentions': [
    { key: 'mentionRate', field: 'mentionRate', label: 'AI mention rate', unit: '%', dir: 'up' },
  ],
};

/** Tools whose performance we snapshot. */
export const METRIC_TOOLS = Object.keys(TRACKED_METRICS);

/** The Google integration tools the daily cron re-pulls (id === provider). */
export const CRON_METRIC_TOOLS = ['gsc', 'ga4', 'google-ads'];

/** Group label for the Performance page, by tool category. */
export const METRIC_GROUPS = {
  gsc: 'Google integrations',
  ga4: 'Google integrations',
  'google-ads': 'Google integrations',
  'technical-seo': 'Site health',
  'forensic-audit': 'Site health',
  'page-analysis': 'Site health',
  backlinks: 'Authority',
  'ai-discovery': 'AI visibility',
  'ai-mentions': 'AI visibility',
};

/**
 * Coerce a summary value to a finite number, tolerating the formatted strings
 * some summaries carry ("3.2%", "S$1,234.50", "12.4"). Returns null when the
 * value is missing or non-numeric — callers skip null metrics (no false zeros).
 */
export function toMetricNumber(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Pull the headline metrics out of a tool run's result. Reads `result.summary`
 * (every metric-bearing runner returns one). Returns an array of
 * { key, label, unit, dir, value } — empty when the tool isn't tracked or the
 * run produced no usable numbers (e.g. a soft failure or a GSC sub-op).
 */
export function extractMetrics(toolId, result) {
  const defs = TRACKED_METRICS[toolId];
  const summary = result?.summary;
  if (!defs || !summary || typeof summary !== 'object') return [];
  const out = [];
  for (const d of defs) {
    const value = toMetricNumber(summary[d.field]);
    if (value == null) continue;
    out.push({ key: d.key, label: d.label, unit: d.unit, dir: d.dir, value });
  }
  return out;
}
