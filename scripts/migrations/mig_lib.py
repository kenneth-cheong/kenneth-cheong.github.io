"""Shared helpers for the stored-scorecard migration."""
import json, subprocess

REGION = "ap-southeast-1"
MONTHS_TABLE = "social_report_months"
PROJECTS_TABLE = "social_report_projects"


def aws(args, timeout=120):
    r = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(r.stderr[:400])
    return json.loads(r.stdout or '{}')


def undyn(v):
    if not isinstance(v, dict):
        return v
    if 'S' in v:
        return v['S']
    if 'N' in v:
        return float(v['N']) if '.' in v['N'] else int(v['N'])
    if 'NULL' in v:
        return None
    if 'BOOL' in v:
        return v['BOOL']
    if 'L' in v:
        return [undyn(x) for x in v['L']]
    if 'M' in v:
        return {k: undyn(x) for k, x in v['M'].items()}
    return v


def all_month_keys():
    """[(projectId, month)] across every project."""
    out = []
    tok = None
    while True:
        args = ["aws", "dynamodb", "scan", "--table-name", MONTHS_TABLE, "--region", REGION,
                "--projection-expression", "projectId,#m",
                "--expression-attribute-names", json.dumps({"#m": "month"}),
                "--output", "json", "--no-cli-pager"]
        if tok:
            args += ["--starting-token", tok]
        r = aws(args)
        for it in r.get('Items', []):
            out.append((it['projectId']['S'], it['month']['S']))
        tok = r.get('NextToken')
        if not tok:
            break
    return sorted(out)


def get_month(pid, month):
    r = aws(["aws", "dynamodb", "get-item", "--table-name", MONTHS_TABLE, "--region", REGION,
             "--key", json.dumps({"projectId": {"S": pid}, "month": {"S": month}}),
             "--output", "json", "--no-cli-pager"])
    return r.get('Item') or {}


def parse_sc(item):
    sc = item.get('scorecard')
    if isinstance(sc, dict) and 'S' in sc:
        try:
            return json.loads(sc['S'])
        except ValueError:
            return None
    if isinstance(sc, dict) and 'M' in sc:
        return undyn(sc)
    return None


# ── the three defects, as pure functions so dry-run and apply share one code path ──

PLAT_WORDS = {
    'facebook': ('facebook', ' fb ', 'meta page'),
    'instagram': ('instagram', ' ig ', 'reels'),
    'linkedin': ('linkedin',),
    'tiktok': ('tiktok', 'tik tok'),
    'youtube': ('youtube', 'yt shorts'),
    'xiaohongshu': ('xiaohongshu', 'red note', 'rednote', 'xhs'),
}


def mentions_other(text, own, keys):
    t = ' ' + str(text or '').lower() + ' '
    for k in keys:
        if k == own:
            continue
        if any(a in t for a in PLAT_WORDS.get(k, (k,))):
            return True
    return False


def fix_rate(v, eng, followers):
    """Recompute a follower-based rate at full precision. None = leave alone."""
    if not followers or followers <= 0 or eng is None:
        return None
    rate = eng / followers * 100
    return round(rate, 2 if rate >= 1 else 4)


def post_engagement(p):
    sig = [p.get(k) for k in ('likes', 'comments', 'shares', 'saves')]
    sig = [x for x in sig if isinstance(x, (int, float))]
    if not sig and isinstance(p.get('reactions'), (int, float)):
        sig = [p['reactions']]
    return sum(sig) if sig else None
