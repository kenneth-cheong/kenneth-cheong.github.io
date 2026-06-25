import json
import os
from urllib.parse import urlparse, urlunparse

import requests

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

    try:
        item = fetch_instant_page(url)
    except Exception as e:  # network / DataForSEO failure
        return {
            "statusCode": 200,
            "body": f"<h4>Webpage Formatting</h4><p>Could not retrieve rendered "
                    f"page data for {url}. The crawler returned an error: {e}.</p>",
        }

    if not item or not item.get("meta"):
        return {
            "statusCode": 200,
            "body": f"<h4>Webpage Formatting</h4><p>The rendered crawl of {url} "
                    f"returned no analysable page content. The page may block "
                    f"automated crawlers, require authentication, or have failed "
                    f"to render.</p>",
        }

    slim = slim_page(item)
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    content = call_claude(build_prompt(url, slim), api_key, max_tokens=2500)
    content = content.replace("```html", "").replace("```", "").strip()

    return {"statusCode": 200, "body": content}
