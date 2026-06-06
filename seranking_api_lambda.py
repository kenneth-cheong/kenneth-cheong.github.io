import json
import requests
import os

SERANKING_API_KEY = os.environ.get('SERANKING_API_KEY')
SERANKING_API_URL = "https://api4.seranking.com"

def lambda_handler(event, context):
    headers = {
        "Authorization": f"Token {SERANKING_API_KEY}",
        "Content-Type": "application/json"
    }

    try:
        body = event
        if 'body' in event and isinstance(event['body'], str):
            try:
                body = json.loads(event['body'])
            except:
                pass
        
        action = body.get('action', 'get_sites')
        data = body.get('data', {})
        # Handle siteId being in the top level or inside 'data'
        site_id = body.get('siteId') or data.get('siteId')

        if action == 'get_sites':
            url = f"{SERANKING_API_URL}/sites"
            res = requests.get(url, headers=headers)
        elif action == 'get_keywords':
            if not site_id:
                return response(400, {"error": "Missing siteId"})
            url = f"{SERANKING_API_URL}/sites/{site_id}/keywords"
            res = requests.get(url, headers=headers)
        elif action == 'get_groups':
            if not site_id:
                return response(400, {"error": "Missing siteId"})
            url = f"{SERANKING_API_URL}/keyword-groups/{site_id}"
            res = requests.get(url, headers=headers)
        elif action == 'get_positions':
            if not site_id:
                return response(400, {"error": "Missing siteId"})
            
            # Extract optional filters
            date_from = data.get('date_from') or body.get('date_from')
            date_to = data.get('date_to') or body.get('date_to')
            with_lp = str(data.get('with_landing_pages') or body.get('with_landing_pages') or "1")
            
            url = f"{SERANKING_API_URL}/sites/{site_id}/positions?with_landing_pages={with_lp}"
            if date_from: url += f"&date_from={date_from}"
            if date_to: url += f"&date_to={date_to}"

            res = requests.get(url, headers=headers)

            # SE Ranking returns every daily reading per keyword. Over a multi-month
            # window that JSON can exceed Lambda's 6 MB sync response cap (HTTP 413),
            # which silently drops the site from the dashboard. The dashboard only uses
            # the latest position per keyword per calendar month, so collapse the daily
            # series server-side: same shape, ~10x smaller, identical chart output.
            if res.status_code == 200:
                try:
                    return response(200, compact_positions(res.json()))
                except Exception as compact_err:
                    print(f"get_positions compaction failed, returning raw: {compact_err}")
            return response(res.status_code, res.json())
        elif action == 'get_site_data':
            if not site_id:
                return response(400, {"error": "Missing siteId"})
            
            # 1. Fetch Groups
            groups_url = f"{SERANKING_API_URL}/keyword-groups/{site_id}"
            groups_res = requests.get(groups_url, headers=headers)
            groups = groups_res.json() if groups_res.status_code == 200 else []
            group_map = {str(g.get('id', '')): g.get('name', 'Unknown') for g in groups if isinstance(g, dict) and 'id' in g}

            # 2. Fetch Keywords
            keywords_url = f"{SERANKING_API_URL}/sites/{site_id}/keywords"
            keywords_res = requests.get(keywords_url, headers=headers)
            keywords = keywords_res.json() if keywords_res.status_code == 200 else []

            # 3. Fetch Positions
            positions_url = f"{SERANKING_API_URL}/sites/{site_id}/positions?with_landing_pages=1"
            positions_res = requests.get(positions_url, headers=headers)
            positions_data = positions_res.json() if positions_res.status_code == 200 else []
            
            pos_map = {}
            if isinstance(positions_data, list) and len(positions_data) > 0:
                # Assume first search engine if multiple exist
                engine_data = positions_data[0]
                if isinstance(engine_data, dict) and 'keywords' in engine_data:
                    for p in engine_data['keywords']:
                        if isinstance(p, dict) and 'id' in p and 'positions' in p and isinstance(p['positions'], list) and len(p['positions']) > 0:
                            latest = p['positions'][-1]
                            pos_map[str(p.get('id', ''))] = {
                                "pos": latest.get('pos'),
                                "change": latest.get('change'),
                                "date": latest.get('date')
                            }

            # 4. Join Data
            results = []
            for kw in keywords:
                kw_id = str(kw.get('id'))
                ranking = pos_map.get(kw_id, {})
                results.append({
                    "keyword": kw.get('name'),
                    "group": group_map.get(str(kw.get('group_id')), "No Group"),
                    "current_ranking": ranking.get('pos', "Not Ranked"),
                    "change": ranking.get('change', "-"),
                    "last_checked": ranking.get('date', "-"),
                    "site_id": site_id
                })
            
            return response(200, results)

        elif action == 'get_search_engines':
            if not site_id:
                return response(400, {"error": "Missing siteId"})
            url = f"{SERANKING_API_URL}/sites/{site_id}/search-engines"
            res = requests.get(url, headers=headers)
        elif action == 'get_system_search_engines':
            url = f"{SERANKING_API_URL}/system/search-engines"
            res = requests.get(url, headers=headers)
        else:
            return response(400, {"error": f"Unknown action: {action}"})

        return response(res.status_code, res.json())

    except Exception as e:
        print(f"Error: {str(e)}")
        return response(500, {"error": str(e)})

def compact_positions(payload):
    """Reduce a SE Ranking positions payload to the latest reading per keyword per
    calendar month. Keeps the engine -> keywords -> positions shape the dashboard
    expects (each kept position is the full original object), just without the
    intra-month daily duplicates that bloat the response past Lambda's 6 MB limit.
    Non-list payloads (e.g. error dicts) are returned untouched."""
    if not isinstance(payload, list):
        return payload
    for engine in payload:
        if not isinstance(engine, dict):
            continue
        for kw in engine.get('keywords') or []:
            if not isinstance(kw, dict):
                continue
            positions = kw.get('positions')
            if not isinstance(positions, list):
                continue
            latest_by_month = {}
            for p in positions:
                if not isinstance(p, dict):
                    continue
                day = (p.get('date') or '')[:10]
                if len(day) < 7:
                    continue
                month = day[:7]
                kept = latest_by_month.get(month)
                if kept is None or day > (kept.get('date') or '')[:10]:
                    latest_by_month[month] = p
            kw['positions'] = [latest_by_month[m] for m in sorted(latest_by_month)]
    return payload

def response(status, body):
    return {
        'statusCode': status,
        'headers': {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Content-Type": "application/json"
        },
        'body': json.dumps(body)
    }
