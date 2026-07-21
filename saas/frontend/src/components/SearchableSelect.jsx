import { useEffect, useMemo, useRef, useState } from 'react';

// A <select> replacement with a type-to-filter search box, for long option
// lists (locations, languages, schema types). Keyboard: ↑/↓ to move, Enter to
// pick, Esc to close. Falls back to the same look as native `.field` selects.
//
// Lives here rather than inside ToolRunner because the dedicated tool pages
// (SEO Diagnostics et al) build their own forms and need the same control —
// without it they fall back to a native <select>, which is unusable once the
// option list is a full country list.
export default function SearchableSelect({ options, value, onChange, autoFocus }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef(null);
  const searchRef = useRef(null);
  const listRef = useRef(null);

  // Accept plain strings or {value,label} pairs (labels searched, values stored).
  const norm = useMemo(() => options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o)), [options]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? norm.filter((o) => o.label.toLowerCase().includes(q)) : norm;
  }, [norm, query]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // When opening, focus the search box and reset to the current selection.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    const i = norm.findIndex((o) => o.value === value);
    setActive(i >= 0 ? i : 0);
    requestAnimationFrame(() => searchRef.current?.focus());
  }, [open, norm, value]);

  // Keep the active option scrolled into view.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const pick = (opt) => { onChange(opt.value); setOpen(false); };
  const selectedLabel = norm.find((o) => o.value === value)?.label || value;

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (filtered[active]) pick(filtered[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
  };

  return (
    <div ref={rootRef} className="relative mt-1.5">
      <button
        type="button" autoFocus={autoFocus}
        onClick={() => setOpen((o) => !o)}
        className="field dm-select flex w-full items-center pr-9 text-left"
      >
        <span className="truncate">{selectedLabel || 'Select…'}</span>
      </button>
      {open && (
        <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-line bg-surface shadow-lift">
          <div className="border-b border-hair p-1.5">
            <input
              ref={searchRef} type="text" value={query}
              onChange={(e) => { setQuery(e.target.value); setActive(0); }}
              onKeyDown={onKeyDown}
              placeholder="Search…"
              className="w-full rounded-md border border-line bg-raised px-2.5 py-1.5 text-sm focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/10"
            />
          </div>
          <ul ref={listRef} className="max-h-60 overflow-y-auto py-1" role="listbox">
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-sm text-muted">No matches</li>
            ) : filtered.map((opt, i) => (
              <li key={opt.value}>
                <button
                  type="button" data-active={i === active}
                  onMouseEnter={() => setActive(i)} onClick={() => pick(opt)}
                  className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-sm ${
                    i === active ? 'bg-brand-50 dark:bg-brand-500/10 text-brand-700 dark:text-brand-300' : 'text-body'
                  }`}
                >
                  <span className="truncate">{opt.label}</span>
                  {opt.value === value && <span className="text-brand-600 dark:text-brand-400">✓</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
