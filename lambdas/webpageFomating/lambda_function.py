import html as _html
import json
import os
from html.parser import HTMLParser
from urllib.parse import urlparse, urlunparse

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
_LLM_FN = 'webpageFomating'
_LLM_SOURCE = 'unknown'


def _set_llm_source(event):
    """Tag this invocation with the front-end that triggered it (saas | index).
    Read from the request body's `_source` (a body field, NOT a header — a custom
    header would force a CORS preflight on every agency Lambda). Lambda handles
    one event at a time per container, so a module global is safe here."""
    global _LLM_SOURCE
    src = ''
    try:
        if isinstance(event, dict):
            body = event.get('body')
            if isinstance(body, str):
                try:
                    body = _mllm_json.loads(body or '{}')
                except Exception:
                    body = {}
            if not isinstance(body, dict):
                body = {}
            src = body.get('_source') or event.get('_source') or ''
        src = str(src).strip().lower()
    except Exception:
        src = ''
    # Anything unrecognised stays 'unknown' so unattributed spend stays visible.
    _LLM_SOURCE = src if src in ('saas', 'index') else 'unknown'


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
        print(_mllm_json.dumps({'_aws': {'Timestamp': int(_mllm_time.time() * 1000), 'CloudWatchMetrics': [{'Namespace': 'Digimetrics/LLM', 'Dimensions': [['Provider'], ['Provider', 'Model'], ['Source'], ['Source', 'Provider']], 'Metrics': [{'Name': 'Calls', 'Unit': 'Count'}, {'Name': 'InputTokens', 'Unit': 'Count'}, {'Name': 'OutputTokens', 'Unit': 'Count'}, {'Name': 'CacheReadTokens', 'Unit': 'Count'}, {'Name': 'CacheWriteTokens', 'Unit': 'Count'}, {'Name': 'WebSearchRequests', 'Unit': 'Count'}]}]}, 'Provider': provider, 'Model': model or 'unknown', 'Source': _LLM_SOURCE, 'fn': fn or _LLM_FN, 'Calls': 1, 'InputTokens': int(b.get('in', 0) or 0), 'OutputTokens': int(b.get('out', 0) or 0), 'CacheReadTokens': int(b.get('cr', 0) or 0), 'CacheWriteTokens': int(b.get('cw', 0) or 0), 'WebSearchRequests': int(b.get('ws', 0) or 0)}))
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


# ── HTML sanitiser ────────────────────────────────────────────────────────
# The report body is HTML generated by the model from third-party crawl data
# (page title, H1, description, etc.), then injected into the page via
# innerHTML by the frontend. A hostile target page could set e.g.
# H1 = "<img src=x onerror=alert(document.cookie)>" and have the model quote it
# back, so we allowlist a small set of formatting tags and DROP every attribute
# (the prompt already forbids styles/classes/links) — this removes event
# handlers, <script>, javascript: URIs and any non-formatting tag entirely.
_ALLOWED_TAGS = {
    "h3", "h4", "h5", "h6", "p", "br", "hr", "ul", "ol", "li",
    "table", "thead", "tbody", "tfoot", "tr", "th", "td",
    "strong", "em", "b", "i", "u", "code", "pre", "span", "small", "blockquote",
}
_VOID_TAGS = {"br", "hr"}


_RAW_TEXT_TAGS = {"script", "style", "title", "textarea", "noscript", "template"}


class _HtmlSanitizer(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out = []
        self._skip_depth = 0  # inside a raw-text element whose content is dropped

    def handle_starttag(self, tag, attrs):
        if tag in _RAW_TEXT_TAGS:
            self._skip_depth += 1
        elif tag in _ALLOWED_TAGS:
            self.out.append("<%s>" % tag)  # attributes intentionally dropped

    def handle_startendtag(self, tag, attrs):
        if tag in _ALLOWED_TAGS and tag not in _RAW_TEXT_TAGS:
            self.out.append("<%s>" % tag)

    def handle_endtag(self, tag):
        if tag in _RAW_TEXT_TAGS:
            if self._skip_depth > 0:
                self._skip_depth -= 1
        elif tag in _ALLOWED_TAGS and tag not in _VOID_TAGS:
            self.out.append("</%s>" % tag)

    def handle_data(self, data):
        if self._skip_depth == 0:
            self.out.append(_html.escape(data))


def sanitize_html(raw):
    """Return `raw` with only allowlisted formatting tags kept (no attributes)
    and all text escaped. Safe to inject via innerHTML."""
    try:
        p = _HtmlSanitizer()
        p.feed(raw or "")
        p.close()
        return "".join(p.out)
    except Exception:
        # If parsing blows up, fall back to fully-escaped text — never raw HTML.
        return _html.escape(raw or "")

# DataForSEO on-page API. Basic-auth header is supplied via the
# DATAFORSEO_AUTH env var (e.g. "Basic <base64 user:pass>") so no credential
# is committed to source.
DFS_AUTH = os.environ.get("DATAFORSEO_AUTH", "")
DFS_INSTANT_PAGES = "https://api.dataforseo.com/v3/on_page/instant_pages"


def call_claude(prompt, api_key, max_tokens=2500, system=None):
    body = {
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": prompt}],
    }
    if system:
        body["system"] = system
    r = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json=body,
        timeout=120,
    )
    data = r.json()
    if "content" not in data:
        raise ValueError(f"Anthropic error: {data}")
    return data["content"][0]["text"]


def normalize_url(url):
    """DataForSEO's crawler returns 0 items for a bare domain with no path
    (e.g. https://example.com). Always give it an explicit path."""
    url = (url or "").strip()
    if "://" not in url:
        url = "https://" + url
    parts = urlparse(url)
    if not parts.path:
        parts = parts._replace(path="/")
    return urlunparse(parts)


def fetch_instant_page(url):
    """Render the page via DataForSEO instant_pages (JS + browser rendering) and
    return the primary HTML page item, or None if nothing usable came back."""
    payload = [{
        "url": url,
        "enable_javascript": True,
        "enable_browser_rendering": True,
        "load_resources": True,
    }]
    r = requests.post(
        DFS_INSTANT_PAGES,
        headers={"Authorization": DFS_AUTH, "Content-Type": "application/json"},
        json=payload,
        timeout=120,
    )
    data = r.json()
    try:
        items = data["tasks"][0]["result"][0]["items"]
    except (KeyError, IndexError, TypeError):
        return None
    if not items:
        return None
    # Prefer the actual rendered HTML document over any sub-resource rows.
    for it in items:
        if it.get("resource_type") == "html" or it.get("meta"):
            return it
    return items[0]


def _bytes_to_human(n):
    if not isinstance(n, (int, float)) or n <= 0:
        return "0 B"
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def slim_page(item):
    """Keep only the formatting / technical-health signals worth analysing,
    so the model reasons over real crawl data instead of raw noise."""
    meta = item.get("meta") or {}
    content = meta.get("content") or {}
    checks = item.get("checks") or {}
    flagged = {k: v for k, v in checks.items() if v is True}
    return {
        "url": item.get("url"),
        "status_code": item.get("status_code"),
        "onpage_score": item.get("onpage_score"),
        "server": item.get("server"),
        "media_type": item.get("media_type"),
        "content_encoding": item.get("content_encoding"),
        "total_dom_size_bytes": item.get("total_dom_size"),
        "page_size_bytes": item.get("size"),
        "title": meta.get("title"),
        "title_length": meta.get("title_length"),
        "description": meta.get("description"),
        "description_length": meta.get("description_length"),
        "charset": meta.get("charset"),
        "generator": meta.get("generator"),
        "canonical": meta.get("canonical"),
        "favicon": meta.get("favicon"),
        "htags": meta.get("htags"),
        "images_count": meta.get("images_count"),
        "images_size_bytes": meta.get("images_size"),
        "internal_links_count": meta.get("internal_links_count"),
        "external_links_count": meta.get("external_links_count"),
        "scripts_count": meta.get("scripts_count"),
        "scripts_size_bytes": meta.get("scripts_size"),
        "stylesheets_count": meta.get("stylesheets_count"),
        "stylesheets_size_bytes": meta.get("stylesheets_size"),
        "render_blocking_scripts_count": meta.get("render_blocking_scripts_count"),
        "render_blocking_stylesheets_count": meta.get("render_blocking_stylesheets_count"),
        "cumulative_layout_shift": meta.get("cumulative_layout_shift"),
        "deprecated_tags": meta.get("deprecated_tags"),
        "duplicate_meta_tags": meta.get("duplicate_meta_tags"),
        "social_media_tags": list((meta.get("social_media_tags") or {}).keys()),
        "content_metrics": content,
        "page_timing": item.get("page_timing"),
        "flagged_checks": list(flagged.keys()),
        "resource_errors": (item.get("resource_errors") or {}).get("errors"),
    }


def build_prompt(url, slim):
    return f"""You are a senior web QA / front-end analyst. Using ONLY the real \
rendered-crawl data below (captured by DataForSEO with JavaScript and browser \
rendering enabled), produce a concise **Webpage Formatting & Technical Consistency** \
report for {url}.

Ground every statement in the data provided. If a specific data point is not \
present, write "Not captured in crawl data" rather than guessing. Convert byte \
counts to KB/MB.

Cover these sections in this order:

1. Heading Structure - from `htags`, give the count per level (H1-H6) and state \
whether the hierarchy is well-formed (exactly one H1, no skipped levels). Quote the H1.
2. Stylesheets & Scripts - report stylesheets_count/size and scripts_count/size, \
flag any render-blocking counts, and judge whether the asset payload is light, \
moderate, or heavy.
3. Layout Stability & Rendering - report cumulative_layout_shift and the key \
page_timing values (largest_contentful_paint, time_to_interactive, dom_complete). \
Classify CLS as Good (<0.1), Needs Improvement (0.1-0.25) or Poor (>0.25), and LCP \
as Good (<2.5s), Needs Improvement (2.5-4s) or Poor (>4s).
4. Markup Health - report DOM size, charset, generator, deprecated_tags, \
duplicate_meta_tags, and list any resource_errors (HTML validation issues).
5. Meta & Social Consistency - title (with length), description (with length), \
canonical, favicon presence, and which Open Graph / Twitter tags are present. Note \
any relevant items from flagged_checks (e.g. no_image_alt, frame, low_content_rate).

Output requirements:
- Return ONLY HTML. No markdown, no code fences. Start directly with the first <h4>.
- Use <h4> for each section heading, <p> for prose, and <ul><li> for lists.
- For the numeric metrics in sections 2 and 3, render a <table> with <thead>/<tbody>.
- Do NOT add inline styles, class attributes, or <html>/<head>/<body> tags.
- Be specific and quantitative; keep it tight.

Crawl data (JSON):
{json.dumps(slim, ensure_ascii=False)}
"""


def lambda_handler(event, context):
    # Accept both the mapped {"url": ...} event and a raw proxy body.
    url = event.get("url") if isinstance(event, dict) else None
    if not url and isinstance(event, dict) and event.get("body"):
        try:
            url = json.loads(event["body"]).get("url")
        except (ValueError, TypeError):
            url = None
    if not url:
        return {"statusCode": 400, "body": "<p>No URL provided.</p>"}

    url = normalize_url(url)

    safe_url = _html.escape(url)

    try:
        item = fetch_instant_page(url)
    except Exception as e:  # network / DataForSEO failure
        return {
            "statusCode": 200,
            "body": f"<h4>Webpage Formatting</h4><p>Could not retrieve rendered "
                    f"page data for {safe_url}. The crawler returned an error: "
                    f"{_html.escape(str(e))}.</p>",
        }

    if not item or not item.get("meta"):
        return {
            "statusCode": 200,
            "body": f"<h4>Webpage Formatting</h4><p>The rendered crawl of {safe_url} "
                    f"returned no analysable page content. The page may block "
                    f"automated crawlers, require authentication, or have failed "
                    f"to render.</p>",
        }

    slim = slim_page(item)
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    content = call_claude(build_prompt(url, slim), api_key, max_tokens=2500)
    content = content.replace("```html", "").replace("```", "").strip()

    # Model output is HTML built from third-party crawl data — sanitise before
    # it reaches the frontend's innerHTML.
    return {"statusCode": 200, "body": sanitize_html(content)}


# ── LLM source attribution ────────────────────────────────────────────────────
# Wrap the handler ONCE so every model call made during this invocation is tagged
# with the front-end that triggered it. Appended at module end because
# lambda_handler must already be defined. Pairs with the metering block above.
try:
    _llm_orig_handler = lambda_handler

    def lambda_handler(event, context=None):
        _set_llm_source(event)
        return _llm_orig_handler(event, context)
except NameError:
    pass
