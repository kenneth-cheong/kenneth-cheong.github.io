import json
import os
import time
import re
import math
import boto3
import requests
import pandas as pd
from datetime import datetime, date
import calendar
from concurrent.futures import ThreadPoolExecutor, as_completed

from google.oauth2 import service_account
from google.oauth2.service_account import Credentials as SACredentials
from googleapiclient.discovery import build
import gspread


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def get_secret(secret_name, region='ap-southeast-1'):
    client = boto3.client('secretsmanager', region_name=region)
    resp = client.get_secret_value(SecretId=secret_name)
    return json.loads(resp['SecretString'])


def fetch_monday_board(api_key, board_id, pages=6):
    """Paginate through a Monday board and return all items."""
    api_url = "https://api.monday.com/v2"
    headers = {"Authorization": api_key, "API-Version": "2025-04"}

    query = (
        '{boards (ids:' + str(board_id) + ')'
        '{items_page (limit:100)'
        '{cursor items { group {title id} id name '
        'column_values{ column{ id title } text value}'
        'subitems { column_values{text value}}}}}}'
    )
    r = requests.post(url=api_url, json={"query": query}, headers=headers)
    board_data = r.json()
    cursor = board_data["data"]["boards"][0]["items_page"]["cursor"]
    items = list(board_data["data"]["boards"][0]["items_page"]["items"])

    for _ in range(pages - 1):
        if not cursor:
            break
        query = (
            '{next_items_page (limit:100, cursor:"' + cursor + '") '
            '{cursor items { group {title id} id name '
            'column_values{ column{ id title } text value}'
            'subitems { column_values{text value}}}}}'
        )
        r = requests.post(url=api_url, json={"query": query}, headers=headers)
        board_data = r.json()
        cursor = board_data["data"]["next_items_page"]["cursor"]
        items += board_data["data"]["next_items_page"]["items"]
        time.sleep(2)

    return items


def build_integrated_df(combined_query):
    """Convert raw Monday board items into a DataFrame."""
    dictionary = {}
    for count, col in enumerate(combined_query[0]["column_values"]):
        dictionary[col["column"]["title"]] = count

    df = pd.DataFrame()
    for count, campaign in enumerate(combined_query):
        df.at[count, "client"] = campaign["name"]
        df.at[count, "id"] = campaign["id"]
        df.at[count, "group_id"] = campaign["group"]["id"]
        for key, idx in dictionary.items():
            df.at[count, key] = campaign["column_values"][idx]["text"]

    # Extract domain
    for index, row in df.iterrows():
        for word in row["client"].split():
            if "//" in word or ".com" in word or "www" in word:
                df.at[index, "domain"] = (
                    word.replace("https://", "")
                        .replace("www.", "")
                        .replace("http://", "")
                ).split("/")[0]

    return df, dictionary


def calc_kpi_hit_rate(df):
    for index, row in df.iterrows():
        try:
            if row["SEO Campaign Type"] == "Standard":
                hit = int(row["SEO [Reg] P1 KWs"]) >= int(row["SEO [Reg] KPI KWs"])
            elif row["SEO Campaign Type"] == "Cluster":
                hit = int(row["SEO [Cluster] Clusters Hit"]) >= int(row["SEO [Cluster] KPI"])
            elif row["SEO Campaign Type"] == "Special":
                hit = int(row["SEO KW Manual Check"]) == 999
            else:
                hit = False
            df.at[index, "[SEO] KPI HIT RATE"] = "KPI HIT" if hit else "NOT HIT"
        except (ValueError, KeyError):
            df.at[index, "[SEO] KPI HIT RATE"] = "INPUT KPI"
    return df


def update_sheet_data(gs_client, spreadsheet_name, worksheet_name, df):
    ws = gs_client.open(spreadsheet_name).worksheet(worksheet_name)
    ws.clear()
    ws.update("A2:ZZ99999", df.fillna("").values.tolist())
    ws.update("A1:ZZ1", [df.columns.values.tolist()])


# ---------------------------------------------------------------------------
# SE Ranking parallelised fetchers
# ---------------------------------------------------------------------------

def fetch_keyword_groups_for_campaign(campaign_id, se_headers):
    result = {}
    for attempt in range(10):
        try:
            s = requests.get(
                f"https://api4.seranking.com/keyword-groups/{campaign_id}",
                headers=se_headers,
                timeout=30,
            )
            for line in s.json():
                result[str(line["id"])] = line["name"]
            return result
        except Exception as exc:
            print(f"Attempt {attempt+1} failed for keyword-groups/{campaign_id}: {exc}")
            if attempt < 9:
                time.sleep(min(45, 5 * (attempt + 1)))
    return result


def fetch_positions_for_campaign(campaign_id, se_headers, formatted_date):
    result = {}
    for attempt in range(10):
        try:
            url = (
                f"https://api4.seranking.com/sites/{campaign_id}/positions"
                f"?date_from={formatted_date}&date_to={formatted_date}"
            )
            r = requests.get(url, headers=se_headers, timeout=30)
            for keyword in r.json()[0]["keywords"]:
                result[keyword["id"]] = {
                    "campaign_id": campaign_id,
                    "name": keyword["name"],
                    "position": keyword["positions"][0]["pos"],
                    "group_id": keyword["group_id"],
                }
            return result
        except Exception as exc:
            print(f"Attempt {attempt+1} failed for positions/{campaign_id}: {exc}")
            if attempt < 9:
                time.sleep(min(45, 5 * (attempt + 1)))
    return result


# ---------------------------------------------------------------------------
# Monday.com update helpers
# ---------------------------------------------------------------------------

BOARD_ID = 2845615047


def monday_update_column(item_id, column_id, value, api_key,
                          api_url="https://api.monday.com/v2"):
    headers = {"Authorization": api_key, "API-Version": "2025-04"}
    query = (
        f'mutation{{ change_simple_column_value('
        f'item_id: {item_id}, board_id: {BOARD_ID}, '
        f'column_id: "{column_id}", value: "{value}") {{ id }} }}'
    )
    return requests.post(url=api_url, json={"query": query}, headers=headers).json()


def batch_monday_updates(updates, api_key,
                          api_url="https://api.monday.com/v2", batch_size=10):
    """
    updates: list of (item_id, column_id, value)
    Sends multiple mutations per request using GraphQL aliases.
    """
    headers = {"Authorization": api_key, "API-Version": "2025-04"}
    for i in range(0, len(updates), batch_size):
        batch = updates[i : i + batch_size]
        parts = []
        for j, (item_id, col_id, val) in enumerate(batch):
            parts.append(
                f'u{j}: change_simple_column_value('
                f'item_id: {item_id}, board_id: {BOARD_ID}, '
                f'column_id: "{col_id}", value: "{val}") {{ id }}'
            )
        query = "mutation { " + " ".join(parts) + " }"
        r = requests.post(url=api_url, json={"query": query}, headers=headers)
        print(r.json())


def monday_create_update(item_id, body, api_key,
                          api_url="https://api.monday.com/v2"):
    headers = {"Authorization": api_key}
    text = body.replace('"', '\\"').replace("\n", "\\n")
    query = f'mutation {{ create_update (item_id: {item_id}, body: "{text}") {{id}}}}'
    return requests.post(url=api_url, json={"query": query}, headers=headers).json()


# ---------------------------------------------------------------------------
# Working-day helpers
# ---------------------------------------------------------------------------

def get_working_days(year):
    days = []
    for month in range(1, 13):
        for day in range(1, calendar.monthrange(year, month)[1] + 1):
            d = date(year, month, day)
            if d.weekday() < 5:
                days.append(d)
    return days


def get_working_days_excluding_holidays(year, holidays):
    return [d for d in get_working_days(year) if d not in holidays]


# ---------------------------------------------------------------------------
# Lambda entry point
# ---------------------------------------------------------------------------

def lambda_handler(event, context):
    pd.options.display.max_colwidth = 500
    pd.set_option("display.max_rows", None)

    # --- Credentials ---
    bubbly_creds = get_secret("bubbly-json")
    monday_api_key = os.environ["MONDAY_API_KEY"]
    se_token = os.environ.get("SE_RANKING_TOKEN", "")
    api_url = "https://api.monday.com/v2"
    today_str = datetime.today().strftime("%Y-%m-%d")

    # --- 1. Fetch Monday board (once for initial data) ---
    print("Fetching Monday board...")
    combined = fetch_monday_board(monday_api_key, BOARD_ID, pages=6)
    df_integrated, _ = build_integrated_df(combined)

    df_integrated = df_integrated[
        (~df_integrated["SEO Campaign Status"].str.contains("Expired", na=False))
        & (~df_integrated["client"].str.contains("TEMPLATE", na=False))
    ]
    df_integrated = calc_kpi_hit_rate(df_integrated)

    # --- 2. Google Sheets update (all 4 sheets in parallel) ---
    print("Updating Google Sheets...")
    scope = ["https://spreadsheets.google.com/feeds", "https://www.googleapis.com/auth/drive"]
    gs_creds = SACredentials.from_service_account_info(bubbly_creds, scopes=scope)
    gs_client = gspread.authorize(gs_creds)

    sheets = [
        ("Individual Timeliness Report", "Integrated Board"),
        ("MediaOne Backlinks Mastersheet (2024)", "Integrated Board"),
        ("MediaOne Backlinks Mastersheet (2025)", "Integrated Board"),
        ("Media Buy Weekly WIP", "Integrated Board"),
    ]
    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = [
            executor.submit(update_sheet_data, gs_client, name, ws, df_integrated)
            for name, ws in sheets
        ]
        for f in as_completed(futures):
            try:
                f.result()
            except Exception as exc:
                print(f"Sheet update error: {exc}")

    # --- 3. Build campaign subsets for SE Ranking processing ---
    df_seo = df_integrated.copy()
    for index, row in df_seo.iterrows():
        for word in row["client"].split(" "):
            if "://" in word:
                df_seo.at[index, "website"] = (
                    word.replace("https://", "").replace("http://", "").replace("www.", "").rstrip("/")
                )
    df_seo.rename(columns={"id": "integrated_item_id"}, inplace=True)
    df_seo = df_seo[df_seo["[BD]Project Type"].str.contains("seo", na=False)]

    active_statuses = [
        "New Onboarding (PM)", "Pending Renewal (Sales)", "Lived (PM)",
        "Pending Website (PM)", "Guarantee (SEO)", "Renewed No Pause (Sales)",
        "Lit (SEO)", "On Hold  - PSG (PM)", "On Hold (PM)", "Delayed (PM)",
    ]
    df_monday_current = df_seo[df_seo["SEO Campaign Status"].isin(active_statuses)]
    df_psg_monday = df_monday_current[
        (~df_monday_current["client"].str.contains("COPY", na=False))
        & (df_monday_current["client"].str.contains("PSG", na=False))
    ]
    df_monday = df_monday_current[~df_monday_current["client"].str.contains("PSG", na=False)]

    live_statuses = [
        "Lived (PM)", "On Hold (PM)", "On Hold - PSG (PM)", "Guarantee (SEO)",
        "Lit (SEO)", "Renewed No Pause", "Renewed No Pause (Sales)", "Pending Website (PM)",
        "Renewed Paused", "Pending Renewal (Sales)", "New Onboarding (PM)",
    ]
    df_monday_filtered = df_monday[df_monday["SEO Campaign Status"].isin(live_statuses)]
    df_monday_cluster = df_monday_filtered[df_monday_filtered["SEO Campaign Type"] == "Cluster"]
    df_monday_standard = df_monday_filtered[df_monday_filtered["SEO Campaign Type"] == "Standard"]

    # --- 4. SE Ranking: get all campaign IDs ---
    print("Fetching SE Ranking campaign list...")
    se_headers = {"Authorization": f"Token {se_token}", "Content-Type": "application/json"}
    r = requests.get("https://api4.seranking.com/sites", headers=se_headers)
    campaign_ids = []
    campaign_id_dict = {}
    for campaign in r.json():
        if campaign["keyword_count"] > 0:
            campaign_ids.append(campaign["id"])
            campaign_id_dict[campaign["id"]] = campaign["title"]

    # --- 5. Parallel: fetch keyword groups ---
    print(f"Fetching keyword groups for {len(campaign_ids)} campaigns in parallel...")
    keyword_group_dict = {}
    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = {
            executor.submit(fetch_keyword_groups_for_campaign, cid, se_headers): cid
            for cid in campaign_ids
        }
        for future in as_completed(futures):
            try:
                keyword_group_dict.update(future.result())
            except Exception as exc:
                print(f"Keyword group error {futures[future]}: {exc}")

    # --- 6. Parallel: fetch positions ---
    print(f"Fetching positions for {len(campaign_ids)} campaigns in parallel...")
    rankings_dict = {}
    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = {
            executor.submit(fetch_positions_for_campaign, cid, se_headers, today_str): cid
            for cid in campaign_ids
        }
        for future in as_completed(futures):
            try:
                rankings_dict.update(future.result())
            except Exception as exc:
                print(f"Position error {futures[future]}: {exc}")

    # Build SE Ranking DataFrame
    if not rankings_dict:
        print("No rankings data returned — aborting.")
        return {"statusCode": 500, "body": "No SE Ranking data"}

    df_seranking = pd.DataFrame(rankings_dict).transpose().reset_index()
    df_seranking.columns = ["keyword_id", "campaign_id", "keyword", "google_ranking", "group_id"]
    df_seranking["tag"] = df_seranking["group_id"].apply(
        lambda g: keyword_group_dict.get(str(g), "Unknown")
    )
    df_seranking["title"] = df_seranking["campaign_id"].apply(
        lambda c: campaign_id_dict.get(c, "Unknown")
    )
    df_seranking = df_seranking[
        (~df_seranking["tag"].isin(["Test", "FOC"]))
        & (~df_seranking["title"].isin(["MediaOne"]))
    ][["keyword", "google_ranking", "tag", "title"]]

    # --- 7. Standard campaigns: collate & detect KPI changes ---
    merged = pd.merge(
        df_seranking, df_monday_standard,
        left_on="title", right_on="SE Ranking Project Name", how="right",
    )

    stats = []
    for cid in merged["integrated_item_id"].unique():
        df_temp = merged[merged["integrated_item_id"] == cid]
        stats.append({
            "campaign_id": cid,
            "p1_kws": str(len(df_temp[(df_temp["google_ranking"] > 0) & (df_temp["google_ranking"] < 11)])),
            "p2_kws": str(len(df_temp[(df_temp["google_ranking"] > 10) & (df_temp["google_ranking"] < 21)])),
            "total_kws": str(len(df_temp)),
            "kpi_kws": df_temp["SEO [Reg] KPI KWs"].iloc[0],
            "title": df_temp["title"].iloc[0] if "title" in df_temp.columns else "",
        })
    df_new = pd.DataFrame(stats)

    df_compare = df_new.merge(
        df_monday_current[df_monday_current["SEO [Reg] P1 KWs"] != ""][
            ["integrated_item_id", "SEO [Reg] P1 KWs"]
        ],
        how="left", left_on="campaign_id", right_on="integrated_item_id",
    )
    df_compare = df_compare[
        (df_compare["kpi_kws"] != "") & (df_compare["integrated_item_id"].notna())
    ]
    df_compare[["p1_kws", "p2_kws", "total_kws", "kpi_kws", "SEO [Reg] P1 KWs"]] = (
        df_compare[["p1_kws", "p2_kws", "total_kws", "kpi_kws", "SEO [Reg] P1 KWs"]].astype("int32")
    )

    df_now_hit = df_compare[
        (df_compare["SEO [Reg] P1 KWs"] < df_compare["kpi_kws"])
        & (df_compare["p1_kws"] >= df_compare["kpi_kws"])
    ]
    df_now_not_hit = df_compare[
        (df_compare["p1_kws"] < df_compare["SEO [Reg] P1 KWs"])
        & (df_compare["p1_kws"] < df_compare["kpi_kws"])
    ]

    # --- 8. Google Chat: KPI change alerts ---
    chat_creds = service_account.Credentials.from_service_account_info(
        bubbly_creds, scopes=["https://www.googleapis.com/auth/chat.bot"]
    )
    chat_service = build("chat", "v1", credentials=chat_creds)
    space_alerts = "spaces/AAAA5DO8AyE"

    def _send_chat(space, text):
        chat_service.spaces().messages().create(parent=space, body={"text": text}).execute()

    if len(df_now_hit) > 0:
        msg = "Newly KPI Hit Campaigns\n\n"
        for _, row in df_now_hit.iterrows():
            try:
                msg += f"{row['title']} - was {row['SEO [Reg] P1 KWs']}/{row['kpi_kws']}, now {row['p1_kws']}/{row['kpi_kws']}\n"
            except Exception:
                pass
        _send_chat(space_alerts, msg)

    if len(df_now_not_hit) > 0:
        msg = "Now Not Hit Campaigns\n\n"
        for _, row in df_now_not_hit.iterrows():
            try:
                msg += f"{row['title']} - was {row['SEO [Reg] P1 KWs']}/{row['kpi_kws']}, now {row['p1_kws']}/{row['kpi_kws']}\n"
            except Exception:
                pass
        _send_chat(space_alerts, msg)

    # --- 9. Batch Monday updates: standard P1 + P2 ---
    print("Updating Monday standard P1/P2 columns...")
    std_updates = []
    for _, row in df_new.iterrows():
        std_updates.append((row["campaign_id"], "numbers98", row["p1_kws"]))
        std_updates.append((row["campaign_id"], "numbers27", row["p2_kws"]))
    batch_monday_updates(std_updates, monday_api_key, api_url)

    # --- 10. Cluster campaigns ---
    merged_cluster = pd.merge(
        df_seranking, df_monday_cluster,
        left_on="title", right_on="SE Ranking Project Name", how="right",
    )
    cluster_summary = (
        merged_cluster[
            (merged_cluster["google_ranking"] > 0) & (merged_cluster["google_ranking"] < 11)
        ]
        .groupby(["title", "tag"]).count().reset_index()
        .groupby("title").count()
    )
    cluster_update = (
        pd.merge(cluster_summary[["tag"]], merged_cluster, on="title", how="left")
        .drop_duplicates(subset=["title"], keep="first")
    )
    cluster_updates = [
        (str(row["integrated_item_id"]), "numbers_18", str(row["tag_x"]))
        for _, row in cluster_update[["title", "integrated_item_id", "tag_x"]].iterrows()
    ]
    batch_monday_updates(cluster_updates, monday_api_key, api_url)

    # --- 11. PSG campaigns ---
    df_psg_seranking = df_seranking[df_seranking["title"].str.contains("PSG", na=False)]
    psg_merged = pd.merge(
        df_psg_monday.astype(str), df_psg_seranking,
        left_on="SE Ranking Project Name", right_on="title", how="left",
    ).dropna(subset=["title"])

    psg_stats = []
    for cid in psg_merged["integrated_item_id"].unique():
        df_temp = psg_merged[psg_merged["integrated_item_id"] == cid]
        psg_stats.append({
            "monday_campaign_id": cid,
            "p1_kws": str(len(df_temp[(df_temp["google_ranking"] > 0) & (df_temp["google_ranking"] < 11)])),
            "p2_kws": str(len(df_temp[(df_temp["google_ranking"] > 10) & (df_temp["google_ranking"] < 21)])),
        })
    df_new_psg = pd.DataFrame(psg_stats)

    psg_updates = []
    for _, row in df_new_psg.iterrows():
        psg_updates.append((row["monday_campaign_id"], "numbers98", row["p1_kws"]))
        psg_updates.append((row["monday_campaign_id"], "numbers27", row["p2_kws"]))
    batch_monday_updates(psg_updates, monday_api_key, api_url)

    # --- 12. Special campaigns (hardcoded KPI logic) ---

    # First Aid
    df_first_aid = df_seranking[df_seranking["title"].str.contains("First Aid", na=False)]
    df_first_aid_hit = df_first_aid[(df_first_aid["google_ranking"] > 0) & (df_first_aid["google_ranking"] < 11)]
    fa_maintain = fa_push = 0
    try:
        fa_maintain = df_first_aid_hit.groupby("tag").count().at["Maintain in 1 - 5", "keyword"]
    except KeyError:
        pass
    try:
        fa_push = df_first_aid_hit.groupby("tag").count().at["Push to 1 - 5", "keyword"]
    except KeyError:
        pass
    fa_kpi = 999 if (fa_maintain > 4 and fa_push > 0) else 0
    monday_update_column(5718076994, "numbers40", str(fa_kpi), monday_api_key, api_url)

    fa_body = (
        f"KPI Keywords Hit for 'Maintain in 1-5': {fa_maintain}/5\n"
        f"KPI Keywords Hit for 'Push to 1-5': {fa_push}/1\n\n"
        "<table><tbody><tr><td><div>keyword</div></td><td><div>tag</div></td><td><div>ranking</div></td></tr>"
    )
    for _, row in df_first_aid.sort_values(["tag", "google_ranking"]).iterrows():
        fa_body += f"<tr><td><div>{row['keyword']}</div></td><td><div>{row['tag']}</div></td><td><div>{int(row['google_ranking'])}</div></td></tr>"
    fa_body += "</tbody></table>"
    monday_create_update(5718076994, fa_body, monday_api_key, api_url)

    # That Econs Tutor
    df_econs = df_seranking[df_seranking["title"].str.contains("That Econs", na=False)].copy()
    special_kws = {"econ tuition jc", "economic tuition", "tuition for economics"}
    df_econs["tag"] = df_econs["keyword"].apply(lambda k: "Regular" if k in special_kws else "Maintenance")
    econs_reg = len(df_econs[(df_econs["tag"] == "Regular") & (df_econs["google_ranking"] < 11)])
    econs_maint = len(df_econs[(df_econs["tag"] == "Maintenance") & (df_econs["google_ranking"] < 11)])
    monday_update_column(9511040804, "numbers40", "999" if (econs_reg > 1 and econs_maint > 3) else "0", monday_api_key, api_url)

    # Ma Kuang
    df_makuang = df_seranking[df_seranking["title"].str.contains("Ma Kuang", na=False)]
    mk_dict = {}
    for _, row in df_makuang.iterrows():
        mk_dict.setdefault(row["tag"], 0)
        if row["google_ranking"] != 999 and row["google_ranking"] < 11:
            mk_dict[row["tag"]] += 1
    mk_clusters_hit = sum(1 for v in mk_dict.values() if v > 3)
    mk_body = f"Clusters Hit: {mk_clusters_hit}/15 (Hit 7 - KPI HIT)\n" + "".join(
        f"\n{k}: {v}/4" for k, v in mk_dict.items()
    )
    monday_create_update(7537978196, mk_body, monday_api_key, api_url)
    monday_update_column(7537978196, "numbers40", "999" if mk_clusters_hit > 6 else "0", monday_api_key, api_url)

    # Dr Gerard Leong (Indonesia)
    df_gerard = df_seranking[df_seranking["title"].str.contains("Dr Gerard Leong (Indonesia)", regex=False, na=False)]
    monday_update_column(5121313538, "numbers98", str(len(df_gerard[df_gerard["google_ranking"] < 11])), monday_api_key, api_url)
    monday_update_column(5121313538, "numbers27", str(len(df_gerard[(df_gerard["google_ranking"] > 10) & (df_gerard["google_ranking"] < 21)])), monday_api_key, api_url)

    # Common TCM
    df_common = df_seranking[df_seranking["title"].str.contains("Common", na=False)]
    df_common_hit = df_common[(df_common["google_ranking"] < 11) & (df_common["google_ranking"] > 0)].groupby("tag").count()
    try:
        common_kpi = 999 if (df_common_hit.at["General", "keyword"] > 4 and df_common_hit.at["Maintenance", "keyword"] > 9) else 0
    except KeyError:
        common_kpi = 0
    monday_update_column(9298658614, "numbers40", str(common_kpi), monday_api_key, api_url)
    common_body = (
        f"General: {len(df_common[(df_common['tag']=='General') & (df_common['google_ranking']<11) & (df_common['google_ranking']>0)])}/10 (5 to hit KPI)"
        f" <br>Maintenance: {len(df_common[(df_common['tag']=='Maintenance') & (df_common['google_ranking']<11) & (df_common['google_ranking']!=0)])}/10 (10 to hit KPI)"
    )
    monday_create_update(9298658614, common_body, monday_api_key, api_url)

    # Anderco
    df_anderco = df_seranking[df_seranking["title"].str.contains("Anderco", na=False)]
    df_anderco_hit = df_anderco[(df_anderco["google_ranking"] < 11) & (df_anderco["google_ranking"] > 0)].groupby("tag").count()
    monday_update_column(9066886636, "numbers40", "999" if len(df_anderco_hit) > 7 else "0", monday_api_key, api_url)
    monday_create_update(9066886636, f"Clusters Hit: {len(df_anderco_hit)}/15 (KPI is 8)", monday_api_key, api_url)

    # SATA
    df_sata = df_seranking[df_seranking["title"].str.contains("Sata", na=False)]
    df_sata_hit = df_sata[(df_sata["google_ranking"] < 11) & (df_sata["google_ranking"] > 0)].groupby("tag").count()
    try:
        sata_kpi = 999 if (df_sata_hit.at["General", "keyword"] > 1 and df_sata_hit.at["Maintenance", "keyword"] > 13) else 0
    except KeyError:
        sata_kpi = 0
    monday_update_column(8579765720, "numbers40", str(sata_kpi), monday_api_key, api_url)
    sata_body = (
        f"General: {len(df_sata[(df_sata['tag']=='General') & (df_sata['google_ranking']<11) & (df_sata['google_ranking']>0)])}/4 (2 to hit KPI)"
        f" <br>Maintenance: {len(df_sata[(df_sata['tag']=='Maintenance') & (df_sata['google_ranking']<11) & (df_sata['google_ranking']!=0)])}/17 (14 to hit KPI)"
    )
    monday_create_update(8579765720, sata_body, monday_api_key, api_url)

    # Dior
    df_dior = df_seranking[df_seranking["title"].str.contains("Dior", na=False)]
    dior_maintain = len(df_dior[(df_dior["tag"] == "To maintain on page 1") & (df_dior["google_ranking"] < 11) & (df_dior["google_ranking"] > 0)])
    dior_rank = len(df_dior[(df_dior["tag"] != "To maintain on page 1") & (df_dior["google_ranking"] < 11) & (df_dior["google_ranking"] != 0)])
    dior_score = (1 if dior_maintain > 35 else 0) + (1 if dior_rank > 31 else 0)
    monday_update_column(9539506286, "numbers98", str(dior_score), monday_api_key, api_url)
    monday_update_column(9539506286, "numbers40", "999" if dior_score == 2 else "0", monday_api_key, api_url)
    dior_body = (
        f"To Maintain Page 1: {dior_maintain}/45 (36 to hit KPI)"
        f" <br>To Rank on Page 1: {dior_rank}/64 (32 to hit KPI)"
    )
    monday_create_update(9539506286, dior_body, monday_api_key, api_url)

    # --- 13. Legend Interiors (multi-engine) ---
    print("Fetching Legend Interiors positions...")
    url = f"https://api4.seranking.com/sites/10231412/positions?date_from={today_str}&date_to={today_str}"
    r = requests.get(url, headers=se_headers)
    site_engine_map = {"3098542": "Thailand", "3098545": "Singapore", "3090931": "Malaysia"}
    legend_item_map = {"Singapore": "8222788388", "Malaysia": "8253266685", "Thailand": "8253270255"}

    df_legend_p1 = pd.DataFrame()
    df_legend_p2 = pd.DataFrame()
    counter = 0
    for engine in r.json():
        engine_name = site_engine_map.get(str(engine["site_engine_id"]), "Unknown")
        for kw in engine["keywords"]:
            tag = keyword_group_dict.get(str(kw["group_id"]), "")
            pos = kw["positions"][0]["pos"]
            if tag == "General" and 0 < pos < 11:
                df_legend_p1.at[counter, "keyword"] = kw["name"]
                df_legend_p1.at[counter, "site_engine"] = engine_name
            if tag == "General" and 10 < pos < 21:
                df_legend_p2.at[counter, "keyword"] = kw["name"]
                df_legend_p2.at[counter, "site_engine"] = engine_name
            counter += 1

    legend_updates = []
    for country, item_id in legend_item_map.items():
        try:
            p1 = int(df_legend_p1.groupby("site_engine").count().at[country, "keyword"])
        except (KeyError, AttributeError, ValueError):
            p1 = 0
        try:
            p2 = int(df_legend_p2.groupby("site_engine").count().at[country, "keyword"])
        except (KeyError, AttributeError, ValueError):
            p2 = 0
        legend_updates += [(item_id, "numbers98", str(p1)), (item_id, "numbers27", str(p2))]
    batch_monday_updates(legend_updates, monday_api_key, api_url)

    # --- 14. Ultra Vault ---
    print("Fetching Ultra Vault positions...")
    url = f"https://api4.seranking.com/sites/10231115/positions?date_from={today_str}&date_to={today_str}"
    r = requests.get(url, headers=se_headers)
    df_ultra = pd.DataFrame()
    counter = 0
    for engine in r.json():
        for kw in engine["keywords"]:
            df_ultra.at[counter, "keyword"] = kw["name"]
            df_ultra.at[counter, "google_rank"] = kw["positions"][0]["pos"]
            df_ultra.at[counter, "tag"] = keyword_group_dict.get(str(kw["group_id"]), "Unknown")
            counter += 1

    try:
        ultra_df_hit = df_ultra[(df_ultra["google_rank"] < 11) & (df_ultra["google_rank"] > 0)].groupby("tag").count()
        ultra_kpi = 999 if (ultra_df_hit.at["General", "keyword"] > 4 and ultra_df_hit.at["Maintenance", "keyword"] > 9) else 0
    except KeyError:
        ultra_kpi = 0
    monday_update_column(7159686829, "numbers40", str(ultra_kpi), monday_api_key, api_url)
    ultra_body = (
        f"General: {len(df_ultra[(df_ultra['tag']=='General') & (df_ultra['google_rank']<11) & (df_ultra['google_rank']>0)])}/12 (5 to hit KPI)"
        f" <br>Maintenance: {len(df_ultra[(df_ultra['tag']=='Maintenance') & (df_ultra['google_rank']<11) & (df_ultra['google_rank']!=0)])}/8 (8 to hit KPI)"
    )
    monday_create_update(7159686829, ultra_body, monday_api_key, api_url)

    # --- 15. Extra Space (DataForSEO competitor check) ---
    print("Running Extra Space competitor check...")
    df_es = df_seranking[df_seranking["title"].str.contains("Extra Space", na=False)].copy()
    df_es["storhub"] = 999
    dfs_url = "https://api.dataforseo.com/v3/serp/google/organic/live/regular"
    dfs_headers = {
        "Authorization": "Basic c3ViQG1lZGlhb25lLmNvOjliZGZkNDBjNzRmMmZjNTM=",
        "Content-Type": "application/json",
    }
    loc_map = {
        "Hong Kong": ("Hong Kong", "English"),
        "Korea": ("South Korea", "Korean"),
        "Malaysia": ("Malaysia", "English"),
        "Singapore": ("Singapore", "English"),
    }
    for index, row in df_es.iterrows():
        for loc_key, (location_name, lang) in loc_map.items():
            if loc_key not in row["title"]:
                continue
            if loc_key == "Hong Kong" and re.findall(r"[一-鿿]+", row["keyword"]):
                lang = "Chinese (Traditional)"
            payload = [{"keyword": row["keyword"], "location_name": location_name, "language_name": lang, "depth": 100}]
            try:
                resp = requests.post(dfs_url, headers=dfs_headers, json=payload, timeout=30)
                for result in resp.json()["tasks"][0]["result"][0]["items"]:
                    if "storhub.co" in result["url"]:
                        df_es.at[index, "storhub"] = result["rank_group"]
                        break
            except Exception as exc:
                print(f"DataForSEO error ({row['keyword']}): {exc}")
            break

    es_region_items = {
        "Hong Kong": "8065489687",
        "Korea": "8065500047",
        "Malaysia": "8065455091",
        "Singapore": "7741515665",
    }
    es_kpi_updates = []
    for region, item_id in es_region_items.items():
        df_region = df_es[df_es["title"].str.contains(region, na=False)]
        if df_region.empty:
            continue
        score = len(df_region[df_region["google_ranking"] < df_region["storhub"]])
        pct = round(score / len(df_region) * 100)
        es_body = (
            f"<p>Automated Ranking Comparison:</p><br>"
            "<table><tbody><tr><td><div>keyword</div></td><td><div>extraspace</div></td><td><div>storhub</div></td></tr>"
        )
        for _, row in df_region.iterrows():
            es_body += f"<tr><td><div>{row['keyword']}</div></td><td>{int(row['google_ranking'])}<div></div></td><td><p>{row['storhub']}</p></td></tr>"
        es_body += f"</tbody></table><p>Better Ranking than StorHub: {score}/{len(df_region)} or {pct}%</p>"
        monday_create_update(int(item_id), es_body, monday_api_key, api_url)
        es_kpi_updates.append((item_id, "numbers40", "999" if score / len(df_region) >= 0.3 else "0"))
    batch_monday_updates(es_kpi_updates, monday_api_key, api_url)

    # --- 16. Re-fetch board for final KPI state, then send staff summary ---
    print("Re-fetching board for staff KPI summary...")
    combined_final = fetch_monday_board(monday_api_key, BOARD_ID, pages=6)
    df_final, _ = build_integrated_df(combined_final)
    df_final = df_final[
        (~df_final["SEO Campaign Status"].str.contains("Expired", na=False))
        & (~df_final["client"].str.contains("TEMPLATE", na=False))
    ]
    df_final = calc_kpi_hit_rate(df_final)

    live_campaign_statuses = [
        "Lived (PM)", "Renewed No Pause (Sales)", "Guarantee (SEO)", "Renewed (Loyal)",
        "Delayed (PM)", "PSG Extended Live", "Final Report", "SEO Consultant to Review",
        "Renewed (New Timeline)", "Lit (SEO)",
    ]
    df_updated_1 = df_final[df_final["SEO Campaign Status"].isin(live_campaign_statuses)]

    seo_staff = ["Kanivarasi Elanchelvan", "Jia Jia", "Chan Ching Yi", "Desiree Bin"]
    sg_holidays_2025 = [
        date(2025, 1, 1), date(2025, 1, 29), date(2025, 1, 30), date(2025, 4, 18),
        date(2025, 5, 1), date(2025, 5, 12), date(2025, 6, 6), date(2025, 8, 9),
        date(2025, 10, 20), date(2025, 12, 25),
    ]
    days = get_working_days_excluding_holidays(2026, sg_holidays_2025)
    today = date.today()
    staff = seo_staff[days.index(today) % 4] if today in days else seo_staff[0]

    text_message = f"*{staff}'s KPI HIT*\n"
    for ctype in ["Standard", "Cluster", "Special"]:
        mask = (df_updated_1["[SEO]SEO"].str.contains(staff, na=False)) & (df_updated_1["SEO Campaign Type"] == ctype)
        hit = len(df_updated_1[mask & (df_updated_1["[SEO] KPI HIT RATE"] == "KPI HIT")])
        total = len(df_updated_1[mask])
        text_message += f"\n{ctype} Campaigns: {hit}/{total}"
    text_message += "\n"
    for _, row in df_updated_1[df_updated_1["[SEO]SEO"].str.contains(staff, na=False)].iterrows():
        rate = row["[SEO] KPI HIT RATE"] or "NA"
        text_message += f"\n{row['client']} | {rate}"

    _send_chat("spaces/AAAA9VgFJmA", text_message)

    print("Lambda execution complete!")
    return {"statusCode": 200, "body": "SEO Monday update completed successfully"}
