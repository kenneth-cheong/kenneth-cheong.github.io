import json
import os
import re

import requests


def _extract_topics(response_data):
    """Robustly pull the JSON topic array out of a Claude Messages API response.

    With the web_search tool, Claude emits a *preamble* text block ("I'll search
    for...") BEFORE the tool-use / tool-result blocks, and the actual JSON array
    arrives in a LATER text block. So we must look at the final text block that
    contains an array, not the first text block. We also salvage truncated output
    (max_tokens cut-off) by scraping the quoted strings.
    """
    text_blocks = [
        b.get('text', '')
        for b in response_data.get('content', [])
        if b.get('type') == 'text'
    ]

    # Prefer the last text block that actually contains an array opener; that is
    # the model's final answer. Fall back to all text joined, then last block.
    content = ''
    for t in reversed(text_blocks):
        if '[' in t:
            content = t
            break
    if not content:
        content = '\n'.join(text_blocks)

    content = content.strip()

    # Strip markdown code fences if present.
    if '```json' in content:
        content = content.split('```json')[1].split('```')[0].strip()
    elif '```' in content:
        content = content.split('```')[1].split('```')[0].strip()

    # Narrow to the JSON array region.
    start_idx = content.find('[')
    end_idx = content.rfind(']')
    if start_idx != -1 and end_idx != -1 and end_idx > start_idx:
        candidate = content[start_idx:end_idx + 1]
    else:
        candidate = content[start_idx:] if start_idx != -1 else content

    # First try a clean parse.
    try:
        parsed = json.loads(candidate)
        if isinstance(parsed, list):
            topics = [str(t).strip() for t in parsed if str(t).strip()]
            if topics:
                return topics
    except (ValueError, TypeError):
        pass

    # Salvage path: output was truncated (no closing ]) or otherwise malformed.
    # Scrape complete quoted strings; a trailing partial (no closing quote) is
    # naturally dropped, so we keep every topic that fully arrived.
    salvaged = re.findall(r'"((?:[^"\\]|\\.)*)"', candidate)
    topics = [s.strip() for s in salvaged if s.strip()]
    return topics


_STOPWORDS = {
    'a', 'an', 'the', 'of', 'for', 'to', 'in', 'on', 'at', 'by', 'with', 'and',
    'or', 'is', 'are', 'it', 'its', 'what', 'how', 'why', 'when', 'your', 'you',
    'this', 'that', 'from', 'as', 'be', 'guide',
}


def _norm(s):
    """Loose key for matching a model-returned topic back to a catalogue entry."""
    return re.sub(r'[^a-z0-9]+', ' ', str(s).lower()).strip()


def _stem(w):
    """Crude suffix strip so choose/choosing and cost/costs collapse together."""
    for suf in ('ing', 'ed', 'es', 's'):
        if len(w) > 4 and w.endswith(suf):
            return w[: -len(suf)]
    return w


def _tokens(s):
    return {_stem(w) for w in _norm(s).split() if w and w not in _STOPWORDS}


def _similarity(a, b):
    """Jaccard overlap of significant word stems — order-insensitive."""
    ta, tb = _tokens(a), _tokens(b)
    if not ta or not tb:
        return 0.0
    inter = len(ta & tb)
    return inter / float(len(ta | tb))


def _snap_to_catalog(selected, all_topics):
    """Map each selected topic back onto the EXACT catalogue string.

    The frontend highlights competitor rows by matching these strings against the
    row text, so anything the model rephrased would silently never match and the
    user would see only a handful of topics selected. We snap back to the original
    wording here (exact → normalised → containment) and drop only what we truly
    cannot place. Order is preserved and duplicates removed.
    """
    catalog = []
    for t in all_topics:
        name = t.get('topic') if isinstance(t, dict) else t
        if name and str(name).strip():
            catalog.append(str(name).strip())

    by_exact = {c: c for c in catalog}
    by_norm = {}
    for c in catalog:
        by_norm.setdefault(_norm(c), c)

    out, seen, unmatched = [], set(), []
    for pick in selected:
        pick = str(pick).strip()
        if not pick:
            continue
        hit = by_exact.get(pick) or by_norm.get(_norm(pick))
        if not hit:
            # The model reworded or reordered the original ("Choosing a storage
            # facility" for "How to Choose a Storage Facility"). Score every entry
            # on stemmed word overlap and take the best, if it clears the bar.
            best, best_score = None, 0.0
            for c in catalog:
                score = _similarity(pick, c)
                if score > best_score:
                    best, best_score = c, score
            if best_score >= 0.6:
                hit = best
        if hit:
            if hit not in seen:
                seen.add(hit)
                out.append(hit)
        else:
            unmatched.append(pick)

    if unmatched:
        print("Topics returned that matched no catalogue entry (dropped):", unmatched)
    return out


def lambda_handler(event, context):
    primary_keyword = event.get('primary_keyword', '')
    secondary_keywords = event.get('secondary_keywords', [])
    all_topics = event.get('all_topics', [])
    location = event.get('location', 'Singapore')

    api_key = os.environ.get('CLAUDE_API_KEY')

    cors_headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'OPTIONS,POST'
    }

    if not api_key:
        return {'statusCode': 500, 'headers': cors_headers, 'body': {'error': 'CLAUDE_API_KEY not found', 'selected_topics': []}}

    prompt = f"""You are an SEO expert. I have a list of content topics extracted from the top SERP competitors for the primary keyword: "{primary_keyword}" in {location}.
Secondary keywords (lower priority): {", ".join(secondary_keywords)}

Here are the topics found across competitors, with their frequency of occurrence:
{json.dumps(all_topics)}

Your task:
1. Perform a HOLISTIC analysis of the ENTIRE list. Scan all of it — do not just pick from the top.
2. Select topics in this order of priority:
   a. HIGH-FREQUENCY topics first. Frequency means many competitors ranking in the top SERP cover it, so it is table stakes — if the article omits it, it will not compete. Work down the frequency order and include the high-frequency topics unless one is truly irrelevant to the keyword.
   b. IMPORTANT / DEFINITION-TYPE topics next. Foundational entries — "definition", "what is", "overview", "introduction", "importance", "benefits", "types", "strategies" — are what readers and search engines expect an authoritative article to answer. Include them; do NOT treat them as filler and do NOT cap them.
   c. Then round the article out with specific, differentiating angles the competitor data supports: techniques & tactics, tools/platforms, best practices, step-by-step how-tos, examples & case studies, comparisons, metrics & measurement, common mistakes, and niche sub-topics.
3. BALANCED SELECTION: the result must not be all foundational or all niche. Cover the full arc — foundational context first, then depth — so the article reads as complete.
4. TOPICAL CONGRUENCY: every selected topic must be genuinely related to "{primary_keyword}" and to the other selections, so the set hangs together as ONE coherent article. Drop topics that are off-theme for this keyword even if they are frequent.
5. Select 15-25 topics. Selecting fewer than 15 is a failure unless the input list genuinely has fewer usable entries. Do not be conservative — under-selecting leaves the article thin and uncompetitive.
6. CRITICAL — COPY EACH TOPIC STRING VERBATIM, character for character, exactly as it appears in the "topic" field of the list above. Do NOT rephrase, retitle, merge, consolidate, shorten, expand, correct, or re-case them. The selected strings are matched back against the original list by exact text; any edit makes the topic fail to match and it will be silently dropped. If two entries are near-duplicates, pick the ONE you prefer and copy that one verbatim — never invent a combined wording.
7. Use the web_search tool at most once or twice to sanity-check current SEO trends for this keyword. Keep research brief — your budget is best spent on the selection itself.
8. After any research, your FINAL message must be ONLY a JSON array of the selected topic strings, with no surrounding prose, explanation, or markdown fences.

Format: ["<verbatim topic from the list>", "<verbatim topic from the list>", ...]"""

    try:
        response = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "anthropic-beta": "web-search-2025-03-05",
                "content-type": "application/json"
            },
            json={
                "model": "claude-haiku-4-5-20251001",
                # 2048 truncated the JSON array once web_search commentary had eaten
                # into the budget, so only a few topics survived the salvage path.
                "max_tokens": 8192,
                "tools": [{"type": "web_search_20250305", "name": "web_search", "max_uses": 2}],
                "messages": [{"role": "user", "content": prompt}]
            },
            timeout=120
        )
        response.raise_for_status()
        response_data = response.json()
        print("Stop reason:", response_data.get('stop_reason'))

        raw_topics = _extract_topics(response_data)
        selected_topics = _snap_to_catalog(raw_topics, all_topics)
        print("Selected topics: %d raw -> %d matched (of %d available)"
              % (len(raw_topics), len(selected_topics), len(all_topics)))
        print(selected_topics)

        return {
            'statusCode': 200,
            'headers': cors_headers,
            'body': {'selected_topics': selected_topics}
        }
    except Exception as e:
        print(f"Error: {str(e)}")
        return {
            'statusCode': 500,
            'headers': cors_headers,
            'body': {'error': str(e), 'selected_topics': []}
        }
