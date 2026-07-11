// One profile input control, chosen by field.type (text | textarea | select |
// multiselect). Shared by the Profile page and the Dashboard drip card so the
// two render identically. `value` is a string or (for multiselect) an array.
export default function ProfileField({ field, value, onChange }) {
  const v = value ?? (field.type === 'multiselect' ? [] : '');

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
