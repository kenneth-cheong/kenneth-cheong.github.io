import { useEffect, useState } from 'react';

// Lightweight toast host — listens for `dm:toast` events (see lib/ui.js).
export default function Toaster() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    const onToast = (e) => {
      const t = e.detail;
      setItems((xs) => [...xs, t]);
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== t.id)), 3200);
    };
    window.addEventListener('dm:toast', onToast);
    return () => window.removeEventListener('dm:toast', onToast);
  }, []);

  const tone = { success: 'bg-green-600', error: 'bg-red-600', info: 'bg-slate-800' };
  return (
    <div className="fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
      {items.map((t) => (
        <div key={t.id} className={`rounded-lg px-4 py-2 text-sm font-medium text-white shadow-lg ${tone[t.type] || tone.info}`}>
          {t.msg}
        </div>
      ))}
    </div>
  );
}
