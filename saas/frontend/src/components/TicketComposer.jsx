import { useRef, useState } from 'react';
import { Paperclip } from 'lucide-react';
import { Attachments, uploadFile } from './Attachments.jsx';

// Shared support-ticket composer: textarea + attach button + paste-to-attach +
// drag-and-drop. Used by the client Support page AND the staff/admin reply box so
// both sides upload screenshots/files the same way. `header` renders above the
// textarea (e.g. the admin "Reply as" toggle).
export function TicketComposer({ value, onChange, attachments, setAttachments, placeholder, onSubmit, rows = 3, header = null }) {
  const fileRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  async function add(files) {
    const list = [...files].filter(Boolean);
    if (!list.length) return;
    setUploading(true);
    try { const up = await Promise.all(list.map(uploadFile)); setAttachments((a) => [...a, ...up]); } catch { /* ignore */ } finally { setUploading(false); }
  }
  // Paste ANY copied file/screenshot (not just images). Leaves plain-text paste alone.
  function onPaste(e) {
    const files = [...(e.clipboardData?.items || [])].filter((it) => it.kind === 'file').map((it) => it.getAsFile()).filter(Boolean);
    if (files.length) { e.preventDefault(); add(files); }
  }
  function onKey(e) {
    if (onSubmit && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSubmit(); }
  }
  function onDrop(e) {
    e.preventDefault(); setDragOver(false);
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) add(files);
  }
  return (
    <div
      onDragOver={(e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); setDragOver(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
      onDrop={onDrop}
      className={`rounded-lg ${dragOver ? 'ring-2 ring-brand-400 ring-offset-1' : ''}`}
    >
      {header}
      <textarea
        rows={rows} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} onPaste={onPaste} onKeyDown={onKey}
        className="w-full rounded-lg border border-slate-300 p-2.5 text-sm focus:border-brand-500 focus:outline-none"
      />
      <Attachments items={attachments} onRemove={(i) => setAttachments((a) => a.filter((_, j) => j !== i))} />
      <div className="mt-1.5 flex items-center gap-3 text-xs text-slate-500">
        <button type="button" onClick={() => fileRef.current?.click()} className="inline-flex items-center gap-1 font-medium text-brand-600 hover:text-brand-700"><Paperclip size={13} aria-hidden /> Attach files</button>
        <span>paste or drag &amp; drop</span>
        {uploading && <span>uploading…</span>}
        <input ref={fileRef} type="file" multiple accept="image/*,.pdf,.txt,.doc,.docx" className="hidden" onChange={(e) => add(e.target.files)} />
      </div>
    </div>
  );
}
