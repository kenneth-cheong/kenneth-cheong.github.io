import { useEffect, useState } from 'react';

// Lightweight toast host — listens for `dm:toast` events (see lib/ui.js).
export default function Toaster() {
  const [items, setItems] = useState([]);
  const dismiss = (id) => setItems((xs) => xs.filter((x) => x.id !== id));

  useEffect(() => {
    const onToast = (e) => {
      const t = e.detail;
      setItems((xs) => [...xs, t]);
      // Give the user time to actually reach an action button before it vanishes.
      setTimeout(() => dismiss(t.id), t.action ? 7000 : 3200);
    };
    window.addEventListener('dm:toast', onToast);
    return () => window.removeEventListener('dm:toast', onToast);
  }, []);

  const tone = { success: 'bg-green-600', error: 'bg-red-600', info: 'bg-slate-800' };
  return (
    <div role="status" aria-live="polite" aria-atomic="true"
      className="dm-no-print fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
      {items.map((t) => (
        <div key={t.id} className={`flex items-center gap-3 rounded-lg px-4 py-2 text-sm font-medium text-white shadow-lg ${tone[t.type] || tone.info}`}>
          <span>{t.msg}</span>
          {t.action && (
            <button
              onClick={() => { t.action.onClick?.(); dismiss(t.id); }}
              className="-mr-1 shrink-0 rounded px-2 py-0.5 text-sm font-semibold underline underline-offset-2 hover:bg-white/15"
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
