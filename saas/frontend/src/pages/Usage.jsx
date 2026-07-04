import { useEffect, useState } from 'react';
import { toolById, PLANS } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../lib/api.js';
import SortableTable from '../components/SortableTable.jsx';
import InfoTip from '../components/InfoTip.jsx';

export default function Usage() {
  const { user } = useAuth();
  const [rows, setRows] = useState([]);
  const plan = PLANS[user.tier];

  useEffect(() => {
    api.usage().then((d) => setRows(d.usage || [])).catch(() => {});
  }, []);

  const spent = rows.reduce((a, r) => a + (r.delta < 0 ? -r.delta : 0), 0);

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-bold">Usage</h1>
      <div className="mt-4 grid grid-cols-3 gap-4">
        <Stat label="Credits left" value={user.credits.toLocaleString()} tip="Credits available to spend right now. Each tool run costs a few credits." />
        <Stat label="Spent this cycle" value={spent.toLocaleString()} tip="Credits you've used since your allowance last reset this billing cycle." />
        <Stat label="Monthly allowance" value={plan.monthlyCredits.toLocaleString()} tip="Fresh credits your plan grants at the start of each billing cycle." />
      </div>

      <div className="card mt-6 overflow-hidden">
        <SortableTable
          rows={rows}
          emptyText="No usage yet — run a tool to see it here."
          columns={[
            { key: 'when', label: 'When', accessor: (r) => r.at || String(r.ts || '').split('#')[0],
              render: (r) => <span className="text-slate-500">{fmtWhen(r)}</span> },
            { key: 'tool', label: 'Tool', accessor: (r) => toolById(r.tool)?.name || r.tool,
              render: (r) => toolById(r.tool)?.name || r.tool },
            { key: 'delta', label: 'Credits', align: 'right', numeric: true,
              render: (r) => <span className="font-medium text-red-500">{r.delta}</span> },
            { key: 'balanceAfter', label: 'Balance', align: 'right', numeric: true,
              render: (r) => <span className="text-slate-500">{r.balanceAfter}</span> },
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

function Stat({ label, value, tip }) {
  return (
    <div className="card p-4">
      <p className="flex items-center gap-1 text-sm text-slate-500">
        {label}
        {tip && <InfoTip text={tip} size={12} />}
      </p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
    </div>
  );
}
