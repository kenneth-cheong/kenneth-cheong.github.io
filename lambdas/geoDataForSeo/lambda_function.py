"""
geoDataForSeo — DataForSEO-backed AI-search visibility engine for the GEO Analytics Dashboard.

Drop-in alternative to the Bright Data `aiMentions` endpoint: it accepts the SAME
`verify_mentions` request shape and returns the SAME `{ verification: [ { status, analysis } ] }`
response shape, so the frontend only has to swap the endpoint URL.

Pipeline per (prompt, engine):
  1. Ask the engine via DataForSEO's AI Optimization API (ChatGPT / Gemini / Perplexity / Claude
     LLM responses) or the SERP API (Google AI Overview / AI Mode) for a real answer + citations.
  2. Citations come straight from DataForSEO annotations (authoritative, no hallucination).
  3. A small Claude model extracts is_mentioned / sentiment / visibility_score / rank / snippet.

Pure stdlib (urllib) so it deploys as a single-file zip with no layer.
Env: DATAFORSEO_AUTH (full "Basic <b64>" header), ANTHROPIC_API_KEY.
"""

import base64
import json
import os
import re
import urllib.error
import urllib.request

DFS_AUTH = os.environ.get("DATAFORSEO_AUTH", "")  # already includes the "Basic " prefix
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
EXTRACT_MODEL = os.environ.get("EXTRACT_MODEL", "claude-haiku-4-5")

DFS_BASE = "https://api.dataforseo.com/v3"
HTTP_TIMEOUT = int(os.environ.get("HTTP_TIMEOUT", "55"))

CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
}

# Map incoming model/engine ids (incl. the Bright-Data ids the frontend already uses)
# to a DataForSEO engine + a default model name. DataForSEO auto-resolves basic names.
LLM_ENGINES = {
    "chatgpt":          ("chat_gpt",   "gpt-4o-mini"),
    "gpt-4o-mini":      ("chat_gpt",   "gpt-4o-mini"),
    "gpt-4o":           ("chat_gpt",   "gpt-4o"),
    "gemini":           ("gemini",     "gemini-2.5-flash"),
    "gemini-2.5-flash": ("gemini",     "gemini-2.5-flash"),
    "perplexity":       ("perplexity", "sonar"),
    "claude":           ("claude",     "claude-3-5-haiku"),
    "claude-haiku-4-5": ("claude",     "claude-3-5-haiku"),
}
SERP_ENGINES = {"google-ai-overview", "google-ai-mode"}

# Minimal country mapping for web-search localisation.
LOCATION_ISO = {
    "singapore": "SG", "united states": "US", "usa": "US", "us": "US",
    "united kingdom": "GB", "uk": "GB", "australia": "AU", "malaysia": "MY",
    "india": "IN", "canada": "CA",
}
LOCATION_NAME = {
    "sg": "Singapore", "us": "United States", "gb": "United Kingdom",
    "au": "Australia", "my": "Malaysia", "in": "India", "ca": "Canada",
}


def _resp(status, body):
    return {"statusCode": status, "headers": {"Content-Type": "application/json", **CORS},
            "body": json.dumps(body)}


def _http_json(url, payload=None, headers=None, method="POST"):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, {"error": f"HTTP {e.code}"}
    except Exception as e:
        return 0, {"error": str(e)}


def domain_of(u):
    if not u:
        return ""
    u = re.sub(r"^https?://", "", str(u)).split("/")[0]
    return re.sub(r"^www\.", "", u).lower()


# ---------------------------------------------------------------------------
# DataForSEO callers
# ---------------------------------------------------------------------------
def _dfs(path, task):
    return _http_json(f"{DFS_BASE}{path}", [task],
                      headers={"Authorization": DFS_AUTH, "Content-Type": "application/json"})


def call_llm_engine(engine_path, model_name, prompt, iso):
    """Returns (answer_text, citations[list of {url,title}], meta) or raises RuntimeError."""
    task = {"user_prompt": prompt[:500], "model_name": model_name,
            "web_search": True, "max_output_tokens": 1024}
    # web_search_country_iso_code is only accepted by some engines (e.g. chat_gpt).
    if iso and engine_path == "chat_gpt":
        task["web_search_country_iso_code"] = iso

    path = f"/ai_optimization/{engine_path}/llm_responses/live"
    t0 = None
    for _ in range(4):  # tolerate per-engine "Invalid Field" rejections by stripping them
        status, body = _dfs(path, task)
        if status != 200 or not isinstance(body, dict):
            raise RuntimeError(f"DataForSEO {status}: {str(body)[:160]}")
        tasks = body.get("tasks") or []
        if not tasks:
            raise RuntimeError("DataForSEO returned no tasks")
        t0 = tasks[0]
        code = t0.get("status_code") or 0
        msg = t0.get("status_message") or ""
        if code >= 40000:
            m = re.search(r"Invalid Field: '([^']+)'", msg)
            if m and m.group(1) in task and m.group(1) not in ("user_prompt", "model_name"):
                task.pop(m.group(1), None)
                continue
            raise RuntimeError(f"task error {code}: {msg}")
        break

    results = (t0.get("result") if t0 else None) or []
    if not results:
        raise RuntimeError("DataForSEO returned no result")
    r0 = results[0]

    text_parts, citations = [], []
    for item in (r0.get("items") or []):
        if item.get("type") == "reasoning":
            continue
        for sec in (item.get("sections") or []):
            if sec.get("text"):
                text_parts.append(sec["text"])
            for ann in (sec.get("annotations") or []):
                if ann.get("url"):
                    citations.append({"url": ann["url"], "title": ann.get("title", "")})
    meta = {"model_name": r0.get("model_name", model_name), "cost": r0.get("money_spent", 0)}
    return "\n".join(text_parts).strip(), citations, meta


def call_serp_ai(engine, prompt, iso):
    """Google AI Overview (organic SERP element) or AI Mode. Returns (answer, citations, meta)."""
    loc = LOCATION_NAME.get((iso or "").lower(), "United States")
    if engine == "google-ai-mode":
        task = {"keyword": prompt[:500], "location_name": loc, "language_code": "en"}
        status, body = _dfs("/serp/google/ai_mode/live/advanced", task)
    else:  # google-ai-overview lives inside organic advanced results
        task = {"keyword": prompt[:500], "location_name": loc, "language_code": "en"}
        status, body = _dfs("/serp/google/organic/live/advanced", task)
    if status != 200 or not isinstance(body, dict):
        raise RuntimeError(f"DataForSEO SERP {status}: {str(body)[:160]}")
    tasks = body.get("tasks") or []
    if not tasks or not (tasks[0].get("result") or []):
        raise RuntimeError("DataForSEO SERP returned no result")
    items = (tasks[0]["result"][0].get("items") or [])
    text_parts, citations = [], []
    for it in items:
        if it.get("type") not in ("ai_overview", "ai_overview_element", "ai_mode"):
            # AI mode endpoint may nest content differently; capture any markdown/text
            if engine == "google-ai-mode" and it.get("type") in ("ai_mode_message", "answer_box"):
                pass
            else:
                continue
        # text can be in .text, .markdown, or nested .items[].text
        if it.get("text"):
            text_parts.append(it["text"])
        if it.get("markdown"):
            text_parts.append(it["markdown"])
        for sub in (it.get("items") or []):
            if sub.get("text"):
                text_parts.append(sub["text"])
            for ref in (sub.get("references") or []):
                if ref.get("url"):
                    citations.append({"url": ref["url"], "title": ref.get("title", "")})
        for ref in (it.get("references") or []):
            if ref.get("url"):
                citations.append({"url": ref["url"], "title": ref.get("title", "")})
    if not text_parts:
        raise RuntimeError("No AI Overview/Mode block present for this query")
    return "\n".join(text_parts).strip(), citations, {"model_name": engine, "cost": 0}


# ---------------------------------------------------------------------------
# Claude extraction
# ---------------------------------------------------------------------------
EXTRACT_SYSTEM = (
    "You analyse an AI assistant's answer to determine how a specific brand appears in it. "
    "Respond with ONLY a compact JSON object, no prose. Schema: "
    '{"is_mentioned":bool,"sentiment":"positive"|"neutral"|"negative",'
    '"sentiment_reason":string,"sentiment_theme":string,'
    '"visibility_score":0-100,"rank":int,"mention_snippet":string}. '
    # Without this, the grader matches the brand string literally and scores a prominent
    # sub-brand mention as absent: "Da Paolo Group" was graded not_mentioned against an answer
    # recommending "Tutto by Da Paolo" as its top pick.
    "WHAT COUNTS AS THE BRAND: is_mentioned is TRUE when the answer refers to the tracked brand "
    "by ANY name a customer would recognise as that business — the exact name, a shortening "
    "('Da Paolo Group' -> 'Da Paolo'), a sub-brand, outlet, product line or venue operated under "
    "it ('Da Paolo Group' -> 'Tutto by Da Paolo', 'Da Paolo Pizza Bar'), a legal-entity variant "
    "('Acme Pte Ltd' -> 'Acme'), or a common misspelling. Corporate suffixes (Group, Holdings, "
    "Pte Ltd, Inc, LLC) are noise: judge on the distinctive part of the name. "
    "It is FALSE when the answer names a DIFFERENT business that merely shares a word "
    "('Paolo's Trattoria' is not 'Da Paolo Group'). If genuinely ambiguous, prefer TRUE and say "
    "why in sentiment_reason. "
    "visibility_score = how prominently/favourably the brand features (0 if absent). "
    "rank = the brand's ordinal position if the answer is a ranked/listed set of options, else 0. "
    "mention_snippet = the VERBATIM sentence(s) from the answer that mention the brand "
    "(copy the exact words, do not paraphrase), or empty string if not mentioned. "
    "sentiment_reason = one short sentence (<=160 chars) explaining WHY you chose that sentiment, "
    "grounded in the answer's actual wording; empty string if not mentioned. "
    "sentiment_theme = a 2-4 word Title Case label for the SPECIFIC angle of the mention so that "
    "mentions sharing an angle can be grouped (e.g. 'Convenient Locations', 'Pricing Concerns', "
    "'Reliable Service', 'Limited Availability'); empty string if not mentioned."
)


# Corporate noise words: present in the registered name, absent from how anyone refers to the
# business in prose. "Da Paolo Group" is written as "Da Paolo"; matching the full string misses it.
_BRAND_NOISE = ("group", "holdings", "holding", "pte", "ltd", "ltd.", "limited", "inc", "inc.",
                "llc", "llp", "plc", "corp", "corp.", "corporation", "company", "co", "co.",
                "sdn", "bhd", "gmbh", "the", "&", "and")


def brand_core(brand):
    """The distinctive part of a brand name — what a human would actually say.

    'Da Paolo Group' -> 'da paolo'. Used only by the heuristic fallback that runs when the grader
    LLM is unreachable; the grader itself is told the rule in EXTRACT_SYSTEM. Returns '' when a
    name is nothing but noise words, so callers must treat '' as "can't match" rather than
    "matches everything"."""
    words = [w for w in re.split(r"[\s,]+", (brand or "").lower().strip()) if w]
    core = [w for w in words if w.strip(".,") not in _BRAND_NOISE]
    return " ".join(core).strip()


def heuristic_mentioned(brand, answer, aliases=None):
    """Substring check on the brand's distinctive core and any curated aliases."""
    if not answer:
        return False
    a = answer.lower()
    for name in [brand] + list(aliases or []):
        if not name:
            continue
        if name.lower() in a:
            return True
        core = brand_core(name)
        # Require a few characters so a short core can't match half the language. Aliases like
        # "FSBP" are deliberate acronyms, so they're checked verbatim above before this.
        if core and len(core) >= 3 and core in a:
            return True
    return False


def extract_with_claude(brand, answer, aliases=None):
    if not answer:
        return {"is_mentioned": False, "sentiment": "neutral", "sentiment_reason": "",
                "sentiment_theme": "", "visibility_score": 0, "rank": 0, "mention_snippet": ""}
    # Aliases are curated per campaign and cover what the general rule can't infer (acronyms like
    # HLAS/FSBP). They ADD to the rule rather than replace it: an unlisted sub-brand must still
    # count, which is exactly the case that produced the original false negative.
    known = [a for a in (aliases or []) if a and a.strip().lower() != (brand or "").strip().lower()]
    alias_line = ("\nAlso known as (these ALL count as the brand): "
                  + ", ".join(known[:20]) + "\n") if known else ""
    user = f"Brand: {brand}\n{alias_line}\nAI answer:\n{answer[:6000]}"
    payload = {"model": EXTRACT_MODEL, "max_tokens": 300, "system": EXTRACT_SYSTEM,
               "messages": [{"role": "user", "content": user}]}
    status, body = _http_json("https://api.anthropic.com/v1/messages", payload, headers={
        "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"})
    if status != 200:
        # Fallback: heuristic mention detection on the raw text.
        mentioned = heuristic_mentioned(brand, answer, aliases)
        return {"is_mentioned": mentioned, "sentiment": "neutral", "sentiment_reason": "",
                "sentiment_theme": "", "visibility_score": 50 if mentioned else 0,
                "rank": 0, "mention_snippet": ""}
    try:
        txt = "".join(b.get("text", "") for b in body.get("content", []) if b.get("type") == "text")
        m = re.search(r"\{.*\}", txt, re.DOTALL)
        data = json.loads(m.group(0) if m else txt)
    except Exception:
        mentioned = heuristic_mentioned(brand, answer, aliases)
        return {"is_mentioned": mentioned, "sentiment": "neutral", "sentiment_reason": "",
                "sentiment_theme": "", "visibility_score": 50 if mentioned else 0,
                "rank": 0, "mention_snippet": ""}
    return {
        "is_mentioned": bool(data.get("is_mentioned")),
        "sentiment": (data.get("sentiment") or "neutral").lower(),
        "sentiment_reason": (data.get("sentiment_reason") or "").strip()[:200],
        "sentiment_theme": (data.get("sentiment_theme") or "").strip()[:60],
        "visibility_score": max(0, min(100, int(data.get("visibility_score") or 0))),
        "rank": int(data.get("rank") or 0),
        "mention_snippet": data.get("mention_snippet") or "",
    }


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------
def verify_one(prompt, brand, url, location, model_id, aliases=None):
    iso = LOCATION_ISO.get((location or "").strip().lower(), "")
    if model_id in SERP_ENGINES:
        answer, citations, meta = call_serp_ai(model_id, prompt, iso)
    else:
        engine_path, model_name = LLM_ENGINES.get(model_id, LLM_ENGINES["chatgpt"])
        try:
            answer, citations, meta = call_llm_engine(engine_path, model_name, prompt, iso)
        except RuntimeError as e:
            # Model-name mismatch: retry once with the first model the engine advertises.
            if "task error" in str(e) or "no result" in str(e):
                alt = _first_model(engine_path)
                if alt and alt != model_name:
                    answer, citations, meta = call_llm_engine(engine_path, alt, prompt, iso)
                else:
                    raise
            else:
                raise

    target_domain = domain_of(url)
    citation_urls = []
    seen = set()
    for c in citations:
        if c["url"] not in seen:
            seen.add(c["url"])
            citation_urls.append(c["url"])
    is_cited = bool(target_domain) and any(domain_of(u) == target_domain for u in citation_urls)

    a = extract_with_claude(brand, answer, aliases)
    a["is_cited"] = is_cited
    a["citation_urls"] = citation_urls
    # Full answer, untruncated. It used to be cut to 4000 chars here and then again to 1200 in
    # geoCampaigns, so the text the dashboard showed under "Full AI response" never was one.
    # Callers that persist it are responsible for where it lands (geoCampaigns → S3 answer store).
    return {"status": "success", "analysis": a, "response": answer,
            "engine": model_id, "model_name": meta.get("model_name"), "cost": meta.get("cost")}


def _first_model(engine_path):
    status, body = _http_json(
        f"{DFS_BASE}/ai_optimization/{engine_path}/llm_responses/models",
        None, headers={"Authorization": DFS_AUTH}, method="GET")
    try:
        items = (body.get("tasks") or [{}])[0].get("result") or []
        names = []
        for it in items:
            n = it.get("model_name") or it.get("name")
            if n:
                names.append(n)
        for pref in ("flash", "mini", "haiku", "sonar"):
            for n in names:
                if pref in n.lower():
                    return n
        return names[0] if names else None
    except Exception:
        return None


def lambda_handler(event, context):
    method = (event.get("requestContext", {}).get("http", {}).get("method")
              or event.get("httpMethod") or "POST")
    if method == "OPTIONS":
        return _resp(200, {"ok": True})

    raw = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        raw = base64.b64decode(raw).decode()
    try:
        req = json.loads(raw) if isinstance(raw, str) else (raw or {})
    except Exception:
        req = {}

    action = req.get("action", "verify_mentions")
    if action == "health":
        return _resp(200, {"ok": True, "has_dfs": bool(DFS_AUTH), "has_anthropic": bool(ANTHROPIC_API_KEY)})

    if action != "verify_mentions":
        return _resp(400, {"error": f"unsupported action: {action}"})

    prompt = req.get("prompt") or ""
    brand = req.get("brand") or ""
    url = req.get("url") or ""
    location = req.get("location") or ""
    models = req.get("models") or ["chatgpt"]
    # Curated brand aliases from the campaign record (alternativeNames). No model can infer
    # that "HLAS" is HL Assurance or "FSBP" is Free Skin & Body Perfect — the prompt rule only
    # catches names that LOOK like the brand. These carry the ones it cannot guess.
    aliases = [str(a).strip() for a in (req.get("aliases") or []) if str(a).strip()]
    model_id = models[0]

    if not prompt or not brand:
        return _resp(400, {"error": "prompt and brand are required"})

    try:
        result = verify_one(prompt, brand, url, location, model_id, aliases)
        return _resp(200, {"verification": [result]})
    except Exception as e:
        return _resp(200, {"verification": [{"status": "error", "error": str(e), "engine": model_id}]})
