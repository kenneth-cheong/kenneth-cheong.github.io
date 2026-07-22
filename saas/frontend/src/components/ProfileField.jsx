import { X } from 'lucide-react';
import SearchableSelect from './SearchableSelect.jsx';

// One profile input control, chosen by field.type (text | textarea | select |
// multiselect). Shared by the Profile page and the Dashboard drip card so the
// two render identically. `value` is a string or (for multiselect) an array.
//
// `field.searchable` switches the long lists (target markets, timezone) from
// "render every option" to a type-to-filter picker. Chips are fine at ten
// options and unusable at sixty — and the drip card on the Dashboard has room
// for neither.
export default function ProfileField({ field, value, onChange }) {
  const v = value ?? (field.type === 'multiselect' ? [] : '');

  if (field.type === 'multiselect' && field.searchable) {
    const selected = Array.isArray(v) ? v : [];
    const remaining = field.options.filter((o) => !selected.includes(o));
    return (
      <div>
        {selected.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {selected.map((opt) => (
              <span key={opt} className="inline-flex items-center gap-1 rounded-full bg-brand-600 py-1 pl-3 pr-1.5 text-sm font-medium text-white">
                {opt}
                <button
                  type="button"
                  onClick={() => onChange(selected.filter((x) => x !== opt))}
                  className="rounded-full p-0.5 hover:bg-white/20"
                  aria-label={`Remove ${opt}`}
                >
                  <X size={13} aria-hidden />
                </button>
              </span>
            ))}
          </div>
        )}
        {remaining.length > 0 && (
          // Keyed on the selection so the picker resets to its placeholder after
          // each add — it is an "add one" control, not a current-value display.
          <SearchableSelect
            key={selected.length}
            options={remaining}
            value=""
            placeholder={selected.length ? 'Add another…' : 'Search and select…'}
            onChange={(opt) => opt && onChange([...selected, opt])}
          />
        )}
      </div>
    );
  }

  if (field.type === 'multiselect') {
    const selected = Array.isArray(v) ? v : [];
    const toggle = (opt) =>
      onChange(selected.includes(opt) ? selected.filter((x) => x !== opt) : [...selected, opt]);
    return (
      <div className="flex flex-wrap gap-2">
        {field.options.map((opt) => {
          const on = selected.includes(opt);
          return (
            <button
              key={opt}
              type="button"
              onClick={() => toggle(opt)}
              className={`rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                on ? 'border-brand-600 bg-brand-600 text-white' : 'border-edge bg-surface text-body hover:bg-raised'
              }`}
            >
              {opt}
            </button>
          );
        })}
      </div>
    );
  }

  if (field.type === 'select') {
    if (field.searchable) {
      return <SearchableSelect options={field.options} value={v} onChange={onChange} />;
    }
    return (
      <select className="field dm-select pr-8" value={v} onChange={(e) => onChange(e.target.value)}>
        <option value="">Select…</option>
        {field.options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
      </select>
    );
  }

  if (field.type === 'textarea') {
    return (
      <textarea
        className="field" rows={3} value={v}
        placeholder={field.placeholder || ''}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  return (
    <input
      className="field" type="text" value={v}
      placeholder={field.placeholder || ''}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
