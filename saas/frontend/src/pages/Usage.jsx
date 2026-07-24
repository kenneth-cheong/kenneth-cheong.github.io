import { useEffect, useState } from 'react';
import { toolById, PLANS } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../lib/api.js';
import SortableTable from '../components/SortableTable.jsx';
import InfoTip from '../components/InfoTip.jsx';
import TopupPacks from '../components/TopupPacks.jsx';

export default function Usage() {
  const { user } = useAuth();
  const [rows, setRows] = useState([]);
  const plan = PLANS[user.tier];

  useEffect(() => {
    api.usage().then((d) => setRows(d.usage || [])).catch(() => {});
  }, []);

  const topup = user.topupCredits || 0;
  // Spent THIS cycle = the monthly allowance minus what's left of the monthly
  // bucket (total credits minus never-expiring top-ups). Mirrors the dashboard's
  // "N of allowance used". The ledger `rows` span multiple cycles/resets, so
  // summing their deltas over-counts massively (was showing 5,576 for ~6 spent).
  const monthlyLeft = Math.max(0, (user.credits || 0) - topup);
  const spent = Math.max(0, (plan?.monthlyCredits || 0) - monthlyLeft);
  const renews = user.periodEnd
    ? new Date(user.periodEnd).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : null;

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-bold">Credits &amp; usage</h1>
      {/* The one rule people trip over, stated in the open (it used to live only
          in the credit meter's hover card — invisible on touch screens). */}
      <p className="mt-1.5 text-sm text-dim">
        Credits are what tool runs cost — most runs cost 1–5, big audits more. Monthly credits reset
        {renews ? ` on ${renews}` : ' each billing cycle'} and don’t carry over; top-up credits roll over and stay valid for 12 months from purchase.
      </p>
      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Stat label="Credits left" value={user.credits.toLocaleString()}
          sub={topup > 0 ? `incl. ${topup.toLocaleString()} top-up (valid 12 months)` : null}
          tip="Credits available to spend right now. Each tool run costs a few credits." />
        <Stat label="Spent this cycle" value={spent.toLocaleString()} tip="Credits you've used since your allowance last reset this billing cycle." />
        <Stat label="Monthly allowance" value={plan.monthlyCredits.toLocaleString()}
          sub={renews ? `resets ${renews}` : null}
          tip="Fresh credits your plan grants at the start of each billing cycle. Unused monthly credits don't carry over." />
      </div>

      {/* Buying sits next to the balance that prompts it — above the ledger,
          which can run long enough to bury anything under it. */}
      <TopupPacks className="card mt-6 p-5" />

      <div className="card mt-6 overflow-hidden">
        <SortableTable
          rows={rows}
          emptyText="No usage yet — run a tool to see it here."
          columns={[
            { key: 'when', label: 'When', accessor: (r) => r.at || String(r.ts || '').split('#')[0],
              render: (r) => <span className="text-muted">{fmtWhen(r)}</span> },
            { key: 'tool', label: 'Tool', accessor: rowLabel,
              render: rowLabel },
            { key: 'delta', label: 'Credits', align: 'right', numeric: true,
              render: (r) => (
                <span className={`font-medium ${r.delta > 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                  {r.delta > 0 ? `+${r.delta}` : r.delta}
                </span>
              ) },
            { key: 'balanceAfter', label: 'Balance', align: 'right', numeric: true,
              render: (r) => <span className="text-muted">{r.balanceAfter}</span> },
          ]}
        />
      </div>
    </div>
  );
}

// Ledger sort keys look like "2026-06-13T..#1#schema"; prefer the clean `at`,
// else take the ISO prefix before the first '#'.
function fmtWhen(r) {
  const iso = r.at || String(r.ts || '').split('#')[0];
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

// Non-tool ledger rows (top-ups, resets, admin nudges) carry no `tool`, so the
// Tool column was blank. Fall back to a human label keyed off `action`.
const ACTION_LABELS = {
  topup: 'Credit top-up',
  monthly_reset: 'Monthly credits',
  monthly_reset_free: 'Monthly credits',
  tier_change: 'Plan change',
  subscription_cancelled: 'Subscription cancelled',
  admin_adjust: 'Credit adjustment',
  admin_set_tier: 'Plan change',
  admin_set_status: 'Account update',
  admin_set_role: 'Account update',
};

function rowLabel(r) {
  return toolById(r.tool)?.name || r.tool || ACTION_LABELS[r.action] || r.action || '—';
}

function Stat({ label, value, sub, tip }) {
  return (
    <div className="card p-4">
      <p className="flex items-center gap-1 text-sm text-muted">
        {label}
        {tip && <InfoTip text={tip} size={12} />}
      </p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-faint">{sub}</p>}
    </div>
  );
}
