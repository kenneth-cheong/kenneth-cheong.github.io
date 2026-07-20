import { useMemo, useState } from 'react';
import { Search, Coins } from 'lucide-react';
import { TOOLS, CATEGORIES, CREDIT_COSTS, SIMPLE_NAMES, PLANS, tierMeets } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';

// The one place in the app that prices tools. Everywhere else — the Tools grid,
// each tool's own page, the run buttons — is deliberately silent about credits,
// so people pick the tool that fits the job instead of the cheapest one. Anyone
// who genuinely needs to plan spend comes HERE.
//
// Reference material, not a launcher: rows are plain text with NO links to the
// tools. A link would turn a price list back into a shopping menu, which is
// exactly what we removed.

// How the cost is actually charged. `fanout` tools bill per input item (rank
// checker → per keyword), so a flat "1 credit" would understate a 40-keyword run.
function costOf(tool) {
  const unit = CREDIT_COSTS[tool.cost] ?? 0;
  if (unit === 0) return { credits: 0, label: 'Free', note: 'Pulls your own connected data — never charged.' };
  if (tool.fanout) return { credits: unit, label: `${unit} per item`, note: `${unit} credit${unit > 1 ? 's' : ''} for each keyword you submit.` };
  if (tool.cost === 'keyword_lookup') return { credits: unit, label: `${unit} per batch`, note: 'One credit covers a batch of up to 10 keywords.' };
  if (tool.cost === 'crawl') return { credits: unit, label: `${unit} per 10 pages`, note: 'Scales with how much of the site is crawled.' };
  return { credits: unit, label: `${unit} credit${unit > 1 ? 's' : ''}`, note: 'Charged once per run.' };
}

export default function CreditGuide() {
  const { user } = useAuth();
  const [q, setQ] = useState('');

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const match = (t) =>
      !needle || (t.name + t.desc + (SIMPLE_NAMES[t.id]?.name || '')).toLowerCase().includes(needle);
    return CATEGORIES
      .map((c) => [c, TOOLS.filter((t) => t.category === c && match(t))])
      .filter(([, tools]) => tools.length > 0);
  }, [q]);

  const hits = groups.reduce((n, [, tools]) => n + tools.length, 0);
  const allowance = PLANS[user.tier]?.monthlyCredits ?? 0;

  return (
    <div>
      <div className="mb-5">
        <h1 className="flex items-center gap-2 text-2xl font-extrabold tracking-tight text-heading">
          <Coins size={22} aria-hidden className="text-faint" /> Credit guide
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Roughly what each tool costs to run. Figures are typical — a run that fans out over
          many keywords or pages costs more, and a run that fails costs nothing.
        </p>
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        {[
          ['Your plan', PLANS[user.tier]?.name || user.tier],
          ['Credits each month', allowance.toLocaleString()],
          ['Credits left now', (user.credits || 0).toLocaleString()],
        ].map(([k, v]) => (
          <div key={k} className="rounded-2xl border border-line bg-raised p-3.5">
            <div className="text-2xl font-extrabold tracking-tight text-heading">{v}</div>
            <div className="mt-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">{k}</div>
          </div>
        ))}
      </div>

      <div className="mb-6 flex items-center gap-2.5 rounded-2xl border border-line bg-raised px-3.5 py-2.5">
        <Search size={16} className="shrink-0 text-faint" aria-hidden />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Search ${TOOLS.length} tools…`}
          aria-label="Search tools"
          className="w-full bg-transparent text-sm text-heading outline-none placeholder:text-faint"
        />
      </div>

      {hits === 0 && <p className="py-12 text-center text-sm text-faint">No tools match “{q}”.</p>}

      <div className="flex flex-col gap-8">
        {groups.map(([category, tools]) => (
          <section key={category}>
            <h2 className="mb-3 text-[11px] font-extrabold uppercase tracking-[0.14em] text-faint">{category}</h2>
            <div className="overflow-x-auto rounded-2xl border border-line bg-raised">
              <table className="w-full min-w-[520px] text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-[10px] font-bold uppercase tracking-wide text-muted">
                    <th scope="col" className="px-4 py-2.5">Tool</th>
                    <th scope="col" className="px-4 py-2.5 text-right">Approx. credits</th>
                    <th scope="col" className="hidden px-4 py-2.5 sm:table-cell">How it's counted</th>
                  </tr>
                </thead>
                <tbody>
                  {tools.map((t) => {
                    const c = costOf(t);
                    // Tools above the user's plan can't be run at all — say so
                    // instead of quoting a price they can't spend.
                    const locked = !tierMeets(user.tier, t.minTier);
                    return (
                      <tr key={t.id} className="border-b border-line last:border-0 align-top">
                        <td className="px-4 py-2.5">
                          <span className="font-semibold text-heading">{t.name}</span>
                          {SIMPLE_NAMES[t.id]?.name && (
                            <span className="block text-xs text-muted">{SIMPLE_NAMES[t.id].name}</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-right">
                          <span className={`font-semibold ${c.credits === 0 ? 'text-pos' : 'text-heading'}`}>{c.label}</span>
                          {locked && (
                            <span className="block text-[10px] font-semibold uppercase tracking-wide text-faint">
                              {PLANS[t.minTier]?.name} plan
                            </span>
                          )}
                        </td>
                        <td className="hidden px-4 py-2.5 text-xs text-muted sm:table-cell">{c.note}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ))}
      </div>

      <p className="mt-8 max-w-2xl text-xs text-faint">
        Failed runs aren't charged. Connected-data pulls (Search Console, Analytics, Ads) are free —
        they use your own account's quota. Monthly credits reset each billing period; top-up credits
        roll over and stay valid for 12 months.
      </p>
    </div>
  );
}
