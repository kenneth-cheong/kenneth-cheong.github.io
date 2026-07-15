import json
import os
import re
import time
import urllib3
import requests

MONDAY_API_KEY = os.environ["MONDAY_API_KEY"]
DEEPSEEK_API_KEY = os.environ["DEEPSEEK_API_KEY"]
DEEPSEEK_MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-chat")
ICIR_BOARD_ID = "2845615047"
SUMMARY_COL_ID = "long_text_mm3cc8x2"
MONDAY_URL = "https://api.monday.com/v2"
GCHAT_WEBHOOK = os.environ.get("GCHAT_WEBHOOK", "")  # Google Chat incoming-webhook URL

http = urllib3.PoolManager()


def notify(message):
    if not GCHAT_WEBHOOK:
        return
    try:
        requests.post(GCHAT_WEBHOOK, json={"text": f"🔴 *campaignSummaryProcessor*: {message}"}, timeout=10)
    except Exception:
        pass


def with_retries(fn, max_attempts=3, base_delay=3):
    for attempt in range(max_attempts):
        try:
            return fn()
        except Exception as e:
            if attempt == max_attempts - 1:
                raise
            wait = base_delay * (2 ** attempt)
            print(f"Attempt {attempt + 1} failed: {e}. Retrying in {wait}s...")
            time.sleep(wait)


def gql(query, variables=None):
    def _call():
        resp = requests.post(
            MONDAY_URL,
            headers={
                "Authorization": MONDAY_API_KEY,
                "Content-Type": "application/json",
                "API-Version": "2024-01",
            },
            json={"query": query, "variables": variables or {}},
            timeout=20,
        )
        # Surface Monday's actual error body BEFORE raising. A bare
        # "400 Bad Request" from raise_for_status() hides the real GraphQL
        # parse/validation message, which is what we need to debug & replay.
        if resp.status_code >= 400:
            raise Exception(f"Monday HTTP {resp.status_code}: {resp.text[:800]}")
        data = resp.json()
        if data.get("errors"):
            raise Exception(f"Monday GraphQL errors: {json.dumps(data['errors'])[:800]}")
        if "error_message" in data:
            raise Exception(data["error_message"])
        return data

    return with_retries(_call)


# Matches both the current "**Campaign:**" summaries and the older bare
# "Campaign:" format still present in item histories.
SUMMARY_HEADER_RE = re.compile(r"^\s*(\*\*\s*Campaign\s*:\s*\*\*|Campaign\s*:)", re.I)


def fetch_existing_summary(item_id):
    """Return the last summary we wrote, in full.

    Monday silently caps long_text columns at 2000 chars, so the column copy
    of the previous summary is usually cut off mid-sentence — seeding the
    prompt from it asks the model to "preserve" sections it cannot see, and
    Trajectory / Peculiarities get re-invented from scratch every run. The
    untruncated text is on the item's updates, which have no such cap.

    Matches on shape rather than author: create_update posts under the API
    key's own user, and staff comment on the same items.
    """
    query = """
    query ($id: [ID!]) {
        items(ids: $id) {
            updates(limit: 25) { text_body created_at }
        }
    }"""
    data = gql(query, {"id": [str(item_id)]})
    items = data.get("data", {}).get("items", [])
    if not items:
        return ""

    summaries = [
        u for u in (items[0].get("updates") or [])
        if u and SUMMARY_HEADER_RE.match(u.get("text_body") or "")
    ]
    if not summaries:
        return ""

    summaries.sort(key=lambda u: u.get("created_at") or "", reverse=True)
    return (summaries[0].get("text_body") or "").strip()


def fetch_board_context(board_id):
    def _call():
        query = f"""
        query {{
            boards(ids: [{board_id}]) {{
                items_page(limit: 75) {{
                    items {{
                        id name
                        column_values {{ id text }}
                        updates(limit: 8) {{
                            text_body created_at
                            creator {{ name }}
                        }}
                    }}
                }}
            }}
        }}"""
        data = gql(query)
        boards = data.get("data", {}).get("boards", [])
        if not boards:
            return []
        return boards[0].get("items_page", {}).get("items", [])

    return with_retries(_call)


def call_llm(prompt):
    def _call():
        resp = http.request(
            "POST",
            "https://api.deepseek.com/chat/completions",
            headers={
                "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
                "content-type": "application/json",
            },
            body=json.dumps({
                "model": DEEPSEEK_MODEL,
                "max_tokens": 1500,
                "messages": [{"role": "user", "content": prompt}],
            }),
        )
        result = json.loads(resp.data.decode("utf-8"))
        if resp.status != 200:
            raise Exception(f"DeepSeek API error {resp.status}: {result}")
        return result["choices"][0]["message"]["content"]

    return with_retries(_call)


# Both mutations below use GraphQL VARIABLES rather than f-string interpolation.
# This is what fixes the 400 Bad Requests: the previous create_update built the
# body via json.dumps(summary), which emits astral-plane emoji (🔥 U+1F525,
# 🌐 U+1F310) as surrogate-pair \uXXXX escapes that Monday's GraphQL string
# parser rejects. Passing the text as a JSON variable sidesteps GraphQL
# string-literal parsing entirely, so emoji, apostrophes (D'Resort), quotes and
# newlines all transit safely.
def write_to_monday(item_id, summary):
    mutation = (
        "mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {"
        " change_column_value(board_id: $boardId, item_id: $itemId,"
        " column_id: $columnId, value: $value) { id } }"
    )
    variables = {
        "boardId": str(ICIR_BOARD_ID),
        "itemId": str(item_id),
        "columnId": SUMMARY_COL_ID,
        "value": json.dumps({"text": summary}),
    }
    return gql(mutation, variables)


def post_update_to_monday(item_id, summary):
    mutation = (
        "mutation ($itemId: ID!, $body: String!) {"
        " create_update(item_id: $itemId, body: $body) { id } }"
    )
    variables = {"itemId": str(item_id), "body": summary}
    return gql(mutation, variables)


def build_prompt(item, board_items, existing=None):
    c = item["_cols"]
    # Falls back to the (capped) column copy when no summary update is available.
    if existing is None:
        existing = (c.get("long_text_mm3cc8x2") or "").strip()

    status_block = "\n".join(filter(None, [
        f"Service Type: {c.get('tags', '')}",
        f"Campaign Code: {c.get('text_mkzhnmbv', '')}",
        f"Group: {item.get('group', {}).get('title', '')}",
        f"CSM Campaign Status: {c.get('status0', '')}",
        f"MB Overall Status: {c.get('status3', '')}",
        f"SEO Status: {c.get('color1', '')}",
        f"GEO Status: {c.get('color_mm1mymh5', '')}",
        f"SMM Status: {c.get('status929', '')}",
    ]))

    items_text = ""
    updates_text = ""

    if board_items:
        rows = []
        all_updates = []

        for bi in board_items[:40]:
            non_empty = [
                f"{cv['id']}={cv['text']}"
                for cv in bi.get("column_values", [])
                if (cv.get("text") or "").strip()
            ]
            if non_empty:
                rows.append(f"  • {bi['name']}: {', '.join(non_empty[:5])}")

            for u in bi.get("updates", []) or []:
                if not u:
                    continue
                all_updates.append({
                    "created_at": u.get("created_at", ""),
                    "author": (u.get("creator") or {}).get("name", ""),
                    "text": u.get("text_body", ""),
                    "item_name": bi["name"],
                })

        if rows:
            items_text = "\n\nCAMPAIGN BOARD ITEM STATUSES:\n" + "\n".join(rows[:25])

        all_updates.sort(key=lambda x: x["created_at"], reverse=True)
        if all_updates:
            lines = [
                f"[{u['created_at'][:10]}] {u['author']} on '{u['item_name']}': {u['text'][:200]}"
                for u in all_updates[:15]
            ]
            updates_text = "\n\nRECENT TEXT UPDATES FROM CAMPAIGN BOARD:\n" + "\n".join(lines)

    if existing:
        instruction = (
            "You are reviewing an existing campaign summary. "
            "Update it to reflect the latest status data and any new updates from the campaign board. "
            "Preserve accurate sections; revise only what has changed. Keep the same format.\n\n"
            f"EXISTING SUMMARY:\n{existing}"
        )
    else:
        instruction = (
            "You are generating a new campaign summary from the data below. "
            "Use the exact format specified."
        )

    return f"""{instruction}

CAMPAIGN: {item['name']}
{status_block}{items_text}{updates_text}

Write the summary in this exact format:
**Campaign:** [name + URL + campaign code] ([service type])
**Status:** [current overall status]
**Strategy:** [campaign approach, targeting, and scope — 2-3 sentences]
**Progress:** [completed milestones, payment statuses, deliverables, reports — be specific]
**Challenges & Notes:** [blockers, payment issues, client friction, structural problems — write "None identified." if none]
**Trajectory:** [where campaign is heading — on track / at risk / concluding / stalled]
**Peculiarities & Notable Updates:** [unusual patterns, notable team decisions, or observations worth flagging]"""


def lambda_handler(event, context):
    item_id = event.get("id", "unknown")
    item_name = event.get("name", "unknown")

    try:
        board_id = (event.get("_cols", {}).get("text_mknpdk1p") or "").strip()

        board_items = None
        if board_id:
            try:
                board_items = fetch_board_context(board_id)
            except Exception as e:
                print(f"Board context fetch failed for {board_id} after retries: {e}")
                # Continue without board context rather than failing the whole item

        # Prefer the full previous summary from the item's updates over the
        # column copy, which Monday has usually truncated at 2000 chars.
        existing = ""
        try:
            existing = fetch_existing_summary(item_id)
        except Exception as e:
            print(f"Existing-summary fetch failed for {item_id}: {e}")
        if not existing:
            existing = (event.get("_cols", {}).get("long_text_mm3cc8x2") or "").strip()

        prompt = build_prompt(event, board_items, existing)
        summary = call_llm(prompt)
        write_to_monday(item_id, summary)
        post_update_to_monday(item_id, summary)

        print(f"Successfully updated item {item_id}: {item_name}")
        return {"status": "success", "item_id": item_id}

    except Exception as e:
        msg = f"Failed for '{item_name}' (id={item_id}): {e}"
        print(msg)
        notify(msg)
        raise
