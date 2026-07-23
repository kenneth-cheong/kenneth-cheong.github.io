"""Post-migration verification, read back from DynamoDB."""
import json, os, glob
from mig_lib import all_month_keys, get_month, parse_sc, fix_rate, post_engagement

bad_rate = zeros_left = 0
checked = 0
bp_rows = 0
struct_fail = []

for pid, month in all_month_keys():
    sc = parse_sc(get_month(pid, month))
    if not sc:
        continue

    def scan(posts, followers):
        global bad_rate, zeros_left, checked
        for p in posts or []:
            if p.get('interaction_rate') is not None or p.get('engagement_rate') is None:
                continue
            checked += 1
            want = fix_rate(p['engagement_rate'], post_engagement(p), followers)
            if want is not None and want != p['engagement_rate']:
                bad_rate += 1
            if float(p['engagement_rate']) == 0 and (post_engagement(p) or 0) > 0:
                zeros_left += 1

    for c in (sc.get('platforms') or []):
        scan(c.get('posts'), c.get('followers'))
    for c in (sc.get('competitors') or []):
        scan(c.get('posts'), c.get('followers'))
        scan(c.get('top_posts'), c.get('followers'))

    bm = sc.get('benchmark') or {}
    if bm.get('by_platform'):
        bp_rows += 1
        for plat, blk in bm['by_platform'].items():
            s = blk.get('share_of_voice') or {}
            for k in ('audience', 'activity', 'engagement'):
                rows = s.get(k) or []
                if not rows:
                    struct_fail.append((pid, month, plat, k, 'empty'))
                    continue
                tot = sum(r.get('pct') or 0 for r in rows)
                if abs(tot - 100) > 1.5:
                    struct_fail.append((pid, month, plat, k, 'pct sums to %.1f' % tot))
            names = {r['name'] for r in (s.get('audience') or [])}
            comps_on = {c.get('name') or c.get('handle') for c in (sc.get('competitors') or [])
                        if c.get('platform') == plat and c.get('followers') is not None}
            stray = comps_on - names
            if stray:
                struct_fail.append((pid, month, plat, 'membership', 'missing %s' % list(stray)[:2]))
            # nobody from ANOTHER platform may appear in this platform's ranking
            other = {c.get('name') or c.get('handle') for c in (sc.get('competitors') or [])
                     if c.get('platform') and c.get('platform') != plat}
            leak = (names & other) - comps_on
            if leak:
                struct_fail.append((pid, month, plat, 'LEAK', list(leak)[:3]))

print('posts re-checked            :', checked)
print('rates still wrong           :', bad_rate, '(want 0)')
print('non-zero engagement showing 0:', zeros_left, '(want 0)')
print('rows with by_platform       :', bp_rows)
print('structural failures         :', len(struct_fail))
for f in struct_fail[:10]:
    print('   ', f)

# backups must faithfully hold the pre-migration state
bks = glob.glob('backup/*.json')
print()
print('backups written             :', len(bks))
ok = all(os.path.getsize(b) > 100 for b in bks)
print('backups non-trivial         :', ok)
