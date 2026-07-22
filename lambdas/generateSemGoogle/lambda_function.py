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
_LLM_FN = 'generateSemGoogle'


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


def call_claude(prompt, api_key, max_tokens=2048, system=None):
    import requests
    body = {"model": "claude-haiku-4-5-20251001", "max_tokens": max_tokens,
            "messages": [{"role": "user", "content": prompt}]}
    if system:
        body["system"] = system
    r = requests.post("https://api.anthropic.com/v1/messages",
        headers={"x-api-key": api_key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
        json=body, timeout=120)
    data = r.json()
    if "content" not in data:
        raise ValueError(f"Anthropic error: {data}")
    return data["content"][0]["text"]


def _error(message, status=502):
    # Clean error envelope — never let a raw exception/traceback reach the client.
    return {'statusCode': status, 'body': {'error': message}}


def lambda_handler(event, context):
    try:
        return _run(event)
    except Exception as e:
        # Log the real detail server-side; return a sanitised message to the client.
        print(f"[generateSemGoogle] error: {repr(e)}")
        return _error("Ad copy generation failed. Please try again.")


def _run(event):
    api_key = os.environ.get('ANTHROPIC_API_KEY')
    if not api_key:
        print("[generateSemGoogle] ANTHROPIC_API_KEY is not configured")
        return _error("Ad copy generation is temporarily unavailable.")
    data = event['input']
    country = event.get('country')
    tone = event.get('tone')
    language = event.get('language')
    keywords = event.get('keywords')
    ad_format = event['type']
    prompt = None

    # Fold target market + must-include keywords into the input so every ad-format
    # prompt below picks them up (they all embed `data`). Both are optional.
    _extra = []
    if country and str(country).strip():
        _extra.append("Target country / market: " + str(country).strip() + ". Tailor wording, spelling and offers to this market.")
    if keywords and str(keywords).strip():
        _extra.append("You MUST naturally incorporate these keywords into the ad copy wherever they fit (do not force them): " + str(keywords).strip() + ".")
    if _extra:
        data = data + "\n\nAdditional requirements:\n- " + "\n- ".join(_extra)

    if ad_format == "google-responsive-search-ads":
        prompt = "Based on the following input, generate 15 Google responsive search ad headlines (max 30 characters each), 4 ad descriptions (85-90 characters each), 5 sitelinks (split into sitelink text - max 25 characters, description line 1 - max 35 characters, description line 2 - max 35 characters), 7 callouts (max 25 characters each), 10 negative keywords, 7 structured snippets (max 25 characters each) in "+language+". The tone should be "+tone+". The input is: "+data+"\n\n Output the answer in a dictionary format {'headlines':[headline1, headline2],'ad_desc':[ad desc1, ad desc 2],'sitelinks':[sitelink1,sitelink2],'callouts':[callout1, callout2],'neg_kyewords':[negative keyword 1, negative keyword 2]}. Use double quotes for strings."
    elif ad_format == "google-performance-max-ads":
        prompt = "Based on the following input, generate 15 Google performance max ad headlines (max 30 characters each), 4 long headlines (max 90 characters each), 4 ad descriptions (85-90 characters each), 5 sitelinks (split into sitelink text - max 25 characters, description line 1 - max 35 characters, description line 2 - max 35 characters), 7 callouts (max 25 characters each), 7 structured snippets (max 25 characters each) in "+language+". The tone should be "+tone+". The input is: "+data+"\n\n Output the answer in a dictionary format {'headlines':[headline1, headline2],'long_headlines':[headline1, headline2],'ad_desc':[ad desc1, ad desc 2],'sitelinks':[sitelink1,sitelink2],'callouts':[callout1, callout2]}. Use double quotes for strings."
    elif ad_format == "google-display-ads":
        prompt = "Based on the following input, generate 5 Google display ad headlines (max 30 characters each), 1 long headline (max 90 characters), 5 ad descriptions (85-90 characters each), 1 CTA in "+language+". The tone should be "+tone+". The input is: "+data+"\n\n Output the answer in a dictionary format {'headlines':[headline1, headline2],'long_headline':[headline],'ad_desc':[ad desc1, ad desc 2],'CTA':[CTA]}. Use double quotes for strings."
    elif ad_format == "meta-carousel-ads":
        prompt = "Based on the following input, generate for meta carousel ads, primary text (max 80 characters) 5 card headlines (max 40 characters each), 1 CTA in "+language+". The tone should be "+tone+". The input is: "+data+"\n\n Output the answer in a dictionary format {'primary_text':[primary_text],'headlines':[headline1, headline2],'CTA':[CTA]}. Use double quotes for strings."
    elif ad_format == "meta-collection-ads":
        prompt = "Based on the following input, generate for meta collection ads, primary text (max 80 characters) 5 card headlines (max 40 characters each), 1 CTA in "+language+". The tone should be "+tone+". The input is: "+data+"\n\n Output the answer in a dictionary format {'primary_text':[primary_text],'headlines':[headline1, headline2],'CTA':[CTA]}. Use double quotes for strings."
    elif ad_format == "meta-image-ads":
        prompt = "Based on the following input, generate for meta image ads, primary text (max 150 characters), 1 headline (max 27 characters), 1 CTA in "+language+". The tone should be "+tone+". The input is: "+data+"\n\n Output the answer in a dictionary format {'primary_text':[primary_text],'headline':[headline],'CTA':[CTA]}. Use double quotes for strings."
    elif ad_format == "meta-video-ads":
        prompt = "Based on the following input, generate for meta video ads, primary text (max 150 characters), 1 headline (max 27 characters), 1 CTA in "+language+". The tone should be "+tone+". The input is: "+data+"\n\n Output the answer in a dictionary format {'primary_text':[primary_text],'headline':[headline],'CTA':[CTA]}. Use double quotes for strings."
    elif ad_format == "linkedin-image-ads":
        prompt = "Based on the following input, generate for LinkedIn image ads, 1 headline (max 70 characters), introductory text (max 150 characters), 1 CTA in "+language+". The tone should be "+tone+". The input is: "+data+"\n\n Output the answer in a dictionary format {'introductory_text':[introductory_text],'headline':[headline],'CTA':[CTA]}. Use double quotes for strings."
    elif ad_format == "linkedin-video-ads":
        prompt = "Based on the following input, generate for LinkedIn video ads, 1 headline (max 70 characters), introductory text (max 150 characters), 1 CTA in "+language+". The tone should be "+tone+". The input is: "+data+"\n\n Output the answer in a dictionary format {'introductory_text':[introductory_text],'headline':[headline],'CTA':[CTA]}. Use double quotes for strings."
    elif ad_format == "linkedin-carousel-ads":
        prompt = "Based on the following input, generate for LinkedIn carousel ads, introductory text (max 1255 characters), 3 headlines (max 45 characters each), 1 CTA in "+language+". The tone should be "+tone+". The input is: "+data+"\n\n Output the answer in a dictionary format {'introductory_text':[introductory_text],'headlines':[haedline_1,headline_2,headline_3],'CTA':[CTA]}. Use double quotes for strings."
    elif ad_format == "linkedin-click-to-message-ads":
        prompt = "Based on the following input, generate for LinkedIn click to message ads, introductory text (max 600 characters), 1 conversation name (max 255 characters), 1 subject (max 60 characters), 1 intro message (max 8000 characters), 1 response message (max 8000 characters) in "+language+". The tone should be "+tone+". The input is: "+data+"\n\n Output the answer in a dictionary format {'introductory_text':[introductory_text],'conversation_name':[converseation_name],'subject':[subject],'intro_message':[intro_message],'response_message':[response_message]}. Use double quotes for strings."

    if not prompt:
        return _error(f"Unsupported ad format: {ad_format}", status=400)

    system = "You are an expert Paid Ads consultant. Stick strictly to the specified character counts. Generate uniquely different variations, attempt to include USPs,CTAs and objectives."

    content = call_claude(prompt, api_key, system=system)

    print(content)
    try:
        output = json.loads(content.replace('python','').replace("```","").replace("'",'"'))
    except Exception as e:
        print(e)
        try:
            output = json.loads('{'+'{'.join(content.replace('python','').replace("```","").split('{')[1:]))
        except Exception as e2:
            print(f"[generateSemGoogle] could not parse model output: {repr(e2)}")
            return _error("Could not parse the generated ad copy. Please try again.")

    return {
        'statusCode': 200,
        'body': output
    }
