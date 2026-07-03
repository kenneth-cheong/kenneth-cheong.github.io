import { useState } from 'react';

// Read-only view of the structured diagnostics captured by the fault reporter.
// Shown on a ticket to both the reporter (Support.jsx) and support staff
// (Admin.jsx) — same component, so what a customer sees is what staff sees.
export default function DiagnosticsPanel({ diagnostics: d }) {
  const [open, setOpen] = useState(false);
  if (!d) return null;
  const env = d.env || {};
  return (
    <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-slate-700">
        🔧 Diagnostics
        <span className="ml-auto text-xs text-slate-400">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-slate-100 px-3 py-3 text-xs text-slate-600">
          {env.url && (
            <div>
              <div className="font-semibold text-slate-700">Environment</div>
              <div className="mt-1 space-y-0.5 text-slate-500">
                <div className="break-all">Page: {env.url}</div>
                {env.viewport && <div>Screen: {env.viewport} · {env.online === false ? 'offline' : 'online'}</div>}
                {env.userAgent && <div className="break-words">Browser: {env.userAgent}</div>}
                {env.timestamp && <div>At: {new Date(env.timestamp).toLocaleString()}</div>}
                {d.user?.email && <div>User: {d.user.email}{d.user.tier ? ` (${d.user.tier})` : ''}</div>}
                {d.project && <div>Project: {d.project.name || d.project.projectId}{d.project.domain ? ` · ${d.project.domain}` : ''}</div>}
              </div>
            </div>
          )}
          {d.apiFailures?.length > 0 && (
            <div>
              <div className="font-semibold text-slate-700">Failed actions</div>
              <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-slate-500">
                {d.apiFailures.map((f, i) => <li key={i} className="break-all">{f.method} {f.path} → {f.status || 'network'} {f.message ? `· ${f.message}` : ''}</li>)}
              </ul>
            </div>
          )}
          {d.apiSuccesses?.length > 0 && (
            <div>
              <div className="font-semibold text-slate-700">Other calls that succeeded around the same time</div>
              <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-slate-500">
                {d.apiSuccesses.map((s, i) => <li key={i} className="break-all">{s.method} {s.path} → OK · {new Date(s.ts).toLocaleTimeString()}</li>)}
              </ul>
            </div>
          )}
          {d.errors?.length > 0 && (
            <div>
              <div className="font-semibold text-slate-700">Errors</div>
              <ul className="mt-1 space-y-0.5 text-slate-500">
                {d.errors.map((e, i) => <li key={i} className="break-words">{e.source ? `[${e.source}] ` : ''}{e.message}</li>)}
              </ul>
            </div>
          )}
          {d.errorToasts?.length > 0 && (
            <div>
              <div className="font-semibold text-slate-700">Messages the user saw</div>
              <ul className="mt-1 space-y-0.5 text-slate-500">{d.errorToasts.map((t, i) => <li key={i}>{t.message}</li>)}</ul>
            </div>
          )}
          {d.fields?.length > 0 && (
            <div>
              <div className="font-semibold text-slate-700">Form fields filled in</div>
              <ul className="mt-1 space-y-0.5 text-slate-500">
                {d.fields.map((f, i) => <li key={i} className="break-words"><span className="font-medium text-slate-600">{f.label}:</span> {f.value}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
