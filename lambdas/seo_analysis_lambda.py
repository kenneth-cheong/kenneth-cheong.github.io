import json
import re
import os
import requests
from bs4 import BeautifulSoup

try:
    import textstat
except ImportError:
    textstat = None

PRIORITY_HIGH = "high"
PRIORITY_MEDIUM = "medium"
PRIORITY_LOW = "low"


def strip_html(content):
    soup = BeautifulSoup(content, "html.parser")
    return soup.get_text()


def count_words(text):
    return len(re.findall(r'\w+', text))


def extract_headings(content):
    soup = BeautifulSoup(content, "html.parser")
    return {
        "h1": [h.get_text().strip() for h in soup.find_all("h1")],
        "h2": [h.get_text().strip() for h in soup.find_all("h2")],
        "h3": [h.get_text().strip() for h in soup.find_all("h3")],
    }


def analyze_title(title, primary_keyword):
    length = len(title)
    score = 0
    recommendations = []

    if 50 <= length <= 60:
        score += 40
    elif 40 <= length <= 70:
        score += 20
    else:
        recommendations.append({"text": "Title length is suboptimal (aim for 50-60 chars)", "priority": PRIORITY_HIGH})

    if primary_keyword and primary_keyword.lower() in title.lower():
        score += 60
        if title.lower().startswith(primary_keyword.lower()):
            score += 10
    elif primary_keyword:
        recommendations.append({"text": f"Primary keyword '{primary_keyword}' missing from title", "priority": PRIORITY_HIGH})

    return {"score": min(score, 100), "length": length, "recommendations": recommendations}


def analyze_meta_description(content_html):
    soup = BeautifulSoup(content_html, "html.parser")
    meta = soup.find("meta", {"name": re.compile("description", re.I)})
    recommendations = []

    if meta:
        content = meta.get("content", "")
        length = len(content)
        if 120 <= length <= 160:
            score = 100
        elif 80 <= length <= 200:
            score = 60
            recommendations.append({"text": f"Meta description is {length} chars — aim for 120-160", "priority": PRIORITY_MEDIUM})
        else:
            score = 20
            recommendations.append({"text": f"Meta description is too {'short' if length < 80 else 'long'} ({length} chars, aim for 120-160)", "priority": PRIORITY_HIGH})
        return {"score": score, "content": content, "length": length, "recommendations": recommendations}
    else:
        return {"score": 0, "content": "", "length": 0, "recommendations": [{"text": "Add a meta description — it's missing", "priority": PRIORITY_HIGH}]}


def analyze_headings(content, primary_keyword):
    headings = extract_headings(content)
    h1_count = len(headings["h1"])
    h2_count = len(headings["h2"])
    score = 0
    recommendations = []

    if h1_count == 1:
        score += 30
        if primary_keyword and primary_keyword.lower() in headings["h1"][0].lower():
            score += 20
        elif primary_keyword:
            recommendations.append({"text": "Include primary keyword in H1 heading", "priority": PRIORITY_HIGH})
    elif h1_count == 0:
        recommendations.append({"text": "Add one H1 heading", "priority": PRIORITY_HIGH})
    else:
        recommendations.append({"text": "Use only one H1 heading", "priority": PRIORITY_MEDIUM})

    if h2_count >= 3:
        score += 30
    elif h2_count >= 1:
        score += 15
        recommendations.append({"text": "Add more H2 headings for better content structure", "priority": PRIORITY_MEDIUM})
    else:
        recommendations.append({"text": "Add H2 headings to structure your content", "priority": PRIORITY_HIGH})

    all_subheadings = " ".join(headings["h2"] + headings["h3"]).lower()
    if primary_keyword and primary_keyword.lower() in all_subheadings:
        score += 20

    return {"score": min(score, 100), "headings": headings, "recommendations": recommendations}


def analyze_readability(text):
    if not textstat:
        return {"score": None, "level": "unavailable", "recommendations": []}

    try:
        flesch_score = textstat.flesch_reading_ease(text)
        normalized = 100 if flesch_score >= 60 else (0 if flesch_score <= 30 else ((flesch_score - 30) / 30) * 100)
        recs = []
        if flesch_score < 60:
            recs.append({"text": "Simplify sentences for better engagement", "priority": PRIORITY_MEDIUM})
        return {
            "score": round(normalized, 2),
            "level": "Easy" if flesch_score >= 60 else ("Moderate" if flesch_score >= 30 else "Difficult"),
            "recommendations": recs
        }
    except Exception:
        return {"score": None, "level": "error", "recommendations": [{"text": "Add more content for readability analysis", "priority": PRIORITY_LOW}]}


def analyze_intent_eeat(text, content_html):
    score = 0
    recommendations = []

    experience_signals = ["in my experience", "our tests", "we found", "i discovered", "case study", "experiment"]
    if any(sig in text.lower() for sig in experience_signals):
        score += 40
    else:
        recommendations.append({"text": "Add evidence of first-hand experience (e.g., 'our tests showed')", "priority": PRIORITY_MEDIUM})

    author_signals = ["about the author", "written by", "authored by", "author bio", "contributor", "credentials", "meet the team"]
    if any(sig in text.lower() for sig in author_signals):
        score += 30
    else:
        recommendations.append({"text": "Include an author bio or credentials to build trust", "priority": PRIORITY_MEDIUM})

    soup = BeautifulSoup(content_html, "html.parser")
    has_faq = "faq" in text.lower() or any(h.get_text().strip().endswith('?') for h in soup.find_all(['h2', 'h3']))
    if has_faq:
        score += 30
    else:
        recommendations.append({"text": "Add an FAQ section or question-based headings for LLM visibility", "priority": PRIORITY_LOW})

    return {"score": min(score, 100), "recommendations": recommendations}


def analyze_cta(content_html):
    soup = BeautifulSoup(content_html, "html.parser")
    buttons = soup.find_all("button")
    cta_links = [a for a in soup.find_all("a") if any(w in " ".join(a.get("class") or []) for w in ["cta", "btn", "button"])]
    forms = soup.find_all("form")
    cta_count = len(buttons) + len(cta_links)
    score = 0
    recommendations = []

    if cta_count >= 1:
        score += 50
    else:
        recommendations.append({"text": "Add at least one clear call-to-action button", "priority": PRIORITY_HIGH})

    if forms:
        score += 30

    if cta_count >= 2:
        score += 20

    return {
        "score": min(score, 100),
        "cta_count": cta_count,
        "form_count": len(forms),
        "recommendations": recommendations
    }


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
        recommendations.append({"text": "Add structured data (schema.org JSON-LD) for rich search results", "priority": PRIORITY_MEDIUM})

    return {"score": min(score, 100), "has_schema": bool(schema_scripts), "og_tags_count": len(og_tags), "recommendations": recommendations}


def analyze_keyword_density(text, primary_keyword):
    if not primary_keyword:
        return {"score": 100, "density": None, "recommendations": []}

    words = re.findall(r'\w+', text.lower())
    total_words = len(words)
    if total_words == 0:
        return {"score": 0, "density": 0, "recommendations": [{"text": "Add more content", "priority": PRIORITY_HIGH}]}

    kw_words = re.findall(r'\w+', primary_keyword.lower())
    kw_count = sum(1 for i in range(len(words) - len(kw_words) + 1) if words[i:i + len(kw_words)] == kw_words)
    density = round((kw_count / total_words) * 100, 2)

    if density < 0.5:
        return {"score": 30, "density": density, "count": kw_count, "recommendations": [{"text": f"Increase keyword usage for '{primary_keyword}' (currently {density}%, aim for 0.5–2%)", "priority": PRIORITY_HIGH}]}
    elif density > 3.0:
        return {"score": 40, "density": density, "count": kw_count, "recommendations": [{"text": f"Reduce keyword repetition for '{primary_keyword}' (currently {density}%, may trigger over-optimisation)", "priority": PRIORITY_MEDIUM}]}
    else:
        return {"score": 100, "density": density, "count": kw_count, "recommendations": []}


def analyze_internal_links(content_html, base_url=""):
    soup = BeautifulSoup(content_html, "html.parser")
    internal, external = [], []
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if href.startswith("#") or href.startswith("/") or (base_url and base_url in href):
            internal.append(href)
        elif href.startswith("http"):
            external.append(href)

    recommendations = []
    if len(internal) >= 3:
        score = 100
    elif len(internal) >= 1:
        score = 60
        recommendations.append({"text": f"Add more internal links (currently {len(internal)}, aim for 3+)", "priority": PRIORITY_LOW})
    else:
        score = 0
        recommendations.append({"text": "Add internal links to improve site depth and crawlability", "priority": PRIORITY_MEDIUM})

    return {
        "score": score,
        "internal_count": len(internal),
        "external_count": len(external),
        "recommendations": recommendations
    }


def _priority_order(r):
    return {PRIORITY_HIGH: 0, PRIORITY_MEDIUM: 1, PRIORITY_LOW: 2}.get(r.get("priority", PRIORITY_LOW), 2)


def lambda_handler(event, context):
    try:
        content = event.get('content', '')
        title = event.get('title', '')
        use_ai = event.get('use_ai', False)
        primary_keyword = event.get('primary_keyword', '') or ''
        secondary_keywords = event.get('secondary_keywords', '') or ''
        base_url = event.get('url', '')

        plain_text = strip_html(content)
        word_count = count_words(plain_text)

        title_res = analyze_title(title, primary_keyword)
        meta_res = analyze_meta_description(content)
        heading_res = analyze_headings(content, primary_keyword)
        readability_res = analyze_readability(plain_text)
        intent_eeat_res = analyze_intent_eeat(plain_text, content)
        cta_res = analyze_cta(content)
        schema_og_res = analyze_schema_og(content)
        kw_density_res = analyze_keyword_density(plain_text, primary_keyword)
        internal_links_res = analyze_internal_links(content, base_url)

        readability_score = readability_res['score'] if readability_res['score'] is not None else 50

        overall_score = (
            (intent_eeat_res['score'] * 0.20) +
            (readability_score * 0.15) +
            (title_res['score'] * 0.15) +
            (heading_res['score'] * 0.15) +
            (cta_res['score'] * 0.15) +
            (schema_og_res['score'] * 0.10) +
            (kw_density_res['score'] * 0.05) +
            (meta_res['score'] * 0.05)
        )

        all_recs = []
        for res in [title_res, meta_res, heading_res, readability_res, intent_eeat_res, cta_res, schema_og_res, kw_density_res, internal_links_res]:
            all_recs.extend(res.get('recommendations', []))

        all_recs.sort(key=_priority_order)
        seen = set()
        action_plan = []
        for r in all_recs:
            if r['text'] not in seen:
                seen.add(r['text'])
                action_plan.append(r)

        result = {
            "overall_score": round(overall_score, 2),
            "word_count": word_count,
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
            "is_ai": False
        }

        if use_ai and os.environ.get('ANTHROPIC_KEY'):
            try:
                keyword_context = f"Primary Keyword: {primary_keyword}. Secondary Keywords: {secondary_keywords}."
                system_msg = "You are a world-class SEO strategist trained on Digimetrics SEO standards. Evaluate content for deep alignment, trust signals, and user value, not just keyword density. Provide clear, actionable steps to reach 100% SEO score. Always respond with valid JSON only."
                prompt = (
                    f"Perform a senior-level SEO analysis based on these specific factors:\n"
                    f"1. Search Intent Match (90% weight): Does this accurately serve a {primary_keyword} searcher?\n"
                    f"2. E-E-A-T (90% weight): Does it show first-hand experience, unique data, or expert credentials?\n"
                    f"3. Topical Coverage (90% weight): Are core subtopics and related terms naturally covered?\n"
                    f"4. Originality (90% weight): Is this better than competitors or just rephrased?\n\n"
                    f"Details:\n"
                    f"Title: {title}\n"
                    f"Keywords: {keyword_context}\n"
                    f"Content Snippet: {plain_text[:3000]}\n\n"
                    f"Output a JSON object with 'score', 'intent_feedback', 'eeat_feedback', 'topical_gaps', 'keyword_usage', and 'urgent_action_plan' (a list of 2-5 specific improvements to reach score 100). "
                    f"Do NOT recommend specific Python libraries or technical implementation details — only content and SEO strategy."
                )
                response = requests.post(
                    "https://api.anthropic.com/v1/messages",
                    headers={
                        "x-api-key": os.environ['ANTHROPIC_KEY'],
                        "anthropic-version": "2023-06-01",
                        "content-type": "application/json"
                    },
                    json={
                        "model": "claude-haiku-4-5-20251001",
                        "max_tokens": 1024,
                        "system": system_msg,
                        "messages": [{"role": "user", "content": prompt}]
                    },
                    timeout=25
                )

                if response.status_code != 200:
                    raise Exception(f"Anthropic API Error: {response.status_code} - {response.text}")

                ai_feedback = json.loads(response.json()['content'][0]['text'])

                ai_score_raw = ai_feedback.get('score', overall_score)
                try:
                    ai_score = float(re.sub(r'[^0-9.]', '', str(ai_score_raw))) if isinstance(ai_score_raw, str) else float(ai_score_raw)
                except Exception:
                    ai_score = overall_score

                result["overall_score"] = round((overall_score * 0.4) + (ai_score * 0.6), 2)

                ai_plan = ai_feedback.get("urgent_action_plan", [])
                if isinstance(ai_plan, list):
                    ai_recs = [{"text": item, "priority": PRIORITY_HIGH} for item in ai_plan]
                    existing_texts = {r['text'] for r in result["action_plan"]}
                    result["action_plan"] = ai_recs + [r for r in result["action_plan"] if r['text'] not in {x['text'] for x in ai_recs}]

                result["ai_feedback"] = ai_feedback
                result["is_ai"] = True
            except Exception as e:
                result["ai_error"] = str(e)

        return {
            'statusCode': 200,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            'body': json.dumps(result)
        }
    except Exception as e:
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)})
        }
