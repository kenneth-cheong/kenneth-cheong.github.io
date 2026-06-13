import { useEffect, useState } from 'react';
import { toolById, PLANS } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../lib/api.js';

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
        <Stat label="Credits left" value={user.credits.toLocaleString()} />
        <Stat label="Spent this cycle" value={spent.toLocaleString()} />
        <Stat label="Monthly allowance" value={plan.monthlyCredits.toLocaleString()} />
      </div>

      <div className="card mt-6 overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-slate-500">
            <tr><th className="px-4 py-2">When</th><th className="px-4 py-2">Tool</th><th className="px-4 py-2 text-right">Credits</th><th className="px-4 py-2 text-right">Balance</th></tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-8 text-center text-slate-400">No usage yet — run a tool to see it here.</td></tr>
            )}
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-slate-100">
                <td className="px-4 py-2 text-slate-500">{fmtWhen(r)}</td>
                <td className="px-4 py-2">{toolById(r.tool)?.name || r.tool}</td>
                <td className="px-4 py-2 text-right font-medium text-red-500">{r.delta}</td>
                <td className="px-4 py-2 text-right text-slate-500">{r.balanceAfter}</td>
              </tr>
            ))}
          </tbody>
        </table>
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

function Stat({ label, value }) {
  return (
    <div className="card p-4">
      <p className="text-sm text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
    </div>
  );
}
