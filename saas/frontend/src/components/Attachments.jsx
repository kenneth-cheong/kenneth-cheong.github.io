import { Paperclip } from 'lucide-react';
import { api } from '../lib/api.js';

// Read a File/Blob as a data URL, upload it via the support attachments endpoint,
// and return the stored attachment. Shared by the Support composer and the
// FaultReporter so both upload screenshots/files the same way.
export async function uploadFile(file) {
  const data = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
  const { attachment } = await api.uploadAttachment({ name: file.name || 'screenshot.png', contentType: file.type, data });
  return attachment;
}

// Thumbnail/file-chip strip for a list of stored attachments. `onRemove(i)`
// makes each removable; `light` styles chips for dark bubbles.
export function Attachments({ items, onRemove, light }) {
  if (!items?.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {items.map((a, i) => (
        <div key={i} className="relative">
          {/(png|jpe?g|gif|webp)$/i.test(a.url) || (a.contentType || '').startsWith('image/') ? (
            <a href={a.url} target="_blank" rel="noreferrer"><img src={a.url} alt={a.name} className="h-16 w-16 rounded-lg border border-line object-cover" /></a>
          ) : (
            <a href={a.url} target="_blank" rel="noreferrer" className={`flex items-center gap-1 rounded-lg border px-3 py-2 text-xs ${light ? 'border-white/40 text-white' : 'border-line text-brand-600 dark:text-brand-400'}`}><Paperclip size={12} aria-hidden /> {a.name}</a>
          )}
          {onRemove && <button type="button" onClick={() => onRemove(i)} className="absolute -right-1.5 -top-1.5 grid h-4 w-4 place-items-center rounded-full bg-slate-700 text-[10px] text-white">×</button>}
        </div>
      ))}
    </div>
  );
}
