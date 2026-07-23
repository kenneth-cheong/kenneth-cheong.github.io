"""Repair stored month scorecards in place.

  1. per-post follower-based engagement_rate that was rounded to 2dp at write
     time and collapsed to 0.00 on large pages -> recomputed at full precision
  2. benchmark.by_platform -> the share-of-voice split the top-level block
     cannot express (it ranks a Facebook Page against an Instagram profile)

Run with --apply to write; without it this only reports. Every touched row is
backed up to backup/<projectId>__<month>.json first.
"""
import json, os, sys, subprocess
from mig_lib import (REGION, MONTHS_TABLE, aws, all_month_keys, get_month,
                     parse_sc, fix_rate, post_engagement)

APPLY = '--apply' in sys.argv
POSTS_PER_MONTH = 4.345
os.makedirs('backup', exist_ok=True)


def entity_totals(name, is_brand, p):
    ppm = (p.get('posts_per_week') or 0) * POSTS_PER_MONTH
    eng = ppm * ((p.get('avg_likes') or 0) + (p.get('avg_comments') or 0))
    return {'name': name, 'is_brand': is_brand,
            'followers': round(p.get('followers') or 0),
            'posts': round(ppm, 1), 'engagement': round(eng)}


def sov(ents, field):
    total = sum(e[field] for e in ents) or 0
    rows = [{'name': e['name'], 'is_brand': e['is_brand'], 'value': e[field],
             'pct': round(e[field] / total * 100, 1) if total else 0} for e in ents]
    return sorted(rows, key=lambda x: -x['value'])


def mix_pct(m):
    m = m or {}
    v, i, c = m.get('video', 0) or 0, m.get('image', 0) or 0, m.get('carousel', 0) or 0
    t = v + i + c
    if not t:
        return None
    return {'video': round(v / t * 100), 'image': round(i / t * 100), 'carousel': round(c / t * 100)}


def by_platform(sc, brand):
    cards = [c for c in (sc.get('platforms') or []) if c.get('found') is not False]
    comps = [c for c in (sc.get('competitors') or []) if c.get('followers') is not None]
    plats = sorted({c.get('platform') for c in cards if c.get('platform')} |
                   {c.get('platform') for c in comps if c.get('platform')})
    out = {}
    for plat in plats:
        bm = next((c for c in cards if c.get('platform') == plat), None)
        cs = [c for c in comps if c.get('platform') == plat]
        ents = ([entity_totals(brand, True, bm)] if bm else []) + \
               [entity_totals(c.get('name') or c.get('handle') or 'Competitor', False, c) for c in cs]
        if len(ents) < 2:
            continue
        fmt = []
        if bm:
            m = mix_pct(bm.get('content_mix'))
            if m:
                fmt.append({'name': brand, 'is_brand': True, **m})
        for c in cs:
            m = mix_pct(c.get('content_mix'))
            if m:
                fmt.append({'name': c.get('name') or c.get('handle') or '', 'is_brand': False, **m})
        out[plat] = {'share_of_voice': {'audience': sov(ents, 'followers'),
                                        'activity': sov(ents, 'posts'),
                                        'engagement': sov(ents, 'engagement')},
                     'format_mix': fmt,
                     'tracked_set': [e['name'] for e in ents]}
    return out


def repair(sc, brand):
    """Mutates sc. Returns (rates_changed, zeros_fixed, platforms_added)."""
    changed = zeros = 0

    def do_posts(posts, followers):
        nonlocal changed, zeros
        for p in posts or []:
            if p.get('interaction_rate') is not None or p.get('engagement_rate') is None:
                continue
            new = fix_rate(p['engagement_rate'], post_engagement(p), followers)
            if new is None or new == p['engagement_rate']:
                continue
            if float(p['engagement_rate']) == 0:
                zeros += 1
            p['engagement_rate'] = new
            p['engagement_rate_basis'] = 'followers'
            changed += 1

    for card in (sc.get('platforms') or []):
        do_posts(card.get('posts'), card.get('followers'))
    for c in (sc.get('competitors') or []):
        do_posts(c.get('posts'), c.get('followers'))
        do_posts(c.get('top_posts'), c.get('followers'))

    added = 0
    bm = sc.get('benchmark')
    if isinstance(bm, dict) and bm.get('share_of_voice') and not bm.get('by_platform'):
        bp = by_platform(sc, brand)
        if bp:
            bm['by_platform'] = bp
            added = len(bp)
    return changed, zeros, added


brands = {}
for pid in {p for p, _ in all_month_keys()}:
    r = aws(["aws", "dynamodb", "get-item", "--table-name", "social_report_projects",
             "--region", REGION, "--key", json.dumps({"projectId": {"S": pid}}),
             "--projection-expression", "brand,#n", "--expression-attribute-names",
             json.dumps({"#n": "name"}), "--output", "json", "--no-cli-pager"])
    it = r.get('Item') or {}
    brands[pid] = (it.get('brand', {}).get('S') or it.get('name', {}).get('S') or 'Brand')

tot_rows = tot_rates = tot_zeros = tot_plats = 0
for pid, month in all_month_keys():
    item = get_month(pid, month)
    sc = parse_sc(item)
    if not sc:
        continue
    before = json.dumps(sc, sort_keys=True)
    rates, zeros, plats = repair(sc, brands.get(pid, 'Brand'))
    if not rates and not plats:
        continue
    tot_rows += 1
    tot_rates += rates
    tot_zeros += zeros
    tot_plats += plats
    print('%-10s %-8s rates=%-4d (zeros=%-3d) by_platform=%s' % (brands.get(pid, '')[:10], month, rates, zeros, plats or '-'))
    if not APPLY:
        continue
    with open('backup/%s__%s.json' % (pid, month), 'w') as f:
        f.write(before)
    aws(["aws", "dynamodb", "update-item", "--table-name", MONTHS_TABLE, "--region", REGION,
         "--key", json.dumps({"projectId": {"S": pid}, "month": {"S": month}}),
         "--update-expression", "SET scorecard = :s",
         "--expression-attribute-values", json.dumps({":s": {"S": json.dumps(sc)}}),
         "--output", "json", "--no-cli-pager"])

print()
print(('APPLIED' if APPLY else 'DRY RUN') + ': rows=%d  post rates fixed=%d (of which read 0.00 before=%d)  by_platform blocks=%d'
      % (tot_rows, tot_rates, tot_zeros, tot_plats))
