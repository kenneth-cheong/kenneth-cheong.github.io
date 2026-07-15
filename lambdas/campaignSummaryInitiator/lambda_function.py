import json
import os
import time
import boto3
import requests
from datetime import datetime, timedelta, timezone

MONDAY_API_KEY = os.environ["MONDAY_API_KEY"]
ICIR_BOARD_ID = "2845615047"
MONDAY_URL = "https://api.monday.com/v2"
PROCESSOR_FUNCTION = "campaignSummaryProcessor"
GCHAT_WEBHOOK = os.environ.get("GCHAT_WEBHOOK", "")  # Google Chat incoming-webhook URL

FETCH_COLS = [
    "text_mknpdk1p",      # [Tech] Board ID
    "long_text_mm3cc8x2", # [Tech] Campaign Summary
    "tags",               # [BD] Project Type
    "status0",            # [CSM] Campaign Status
    "status3",            # [MB] Overall Campaign Status
    "color1",             # SEO Campaign Status
    "color_mm1mymh5",     # GEO Campaign Status
    "status929",          # SMM Status
    "text_mkzhnmbv",      # Campaign Code
]

EXCLUDE_STATUSES = {"Completed", "Terminated", "Expired", "[PSG] Expired", "Abandoned"}

lambda_client = boto3.client("lambda", region_name="ap-southeast-1")


def notify(message):
    if not GCHAT_WEBHOOK:
        return
    try:
        requests.post(GCHAT_WEBHOOK, json={"text": f"🔴 *campaignSummaryOrchestrator*: {message}"}, timeout=10)
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
        resp.raise_for_status()
        data = resp.json()
        if "error_message" in data:
            raise Exception(data["error_message"])
        return data

    return with_retries(_call)


def fetch_icir_items(cutoff):
    cols_json = json.dumps(FETCH_COLS)
    no_summary, recently_updated = [], []
    cursor = None

    while True:
        if cursor:
            query = f"""
            query($c: String!) {{
                next_items_page(limit: 200, cursor: $c) {{
                    cursor
                    items {{
                        id name updated_at
                        group {{ title }}
                        column_values(ids: {cols_json}) {{ id text }}
                    }}
                }}
            }}"""
            page = gql(query, {"c": cursor})["data"]["next_items_page"]
        else:
            query = f"""
            query($b: ID!) {{
                boards(ids: [$b]) {{
                    items_page(limit: 200) {{
                        cursor
                        items {{
                            id name updated_at
                            group {{ title }}
                            column_values(ids: {cols_json}) {{ id text }}
                        }}
                    }}
                }}
            }}"""
            page = gql(query, {"b": ICIR_BOARD_ID})["data"]["boards"][0]["items_page"]

        for item in page["items"]:
            cols = {cv["id"]: cv.get("text") or "" for cv in item["column_values"]}
            item["_cols"] = cols

            csm_status = (cols.get("status0") or "").strip()
            if not csm_status or csm_status in EXCLUDE_STATUSES:
                continue

            has_summary = bool((cols.get("long_text_mm3cc8x2") or "").strip())
            updated = datetime.fromisoformat(item["updated_at"].replace("Z", "+00:00"))

            if not has_summary:
                no_summary.append(item)
            elif updated >= cutoff:
                recently_updated.append(item)

        cursor = page.get("cursor")
        if not cursor:
            break

    return no_summary + recently_updated


def fetch_specific_items(item_ids):
    cols_json = json.dumps(FETCH_COLS)
    ids_gql = ", ".join(item_ids)
    query = f"""
    query {{
        items(ids: [{ids_gql}]) {{
            id name updated_at
            group {{ title }}
            column_values(ids: {cols_json}) {{ id text }}
        }}
    }}"""
    data = gql(query)
    items = data.get("data", {}).get("items", [])
    result = []
    for item in items:
        cols = {cv["id"]: cv.get("text") or "" for cv in item["column_values"]}
        item["_cols"] = cols
        csm_status = (cols.get("status0") or "").strip()
        if not csm_status or csm_status in EXCLUDE_STATUSES:
            continue
        result.append(item)
    return result


def lambda_handler(event, context):
    try:
        item_ids = event.get("item_ids")

        if item_ids:
            print(f"Fetching {len(item_ids)} specific items: {item_ids}")
            items = fetch_specific_items([str(i) for i in item_ids])
        else:
            cutoff = datetime.now(timezone.utc) - timedelta(days=14)
            print(f"Fetching items updated since {cutoff.strftime('%Y-%m-%dT%H:%M:%SZ')}")
            items = fetch_icir_items(cutoff)
        print(f"Dispatching {len(items)} items to processor")

        dispatched = 0
        failed = []
        for item in items:
            # Remove non-serialisable datetime objects before passing as payload
            item.pop("updated_at", None)
            try:
                lambda_client.invoke(
                    FunctionName=PROCESSOR_FUNCTION,
                    InvocationType="Event",
                    Payload=json.dumps(item),
                )
                dispatched += 1
            except Exception as e:
                print(f"Failed to dispatch item {item['id']}: {e}")
                failed.append(item["id"])

        if failed:
            notify(f"Failed to dispatch {len(failed)} item(s): {', '.join(failed[:5])}{'...' if len(failed) > 5 else ''}")

        print(f"Dispatched {dispatched}/{len(items)}")
        return {"status": "dispatched", "count": dispatched, "failed": len(failed)}

    except Exception as e:
        msg = f"Orchestrator failed: {e}"
        print(msg)
        notify(msg)
        raise
