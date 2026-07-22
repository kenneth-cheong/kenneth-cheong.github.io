"""
Overdue Responses automation
=============================

Scans the **Integrated Campaign Info Repository** board for SEO & GEO campaigns
that are waiting on a consultant's reply, and posts the offenders into the
**OVERDUE RESPONSES** group of the *SEO Team Weekly Huddle* board, each line item
auto-assigned to the consultant who has not responded.

Pipeline (hybrid: deterministic gathering + LLM judgement)
----------------------------------------------------------
  Step 1  Build the consultant -> campaign map by paging the ICIR board
          (board 2845615047). For every row that has both an assigned
          consultant and a [Tech] Board ID we record (consultant, role,
          individual board id, campaign name, campaign code).
  Step 2  Resolve each consultant to their monday user id (for assignment and
          for reply-author matching).
  Step 3  For each individual campaign board pull recent item updates + replies.
          Pre-filter to the threads that actually mention one of that board's
          consultants, then hand those threads to the LLM, which decides -
          exactly as the human prompt describes - whether the consultant was
          @-mentioned and has NOT posted any reply since, with the last mention
          older than the overdue threshold.
  Step 4  De-duplicate against items already sitting in the OVERDUE RESPONSES
          group (keyed by board id + triggering update id) and, unless running
          in dry-run mode, create a line item assigned to the consultant.

Designed to run head-less from EventBridge Scheduler every morning, and to be
invokable on demand (dry_run) from scheduler.html.

Dependencies: standard library only (urllib) so it can be deployed as a single
inline file with no packaging.

Environment variables
----------------------
  MONDAY_API_KEY        monday.com API token (required)
  DEEPSEEK_API_KEY      DeepSeek API key (required)
  LLM_MODEL             default 'deepseek-chat'
  PROJECT_TYPE_FILTER   [BD]Project Type must contain one of these comma-sep
                        terms (default 'seo,geo'; empty to disable)
  EXCLUDE_GROUPS        comma-separated ICIR group ids to skip
  ICIR_BOARD_ID         default 2845615047
  HUDDLE_BOARD_ID       default 1313736399
  OVERDUE_GROUP_ID      default 'group_mm4mfgk7'
  LOOKBACK_DAYS         only consider update threads touched in the last N days
                        (default 14)
  OVERDUE_HOURS         a reply is "overdue" once the mention is older than this
                        many hours (default 24)
  MAX_ITEMS_PER_BOARD   cap line items scanned per campaign board (default 100)
  DRY_RUN               '1' to report only and never write to the board.
                        The event payload {"dry_run": true} overrides this.
"""

import os
import re
import json
import time
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone, timedelta

# ── LLM usage metering (CloudWatch EMF) — Digimetrics/LLM ─────────────────────
# Meters every Claude/DeepSeek/OpenAI call at each LLM helper's
# response site (this Lambda uses urllib/urllib3, not requests) — all call sites report RAW token buckets (input, output,
# cache read/write, web-search requests) into Digimetrics/LLM (dims Provider,
# Provider+Model). Cost is derived at READ time from one central table, so no
# rates live here (nothing to go stale). Mirrors saas/backend/src/lib/
# llm-metric.mjs. Logs only; safe by construction — the real call runs first and
# is returned regardless of metering.
import json as _mllm_json
import time as _mllm_time
_LLM_FN = 'overdueResponses'


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


# ── end LLM usage metering ────────────────────────────────────────────────────


# ----------------------------------------------------------------------------
# Configuration
# ----------------------------------------------------------------------------
MONDAY_API_URL = "https://api.monday.com/v2"
MONDAY_API_VERSION = "2024-10"

ICIR_BOARD_ID = os.environ.get("ICIR_BOARD_ID", "2845615047")
HUDDLE_BOARD_ID = os.environ.get("HUDDLE_BOARD_ID", "1313736399")
OVERDUE_GROUP_ID = os.environ.get("OVERDUE_GROUP_ID", "group_mm4mfgk7")
# monday account slug, used to build deep links to the triggering update.
MONDAY_SLUG = os.environ.get("MONDAY_SLUG", "mediaone-business-group-pte-ltd")


def build_update_url(board_id, item_id, update_id):
    """Permalink straight to the triggering update/reply on the campaign board."""
    if not item_id:
        return "https://%s.monday.com/boards/%s" % (MONDAY_SLUG, board_id)
    return "https://%s.monday.com/boards/%s/pulses/%s/posts/%s" % (
        MONDAY_SLUG, board_id, item_id, update_id)

# ICIR column ids (verified against the live board)
COL_CAMPAIGN_CODE = "text_mkzhnmbv"      # Campaign Code
COL_TECH_BOARD_ID = "text_mknpdk1p"      # [Tech] Board ID
COL_SEO_PERSON = "people6"               # [SEO]SEO
COL_GEO_PERSON = "multiple_person_mm1mcx4v"  # [GEO]GEO

# Huddle (target) column ids
HUDDLE_PEOPLE_COL = "people"             # "Assigned to"
HUDDLE_TEXT_COL = "text"                 # "Additional Info"

LLM_MODEL = os.environ.get("LLM_MODEL", "deepseek-chat")
DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions"
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "14"))
OVERDUE_HOURS = int(os.environ.get("OVERDUE_HOURS", "24"))
# When false (default), a consultant who is only carbon-copied / FYI'd on a
# thread (cc/cc:/fyr/fyi @Name, or the actual request is addressed to someone
# else) is NOT treated as overdue — only messages directed AT them count.
COUNT_CC = os.environ.get("COUNT_CC", "0") == "1"
# A campaign line item whose Status column matches one of these terms is
# considered resolved/handled, and its update threads are skipped entirely (no
# overdue flag) — even if the consultant never typed a textual reply. Match is
# case-insensitive substring, so "[MO] Done" matches "done" and "[MO] Not
# Needed" matches "not needed". Set RESOLVED_STATUSES empty to disable.
DONE_STATUS_COL = os.environ.get("DONE_STATUS_COL", "status")
RESOLVED_STATUSES = [
    s.strip().lower() for s in os.environ.get(
        "RESOLVED_STATUSES", "done,not needed,completed,won't do,wont do"
    ).split(",") if s.strip()
]
MAX_ITEMS_PER_BOARD = int(os.environ.get("MAX_ITEMS_PER_BOARD", "100"))
# Number of campaign boards fetched concurrently (I/O-bound).
MAX_WORKERS = int(os.environ.get("MAX_WORKERS", "8"))
# Threads handed to the LLM per request. Keep at 1: deepseek-chat reliably
# applies the strict "mentioned but not replied" rule on a single thread, but
# silently under-detects when several threads are batched into one prompt.
JUDGE_BATCH = int(os.environ.get("JUDGE_BATCH", "1"))
# Concurrent DeepSeek judge calls (the per-thread calls are independent).
LLM_WORKERS = int(os.environ.get("LLM_WORKERS", "8"))
# ICIR groups to skip. Comma-separated group ids; override via env. These map to:
#   new_group13835 = Pending Campaigns - No Updates for >6 months
#   new_group46811 = Completed Campaigns - Update Here
#   new_group52976 = Completed PSG Campaigns
#   new_group88080 = Expired Campaigns (Do not remove or change details)
_DEFAULT_EXCLUDE = "new_group13835,new_group46811,new_group52976,new_group88080"
EXCLUDE_GROUPS = set(
    g.strip() for g in os.environ.get("EXCLUDE_GROUPS", _DEFAULT_EXCLUDE).split(",") if g.strip()
)

# Only campaigns whose [BD]Project Type (tags column) contains one of these terms
# are considered (case-insensitive substring; comma-separated). Set empty to
# disable.
PROJECT_TYPE_FILTER = [
    t.strip().lower() for t in os.environ.get("PROJECT_TYPE_FILTER", "seo,geo").split(",")
    if t.strip()
]
COL_PROJECT_TYPE = "tags"  # [BD]Project Type

# Consultant roster. Each label maps to a list of alias token-sets; a monday
# display name matches the label if every token of ANY alias appears in it
# (case-insensitive, substring). This is resilient to "Surname Given Name"
# ordering and to nicknames (e.g. Kanikka == "Kanivarasi Elanchelvan").
SEO_CONSULTANTS = {
    "Elvin":      [["elvin"]],
    "Kanikka":    [["kanikka"], ["kanivarasi"]],
    "Ching Yi":   [["ching", "yi"]],
    "Yi Yong":    [["yi", "yong"]],
    "Choon Ling": [["choon", "ling"]],
    "Kar Ting":   [["kar", "ting"]],
    "Carl":       [["carl"]],
    "Rein":       [["rein"]],
    "Jia Jia":    [["jia", "jia"]],
}
GEO_CONSULTANTS = {
    "Yi Yong":  [["yi", "yong"]],
    "Ching Yi": [["ching", "yi"]],
}


# ----------------------------------------------------------------------------
# HTTP helpers (stdlib only)
# ----------------------------------------------------------------------------
def _http_post(url, headers, payload, timeout=60, max_retries=4):
    """POST JSON with exponential-backoff retries on transient failures."""
    data = json.dumps(payload).encode("utf-8")
    last_err = None
    for attempt in range(max_retries):
        try:
            req = urllib.request.Request(url, data=data, headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = ""
            try:
                body = e.read().decode("utf-8")
            except Exception:
                pass
            last_err = "HTTP %s: %s" % (e.code, body[:300])
            if e.code in (429, 500, 502, 503, 504) or "complexity" in body.lower():
                time.sleep(min(2 ** attempt, 12))
                continue
            raise RuntimeError(last_err)
        except (urllib.error.URLError, TimeoutError) as e:
            last_err = str(e)
            time.sleep(min(2 ** attempt, 12))
    raise RuntimeError("POST failed after %d retries: %s" % (max_retries, last_err))


def monday_gql(query, variables=None):
    key = os.environ.get("MONDAY_API_KEY") or os.environ.get("MONDAY_TOKEN")
    if not key:
        raise RuntimeError("MONDAY_API_KEY not configured")
    headers = {
        "Authorization": key,
        "Content-Type": "application/json",
        "API-Version": MONDAY_API_VERSION,
    }
    out = _http_post(MONDAY_API_URL, headers, {"query": query, "variables": variables or {}})
    if out.get("errors"):
        raise RuntimeError("monday GraphQL error: %s" % json.dumps(out["errors"])[:400])
    return out["data"]


def deepseek_chat(api_key, body, timeout=120, max_retries=4):
    """OpenAI-compatible chat completion against DeepSeek."""
    headers = {
        "Authorization": "Bearer %s" % api_key,
        "Content-Type": "application/json",
    }
    _ds_resp = _http_post(DEEPSEEK_API_URL, headers, body, timeout=timeout, max_retries=max_retries)
    _emit_llm_from_body('deepseek', _ds_resp)
    return _ds_resp


# ----------------------------------------------------------------------------
# Name matching
# ----------------------------------------------------------------------------
def match_label(display_name, roster):
    """Return the set of roster labels a monday display name belongs to."""
    if not display_name:
        return []
    low = display_name.lower()
    hits = []
    for label, aliases in roster.items():
        for tokens in aliases:
            if all(tok in low for tok in tokens):
                hits.append(label)
                break
    return hits


# ----------------------------------------------------------------------------
# Step 1 - build consultant -> campaign map
# ----------------------------------------------------------------------------
ICIR_PAGE_QUERY = """
query ($board: [ID!], $cursor: String) {
  boards(ids: $board) {
    items_page(limit: 200, cursor: $cursor) {
      cursor
      items {
        id
        name
        group { id }
        column_values(ids: ["%s","%s","%s","%s","%s"]) { id text }
      }
    }
  }
}
""" % (COL_CAMPAIGN_CODE, COL_TECH_BOARD_ID, COL_SEO_PERSON, COL_GEO_PERSON, COL_PROJECT_TYPE)


def build_campaign_map():
    """Return dict: board_id -> {campaign_name, campaign_code, consultants: set(label)}
    where consultants come from the SEO and GEO people columns restricted to the
    rostered set."""
    boards = {}
    cursor = None
    pages = 0
    while True:
        data = monday_gql(ICIR_PAGE_QUERY, {"board": [ICIR_BOARD_ID], "cursor": cursor})
        page = data["boards"][0]["items_page"]
        for it in page["items"]:
            grp = (it.get("group") or {}).get("id", "")
            if grp in EXCLUDE_GROUPS:
                continue
            cv = {c["id"]: (c.get("text") or "").strip() for c in it["column_values"]}
            board_id = cv.get(COL_TECH_BOARD_ID, "")
            seo_raw = cv.get(COL_SEO_PERSON, "")
            geo_raw = cv.get(COL_GEO_PERSON, "")
            if not board_id or not (seo_raw or geo_raw):
                continue
            # [BD]Project Type must contain one of the configured terms (seo/geo)
            if PROJECT_TYPE_FILTER:
                ptype = cv.get(COL_PROJECT_TYPE, "").lower()
                if not any(term in ptype for term in PROJECT_TYPE_FILTER):
                    continue
            labels = set()
            # people columns can hold multiple comma-separated names
            for nm in [n.strip() for n in seo_raw.split(",") if n.strip()]:
                for lbl in match_label(nm, SEO_CONSULTANTS):
                    labels.add(lbl)
            for nm in [n.strip() for n in geo_raw.split(",") if n.strip()]:
                for lbl in match_label(nm, GEO_CONSULTANTS):
                    labels.add(lbl)
            if not labels:
                continue
            entry = boards.setdefault(board_id, {
                "campaign_name": it["name"],
                "campaign_code": cv.get(COL_CAMPAIGN_CODE, ""),
                "consultants": set(),
            })
            entry["consultants"].update(labels)
        cursor = page.get("cursor")
        pages += 1
        if not cursor or pages > 40:
            break
    return boards


# ----------------------------------------------------------------------------
# Step 2 - resolve consultant labels -> monday user ids + canonical names
# ----------------------------------------------------------------------------
def resolve_consultants():
    """Map every rostered label to {user_id, display_name} using the account
    user directory."""
    data = monday_gql("query { users(limit: 500, kind: all) { id name enabled } }")
    users = data.get("users", []) or []
    roster = {}
    roster.update({l: GEO_CONSULTANTS[l] for l in GEO_CONSULTANTS})
    for l in SEO_CONSULTANTS:
        roster.setdefault(l, SEO_CONSULTANTS[l])
    resolved = {}
    for u in users:
        if u.get("enabled") is False:
            continue
        for lbl in match_label(u.get("name", ""), roster):
            # prefer the first / keep a list of candidates
            resolved.setdefault(lbl, {"user_id": str(u["id"]), "display_name": u["name"]})
    return resolved


# ----------------------------------------------------------------------------
# Step 3 - pull recent update threads per campaign board
# ----------------------------------------------------------------------------
BOARD_UPDATES_QUERY = """
query ($board: [ID!]) {
  boards(ids: $board) {
    items_page(limit: %d) {
      items {
        id
        name
        column_values(ids: ["%s"]) { id text }
        updates(limit: 25) {
          id
          text_body
          created_at
          creator { id name }
          replies {
            id
            text_body
            created_at
            creator { id name }
          }
        }
      }
    }
  }
}
""" % (MAX_ITEMS_PER_BOARD, DONE_STATUS_COL)


def _is_resolved_status(status_text):
    """True if a line item's Status marks it handled (Done / Not Needed / ...)."""
    if not RESOLVED_STATUSES:
        return False
    low = (status_text or "").lower()
    return any(term in low for term in RESOLVED_STATUSES)


def fetch_board_threads(board_id, since_dt):
    """Return list of thread dicts for a campaign board, restricted to threads
    with any activity since `since_dt`. Line items whose Status is resolved
    (Done / Not Needed / ...) are skipped entirely — a status change is how staff
    mark work handled, so we don't chase a missing textual reply on them."""
    try:
        data = monday_gql(BOARD_UPDATES_QUERY, {"board": [board_id]})
    except Exception as e:
        print("WARN could not fetch updates for board %s: %s" % (board_id, e))
        return []
    boards = data.get("boards") or []
    if not boards or not boards[0]:
        return []
    threads = []
    skipped_resolved = 0
    for it in boards[0]["items_page"]["items"]:
        status_text = ""
        for c in it.get("column_values") or []:
            if c.get("id") == DONE_STATUS_COL:
                status_text = c.get("text") or ""
        if _is_resolved_status(status_text):
            skipped_resolved += 1
            continue  # item is marked handled — don't judge its threads
        for up in it.get("updates") or []:
            posts = []
            root_ts = _parse_dt(up.get("created_at"))
            posts.append({
                "author": (up.get("creator") or {}).get("name", ""),
                "author_id": str((up.get("creator") or {}).get("id", "")),
                "date": up.get("created_at"),
                "text": up.get("text_body") or "",
            })
            latest = root_ts
            for rp in up.get("replies") or []:
                rts = _parse_dt(rp.get("created_at"))
                if rts and (latest is None or rts > latest):
                    latest = rts
                posts.append({
                    "author": (rp.get("creator") or {}).get("name", ""),
                    "author_id": str((rp.get("creator") or {}).get("id", "")),
                    "date": rp.get("created_at"),
                    "text": rp.get("text_body") or "",
                })
            if latest and since_dt and latest < since_dt:
                continue  # whole thread is stale
            threads.append({
                "update_id": up["id"],
                "item_id": it["id"],
                "item_name": it["name"],
                "posts": posts,
            })
    if skipped_resolved:
        print("Board %s: skipped %d resolved (Done/Not Needed) line items"
              % (board_id, skipped_resolved))
    return threads


def _parse_dt(s):
    if not s:
        return None
    try:
        s = s.replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


# ----------------------------------------------------------------------------
# LLM judgement (Step 3/4 core) - DeepSeek, JSON output mode
# ----------------------------------------------------------------------------
def judge_threads(api_key, label_names, threads, now_iso, debug_sink=None):
    """Ask DeepSeek which threads are overdue. `label_names` maps consultant
    label -> [display names to look for] (global roster). Each thread carries its
    own campaign context. Returns a list of overdue findings keyed by update_id."""
    if not threads:
        return []
    lines = []
    for t in threads:
        lines.append("THREAD update_id=%s | campaign: %s | item: %s"
                     % (t["update_id"], t.get("campaign_name", "-"), t["item_name"]))
        for i, p in enumerate(t["posts"]):
            tag = "ROOT" if i == 0 else "reply"
            lines.append("  [%s] %s | %s: %s" % (tag, p["date"], p["author"],
                                                 (p["text"] or "").replace("\n", " ").strip()))
    transcript = "\n".join(lines)

    consultant_block = "\n".join(
        "- %s  (monday display name(s): %s)" % (lbl, ", ".join(names))
        for lbl, names in label_names.items()
    )

    if COUNT_CC:
        step1 = (
            "STEP 1. Find every message (the ROOT update or any reply) whose text "
            "contains that consultant's display name (mentions appear after '@'). "
            "Treat ALL mentions equally: a direct '@Name', a 'cc @Name', an "
            "'fyr @Name', or an informational note like '@Name marking this as not "
            "needed' ALL count. The reason for the mention is IRRELEVANT.\n"
        )
        skip_rule = (
            "Do NOT skip a mention because it 'doesn't need a reply', is a cc, is "
            "informational, or seems closed — only the presence/absence of a later "
            "message by that consultant matters. "
        )
        example = (
            "Worked example — thread X: ROOT at 2026-06-01T00:00Z 'tech audit "
            "approved cc @Yeoh Choon Ling'; later replies are all authored by other "
            "people, none by Yeoh Choon Ling. If now is 2026-06-05, then Choon Ling "
            "IS overdue (a cc with no later message from them counts).\n\n"
        )
    else:
        step1 = (
            "STEP 1. Find every message (the ROOT update or any reply) that is "
            "DIRECTED AT that consultant — it asks them to do something, asks them a "
            "question, or hands them a task, naming them after '@'. DO NOT count a "
            "message where the consultant is merely carbon-copied or kept in the "
            "loop: their '@name' comes after 'cc', 'cc:', 'fyr', 'fyi', or the "
            "actual request/question is plainly addressed to a DIFFERENT person and "
            "the consultant is only copied. If, across the whole thread, the "
            "consultant is ONLY ever cc'd / FYI'd and never directly asked, they are "
            "NOT overdue — output nothing for them.\n"
        )
        skip_rule = (
            "Apart from the cc/FYI exclusion above, do NOT skip a directed request "
            "because it 'seems closed' or 'looks low priority' — only whether they "
            "were directly asked and whether a later reply by them exists matters. "
        )
        example = (
            "Worked example A — ROOT 'hi @Janine Wong , tech audit approved, please "
            "proceed ... cc @Yeoh Choon Ling': the request is to Janine and Choon "
            "Ling is only cc'd, so Choon Ling is NOT overdue. Worked example B — "
            "ROOT 'hi @Yeoh Choon Ling , please start KWP, eta 29 June': this is "
            "directed at Choon Ling, so if she posts no later reply and it is >%d h "
            "old, she IS overdue.\n\n" % OVERDUE_HOURS
        )

    system = (
        "You decide whether a consultant was DIRECTLY asked to act on a thread and "
        "has not replied. The current time is %s (UTC).\n\n"
        "For each consultant in the user's list, and each thread, do exactly this:\n"
        "%s"
        "STEP 2. Take the LAST (latest timestamp) such message — the last mention.\n"
        "STEP 3. Check whether that SAME consultant authored any message in the "
        "SAME thread with a timestamp strictly AFTER that last mention (match by "
        "the author name shown before each message).\n"
        "STEP 4. Output the consultant as OVERDUE for that thread if, and only if, "
        "(a) they authored NO later message in the thread, AND (b) the last "
        "mention is more than %d hours before the current time.\n\n"
        "%s"
        "Only consider the consultants the user lists; ignore mentions of anyone "
        "else. Report each (consultant, thread) at most once.\n\n"
        "%s"
        "Respond with ONLY a JSON object of this exact shape:\n"
        '{\"overdue\": [{\"consultant\": \"<label exactly as given>\", '
        '\"update_id\": \"<the thread update_id>\", '
        '\"mention_text\": \"<verbatim text of the message that tagged them>\", '
        '\"mention_author\": \"<who wrote it>\", '
        '\"mention_date\": \"<the ISO timestamp of that message>\"}]}\n'
        "If nothing qualifies, return {\"overdue\": []}."
        % (now_iso, step1, OVERDUE_HOURS, skip_rule, example)
    )
    user = ("Consultants to audit:\n%s\n\nThreads:\n%s" % (consultant_block, transcript))

    body = {
        "model": LLM_MODEL,
        "max_tokens": 4096,
        "temperature": 0,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }
    try:
        resp = deepseek_chat(api_key, body)
    except Exception as e:
        print("WARN LLM judgement failed: %s" % e)
        return []
    try:
        content = (resp.get("choices") or [{}])[0].get("message", {}).get("content") or "{}"
        if debug_sink is not None and len(debug_sink) < 2:
            debug_sink.append({"transcript": transcript[:2500], "raw": content[:2500]})
        parsed = json.loads(content)
        return parsed.get("overdue", []) or []
    except Exception as e:
        print("WARN could not parse DeepSeek JSON: %s" % e)
        if debug_sink is not None and len(debug_sink) < 2:
            debug_sink.append({"error": str(e), "raw": content[:2500]})
        return []


# ----------------------------------------------------------------------------
# Step 4 - dedupe + create line items
# ----------------------------------------------------------------------------
def _key(board_id, update_id, consultant):
    # consultant is part of the key: two people tagged in one thread are two
    # separate overdue items, and re-runs must dedupe per-consultant.
    return "OR-KEY:%s:%s:%s" % (board_id, update_id, (consultant or "").replace(" ", "_"))


_URL_SIG_RE = re.compile(r"/boards/(\d+)/pulses/\d+/posts/(\d+)")


def existing_signatures():
    """Read items already in the OVERDUE group and return two dedupe sets:

      legacy : OR-KEY markers (older items stored the full details blob, which
               carried an `OR-KEY:<board>:<update>:<consultant>` token).
      sigs   : `<board>:<update>:<user_id>` signatures rebuilt from the new-style
               Additional Info (a permalink to the triggering update) plus the
               assigned-person column. Equivalent dedupe identity, no marker text.
    """
    legacy = set()
    sigs = set()
    cursor = None
    group_query = """
    query ($board: [ID!], $group: [String!], $cursor: String) {
      boards(ids: $board) {
        groups(ids: $group) {
          items_page(limit: 200, cursor: $cursor) {
            cursor
            items { id name column_values(ids: ["%s","%s"]) { id text value } }
          }
        }
      }
    }
    """ % (HUDDLE_TEXT_COL, HUDDLE_PEOPLE_COL)
    pages = 0
    while True:
        data = monday_gql(group_query, {"board": [HUDDLE_BOARD_ID],
                                        "group": [OVERDUE_GROUP_ID], "cursor": cursor})
        groups = data["boards"][0].get("groups") or []
        if not groups:
            break
        page = groups[0]["items_page"]
        for it in page["items"]:
            text_val = ""
            person_id = ""
            for c in it["column_values"]:
                if c["id"] == HUDDLE_TEXT_COL:
                    text_val = c.get("text") or ""
                elif c["id"] == HUDDLE_PEOPLE_COL:
                    try:
                        v = json.loads(c.get("value") or "{}")
                        pts = v.get("personsAndTeams") or []
                        if pts:
                            person_id = str(pts[0].get("id"))
                    except Exception:
                        pass
            # legacy OR-KEY tokens (item name or Additional Info blob)
            for token in (it["name"] + " " + text_val).split():
                if token.startswith("OR-KEY:"):
                    legacy.add(token)
            # new-style signature from the permalink + assignee
            m = _URL_SIG_RE.search(text_val)
            if m and person_id:
                sigs.add("%s:%s:%s" % (m.group(1), m.group(2), person_id))
        cursor = page.get("cursor")
        pages += 1
        if not cursor or pages > 20:
            break
    return legacy, sigs


CREATE_ITEM_MUTATION = """
mutation ($board: ID!, $group: String!, $name: String!, $cols: JSON!) {
  create_item(board_id: $board, group_id: $group, item_name: $name,
              column_values: $cols, create_labels_if_missing: false) { id }
}
"""

CREATE_UPDATE_MUTATION = """
mutation ($item: ID!, $body: String!) {
  create_update(item_id: $item, body: $body) { id }
}
"""


def _html_escape(s):
    return ((s or "")
            .replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def post_mention_update(item_id, finding):
    """Post the message that tagged the consultant as an update on the new item,
    with a link back to the original update/reply on the campaign board."""
    author = _html_escape(finding.get("mention_author") or "-")
    when = _html_escape((finding.get("mention_date") or "")[:10])
    msg = _html_escape((finding.get("mention_text") or "").strip())
    url = finding.get("update_url") or ""
    body = (
        "<b>\U0001F514 Tagged by %s on %s</b><br>%s<br><br>"
        "\U0001F517 <a href=\"%s\">View the original update on monday.com</a>"
    ) % (author, when, msg, url)
    monday_gql(CREATE_UPDATE_MUTATION, {"item": int(item_id), "body": body})


def create_overdue_item(finding):
    name = finding["item_label"]
    # Additional Info now holds just the permalink to the triggering update.
    cols = {HUDDLE_TEXT_COL: finding.get("update_url") or ""}
    if finding.get("user_id"):
        cols[HUDDLE_PEOPLE_COL] = {"personsAndTeams": [{"id": int(finding["user_id"]), "kind": "person"}]}
    data = monday_gql(CREATE_ITEM_MUTATION, {
        "board": HUDDLE_BOARD_ID,
        "group": OVERDUE_GROUP_ID,
        "name": name[:255],
        "cols": json.dumps(cols),
    })
    new_id = data["create_item"]["id"]
    # Attach the tagging message as an update on the freshly-created item.
    try:
        post_mention_update(new_id, finding)
    except Exception as e:
        print("WARN could not post mention update on item %s: %s" % (new_id, e))
    return new_id


# ----------------------------------------------------------------------------
# Handler
# ----------------------------------------------------------------------------
def lambda_handler(event, context):
    event = event or {}
    # API Gateway proxy support
    if isinstance(event.get("body"), str):
        try:
            event = {**event, **json.loads(event["body"] or "{}")}
        except Exception:
            pass

    dry_run = event.get("dry_run")
    if dry_run is None:
        dry_run = os.environ.get("DRY_RUN", "0") == "1"
    dry_run = bool(dry_run)

    llm_key = os.environ.get("DEEPSEEK_API_KEY")
    if not llm_key:
        return _resp(500, {"error": "DEEPSEEK_API_KEY not configured"})

    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()
    since_dt = now - timedelta(days=LOOKBACK_DAYS)

    # --- DeepSeek connectivity self-test: {"test_llm": true} ---
    if event.get("test_llm"):
        synthetic = [{
            "update_id": "TEST1", "item_name": "Sample task", "campaign_name": "Demo",
            "posts": [
                {"author": "Regine Lim", "date": "2026-06-01T02:00:00Z",
                 "text": "hi @Jia Jia , please start KWP, eta soon, thanks!"},
            ],
        }]
        label_names = {"Jia Jia": ["Jia Jia"]}
        body = {
            "model": LLM_MODEL, "max_tokens": 1024, "temperature": 0,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content":
                    "Return JSON {\"overdue\":[{\"consultant\":\"Jia Jia\",\"update_id\":\"TEST1\","
                    "\"mention_text\":\"...\",\"mention_author\":\"...\",\"mention_date\":\"...\"}]} "
                    "for any consultant @-mentioned and not replied since. Current time "
                    + now_iso + "."},
                {"role": "user", "content":
                    "Consultant: Jia Jia. Thread:\nTHREAD update_id=TEST1\n  [ROOT] "
                    "2026-06-01T02:00:00Z | Regine Lim: hi @Jia Jia please start KWP"},
            ],
        }
        try:
            raw = deepseek_chat(llm_key, body)
            content = (raw.get("choices") or [{}])[0].get("message", {}).get("content")
            return _resp(200, {"ok": True, "raw_content": content,
                               "parsed": judge_threads(llm_key, label_names, synthetic, now_iso)})
        except Exception as e:
            return _resp(200, {"ok": False, "error": str(e)})

    started = time.time()
    print("Overdue Responses run | dry_run=%s | lookback=%dd | threshold=%dh"
          % (dry_run, LOOKBACK_DAYS, OVERDUE_HOURS))

    # Step 1 + 2
    campaign_map = build_campaign_map()
    # Optional cap for testing/sampling (event: {"max_boards": N})
    max_boards = event.get("max_boards")
    if max_boards:
        campaign_map = dict(list(campaign_map.items())[:int(max_boards)])
    resolved = resolve_consultants()
    print("Mapped %d campaign boards; resolved %d/%d consultants: %s"
          % (len(campaign_map), len(resolved),
             len(set(list(SEO_CONSULTANTS) + list(GEO_CONSULTANTS))),
             ", ".join(sorted(resolved.keys()))))

    # Step 4 prep: existing items for dedupe (legacy OR-KEY tokens + new-style
    # board:update:user signatures rebuilt from the permalink + assignee).
    try:
        seen_keys, seen_sigs = existing_signatures()
    except Exception as e:
        print("WARN could not read existing OVERDUE items: %s" % e)
        seen_keys, seen_sigs = set(), set()

    # Global roster display names (label -> [names to look for]).
    label_names = {}
    for lbl in set(list(SEO_CONSULTANTS) + list(GEO_CONSULTANTS)):
        disp = resolved.get(lbl, {}).get("display_name") or lbl
        label_names[lbl] = sorted({disp, lbl})

    # ---- Step 3a: fetch every campaign board's recent threads, concurrently ----
    candidates = []          # thread dicts, each tagged with board/campaign context
    update_ctx = {}          # update_id -> (board_id, info)
    boards_processed = 0

    def _work(board_id, info):
        threads = fetch_board_threads(board_id, since_dt)
        # names relevant to THIS board (its assigned consultants)
        names_for_board = []
        for lbl in info["consultants"]:
            names_for_board.extend(label_names.get(lbl, [lbl]))
        names_for_board = [n.lower() for n in names_for_board]
        out = []
        for t in threads:
            blob = " ".join((p["text"] or "") for p in t["posts"]).lower()
            if any(all(tok in blob for tok in nm.split()) for nm in names_for_board):
                t = dict(t)
                t["campaign_name"] = info["campaign_name"]
                out.append(t)
                update_ctx[t["update_id"]] = {
                    "board_id": board_id,
                    "info": info,
                    "item_name": t.get("item_name", "-"),
                    "item_id": t.get("item_id"),
                }
        return out

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futs = {pool.submit(_work, bid, info): bid for bid, info in campaign_map.items()}
        for fut in as_completed(futs):
            boards_processed += 1
            try:
                candidates.extend(fut.result())
            except Exception as e:
                print("WARN board %s failed: %s" % (futs[fut], e))

    print("Fetched %d boards; %d candidate threads mention a rostered consultant"
          % (boards_processed, len(candidates)))

    # ---- Step 3b/4: judge each candidate thread, one per LLM call, in parallel.
    # (deepseek-chat under-detects when threads are batched, so batch_size is 1.)
    overdue_raw = []
    debug_sink = [] if event.get("debug_raw") else None
    batch_size = int(event.get("judge_batch") or JUDGE_BATCH)
    batches = [candidates[i:i + batch_size] for i in range(0, len(candidates), batch_size)]
    llm_batches = len(batches)
    if batches:
        with ThreadPoolExecutor(max_workers=LLM_WORKERS) as pool:
            futs = [pool.submit(judge_threads, llm_key, label_names, b, now_iso, debug_sink)
                    for b in batches]
            for fut in as_completed(futs):
                try:
                    overdue_raw.extend(fut.result())
                except Exception as e:
                    print("WARN judge batch failed: %s" % e)

    findings = []
    dropped_validation = 0
    dropped_too_recent = 0
    for o in overdue_raw:
        lbl = (o.get("consultant") or "").strip()
        upd = o.get("update_id", "")
        ctx = update_ctx.get(upd)
        if lbl not in label_names or not ctx:
            continue
        board_id, info = ctx["board_id"], ctx["info"]
        item_name = ctx["item_name"]
        item_id = ctx.get("item_id")
        if lbl not in info["consultants"]:
            continue  # consultant not actually assigned to this campaign
        # Guard against mis-attribution: the quoted mention must actually name
        # this consultant (catches the LLM quoting a different person's tag).
        mtext = (o.get("mention_text") or "").lower()
        if not any(all(tok in mtext for tok in nm.lower().split())
                   for nm in label_names[lbl]):
            dropped_validation += 1
            print("DROP mis-attributed: %s not in mention %r" % (lbl, mtext[:80]))
            continue
        # Enforce the "more than a day" rule deterministically when we can parse
        # the mention timestamp (don't rely on the LLM's date arithmetic).
        mdt = _parse_dt(o.get("mention_date"))
        if mdt and (now - mdt) < timedelta(hours=OVERDUE_HOURS):
            dropped_too_recent += 1
            print("DROP too-recent: %s mention at %s" % (lbl, o.get("mention_date")))
            continue
        user = resolved.get(lbl, {})
        uid = user.get("user_id")
        # Dedupe identity: legacy OR-KEY (older items) OR the new
        # board:update:user signature (rebuilt from the permalink + assignee).
        key = _key(board_id, upd, lbl)
        sig = "%s:%s:%s" % (board_id, upd, uid) if uid else None
        if key in seen_keys or (sig and sig in seen_sigs):
            continue
        seen_keys.add(key)
        if sig:
            seen_sigs.add(sig)
        update_url = build_update_url(board_id, item_id, upd)
        # Item name is just the campaign — the consultant is shown in the
        # "Assigned to" people column, so no name prefix is needed.
        item_label = "%s (%s)" % (info["campaign_name"], info["campaign_code"] or "no code")
        findings.append({
            "consultant": lbl,
            "user_id": uid,
            "campaign_name": info["campaign_name"],
            "campaign_code": info["campaign_code"],
            "board_id": board_id,
            "item_id": item_id,
            "item_name": item_name,
            "mention_text": o.get("mention_text"),
            "mention_author": o.get("mention_author"),
            "mention_date": o.get("mention_date"),
            "item_label": item_label,
            "update_url": update_url,
            "key": key,
        })

    created = []
    if not dry_run:
        for f in findings:
            try:
                new_id = create_overdue_item(f)
                f["created_item_id"] = new_id
                created.append(new_id)
            except Exception as e:
                print("ERROR creating item for %s: %s" % (f["item_label"], e))
                f["error"] = str(e)

    summary = {
        "dry_run": dry_run,
        "boards_in_scope": len(campaign_map),
        "boards_processed": boards_processed,
        "consultants_resolved": sorted(resolved.keys()),
        "consultants_unresolved": sorted(
            set(list(SEO_CONSULTANTS) + list(GEO_CONSULTANTS)) - set(resolved.keys())
        ),
        "candidate_threads": len(candidates),
        "llm_batches": llm_batches,
        "overdue_raw": len(overdue_raw),
        "overdue_found": len(findings),
        "dropped_misattributed": dropped_validation,
        "dropped_too_recent": dropped_too_recent,
        "items_created": len(created),
        "elapsed_sec": round(time.time() - started, 1),
        "findings": findings,
    }
    if debug_sink is not None:
        summary["debug_samples"] = debug_sink
    print("Done in %ss | overdue=%d | created=%d | dry_run=%s"
          % (summary["elapsed_sec"], len(findings), len(created), dry_run))
    return _resp(200, summary)


def _resp(status, payload):
    return {
        "statusCode": status,
        "headers": {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type,Authorization,x-api-key",
            "Access-Control-Allow-Methods": "OPTIONS,POST,GET",
            "Content-Type": "application/json",
        },
        "body": json.dumps(payload, default=str),
    }
