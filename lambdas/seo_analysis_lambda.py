import json
import re
import os
import requests
from bs4 import BeautifulSoup
from urllib.parse import urlparse

def _count_syllables(word):
    word = word.lower().strip(".,!?;:")
    if not word:
        return 0
    vowels = "aeiouy"
    count = 0
    prev_vowel = False
    for ch in word:
        is_vowel = ch in vowels
        if is_vowel and not prev_vowel:
            count += 1
        prev_vowel = is_vowel
    if word.endswith("e") and count > 1:
        count -= 1
    return max(1, count)

def _flesch_reading_ease(text):
    sentences = max(1, len(re.findall(r'[.!?]+', text)))
    words = re.findall(r'\b\w+\b', text)
    if not words:
        return 0
    syllables = sum(_count_syllables(w) for w in words)
    return 206.835 - 1.015 * (len(words) / sentences) - 84.6 * (syllables / len(words))

PRIORITY_HIGH = "high"
PRIORITY_MEDIUM = "medium"
PRIORITY_LOW = "low"


# ── Utilities ──────────────────────────────────────────────────────────────────

def fetch_page(url):
    headers = {
        "User-Agent": "Mozilla/5.0 (compatible; DigiSEOBot/1.0)",
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }
    resp = requests.get(url, headers=headers, timeout=20, allow_redirects=True)
    soup = BeautifulSoup(resp.text, "html.parser")
    title_tag = soup.find("title")
    title = title_tag.get_text().strip() if title_tag else ""
    return resp.text, title


def strip_html(content):
    return BeautifulSoup(content, "html.parser").get_text()


def count_words(text):
    return len(re.findall(r'\w+', text))


def _norm_key(text):
    return re.sub(r'[^a-z0-9]', '', text.lower())


def _priority_order(r):
    return {PRIORITY_HIGH: 0, PRIORITY_MEDIUM: 1, PRIORITY_LOW: 2}.get(r.get("priority", PRIORITY_LOW), 2)


# ── Analysis functions ─────────────────────────────────────────────────────────

def check_https(url):
    is_https = url.startswith("https://")
    return {
        "label": "HTTPS Security",
        "score": 100 if is_https else 0,
        "recommendations": [] if is_https else [
            {"text": "Migrate to HTTPS — required for security, user trust, and ranking", "priority": PRIORITY_HIGH}
        ]
    }


def analyze_canonical(content_html, url):
    soup = BeautifulSoup(content_html, "html.parser")
    canonical = soup.find("link", {"rel": "canonical"})
    if not canonical:
        return {"label": "Canonical Tag", "score": 0, "canonical_url": None, "recommendations": [
            {"text": "Add a <link rel='canonical'> tag to prevent duplicate content penalties", "priority": PRIORITY_HIGH}
        ]}
    canonical_url = canonical.get("href", "")
    parsed_page = urlparse(url)
    parsed_canon = urlparse(canonical_url)
    if parsed_page.netloc and parsed_canon.netloc and parsed_page.netloc != parsed_canon.netloc:
        return {"label": "Canonical Tag", "score": 30, "canonical_url": canonical_url, "recommendations": [
            {"text": f"Canonical points to a different domain ({parsed_canon.netloc}) — verify this is intentional", "priority": PRIORITY_HIGH}
        ]}
    return {"label": "Canonical Tag", "score": 100, "canonical_url": canonical_url, "recommendations": []}


def analyze_images(content_html):
    soup = BeautifulSoup(content_html, "html.parser")
    images = soup.find_all("img")
    if not images:
        return {"label": "Images & Alt Text", "score": 100, "total": 0, "missing_alt": 0, "recommendations": []}
    missing_alt = [img for img in images if not img.get("alt", "").strip()]
    pct_missing = len(missing_alt) / len(images)
    if pct_missing == 0:
        return {"label": "Images & Alt Text", "score": 100, "total": len(images), "missing_alt": 0, "recommendations": []}
    recs = []
    if pct_missing <= 0.2:
        score = 70
        recs.append({"text": f"{len(missing_alt)} image(s) missing alt text — add descriptive alt attributes", "priority": PRIORITY_MEDIUM})
    else:
        score = max(0, int((1 - pct_missing) * 100))
        recs.append({"text": f"{len(missing_alt)}/{len(images)} images missing alt text — add keyword-relevant alt attributes", "priority": PRIORITY_HIGH})
    return {"label": "Images & Alt Text", "score": score, "total": len(images), "missing_alt": len(missing_alt), "recommendations": recs}


def analyze_title(title, primary_keyword):
    length = len(title)
    score = 0
    recommendations = []
    if 50 <= length <= 60:
        score += 40
    elif 40 <= length <= 70:
        score += 20
    else:
        recommendations.append({"text": f"Title is {length} chars — aim for 50–60 for full SERP display", "priority": PRIORITY_HIGH})
    if primary_keyword and primary_keyword.lower() in title.lower():
        score += 60
        if title.lower().startswith(primary_keyword.lower()):
            score += 10
    elif primary_keyword:
        recommendations.append({"text": f"Primary keyword '{primary_keyword}' is missing from the title tag", "priority": PRIORITY_HIGH})
    return {"label": "Page Title", "score": min(score, 100), "title": title, "length": length, "recommendations": recommendations}


def analyze_meta_description(content_html, primary_keyword=None):
    soup = BeautifulSoup(content_html, "html.parser")
    meta = soup.find("meta", {"name": re.compile("description", re.I)})
    if not meta:
        return {"label": "Meta Description", "score": 0, "content": "", "length": 0, "recommendations": [
            {"text": "Meta description is missing — add one to improve CTR in search results", "priority": PRIORITY_HIGH}
        ]}
    content = meta.get("content", "")
    length = len(content)
    recommendations = []
    if 120 <= length <= 160:
        score = 100
    elif 80 <= length <= 200:
        score = 60
        recommendations.append({"text": f"Meta description is {length} chars — aim for 120–160", "priority": PRIORITY_MEDIUM})
    else:
        recommendations.append({"text": f"Meta description is {'too short' if length < 80 else 'too long'} ({length} chars, aim 120–160)", "priority": PRIORITY_HIGH})
        score = 20
    if primary_keyword and primary_keyword.lower() not in content.lower():
        recommendations.append({"text": f"Add primary keyword '{primary_keyword}' to meta description", "priority": PRIORITY_MEDIUM})
    return {"label": "Meta Description", "score": score, "content": content, "length": length, "recommendations": recommendations}


def analyze_headings(content, primary_keyword):
    soup = BeautifulSoup(content, "html.parser")
    headings = {
        "h1": [h.get_text().strip() for h in soup.find_all("h1")],
        "h2": [h.get_text().strip() for h in soup.find_all("h2")],
        "h3": [h.get_text().strip() for h in soup.find_all("h3")],
    }
    h1_count = len(headings["h1"])
    h2_count = len(headings["h2"])
    score = 0
    recommendations = []
    if h1_count == 1:
        score += 30
        if primary_keyword and primary_keyword.lower() in headings["h1"][0].lower():
            score += 20
        elif primary_keyword:
            recommendations.append({"text": "Include primary keyword in the H1 heading", "priority": PRIORITY_HIGH})
    elif h1_count == 0:
        recommendations.append({"text": "Add one H1 heading to the page", "priority": PRIORITY_HIGH})
    else:
        recommendations.append({"text": f"Multiple H1 headings found ({h1_count}) — keep exactly one", "priority": PRIORITY_MEDIUM})
    if h2_count >= 3:
        score += 30
    elif h2_count >= 1:
        score += 15
        recommendations.append({"text": "Add more H2 subheadings for better content structure and topical depth", "priority": PRIORITY_MEDIUM})
    else:
        recommendations.append({"text": "Add H2 headings to structure your content and improve scannability", "priority": PRIORITY_HIGH})
    all_subheadings = " ".join(headings["h2"] + headings["h3"]).lower()
    if primary_keyword and primary_keyword.lower() in all_subheadings:
        score += 20
    return {"label": "Headings", "score": min(score, 100), "headings": headings, "recommendations": recommendations}


def analyze_readability(text):
    try:
        flesch_score = _flesch_reading_ease(text)
        normalized = 100 if flesch_score >= 60 else (0 if flesch_score <= 30 else ((flesch_score - 30) / 30) * 100)
        recs = []
        if flesch_score < 60:
            recs.append({"text": f"Flesch reading ease is {round(flesch_score)} — shorten sentences and use simpler words", "priority": PRIORITY_MEDIUM})
        return {
            "label": "Readability",
            "score": round(normalized, 2),
            "flesch_score": round(flesch_score, 2),
            "level": "Easy" if flesch_score >= 60 else ("Moderate" if flesch_score >= 30 else "Difficult"),
            "recommendations": recs
        }
    except Exception:
        return {"label": "Readability", "score": None, "level": "error", "recommendations": [
            {"text": "Add more content for readability analysis", "priority": PRIORITY_LOW}
        ]}


def analyze_intent_eeat(text, content_html):
    score = 0
    recommendations = []
    experience_signals = [
        "in my experience", "our tests", "we found", "i discovered", "case study",
        "experiment", "our research", "we tested", "we ran", "firsthand", "our study",
        "we measured", "our data shows", "in practice", "real-world", "we observed",
    ]
    if any(sig in text.lower() for sig in experience_signals):
        score += 40
    else:
        recommendations.append({"text": "Add first-hand experience signals (e.g., 'our tests showed X', 'in practice we found')", "priority": PRIORITY_MEDIUM})
    author_signals = [
        "about the author", "written by", "authored by", "author bio", "contributor",
        "credentials", "meet the team", "our experts", "certified", "years of experience",
    ]
    if any(sig in text.lower() for sig in author_signals):
        score += 30
    else:
        recommendations.append({"text": "Include an author bio or credentials to build E-E-A-T trust signals", "priority": PRIORITY_MEDIUM})
    soup = BeautifulSoup(content_html, "html.parser")
    has_faq = "faq" in text.lower() or any(h.get_text().strip().endswith('?') for h in soup.find_all(['h2', 'h3']))
    if has_faq:
        score += 30
    else:
        recommendations.append({"text": "Add an FAQ section or question-format headings for LLM and voice search visibility", "priority": PRIORITY_LOW})
    return {"label": "E-E-A-T Signals", "score": min(score, 100), "recommendations": recommendations}


def analyze_cta(content_html):
    soup = BeautifulSoup(content_html, "html.parser")
    buttons = soup.find_all("button")
    cta_class_links = [a for a in soup.find_all("a") if any(w in " ".join(a.get("class") or []) for w in ["cta", "btn", "button"])]
    action_verbs = {"get", "start", "try", "buy", "sign", "download", "contact", "book", "schedule",
                    "request", "apply", "subscribe", "join", "register", "claim", "order", "shop"}
    action_links = [a for a in soup.find_all("a") if (a.get_text().strip().lower().split() or [''])[0] in action_verbs]
    forms = soup.find_all("form")
    all_ctas = set(str(b) for b in buttons) | set(str(a) for a in cta_class_links) | set(str(a) for a in action_links)
    cta_count = len(all_ctas)
    score = 0
    recommendations = []
    if cta_count >= 1:
        score += 50
    else:
        recommendations.append({"text": "Add at least one clear call-to-action button or link", "priority": PRIORITY_HIGH})
    if forms:
        score += 30
    if cta_count >= 2:
        score += 20
    return {"label": "Calls to Action", "score": min(score, 100), "cta_count": cta_count, "form_count": len(forms), "recommendations": recommendations}


def analyze_schema_og(content_html):
    soup = BeautifulSoup(content_html, "html.parser")
    og_tags = soup.find_all("meta", property=re.compile("^og:", re.I))
    has_og_title = any(t.get("property", "").lower() == "og:title" for t in og_tags)
    has_og_desc = any(t.get("property", "").lower() == "og:description" for t in og_tags)
    has_og_image = any(t.get("property", "").lower() == "og:image" for t in og_tags)
    schema_scripts = soup.find_all("script", {"type": "application/ld+json"})
    score = 0
    recommendations = []
    if has_og_title and has_og_desc and has_og_image:
        score += 40
    else:
        missing = [tag for tag, present in [("og:title", has_og_title), ("og:description", has_og_desc), ("og:image", has_og_image)] if not present]
        recommendations.append({"text": f"Add missing Open Graph tags: {', '.join(missing)}", "priority": PRIORITY_MEDIUM})
    if schema_scripts:
        score += 60
    else:
        recommendations.append({"text": "Add structured data (schema.org JSON-LD) for rich results in search", "priority": PRIORITY_MEDIUM})
    return {"label": "Schema & OG Tags", "score": min(score, 100), "has_schema": bool(schema_scripts), "og_tags_count": len(og_tags), "recommendations": recommendations}


def analyze_keyword_density(text, primary_keyword):
    if not primary_keyword:
        return {"label": "Keyword Density", "score": 100, "density": None, "recommendations": []}
    words = re.findall(r'\w+', text.lower())
    total_words = len(words)
    if total_words == 0:
        return {"label": "Keyword Density", "score": 0, "density": 0, "recommendations": [{"text": "Add content to the page", "priority": PRIORITY_HIGH}]}
    kw_words = re.findall(r'\w+', primary_keyword.lower())
    kw_count = sum(1 for i in range(len(words) - len(kw_words) + 1) if words[i:i + len(kw_words)] == kw_words)
    density = round((kw_count / total_words) * 100, 2)
    if density < 0.5:
        return {"label": "Keyword Density", "score": 30, "density": density, "count": kw_count, "recommendations": [
            {"text": f"Keyword '{primary_keyword}' appears {kw_count}× ({density}%) — aim for 0.5–2%", "priority": PRIORITY_HIGH}
        ]}
    if density > 3.0:
        return {"label": "Keyword Density", "score": 40, "density": density, "count": kw_count, "recommendations": [
            {"text": f"Keyword '{primary_keyword}' at {density}% risks over-optimisation — reduce and use synonyms", "priority": PRIORITY_MEDIUM}
        ]}
    return {"label": "Keyword Density", "score": 100, "density": density, "count": kw_count, "recommendations": []}


def analyze_internal_links(content_html, base_url=""):
    soup = BeautifulSoup(content_html, "html.parser")
    parsed_base = urlparse(base_url)
    nav_links = set()
    for el in soup.find_all(['nav', 'header', 'footer']):
        for a in el.find_all("a", href=True):
            nav_links.add(a["href"])
    internal, external = set(), set()
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if href in nav_links or href.startswith("#"):
            continue
        if href.startswith("/") or (parsed_base.netloc and parsed_base.netloc in href):
            internal.add(href)
        elif href.startswith("http"):
            external.add(href)
    recommendations = []
    if len(internal) >= 3:
        score = 100
    elif len(internal) >= 1:
        score = 60
        recommendations.append({"text": f"Add more body internal links (currently {len(internal)}, aim for 3+)", "priority": PRIORITY_LOW})
    else:
        score = 0
        recommendations.append({"text": "Add internal links in the page body to improve crawlability and site depth", "priority": PRIORITY_MEDIUM})
    return {"label": "Internal Links", "score": score, "internal_count": len(internal), "external_count": len(external), "recommendations": recommendations}


# ── AI enrichment (Claude Haiku) ───────────────────────────────────────────────

def call_haiku(title, primary_keyword, plain_text, all_h2s):
    anthropic_key = os.environ.get('ANTHROPIC_KEY')
    if not anthropic_key:
        return None, "ANTHROPIC_KEY not configured"

    h2_list = "\n".join(f"  - {h}" for h in all_h2s[:10]) if all_h2s else "  (none found)"

    # Sample: first 1500 + last 500 to capture intro and conclusion
    text_sample = plain_text[:1500]
    if len(plain_text) > 2000:
        text_sample += "\n...\n" + plain_text[-500:]

    system_msg = (
        "You are a senior SEO strategist. Analyze content and respond ONLY with valid JSON — "
        "no markdown fences, no prose preamble, no explanation. If a field cannot be assessed, use null."
    )

    prompt = (
        f"Audit this landing page for SEO quality.\n\n"
        f"Scoring rubric (0–100):\n"
        f"  30 = generic/thin, no differentiation from competitors\n"
        f"  50 = adequate but not competitive for this keyword\n"
        f"  70 = good targeting, some trust signals, minor gaps\n"
        f"  85 = strong E-E-A-T, clear intent match, well-structured\n"
        f"  95 = best-in-class: unique data, compelling UX, schema, FAQ\n\n"
        f"Title: {title or '(missing)'}\n"
        f"Primary keyword: {primary_keyword or '(not provided)'}\n"
        f"H2 headings:\n{h2_list}\n"
        f"Content sample:\n{text_sample}\n\n"
        f"Return this exact JSON schema (no other text):\n"
        f'{{"score":<0-100 integer>,'
        f'"intent_feedback":"<1-2 sentences: does the page match what a {primary_keyword or "target"} searcher actually wants?>", '
        f'"eeat_feedback":"<1-2 sentences on expertise/authority/trust signals found or missing>", '
        f'"topical_gaps":["<missing subtopic 1>","<missing subtopic 2>","<missing subtopic 3>"], '
        f'"keyword_usage":"<1 sentence: how naturally and effectively is the keyword used?>", '
        f'"urgent_action_plan":["<specific improvement 1 — quote exact text or H2s from the page where relevant>","<improvement 2>","<improvement 3>"]}}'
    )

    resp = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": anthropic_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json={
            "model": "claude-haiku-4-5-20251001",
            "max_tokens": 1024,
            "system": system_msg,
            "messages": [{"role": "user", "content": prompt}],
        },
        timeout=25,
    )

    if resp.status_code != 200:
        return None, f"Anthropic API error {resp.status_code}: {resp.text[:200]}"

    raw = resp.json()['content'][0]['text'].strip()
    raw = re.sub(r'^```(?:json)?\s*', '', raw)
    raw = re.sub(r'\s*```$', '', raw)

    try:
        return json.loads(raw), None
    except json.JSONDecodeError as e:
        return None, f"JSON parse failed: {e} — raw: {raw[:200]}"


# ── HTML report generation ─────────────────────────────────────────────────────

def _score_color(score):
    if score is None:
        return "#8c8c8c"
    if score >= 80:
        return "#52c41a"
    if score >= 50:
        return "#faad14"
    return "#ff4d4f"


def _score_bar(label, score):
    pct = min(100, max(0, score)) if score is not None else 0
    display = f"{round(score)}" if score is not None else "N/A"
    color = _score_color(score)
    return (
        f'<div style="margin-bottom:10px;">'
        f'<div style="display:flex;justify-content:space-between;margin-bottom:4px;">'
        f'<span style="font-size:13px;color:#444;">{label}</span>'
        f'<span style="font-size:13px;font-weight:700;color:{color};">{display}/100</span>'
        f'</div>'
        f'<div style="background:#f0f0f0;border-radius:4px;height:8px;overflow:hidden;">'
        f'<div style="background:{color};width:{pct}%;height:100%;border-radius:4px;"></div>'
        f'</div>'
        f'</div>'
    )


def _action_plan_html(action_plan):
    grouped = {PRIORITY_HIGH: [], PRIORITY_MEDIUM: [], PRIORITY_LOW: []}
    for item in action_plan:
        grouped.get(item.get("priority", PRIORITY_LOW), grouped[PRIORITY_LOW]).append(item["text"])
    config = {
        PRIORITY_HIGH: ("High Priority", "#ff4d4f", "#fff1f0"),
        PRIORITY_MEDIUM: ("Medium Priority", "#faad14", "#fffbe6"),
        PRIORITY_LOW: ("Low Priority", "#52c41a", "#f6ffed"),
    }
    html = ""
    for priority in [PRIORITY_HIGH, PRIORITY_MEDIUM, PRIORITY_LOW]:
        items = grouped[priority]
        if not items:
            continue
        label, color, bg = config[priority]
        html += (
            f'<div style="margin-bottom:16px;">'
            f'<div style="display:inline-block;background:{bg};color:{color};border:1px solid {color};'
            f'border-radius:4px;padding:3px 10px;font-size:11px;font-weight:700;letter-spacing:0.5px;margin-bottom:8px;">'
            f'{label.upper()}</div>'
            f'<ul style="margin:0;padding-left:20px;">'
        )
        for text in items:
            html += f'<li style="font-size:13px;color:#444;margin-bottom:6px;">{text}</li>'
        html += '</ul></div>'
    return html


def _ai_insights_html(ai_feedback):
    cards = [
        ("fa-bullseye", "Search Intent", ai_feedback.get("intent_feedback")),
        ("fa-shield-alt", "E-E-A-T Assessment", ai_feedback.get("eeat_feedback")),
        ("fa-key", "Keyword Usage", ai_feedback.get("keyword_usage")),
    ]
    topical_gaps = ai_feedback.get("topical_gaps") or []

    html = (
        '<div style="margin-top:20px;background:#fafaff;border:1px solid #e0e0ff;border-radius:10px;padding:18px;">'
        '<div style="font-weight:700;font-size:14px;color:#4b0082;margin-bottom:14px;display:flex;align-items:center;gap:8px;">'
        '<i class="fas fa-robot"></i> AI Strategic Analysis <span style="background:#e8e0ff;color:#7c3aed;'
        'padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;margin-left:4px;">Claude Haiku</span></div>'
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:14px;">'
    )
    for icon, label, content in cards:
        if not content:
            continue
        html += (
            f'<div style="background:#fff;border:1px solid #ddd8ff;border-radius:8px;padding:12px;">'
            f'<div style="font-size:11px;font-weight:700;color:#7c3aed;margin-bottom:6px;display:flex;align-items:center;gap:5px;">'
            f'<i class="fas {icon}"></i> {label}</div>'
            f'<p style="font-size:13px;color:#444;margin:0;line-height:1.5;">{content}</p>'
            f'</div>'
        )
    html += '</div>'
    if topical_gaps and isinstance(topical_gaps, list):
        html += (
            '<div style="background:#fff7e6;border:1px solid #ffd591;border-radius:8px;padding:12px;">'
            '<div style="font-size:11px;font-weight:700;color:#d46b08;margin-bottom:8px;display:flex;align-items:center;gap:5px;">'
            '<i class="fas fa-exclamation-triangle"></i> Topical Gaps to Fill</div>'
            '<div style="display:flex;flex-wrap:wrap;gap:6px;">'
        )
        for gap in topical_gaps:
            if gap:
                html += f'<span style="background:#fff;border:1px solid #ffa940;border-radius:12px;padding:3px 10px;font-size:12px;color:#873800;">{gap}</span>'
        html += '</div></div>'
    html += '</div>'
    return html


def generate_html_report(url, keyword, result, ai_feedback=None, ai_error=None):
    overall = round(result["overall_score"])
    color = _score_color(overall)
    wc = result.get("word_count", 0)
    wc_color = "#52c41a" if wc >= 500 else ("#faad14" if wc >= 200 else "#ff4d4f")
    wc_note = "Good length" if wc >= 500 else ("Moderate — 500+ recommended" if wc >= 200 else "Too short — add more content")

    dims = [
        result.get("https_check"),
        result.get("canonical_analysis"),
        result.get("title_analysis"),
        result.get("meta_description_analysis"),
        result.get("heading_analysis"),
        result.get("cta_analysis"),
        result.get("images_analysis"),
        result.get("schema_og_analysis"),
        result.get("keyword_density_analysis"),
        result.get("readability_analysis"),
        result.get("intent_eeat_analysis"),
        result.get("internal_links_analysis"),
    ]
    bars_html = "".join(_score_bar(d["label"], d.get("score")) for d in dims if d)

    keyword_chip = (
        f'<span style="background:rgba(255,255,255,0.15);padding:2px 10px;border-radius:10px;font-size:11px;">Keyword: {keyword}</span>'
        if keyword else ""
    )

    ai_block = ""
    if ai_feedback:
        ai_block = _ai_insights_html(ai_feedback)
    if ai_error:
        ai_block += (
            f'<div style="background:#fff3f3;border:1px solid #ff4d4f;border-radius:8px;padding:12px;margin-top:12px;font-size:13px;color:#c0392b;">'
            f'<i class="fas fa-exclamation-circle"></i> AI analysis unavailable: {ai_error}</div>'
        )

    action_count = len(result["action_plan"])

    return f"""<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:100%;">
  <div style="background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);border-radius:12px;padding:20px 24px;margin-bottom:16px;color:white;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
    <div style="flex:1;min-width:0;">
      <div style="font-size:11px;opacity:0.55;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px;">Landing Page Audit</div>
      <div style="font-size:13px;opacity:0.85;word-break:break-all;">{url}</div>
      {f'<div style="margin-top:6px;">{keyword_chip}</div>' if keyword else ''}
    </div>
    <div style="text-align:center;flex-shrink:0;">
      <div style="font-size:46px;font-weight:800;color:{color};line-height:1;">{overall}</div>
      <div style="font-size:11px;opacity:0.55;">/ 100</div>
    </div>
  </div>

  <div style="background:#f8f9fa;border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:13px;color:#555;display:flex;align-items:center;gap:8px;">
    <i class="fas fa-align-left" style="color:{wc_color};"></i>
    Word count: <strong style="color:{wc_color};">{wc:,}</strong> — <span style="color:{wc_color};">{wc_note}</span>
  </div>

  <div style="background:#fff;border:1px solid #eee;border-radius:10px;padding:18px;margin-bottom:14px;">
    <div style="font-weight:700;font-size:14px;color:#1a1a2e;margin-bottom:14px;display:flex;align-items:center;gap:8px;">
      <i class="fas fa-chart-bar" style="color:#1a73e8;"></i> Score Breakdown
    </div>
    {bars_html}
  </div>

  {ai_block}

  <div style="background:#fff;border:1px solid #eee;border-radius:10px;padding:18px;margin-top:14px;">
    <div style="font-weight:700;font-size:14px;color:#1a1a2e;margin-bottom:12px;display:flex;align-items:center;gap:8px;">
      <i class="fas fa-tasks" style="color:#34a853;"></i> Action Plan
      <span style="background:#eee;border-radius:10px;padding:2px 8px;font-size:11px;font-weight:600;color:#555;">{action_count} item{"s" if action_count != 1 else ""}</span>
    </div>
    {_action_plan_html(result["action_plan"])}
  </div>
</div>"""


# ── Lambda handler ─────────────────────────────────────────────────────────────

def lambda_handler(event, context):
    try:
        url = (event.get('url') or '').strip()
        primary_keyword = (event.get('keyword') or event.get('primary_keyword') or '').strip()
        secondary_keywords = (event.get('secondary_keywords') or '').strip()
        use_ai = bool(event.get('use_ai', False))

        if not url:
            return {'statusCode': 400, 'headers': {'Access-Control-Allow-Origin': '*'}, 'body': json.dumps({'error': 'URL is required'})}

        try:
            content, title = fetch_page(url)
        except Exception as e:
            error_html = (
                f'<div style="padding:16px;background:#fff3f3;border:1px solid #ff4d4f;border-radius:8px;color:#c0392b;">'
                f'<i class="fas fa-exclamation-circle"></i> <strong>Failed to fetch page:</strong> {str(e)}'
                f'<br><small>Confirm the URL is publicly accessible and try again.</small></div>'
            )
            return {'statusCode': 200, 'headers': {'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json'},
                    'body': json.dumps({'body': error_html, 'quality_score': 0})}

        plain_text = strip_html(content)
        word_count = count_words(plain_text)

        https_res = check_https(url)
        canonical_res = analyze_canonical(content, url)
        images_res = analyze_images(content)
        title_res = analyze_title(title, primary_keyword)
        meta_res = analyze_meta_description(content, primary_keyword)
        heading_res = analyze_headings(content, primary_keyword)
        readability_res = analyze_readability(plain_text)
        intent_eeat_res = analyze_intent_eeat(plain_text, content)
        cta_res = analyze_cta(content)
        schema_og_res = analyze_schema_og(content)
        kw_density_res = analyze_keyword_density(plain_text, primary_keyword)
        internal_links_res = analyze_internal_links(content, url)

        readability_score = readability_res['score'] if readability_res['score'] is not None else 50

        overall_score = (
            (https_res['score'] * 0.10) +
            (canonical_res['score'] * 0.08) +
            (images_res['score'] * 0.07) +
            (title_res['score'] * 0.12) +
            (meta_res['score'] * 0.04) +
            (heading_res['score'] * 0.10) +
            (readability_score * 0.10) +
            (intent_eeat_res['score'] * 0.15) +
            (cta_res['score'] * 0.12) +
            (schema_og_res['score'] * 0.07) +
            (kw_density_res['score'] * 0.05)
        )

        all_recs = []
        for res in [https_res, canonical_res, images_res, title_res, meta_res, heading_res,
                    readability_res, intent_eeat_res, cta_res, schema_og_res, kw_density_res, internal_links_res]:
            all_recs.extend(res.get('recommendations', []))

        all_recs.sort(key=_priority_order)
        seen_keys = set()
        action_plan = []
        for r in all_recs:
            key = _norm_key(r['text'])
            if key not in seen_keys:
                seen_keys.add(key)
                action_plan.append(r)

        result = {
            "overall_score": round(overall_score, 2),
            "word_count": word_count,
            "https_check": https_res,
            "canonical_analysis": canonical_res,
            "images_analysis": images_res,
            "title_analysis": title_res,
            "meta_description_analysis": meta_res,
            "heading_analysis": heading_res,
            "readability_analysis": readability_res,
            "intent_eeat_analysis": intent_eeat_res,
            "cta_analysis": cta_res,
            "schema_og_analysis": schema_og_res,
            "keyword_density_analysis": kw_density_res,
            "internal_links_analysis": internal_links_res,
            "action_plan": action_plan,
            "is_ai": False,
        }

        ai_feedback = None
        ai_error = None
        if use_ai:
            soup = BeautifulSoup(content, "html.parser")
            all_h2s = [h.get_text().strip() for h in soup.find_all("h2")]
            ai_feedback, ai_error = call_haiku(title, primary_keyword, plain_text, all_h2s)

            if ai_feedback:
                ai_score_raw = ai_feedback.get('score', overall_score)
                try:
                    ai_score = float(re.sub(r'[^0-9.]', '', str(ai_score_raw))) if isinstance(ai_score_raw, str) else float(ai_score_raw)
                    if ai_score <= 10:
                        ai_score *= 10
                except Exception:
                    ai_score = overall_score

                result["overall_score"] = round((overall_score * 0.4) + (ai_score * 0.6), 2)

                ai_plan = ai_feedback.get("urgent_action_plan") or []
                if isinstance(ai_plan, list):
                    ai_recs = [{"text": item, "priority": PRIORITY_HIGH} for item in ai_plan if isinstance(item, str) and item]
                    existing_keys = {_norm_key(r['text']) for r in result["action_plan"]}
                    new_ai_recs = [r for r in ai_recs if _norm_key(r['text']) not in existing_keys]
                    result["action_plan"] = new_ai_recs + result["action_plan"]

                result["ai_feedback"] = ai_feedback
                result["is_ai"] = True

        html_body = generate_html_report(url, primary_keyword, result, ai_feedback=ai_feedback, ai_error=ai_error)
        quality_score = min(100, max(0, round(result["overall_score"])))

        return {
            'body': html_body,
            'quality_score': quality_score,
        }

    except Exception as e:
        return {'body': f'<p style="color:red;">Error: {str(e)}</p>', 'quality_score': 0}
