import json
import requests

# ── LLM usage metering (CloudWatch EMF) — Digimetrics/LLM ─────────────────────
# Meters every Claude/DeepSeek/OpenAI call by transparently wrapping
# requests.post ONCE — all call sites report RAW token buckets (input, output,
# cache read/write, web-search requests) into Digimetrics/LLM (dims Provider,
# Provider+Model). Cost is derived at READ time from one central table, so no
# rates live here (nothing to go stale). Mirrors saas/backend/src/lib/
# llm-metric.mjs. Logs only; safe by construction — the real call runs first and
# is returned regardless of metering.
import json as _mllm_json
import time as _mllm_time
_LLM_FN = 'mediaPlanGenerator'


def _llm_provider(model, url=''):
    m = (model or '').lower()
    u = url or ''
    if 'deepseek' in m or 'deepseek' in u:
        return 'deepseek'
    if 'openai' in u or m.startswith('gpt') or m.startswith('o1') or m.startswith('o3'):
        return 'openai'
    if 'claude' in m or 'anthropic' in u:
        return 'claude'
    return 'other'


def _llm_buckets(body, url=''):
    """(provider, model, {in,out,cr,cw,ws}) from an Anthropic/OpenAI/DeepSeek body."""
    u = (body.get('usage') or {}) if isinstance(body, dict) else {}
    model = body.get('model') if isinstance(body, dict) else None
    prov = _llm_provider(model, url)
    if 'input_tokens' in u or 'output_tokens' in u:            # Anthropic shape
        stu = u.get('server_tool_use') or {}
        return prov, model, {'in': u.get('input_tokens', 0), 'out': u.get('output_tokens', 0),
                             'cr': u.get('cache_read_input_tokens', 0),
                             'cw': u.get('cache_creation_input_tokens', 0),
                             'ws': stu.get('web_search_requests', 0)}
    out = u.get('completion_tokens', 0)                        # OpenAI / DeepSeek
    if 'prompt_cache_hit_tokens' in u or 'prompt_cache_miss_tokens' in u:   # DeepSeek
        cr = u.get('prompt_cache_hit_tokens', 0)
        inp = u.get('prompt_cache_miss_tokens', (u.get('prompt_tokens', 0) - cr))
    else:                                                      # OpenAI
        cr = (u.get('prompt_tokens_details') or {}).get('cached_tokens', 0)
        inp = u.get('prompt_tokens', 0) - cr
    return prov, model, {'in': max(0, inp), 'out': out, 'cr': cr, 'cw': 0, 'ws': 0}


def _emit_llm_metric(provider, model, b, fn=None):
    try:
        print(_mllm_json.dumps({'_aws': {'Timestamp': int(_mllm_time.time() * 1000), 'CloudWatchMetrics': [{'Namespace': 'Digimetrics/LLM', 'Dimensions': [['Provider'], ['Provider', 'Model']], 'Metrics': [{'Name': 'Calls', 'Unit': 'Count'}, {'Name': 'InputTokens', 'Unit': 'Count'}, {'Name': 'OutputTokens', 'Unit': 'Count'}, {'Name': 'CacheReadTokens', 'Unit': 'Count'}, {'Name': 'CacheWriteTokens', 'Unit': 'Count'}, {'Name': 'WebSearchRequests', 'Unit': 'Count'}]}]}, 'Provider': provider, 'Model': model or 'unknown', 'fn': fn or _LLM_FN, 'Calls': 1, 'InputTokens': int(b.get('in', 0) or 0), 'OutputTokens': int(b.get('out', 0) or 0), 'CacheReadTokens': int(b.get('cr', 0) or 0), 'CacheWriteTokens': int(b.get('cw', 0) or 0), 'WebSearchRequests': int(b.get('ws', 0) or 0)}))
    except Exception:
        pass


def _emit_llm_from_body(provider, body):
    try:
        if not isinstance(body, dict):
            return
        prov, model, b = _llm_buckets(body)
        if any(b.values()):
            _emit_llm_metric(provider or prov, model, b)
    except Exception:
        pass


_LLM_HOSTS = ('api.anthropic.com', 'api.deepseek.com', 'api.openai.com')
try:
    _orig_requests_post = requests.post

    def _metered_requests_post(*a, **kw):
        resp = _orig_requests_post(*a, **kw)
        try:
            url = a[0] if a else kw.get('url', '')
            if isinstance(url, str) and any(h in url for h in _LLM_HOSTS) and not kw.get('stream'):
                try:
                    _body = resp.json()
                except Exception:
                    _body = None
                if isinstance(_body, dict):
                    _prov, _model, _b = _llm_buckets(_body, url)
                    if any(_b.values()):
                        _emit_llm_metric(_prov, _model, _b)
        except Exception:
            pass
        return resp

    requests.post = _metered_requests_post
except Exception:
    pass
# ── end LLM usage metering ────────────────────────────────────────────────────

import os
import re
from datetime import datetime, timedelta

BENCHMARK_LAST_UPDATED = "2025-Q4"  # Update this when refreshing benchmark data below

def lambda_handler(event, context):
    # Extract data from event. The frontend sends the scraped webpage content
    # under 'webpagesInput'; fall back to 'data' for other callers (e.g. chatbot).
    data = event.get('webpagesInput') or event.get('data', {})
    budget = event.get('budget', '')  # Default to empty string if missing
    manual = event.get('manualInput', '') #Renamed and default to empty string if missing

    # Extract and format ad format choices
    ad_formats = event.get('adFormats', {})
    selected_ad_formats = [
        "Google Display" if ad_formats.get('googleDisplay', False) else None,
        "Google Search" if ad_formats.get('googleSearch', False) else None,
        "Performance Max" if ad_formats.get('performanceMax', False) else None,
        "Facebook/Instagram" if ad_formats.get('fbIg', False) else None,
        "LinkedIn" if ad_formats.get('linkedIn', False) else None,
        "TikTok" if ad_formats.get('tikTok', False) else None
    ]
    selected_ad_formats = [format for format in selected_ad_formats if format] #Filter Nones

    # Extract other parameters
    organisational_objectives = event.get('organisationalObjectives', '')
    media_plan_location = event.get('mediaPlanLocation', 'Singapore') #Default to Singapore
    media_plan_target_audience = event.get('mediaPlanTargetAudience', '')
    media_plan_customer_personas = event.get('mediaPlanCustomerPersonas', '')
    media_plan_touchpoints = event.get('mediaPlanTouchpoints', '')
    media_plan_content_strategy = event.get('mediaPlanContentStrategy', '')
    media_plan_landing_pages = event.get('mediaPlanLandingPages', '')
    media_plan_cta = event.get('mediaPlanCta', '')
    media_plan_product_service = event.get('mediaPlanProductService', '')
    media_plan_kpis = event.get('mediaPlanKpis', '')
    media_plan_competitive_analysis = event.get('mediaPlanCompetitiveAnalysis', '')
    media_plan_compliance = event.get('mediaPlanCompliance', '')
    media_plan_technology_plan = event.get('mediaPlanTechnologyPlan', '')
    media_plan_analytics_reporting = event.get('mediaPlanAnalyticsReporting', '')

    # --- Campaign period: derive start/end dates and duration ---
    raw_start = (event.get('mediaPlanStartDate', '') or '').strip()
    raw_end = (event.get('mediaPlanEndDate', '') or '').strip()

    def _parse_date(s):
        try:
            return datetime.strptime(s, "%Y-%m-%d")
        except (ValueError, TypeError):
            return None

    start_dt = _parse_date(raw_start)
    end_dt = _parse_date(raw_end)

    # Default to a 90-day campaign starting on the 1st of next month if not supplied
    if not start_dt:
        today = datetime.utcnow()
        if today.month == 12:
            start_dt = datetime(today.year + 1, 1, 1)
        else:
            start_dt = datetime(today.year, today.month + 1, 1)
    if not end_dt or end_dt <= start_dt:
        end_dt = start_dt + timedelta(days=90)

    duration_days = (end_dt - start_dt).days
    if duration_days < 1:
        duration_days = 1
    months = round(duration_days / 30.4, 2)
    if months < 0.1:
        months = 0.1

    campaign_start = start_dt.strftime("%-d-%b-%Y")
    campaign_end = end_dt.strftime("%-d-%b-%Y")

    # Parse the monthly budget to a number so we can state the expected totals explicitly
    try:
        import re as _re_budget
        monthly_budget_num = float(_re_budget.sub(r'[^0-9.]', '', str(budget)) or 0)
    except (ValueError, TypeError):
        monthly_budget_num = 0.0
    total_budget_num = round(monthly_budget_num * months)
    monthly_budget_fmt = f"${monthly_budget_num:,.0f}"
    total_budget_fmt = f"${total_budget_num:,.0f}"

    # Anthropic API details
    claude_url = "https://api.anthropic.com/v1/messages"
    claude_key = os.environ.get('CLAUDE_API_KEY', '')


    google_benchmarks = {
    "table_1": {
        "headers": ["Industry", "Average CTR (Search)", "Average CTR (GDN)"],
        "rows": [
            {"Industry": "Advocacy", "Average CTR (Search)": "4.41%", "Average CTR (GDN)": "0.59%"},
            {"Industry": "Auto", "Average CTR (Search)": "4.00%", "Average CTR (GDN)": "0.60%"},
            {"Industry": "B2B", "Average CTR (Search)": "2.41%", "Average CTR (GDN)": "0.46%"},
            {"Industry": "Consumer Services", "Average CTR (Search)": "2.41%", "Average CTR (GDN)": "0.51%"},
            {"Industry": "Dating & Personals", "Average CTR (Search)": "6.05%", "Average CTR (GDN)": "0.72%"},
            {"Industry": "E-Commerce", "Average CTR (Search)": "2.69%", "Average CTR (GDN)": "0.51%"},
            {"Industry": "Education", "Average CTR (Search)": "3.78%", "Average CTR (GDN)": "0.53%"},
            {"Industry": "Employment Services", "Average CTR (Search)": "2.42%", "Average CTR (GDN)": "0.59%"},
            {"Industry": "Finance & Insurance", "Average CTR (Search)": "2.91%", "Average CTR (GDN)": "0.52%"},
            {"Industry": "Health & Medical", "Average CTR (Search)": "3.27%", "Average CTR (GDN)": "0.59%"},
            {"Industry": "Home Goods", "Average CTR (Search)": "2.44%", "Average CTR (GDN)": "0.49%"},
            {"Industry": "Industrial Services", "Average CTR (Search)": "2.61%", "Average CTR (GDN)": "0.50%"},
            {"Industry": "Legal", "Average CTR (Search)": "2.93%", "Average CTR (GDN)": "0.59%"},
            {"Industry": "Real Estate", "Average CTR (Search)": "3.71%", "Average CTR (GDN)": "1.08%"},
            {"Industry": "Technology", "Average CTR (Search)": "2.09%", "Average CTR (GDN)": "0.39%"},
            {"Industry": "Travel & Hospitality", "Average CTR (Search)": "4.68%", "Average CTR (GDN)": "0.47%"}
        ]
    },
    "table_2": {
        "headers": ["Industry", "Average CPC (Search)", "Average CPC (GDN)"],
        "rows": [
            {"Industry": "Advocacy", "Average CPC (Search)": "$1.43", "Average CPC (GDN)": "$0.62"},
            {"Industry": "Auto", "Average CPC (Search)": "$2.46", "Average CPC (GDN)": "$0.58"},
            {"Industry": "B2B", "Average CPC (Search)": "$3.33", "Average CPC (GDN)": "$0.79"},
            {"Industry": "Consumer Services", "Average CPC (Search)": "$6.40", "Average CPC (GDN)": "$0.81"},
            {"Industry": "Dating & Personals", "Average CPC (Search)": "$2.78", "Average CPC (GDN)": "$1.49"},
            {"Industry": "E-Commerce", "Average CPC (Search)": "$1.16", "Average CPC (GDN)": "$0.45"},
            {"Industry": "Education", "Average CPC (Search)": "$2.40", "Average CPC (GDN)": "$0.47"},
            {"Industry": "Employment Services", "Average CPC (Search)": "$2.04", "Average CPC (GDN)": "$0.78"},
            {"Industry": "Finance & Insurance", "Average CPC (Search)": "$3.44", "Average CPC (GDN)": "$0.86"},
            {"Industry": "Health & Medical", "Average CPC (Search)": "$2.62", "Average CPC (GDN)": "$0.63"},
            {"Industry": "Home Goods", "Average CPC (Search)": "$2.94", "Average CPC (GDN)": "$0.60"},
            {"Industry": "Industrial Services", "Average CPC (Search)": "$2.56", "Average CPC (GDN)": "$0.54"},
            {"Industry": "Legal", "Average CPC (Search)": "$6.75", "Average CPC (GDN)": "$0.72"},
            {"Industry": "Real Estate", "Average CPC (Search)": "$2.37", "Average CPC (GDN)": "$0.75"},
            {"Industry": "Technology", "Average CPC (Search)": "$3.80", "Average CPC (GDN)": "$0.51"},
            {"Industry": "Travel & Hospitality", "Average CPC (Search)": "$1.53", "Average CPC (GDN)": "$0.44"}
        ]
    },
    "table_3": {
        "headers": ["Industry", "Average CVR (Search)", "Average CVR (GDN)"],
        "rows": [
            {"Industry": "Advocacy", "Average CVR (Search)": "1.96%", "Average CVR (GDN)": "1.00%"},
            {"Industry": "Auto", "Average CVR (Search)": "6.03%", "Average CVR (GDN)": "1.19%"},
            {"Industry": "B2B", "Average CVR (Search)": "3.04%", "Average CVR (GDN)": "0.80%"},
            {"Industry": "Consumer Services", "Average CVR (Search)": "6.64%", "Average CVR (GDN)": "0.98%"},
            {"Industry": "Dating & Personals", "Average CVR (Search)": "9.64%", "Average CVR (GDN)": "3.34%"},
            {"Industry": "E-Commerce", "Average CVR (Search)": "2.81%", "Average CVR (GDN)": "0.59%"},
            {"Industry": "Education", "Average CVR (Search)": "3.39%", "Average CVR (GDN)": "0.50%"},
            {"Industry": "Employment Services", "Average CVR (Search)": "5.13%", "Average CVR (GDN)": "1.57%"},
            {"Industry": "Finance & Insurance", "Average CVR (Search)": "5.10%", "Average CVR (GDN)": "1.19%"},
            {"Industry": "Health & Medical", "Average CVR (Search)": "3.36%", "Average CVR (GDN)": "0.82%"},
            {"Industry": "Home Goods", "Average CVR (Search)": "2.70%", "Average CVR (GDN)": "0.43%"},
            {"Industry": "Industrial Services", "Average CVR (Search)": "3.37%", "Average CVR (GDN)": "0.94%"},
            {"Industry": "Legal", "Average CVR (Search)": "6.98%", "Average CVR (GDN)": "1.84%"},
            {"Industry": "Real Estate", "Average CVR (Search)": "2.47%", "Average CVR (GDN)": "0.80%"},
            {"Industry": "Technology", "Average CVR (Search)": "2.92%", "Average CVR (GDN)": "0.86%"},
            {"Industry": "Travel & Hospitality", "Average CVR (Search)": "3.55%", "Average CVR (GDN)": "0.51%"}
        ]
    },
    "table_4": {
        "headers": ["Industry", "Average CPA (Search)", "Average CPA (GDN)"],
        "rows": [
            {"Industry": "Advocacy", "Average CPA (Search)": "$96.55", "Average CPA (GDN)": "$70.69"},
            {"Industry": "Auto", "Average CPA (Search)": "$33.52", "Average CPA (GDN)": "$23.68"},
            {"Industry": "B2B", "Average CPA (Search)": "$116.13", "Average CPA (GDN)": "$130.36"},
            {"Industry": "Consumer Services", "Average CPA (Search)": "$90.70", "Average CPA (GDN)": "$60.48"},
            {"Industry": "Dating & Personals", "Average CPA (Search)": "$76.76", "Average CPA (GDN)": "$60.23"},
            {"Industry": "E-Commerce", "Average CPA (Search)": "$45.27", "Average CPA (GDN)": "$65.80"},
            {"Industry": "Education", "Average CPA (Search)": "$72.70", "Average CPA (GDN)": "$143.36"},
            {"Industry": "Employment Services", "Average CPA (Search)": "$48.04", "Average CPA (GDN)": "$59.47"},
            {"Industry": "Finance & Insurance", "Average CPA (Search)": "$81.93", "Average CPA (GDN)": "$56.76"},
            {"Industry": "Health & Medical", "Average CPA (Search)": "$78.09", "Average CPA (GDN)": "$72.58"},
            {"Industry": "Home Goods", "Average CPA (Search)": "$87.13", "Average CPA (GDN)": "$116.17"},
            {"Industry": "Industrial Services", "Average CPA (Search)": "$79.28", "Average CPA (GDN)": "$51.58"},
            {"Industry": "Legal", "Average CPA (Search)": "$86.02", "Average CPA (GDN)": "$39.52"},
            {"Industry": "Real Estate", "Average CPA (Search)": "$116.61", "Average CPA (GDN)": "$74.79"},
            {"Industry": "Technology", "Average CPA (Search)": "$133.52", "Average CPA (GDN)": "$103.60"},
            {"Industry": "Travel & Hospitality", "Average CPA (Search)": "$44.73", "Average CPA (GDN)": "$99.13"}
        ]
    }
}

    tiktok_benchmarks = {
        "TikTok Ad Benchmarks by Industry": {
            "headers": [
                "Industry",
                "Click-through rate (CTR)",
                "Cost per click (CPC)",
                "Cost per mille (CPM)",
                "Conversion rate (CVR)",
                "Return on ad spend (ROAS)",
                "Engagement rate (ER)"
            ],
            "rows": [
                {
                    "Industry": "Alcohol",
                    "Click-through rate (CTR)": "0.18%",
                    "Cost per click (CPC)": "$0.5",
                    "Cost per mille (CPM)": "$8",
                    "Conversion rate (CVR)": "0.8%",
                    "Return on ad spend (ROAS)": "3.5",
                    "Engagement rate (ER)": "18%"
                },
                {
                    "Industry": "Fashion",
                    "Click-through rate (CTR)": "0.25%",
                    "Cost per click (CPC)": "$0.8",
                    "Cost per mille (CPM)": "$12",
                    "Conversion rate (CVR)": "0.6%",
                    "Return on ad spend (ROAS)": "2.5",
                    "Engagement rate (ER)": "15%"
                },
                {
                    "Industry": "Financial service",
                    "Click-through rate (CTR)": "0.1%",
                    "Cost per click (CPC)": "$1.5",
                    "Cost per mille (CPM)": "$15",
                    "Conversion rate (CVR)": "0.4%",
                    "Return on ad spend (ROAS)": "1.2",
                    "Engagement rate (ER)": "8%"
                },
                {
                    "Industry": "Food & Beverage",
                    "Click-through rate (CTR)": "0.32%",
                    "Cost per click (CPC)": "$0.6",
                    "Cost per mille (CPM)": "$9",
                    "Conversion rate (CVR)": "0.7%",
                    "Return on ad spend (ROAS)": "2.8",
                    "Engagement rate (ER)": "16%"
                },
                {
                    "Industry": "Health and Beauty",
                    "Click-through rate (CTR)": "0.32%",
                    "Cost per click (CPC)": "$0.7",
                    "Cost per mille (CPM)": "$11",
                    "Conversion rate (CVR)": "0.6%",
                    "Return on ad spend (ROAS)": "2.5",
                    "Engagement rate (ER)": "15%"
                },
                {
                    "Industry": "Higher education",
                    "Click-through rate (CTR)": "0.32%",
                    "Cost per click (CPC)": "$0.6",
                    "Cost per mille (CPM)": "$9",
                    "Conversion rate (CVR)": "0.7%",
                    "Return on ad spend (ROAS)": "2.8",
                    "Engagement rate (ER)": "16%"
                },
                {
                    "Industry": "Home decoration",
                    "Click-through rate (CTR)": "0.15%",
                    "Cost per click (CPC)": "$0.4",
                    "Cost per mille (CPM)": "$6",
                    "Conversion rate (CVR)": "0.5%",
                    "Return on ad spend (ROAS)": "2.2",
                    "Engagement rate (ER)": "12%"
                },
                {
                    "Industry": "Retail",
                    "Click-through rate (CTR)": "0.25%",
                    "Cost per click (CPC)": "$0.8",
                    "Cost per mille (CPM)": "$12",
                    "Conversion rate (CVR)": "0.6%",
                    "Return on ad spend (ROAS)": "2.5",
                    "Engagement rate (ER)": "15%"
                },
                {
                    "Industry": "Sports teams",
                    "Click-through rate (CTR)": "0.32%",
                    "Cost per click (CPC)": "$0.6",
                    "Cost per mille (CPM)": "$9",
                    "Conversion rate (CVR)": "0.7%",
                    "Return on ad spend (ROAS)": "2.8",
                    "Engagement rate (ER)": "16%"
                },
                {
                    "Industry": "Tech & Software",
                    "Click-through rate (CTR)": "0.28%",
                    "Cost per click (CPC)": "$0.9",
                    "Cost per mille (CPM)": "$11",
                    "Conversion rate (CVR)": "0.5%",
                    "Return on ad spend (ROAS)": "2.2",
                    "Engagement rate (ER)": "14%"
                },
                {
                    "Industry": "Travel",
                    "Click-through rate (CTR)": "0.15%",
                    "Cost per click (CPC)": "$0.4",
                    "Cost per mille (CPM)": "$6",
                    "Conversion rate (CVR)": "0.5%",
                    "Return on ad spend (ROAS)": "2.2",
                    "Engagement rate (ER)": "12%"
                },
            {
                    "Industry": "TikTok Ads Average",
                    "Click-through rate (CTR)": "0.84%",
                    "Cost per click (CPC)": "$1",
                    "Cost per mille (CPM)": "$10",
                    "Conversion rate (CVR)": "0.46%",
                    "Return on ad spend (ROAS)": "1.67",
                    "Engagement rate (ER)": "5-16%"
                }
            ]
        }
    }

    facebook_benchmarks = {
        "Facebook Ad Benchmarks by Industry": {
            "headers": [
                "Industry",
                "Average CTR",
                "Average CPC",
                "Average CVR",
                "Average CPA"
            ],
            "rows": [
                {
                    "Industry": "Apparel",
                    "Average CTR": "1.24%",
                    "Average CPC": "$0.45",
                    "Average CVR": "4.11%",
                    "Average CPA": "$10.98"
                },
                {
                    "Industry": "Auto",
                    "Average CTR": "0.80%",
                    "Average CPC": "$2.24",
                    "Average CVR": "5.11%",
                    "Average CPA": "$43.84"
                },
                {
                    "Industry": "B2B",
                    "Average CTR": "0.78%",
                    "Average CPC": "$2.52",
                    "Average CVR": "10.63%",
                    "Average CPA": "$23.77"
                },
                {
                    "Industry": "Beauty",
                    "Average CTR": "1.16%",
                    "Average CPC": "$1.81",
                    "Average CVR": "7.10%",
                    "Average CPA": "$25.49"
                },
                {
                    "Industry": "Consumer Services",
                    "Average CTR": "0.62%",
                    "Average CPC": "$3.08",
                    "Average CVR": "9.96%",
                    "Average CPA": "$31.11"
                },
                {
                    "Industry": "Education",
                    "Average CTR": "0.73%",
                    "Average CPC": "$1.06",
                    "Average CVR": "13.58%",
                    "Average CPA": "$7.85"
                },
                {
                    "Industry": "Employment & Job Training",
                    "Average CTR": "0.47%",
                    "Average CPC": "$2.72",
                    "Average CVR": "11.73%",
                    "Average CPA": "$23.24"
                },
                {
                    "Industry": "Finance & Insurance",
                    "Average CTR": "0.56%",
                    "Average CPC": "$3.77",
                    "Average CVR": "9.09%",
                    "Average CPA": "$41.43"
                },
                {
                    "Industry": "Fitness",
                    "Average CTR": "1.01%",
                    "Average CPC": "$1.90",
                    "Average CVR": "14.29%",
                    "Average CPA": "$13.29"
                },
                {
                    "Industry": "Home Improvement",
                    "Average CTR": "0.70%",
                    "Average CPC": "$2.93",
                    "Average CVR": "6.56%",
                    "Average CPA": "$44.66"
                },
                {
                    "Industry": "Healthcare",
                    "Average CTR": "0.83%",
                    "Average CPC": "$1.32",
                    "Average CVR": "11.00%",
                    "Average CPA": "$12.31"
                },
                {
                    "Industry": "Industrial Services",
                    "Average CTR": "0.71%",
                    "Average CPC": "$2.14",
                    "Average CVR": "0.71%",
                    "Average CPA": "$38.21"
                },
                {
                    "Industry": "Legal",
                    "Average CTR": "1.61%",
                    "Average CPC": "$1.32",
                    "Average CVR": "5.60%",
                    "Average CPA": "$28.70"
                },
                {
                    "Industry": "Real Estate",
                    "Average CTR": "0.99%",
                    "Average CPC": "$1.81",
                    "Average CVR": "10.68%",
                    "Average CPA": "$16.92"
                },
                {
                    "Industry": "Retail",
                    "Average CTR": "1.59%",
                    "Average CPC": "$0.70",
                    "Average CVR": "3.26%",
                    "Average CPA": "$21.47"
                },
                {
                    "Industry": "Technology",
                    "Average CTR": "1.04%",
                    "Average CPC": "$1.27",
                    "Average CVR": "2.31%",
                    "Average CPA": "$55.21"
                },
                {
                    "Industry": "Travel & Hospitality",
                    "Average CTR": "0.90%",
                    "Average CPC": "$0.63",
                    "Average CVR": "2.82%",
                    "Average CPA": "$22.50"
                },
                {
                    "Industry": "All",
                    "Average CTR": "0.90%",
                    "Average CPC": "$1.72",
                    "Average CVR": "9.21%",
                    "Average CPA": "$18.68"
                }
            ]
        }
    }

    linkedin_benchmarks = {
        "LinkedIn Ad Benchmarks 2024": {
            "headers": [
                "Metric",
                "Value",
                "Segmentation"
            ],
            "rows": [
                {
                    "Metric": "Sponsored Content (Single Image) CTR",
                    "Value": "0.56%",
                    "Segmentation": "Ad Format"
                },
                {
                    "Metric": "Sponsored Content (Carousel) CTR",
                    "Value": "0.40%",
                    "Segmentation": "Ad Format"
                },
                {
                    "Metric": "Sponsored Content (Video) CTR",
                    "Value": "0.44%",
                    "Segmentation": "Ad Format"
                },
                {
                    "Metric": "Message Ads CTR",
                    "Value": "3%",
                    "Segmentation": "Ad Format"
                },
                {
                    "Metric": "Message Ads Open Rates",
                    "Value": "30%",
                    "Segmentation": "Ad Format"
                },
                {
                    "Metric": "LinkedIn Document Ad CTR",
                    "Value": "0.43%",
                    "Segmentation": "Ad Format"
                },
                {
                    "Metric": "LinkedIn Event Ad CTR",
                    "Value": "0.55%",
                    "Segmentation": "Ad Format"
                },
                {
                    "Metric": "Global CTR (Senior decision-makers)",
                    "Value": "0.55%",
                    "Segmentation": "Seniority"
                },
                {
                    "Metric": "Global CTR (Junior employees)",
                    "Value": "0.60%",
                    "Segmentation": "Seniority"
                },
                {
                    "Metric": "CTR (Accounting)",
                    "Value": "0.60%",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CTR (Business Development)",
                    "Value": "0.65%",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CTR (Education)",
                    "Value": "0.65%",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CTR (Engineering)",
                    "Value": "0.57%",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CTR (Finance)",
                    "Value": "0.60%",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CTR (Human Resources)",
                    "Value": "0.62%",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CTR (Information Technology)",
                    "Value": "0.57%",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CTR (Marketing)",
                    "Value": "0.60%",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CTR (Media and Communications)",
                    "Value": "0.63%",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CTR (Operations)",
                    "Value": "0.55%",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CTR (Product Management)",
                    "Value": "0.54%",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CTR (Sales)",
                    "Value": "0.58%",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CTR (NAMER)",
                    "Value": "0.5%",
                    "Segmentation": "Region"
                },
                {
                    "Metric": "CTR (APAC)",
                    "Value": "0.8%",
                    "Segmentation": "Region"
                },
                {
                    "Metric": "CTR (EMEA)",
                    "Value": "0.6%",
                    "Segmentation": "Region"
                },
                {
                    "Metric": "CTR (LATAM)",
                    "Value": "0.7%",
                    "Segmentation": "Region"
                },
                {
                    "Metric": "CTR (Software & Internet)",
                    "Value": "0.39%",
                    "Segmentation": "Industry"
                },
                {
                    "Metric": "CTR (Finance Services, Insurance & Banking)",
                    "Value": "0.49%",
                    "Segmentation": "Industry"
                },
                {
                    "Metric": "CTR (Education)",
                    "Value": "0.42%",
                    "Segmentation": "Industry"
                },
                {
                    "Metric": "CTR (Hardware & Networking)",
                    "Value": "0.40%",
                    "Segmentation": "Industry"
                },
                {
                    "Metric": "CTR (Healthcare)",
                    "Value": "0.58%",
                    "Segmentation": "Industry"
                },
                {
                    "Metric": "CTR (Manufacturing)",
                    "Value": "0.49%",
                    "Segmentation": "Industry"
                },
                {
                    "Metric": "CTR (Media & Communication)",
                    "Value": "0.42%",
                    "Segmentation": "Industry"
                },
                {
                    "Metric": "CTR (Retail)",
                    "Value": "0.8%",
                    "Segmentation": "Industry"
                },
                {
                    "Metric": "CTR (Public Administration)",
                    "Value": "0.46%",
                    "Segmentation": "Industry"
                },
                {
                    "Metric": "CTR (Consumer Goods)",
                    "Value": "0.6%",
                    "Segmentation": "Industry"
                },
                {
                    "Metric": "CTR (Transportation & Logistics)",
                    "Value": "0.67%",
                    "Segmentation": "Industry"
                },
                {
                    "Metric": "CTR (Corporate Services)",
                    "Value": "0.5%",
                    "Segmentation": "Industry"
                },
                {
                    "Metric": "CPC (Global)",
                    "Value": "$5.58",
                    "Segmentation": "All"
                },
                {
                    "Metric": "CPC (Senior decision-makers)",
                    "Value": "$6.40",
                    "Segmentation": "Seniority"
                },
                {
                    "Metric": "CPC (Junior employees)",
                    "Value": "$4.40",
                    "Segmentation": "Seniority"
                },
                {
                    "Metric": "CPC (Accounting)",
                    "Value": "$5.00",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CPC (Business Development)",
                    "Value": "$6.30",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CPC (Education)",
                    "Value": "$4.90",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CPC (Engineering)",
                    "Value": "$5.10",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CPC (Finance)",
                    "Value": "$6.90",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CPC (Human Resources)",
                    "Value": "$6.00",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CPC (Information Technology)",
                    "Value": "$7.90",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CPC (Marketing)",
                    "Value": "$6.80",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CPC (Media and Communications)",
                    "Value": "$5.60",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CPC (Operations)",
                    "Value": "$5.70",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CPC (Product Management)",
                    "Value": "$7.30",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CPC (Sales)",
                    "Value": "$5.40",
                    "Segmentation": "Job Function"
                },
                {
                    "Metric": "CPM (Average)",
                    "Value": "$33.80",
                    "Segmentation": "All"
                },
                {
                    "Metric": "CPL (NAMER)",
                    "Value": "$230",
                    "Segmentation": "Region"
                },
                {
                    "Metric": "CPL (APAC)",
                    "Value": "$80",
                    "Segmentation": "Region"
                },
                {
                    "Metric": "CPL (EMEA)",
                    "Value": "$120",
                    "Segmentation": "Region"
                },
                {
                    "Metric": "CPL (LATAM)",
                    "Value": "$60",
                    "Segmentation": "Region"
                },
                {
                    "Metric": "CPL (Software & IT)",
                    "Value": "$125",
                    "Segmentation": "Industry"
                },
                {
                    "Metric": "CPL (Finance)",
                    "Value": "$100",
                    "Segmentation": "Industry"
                },
                {
                    "Metric": "CPL (Education)",
                    "Value": "$64",
                    "Segmentation": "Industry"
                },
                {
                    "Metric": "CPL (Hardware & Networking)",
                    "Value": "$150",
                    "Segmentation": "Industry"
                },
                {
                    "Metric": "CPL (Healthcare)",
                    "Value": "$125",
                    "Segmentation": "Industry"
                },
                {
                    "Metric": "CPL (Manufacturing)",
                    "Value": "$100",
                    "Segmentation": "Industry"
                },
                {
                    "Metric": "CPL (Media & Communications)",
                    "Value": "$65",
                    "Segmentation": "Industry"
                },
                {
                    "Metric": "CPL (Retail)",
                    "Value": "$80",
                    "Segmentation": "Industry"
                },
                {
                    "Metric": "CPL (Public Administration)",
                    "Value": "89",
                    "Segmentation": "Industry"
                    },
                    {
                    "Metric": "CPL (Transportation & Logistics)",
                    "Value": "60",
                    "Segmentation": "Industry"
                    },
                    {
                    "Metric": "Lead Gen Form Completion Rate (Average)",
                    "Value": "10%",
                    "Segmentation": "All"
                    },
                    {
                    "Metric": "Conversion Rate (Average)",
                    "Value": "5% - 15%",
                    "Segmentation": "All"
                    },
                    {
                    "Metric": "Sponsored Content (Non-video) Engagement Rate",
                    "Value": "0.5%",
                    "Segmentation": "Ad Format"
                    },
                    {
                    "Metric": "Sponsored Content (Video) Engagement Rate",
                    "Value": "1.6%",
                    "Segmentation": "Ad Format"
                    },
                    {
                    "Metric": "Message Ad / Inmail CTR",
                    "Value": "3.6%",
                    "Segmentation": "Ad Format"
                    },
                    {
                    "Metric": "Message Ad / Inmail Open rates",
                    "Value": "38%",
                    "Segmentation": "Ad Format"
                    },
                    {
                    "Metric": "Video View-through rate",
                    "Value": "29.5%",
                    "Segmentation": "Ad Format"
                    },
                    {
                    "Metric": "Video Engagement Rate",
                    "Value": "1.8%",
                    "Segmentation": "Ad Format"
                    },
                    {
                    "Metric": "LinkedIn Conversation Ads Open Rate",
                    "Value": "50%",
                    "Segmentation": "Ad Format"
                    },
                    {
                    "Metric": "LinkedIn Conversation Ads CTR",
                    "Value": "12%",
                    "Segmentation": "Ad Format"
                    },
                    {
                    "Metric": "LinkedIn Live Engagement Rate",
                    "Value": "10%",
                    "Segmentation": "Ad Format"
                    },
                    {
                    "Metric": "LinkedIn Live Attendance Rate",
                    "Value": "37%",
                    "Segmentation": "Ad Format"
                    }

                    ]
                        }
                    }
    
    uses_google = any(f in selected_ad_formats for f in ["Google Display", "Google Search", "Performance Max"])
    uses_tiktok = "TikTok" in selected_ad_formats
    uses_fb = "Facebook/Instagram" in selected_ad_formats
    uses_linkedin = "LinkedIn" in selected_ad_formats

    benchmark_lines = []
    if uses_google:
        benchmark_lines.append(f"        - Google Ads: {json.dumps(google_benchmarks)}")
    if uses_tiktok:
        benchmark_lines.append(f"        - TikTok: {json.dumps(tiktok_benchmarks)}")
    if uses_fb:
        benchmark_lines.append(f"        - Facebook/Instagram: {json.dumps(facebook_benchmarks)}")
    if uses_linkedin:
        benchmark_lines.append(f"        - LinkedIn: {json.dumps(linkedin_benchmarks)}")
    benchmark_section = "\n".join(benchmark_lines)

    prompt = f"""You are a senior digital marketing strategist. Produce a detailed, execution-ready media plan as a STRICT JSON object only — no prose, no markdown, no code fences. Your entire reply must be a single JSON object.

**You MUST ONLY use these platforms: {selected_ad_formats}**. Do not invent others. If a platform in that list cannot reasonably run the selected format, omit it and mention why in rationale_html.

CAMPAIGN PERIOD (the same for every campaign): start {campaign_start}, end {campaign_end}, duration {duration_days} days (~{months} months).

GRANULARITY — produce ONE OBJECT PER CAMPAIGN, not per platform. Split platforms into multiple campaigns by funnel objective where realistic. For example Meta (Facebook/Instagram) => a Conversion campaign, a Traffic campaign, and an Awareness campaign as three separate objects. Google Search => usually one Conversion/Lead campaign. Aim for the level of detail a real media buyer sets up in ad accounts (typically 7-12 campaigns total).

For each campaign provide these fields:
  - "platform": one of {selected_ad_formats}
  - "campaign_type": SEM | Display | Display/SEM | Social Media | Video
  - "focus": e.g. Conversion (Leads), Conversion (Sales), Traffic, Awareness, Video Views, Website Traffic
  - "objective": plain-language goal, e.g. "Maximise number of submit lead forms"
  - "budget_weight": a positive number representing this campaign's RELATIVE share of monthly spend (the weights across all campaigns will be normalised; they do NOT need to add to any specific number). Put more weight on highest-ROI / conversion campaigns.
  - "target_audience": short HTML using <br> between lines, e.g. "Location: Singapore<br>Demo: SME owners 30-55<br>Keyword Targeting: storage units, ..." (use Affinity/In-market, Audience Signals, or Interest & Behaviours / Custom Audience as appropriate to the platform)
  - "creative_type": e.g. "Text (Responsive Search Ad)", "Image (Square, Landscape)", "Text, Image, Video", "Image/Carousel/Video", "Video (Skippable In-stream / Bumper / Shorts)"
  - "campaign_structure": short HTML using <br>, e.g. "1 Campaign Group<br>2 Ad Sets<br>4 Ad Copies each"
  - "ctr_pct": estimated click-through rate as a NUMBER in percent (e.g. 2.41)
  - "cpc": estimated cost-per-click as a NUMBER in dollars (e.g. 0.61). Use for Search/most platforms.
  - "cpm": estimated cost per 1000 impressions as a NUMBER in dollars for Display/Social/Video; use null for Google Search.
  - "conversion_rate_pct": estimated conversion rate as a NUMBER in percent, realistic and at most 5 (e.g. 3.0)

Ground every ctr/cpc/cpm/conversion figure in these published benchmarks (last updated {BENCHMARK_LAST_UPDATED}; if no Instagram-specific data, use Facebook):
{benchmark_section}

Also return:
  - "rationale_html": an HTML fragment (use <h3>Budget Allocation Rationale</h3> then <p> paragraphs) explaining each platform's role, fit for the audience, and any exclusions. Then a <h3>Benchmark Data Note</h3> stating benchmarks are from published platform industry data ({BENCHMARK_LAST_UPDATED}), may not reflect current or account-specific conditions, and should be validated against actual performance after 2-4 weeks.

Do NOT compute budgets, impressions, clicks, conversions, or totals — only provide the per-campaign rates and weights above; the dollar amounts and projections are calculated downstream.

Output JSON shape:
{{"campaigns": [ {{ ...fields... }} ], "rationale_html": "..."}}

Key Considerations:
  * Campaign location: {media_plan_location}
  * Target audience: {media_plan_target_audience} for: {media_plan_product_service}
  * Content pillars: {media_plan_content_strategy}
  * Touchpoints: {media_plan_touchpoints}
  * Customer personas: {media_plan_customer_personas}
  * Landing pages: {media_plan_landing_pages}
  * CTA: {media_plan_cta}
  * Organisational objectives: {organisational_objectives}
  * KPIs: {media_plan_kpis}
  * Competitive differentiation: {media_plan_competitive_analysis}
  * Compliance: {media_plan_compliance}
  * Technology: {media_plan_technology_plan}
  * Analytics & Reporting: {media_plan_analytics_reporting}

  Company/product context from webpages: {json.dumps(data)}
  Additional information: {manual}
"""

    # LLM request — DeepSeek if requested (OpenAI-compatible), else Anthropic Claude.
    # Default stays Claude, so the client can switch back at any time.
    provider = (event.get('provider') or '').lower()
    # Bounded LLM call, guarded so a timeout/connection error returns a clean
    # message instead of an uncaught 500 (the call used to sit outside any try).
    try:
        if provider == 'deepseek':
            querystring = {
                "model": "deepseek-chat",
                "max_tokens": 8192,
                "messages": [{"role": "user", "content": prompt}]
            }
            headers = {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {os.environ.get('DEEPSEEK_API_KEY', '')}"
            }
            response = requests.post("https://api.deepseek.com/chat/completions", headers=headers, json=querystring, timeout=120)
        else:
            querystring = {
                "model": "claude-haiku-4-5-20251001",
                "max_tokens": 8192,
                "messages": [{"role": "user", "content": prompt}]
            }
            headers = {
                "Content-Type": "application/json",
                "x-api-key": claude_key,
                "anthropic-version": "2023-06-01"
            }
            response = requests.post(claude_url, headers=headers, json=querystring, timeout=120)
    except Exception as e:
        print(f"mediaPlanGenerator LLM request failed: {e}")
        return {'statusCode': 502, 'body': "<p style='color:red;'>The media plan service timed out or failed. Please try again.</p>"}

    # ---- Helpers for formatting / safe parsing ----
    def _num(v, default=0.0):
        try:
            if v is None:
                return default
            if isinstance(v, (int, float)):
                return float(v)
            import re as _r
            cleaned = _r.sub(r'[^0-9.\-]', '', str(v))
            return float(cleaned) if cleaned not in ('', '-', '.', '-.') else default
        except (ValueError, TypeError):
            return default

    def _money(n):
        return "${:,.0f}".format(round(n))

    def _money2(n):
        return "${:,.2f}".format(n)

    def _int(n):
        return "{:,.0f}".format(round(n))

    def _cell(s):
        # Escape model-provided cell text (rendered as innerHTML on the client),
        # but keep the simple <br> line breaks the template intends.
        if s is None:
            return ""
        out = str(s).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;')
        return (out.replace('&lt;br&gt;', '<br>')
                   .replace('&lt;br/&gt;', '<br>')
                   .replace('&lt;br /&gt;', '<br>'))

    def _sanitize_html(h):
        # rationale_html is model-authored rich HTML — strip active content
        # (scripts, inline event handlers, javascript: URLs) before it hits innerHTML.
        h = str(h or '')
        h = re.sub(r'(?is)<\s*script.*?<\s*/\s*script\s*>', '', h)
        h = re.sub(r'(?is)<\s*/?\s*script[^>]*>', '', h)
        h = re.sub(r'(?is)<\s*iframe.*?<\s*/\s*iframe\s*>', '', h)
        h = re.sub(r'(?i)\son\w+\s*=\s*"[^"]*"', '', h)
        h = re.sub(r"(?i)\son\w+\s*=\s*'[^']*'", '', h)
        h = re.sub(r'(?i)\son\w+\s*=\s*[^\s>]+', '', h)
        h = re.sub(r'(?i)javascript:', '', h)
        return h

    try:
        _rj = response.json()
        # Normalize across providers: DeepSeek/OpenAI -> choices[].message.content; Claude -> content[].text
        response_text = _rj['choices'][0]['message']['content'] if 'choices' in _rj else _rj['content'][0]['text']

        # Extract the JSON object from the model output
        raw = response_text.strip()
        if raw.startswith('```'):
            raw = raw.split('```', 2)
            raw = raw[1] if len(raw) > 1 else response_text
            if raw.lstrip().lower().startswith('json'):
                raw = raw.lstrip()[4:]
        first = raw.find('{')
        last = raw.rfind('}')
        if first == -1 or last == -1:
            raise ValueError("No JSON object found in model response.")
        plan = json.loads(raw[first:last + 1])

        campaigns = plan.get('campaigns', []) or []
        if not campaigns:
            raise ValueError("Model returned no campaigns.")

        # Normalise budget weights so monthly spend sums exactly to the monthly budget
        weights = [max(_num(c.get('budget_weight'), 0.0), 0.0) for c in campaigns]
        wsum = sum(weights)
        if wsum <= 0:
            weights = [1.0] * len(campaigns)
            wsum = float(len(campaigns))

        rows_html = []
        tot_total = tot_monthly = tot_daily = 0.0
        tot_impr = tot_clicks = tot_conv = 0.0

        for c, w in zip(campaigns, weights):
            monthly = monthly_budget_num * (w / wsum)
            total = monthly * months
            daily = monthly / 30.4 if monthly else 0.0

            ctr = _num(c.get('ctr_pct'), 0.0)
            cpc = _num(c.get('cpc'), 0.0)
            cpm = _num(c.get('cpm'), 0.0)
            conv_rate = min(_num(c.get('conversion_rate_pct'), 0.0), 100.0)

            # Derive clicks / impressions consistently
            if cpc > 0:
                clicks = monthly / cpc
                impressions = clicks / (ctr / 100.0) if ctr > 0 else 0.0
            elif cpm > 0:
                impressions = (monthly / cpm) * 1000.0
                clicks = impressions * (ctr / 100.0)
            else:
                clicks = impressions = 0.0

            # Backfill displayed cpm/cpc where derivable
            disp_cpc = cpc if cpc > 0 else (monthly / clicks if clicks > 0 else 0.0)
            disp_cpm = cpm if cpm > 0 else (((monthly / impressions) * 1000.0) if impressions > 0 else 0.0)
            # Google Search rows show no CPM
            is_search = 'search' in str(c.get('platform', '')).lower()

            conversions = clicks * (conv_rate / 100.0)
            cost_per_conv = (monthly / conversions) if conversions > 0 else 0.0

            tot_total += total
            tot_monthly += monthly
            tot_daily += daily
            tot_impr += impressions
            tot_clicks += clicks
            tot_conv += conversions

            rows_html.append(
                "<tr>"
                f"<td>{_cell(c.get('platform'))}</td>"
                f"<td>{_cell(c.get('campaign_type'))}</td>"
                f"<td>{_cell(c.get('focus'))}</td>"
                f"<td class=\"mp-wrap\">{_cell(c.get('objective'))}</td>"
                f"<td>{_money(total)}</td>"
                f"<td>{_money(monthly)}</td>"
                f"<td>{_money2(daily)}</td>"
                f"<td class=\"mp-wrap\">{_cell(c.get('target_audience'))}</td>"
                f"<td class=\"mp-wrap\">{_cell(c.get('creative_type'))}</td>"
                f"<td>{campaign_start}</td>"
                f"<td>{campaign_end}</td>"
                f"<td>{duration_days}</td>"
                f"<td class=\"mp-wrap\">{_cell(c.get('campaign_structure'))}</td>"
                f"<td>{_int(impressions)}</td>"
                f"<td>{_int(clicks)}</td>"
                f"<td>{ctr:.2f}%</td>"
                f"<td>{'&mdash;' if is_search else _money2(disp_cpm)}</td>"
                f"<td>{_money2(disp_cpc)}</td>"
                f"<td>{_int(conversions)}</td>"
                f"<td>{_money(cost_per_conv) if conversions > 0 else '&mdash;'}</td>"
                "</tr>"
            )

        tot_ctr = (tot_clicks / tot_impr * 100.0) if tot_impr > 0 else 0.0
        tot_cpc = (tot_monthly / tot_clicks) if tot_clicks > 0 else 0.0
        tot_cpconv = (tot_monthly / tot_conv) if tot_conv > 0 else 0.0

        total_row = (
            "<tr class=\"mp-total\">"
            "<td>Total</td><td></td><td></td><td></td>"
            f"<td>{_money(tot_total)}</td>"
            f"<td>{_money(tot_monthly)}</td>"
            f"<td>{_money2(tot_daily)}</td>"
            "<td></td><td></td><td></td><td></td><td></td><td></td>"
            f"<td>{_int(tot_impr)}</td>"
            f"<td>{_int(tot_clicks)}</td>"
            f"<td>{tot_ctr:.2f}%</td>"
            "<td></td>"
            f"<td>{_money2(tot_cpc)}</td>"
            f"<td>{_int(tot_conv)}</td>"
            f"<td>{_money(tot_cpconv) if tot_conv > 0 else '&mdash;'}</td>"
            "</tr>"
        )

        headers_html = "".join("<th>{}</th>".format(h) for h in [
            "Platform", "Campaign Type", "Focus of Campaign", "Objective",
            "Total Ad Budget", "Monthly Ad Budget", "Daily Ad Budget",
            "Target Audience", "Creative Type", "Campaign Start Date",
            "Campaign End Date", "Campaign Duration (days)", "Campaign Structure",
            "Estimated Impressions", "Estimated Clicks", "Estimated CTR",
            "Estimated CPM", "Estimated CPC", "Estimated Conversions",
            "Estimated Cost / Conversion"
        ])

        period_note = (
            f"<p style=\"font-size:12px;color:#64748b;margin:0 0 8px;\">"
            f"Campaign period: <strong>{campaign_start}</strong> &ndash; <strong>{campaign_end}</strong> "
            f"({duration_days} days) &middot; Monthly budget <strong>{monthly_budget_fmt}</strong> "
            f"&middot; Total campaign budget <strong>{total_budget_fmt}</strong></p>"
        )

        table_html = (
            period_note
            + "<div class=\"mp-exec-wrap\"><table class=\"mp-exec-table\"><thead><tr>"
            + headers_html
            + "</tr></thead><tbody>"
            + "".join(rows_html)
            + total_row
            + "</tbody></table></div>"
        )

        rationale = _sanitize_html(plan.get('rationale_html', '') or '')
        body = table_html + rationale

        if not body.strip():
            raise ValueError("Empty media plan body.")
    except (KeyError, ValueError, IndexError, json.JSONDecodeError, TypeError) as e:
        # Handle API / parsing errors gracefully
        error_message = f"Error processing Claude API response: {str(e)}.  Raw response: {response.text[:1500]}"
        print(error_message)
        body = f"<p style='color:red;'>An error occurred while generating the media plan: {error_message}</p>"


    print(body)
    return {
        'statusCode': 200,
        'body': body
    }
