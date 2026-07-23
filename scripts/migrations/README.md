# social_report_months — stored scorecard repair (run 2026-07-23)

One-off repair of values that were written wrong (or written less precisely than
the data allowed) into `social_report_months.scorecard`. Display had already been
corrected in `index.html`, but the stored JSON stayed stale, so anything reading
DynamoDB directly — an export, a future feature, a hand-written query — still saw
the bad figures.

## What it fixes

1. **Per-post follower-based `engagement_rate`.** `_grid_post()` rounded to 2dp at
   write time, which collapses to `0.00` on a large page: OCBC Facebook, 860,836
   followers, 26 engagements → stored `0.0`, actually `0.003%`. Recomputed from
   the stored likes/comments/shares/saves against the account's follower count,
   keeping 4dp below 1%. Posts carrying a reach-based `interaction_rate` are never
   touched — that number is not follower-derived.

2. **`benchmark.by_platform`.** The stored benchmark ranks every tracked account
   in ONE share-of-voice list, so a Facebook Page is compared against an Instagram
   profile — Singapore Pools' list was 71.5% "OCBC Facebook" while also containing
   Instagram accounts. The top-level block is left alone (it is the correct
   all-platforms view); a per-platform split is added alongside it. The Lambda's
   `_benchmark_by_platform()` now writes the same block on every new capture, so
   this does not go stale again.

Nothing else needed repair: **no saved AI recommendation blocks exist** — all 207
month rows carry only `{executive_summary, overall_health}` from capture time, and
there is no `recs_block` attribute anywhere in the table.

## Result

    rows written                 14
    post rates fixed            164   (17 of them previously read exactly 0.00)
    by_platform blocks added      6   (across 3 rows — the only rows with SOV)

Verified by reading back from DynamoDB: 273 follower-based rates re-checked, 0
still wrong, 0 non-zero engagements rendering as zero, 0 structural failures
(including a check that no platform's ranking contains an account from another
platform). Re-running the dry run reports 0 rows, i.e. it is idempotent.

## Usage

    python3 migrate.py            # dry run — reports, writes nothing
    python3 migrate.py --apply    # backs each touched row up to backup/ then writes
    python3 verify.py             # independent read-back check

`--apply` writes `backup/<projectId>__<month>.json` containing the exact
pre-migration scorecard before each update. Those backups are the rollback path
and are deliberately NOT committed (client data).
