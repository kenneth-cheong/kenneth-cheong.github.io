import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { TOOLS, CATEGORIES, SIMPLE_NAMES } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import Modal from './Modal.jsx';
import ToolCard from './ToolCard.jsx';

// The approved design's catalog popup (mockup #modal-tools): one searchable
// sheet holding every tool, grouped by category, in the illustrated tiles.
// Runs off the real TOOLS catalog, so the count and the tiles can't drift.
export default function ToolsModal({ open, onClose }) {
  const { user } = useAuth();
  const [q, setQ] = useState('');

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const match = (t) =>
      !needle ||
      (t.name + t.desc + (SIMPLE_NAMES[t.id]?.name || '')).toLowerCase().includes(needle);
    return CATEGORIES
      .map((c) => [c, TOOLS.filter((t) => t.category === c && match(t))])
      .filter(([, tools]) => tools.length > 0);
  }, [q]);

  const hits = groups.reduce((n, [, tools]) => n + tools.length, 0);

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      tag="CATALOG"
      title="All tools"
      titleNote={TOOLS.length}
      labelledBy="dm-tools-title"
    >
      <div className="flex items-center gap-2.5 rounded-2xl border border-line bg-raised px-3.5 py-2.5">
        <Search size={16} className="shrink-0 text-faint" aria-hidden />
        <input
          data-autofocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Search ${TOOLS.length} tools…`}
          aria-label="Search tools"
          className="w-full bg-transparent text-[12.5px] text-heading outline-none placeholder:text-faint"
        />
      </div>

      {hits === 0 && <p className="py-8 text-center text-sm text-faint">No tools match “{q}”.</p>}

      {groups.map(([category, tools]) => (
        <section key={category}>
          <h4 className="mb-2.5 text-[10px] font-extrabold uppercase tracking-[0.14em] text-faint">{category}</h4>
          {/* auto-fill/224px — the mockup's denser catalog grid, not the page's 3-up */}
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(224px, 1fr))' }}>
            {tools.map((t) => <ToolCard key={t.id} tool={t} userTier={user.tier} />)}
          </div>
        </section>
      ))}
    </Modal>
  );
}
