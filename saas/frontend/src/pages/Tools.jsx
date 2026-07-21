import { useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { TOOLS, CATEGORIES, CATEGORY_META, SIMPLE_NAMES } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import ToolCard from '../components/ToolCard.jsx';

// The full tool catalogue as a first-class PAGE (it used to be a modal). Every
// tool tile, grouped by category, searchable by name / description / plain-name.
// Tiles navigate to each tool's own page — consistent with how tools open
// everywhere else in the app.
export default function Tools() {
  const { user } = useAuth();
  const [q, setQ] = useState('');
  // ?category=… — set by the sidebar's discipline sub-menu. An unknown value is
  // ignored rather than showing an empty page.
  const [params] = useSearchParams();
  const raw = params.get('category');
  const category = CATEGORIES.includes(raw) ? raw : null;

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const match = (t) =>
      !needle || (t.name + t.desc + (SIMPLE_NAMES[t.id]?.name || '')).toLowerCase().includes(needle);
    return CATEGORIES
      .filter((c) => !category || c === category)
      .map((c) => [c, TOOLS.filter((t) => t.category === c && match(t))])
      .filter(([, tools]) => tools.length > 0);
  }, [q, category]);

  const hits = groups.reduce((n, [, tools]) => n + tools.length, 0);

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-heading">{category || 'Tools'}</h1>
          <p className="mt-1 text-sm text-muted">
            {category
              ? <>Showing {category} tools only. Click any tile to open and run it.</>
              : <>Every tool, grouped by job. Click any tile to open and run it.</>}
          </p>
        </div>
        <span className="shrink-0 text-sm font-semibold text-muted">
          {category ? TOOLS.filter((t) => t.category === category).length : TOOLS.length} tools
        </span>
      </div>

      {/* The same discipline filter the sidebar offers, repeated here — on mobile
          the rail is hidden behind a menu, and on desktop this shows which
          discipline you're currently narrowed to. */}
      <div className="mb-4 flex flex-wrap gap-2">
        <Link to="/tools" className={`dm-cat-chip ${!category ? 'dm-cat-chip-on' : ''}`}>All</Link>
        {CATEGORIES.map((c) => (
          <Link
            key={c}
            to={category === c ? '/tools' : `/tools?category=${encodeURIComponent(c)}`}
            className={`dm-cat-chip ${category === c ? 'dm-cat-chip-on' : ''}`}
          >
            <span className="dm-sb-dot" style={{ background: CATEGORY_META[c]?.color || 'currentColor' }} aria-hidden />
            {c}
            {category === c && <X size={12} aria-hidden />}
          </Link>
        ))}
      </div>

      <div className="mb-6 flex items-center gap-2.5 rounded-2xl border border-line bg-raised px-3.5 py-2.5">
        <Search size={16} className="shrink-0 text-faint" aria-hidden />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Search ${TOOLS.length} tools…`}
          aria-label="Search tools"
          className="w-full bg-transparent text-sm text-heading outline-none placeholder:text-faint"
        />
      </div>

      {hits === 0 && <p className="py-12 text-center text-sm text-faint">No tools match “{q}”.</p>}

      <div className="flex flex-col gap-8">
        {groups.map(([cat, tools]) => (
          <section key={cat}>
            {/* Redundant when the page title already names the one discipline. */}
            {!category && <h2 className="mb-3 text-[11px] font-extrabold uppercase tracking-[0.14em] text-faint">{cat}</h2>}
            <div className="grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
              {tools.map((t) => <ToolCard key={t.id} tool={t} userTier={user.tier} />)}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
