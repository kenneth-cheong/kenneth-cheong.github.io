import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';

// Read a File/Blob as a data URL, upload it, and return the stored attachment.
async function uploadFile(file) {
  const data = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
  const { attachment } = await api.uploadAttachment({ name: file.name || 'screenshot.png', contentType: file.type, data });
  return attachment;
}

// Attachment row: thumbnails for images, a chip for other files.
function Attachments({ items, onRemove }) {
  if (!items?.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {items.map((a, i) => (
        <div key={i} className="relative">
          {/(png|jpe?g|gif|webp)$/i.test(a.url) || (a.contentType || '').startsWith('image/') ? (
            <a href={a.url} target="_blank" rel="noreferrer"><img src={a.url} alt={a.name} className="h-16 w-16 rounded-lg border border-slate-200 object-cover" /></a>
          ) : (
            <a href={a.url} target="_blank" rel="noreferrer" className="block rounded-lg border border-slate-200 px-3 py-2 text-xs text-brand-600">📎 {a.name}</a>
          )}
          {onRemove && (
            <button type="button" onClick={() => onRemove(i)} className="absolute -right-1.5 -top-1.5 grid h-4 w-4 place-items-center rounded-full bg-slate-700 text-[10px] text-white">×</button>
          )}
        </div>
      ))}
    </div>
  );
}

// Composer (textarea + file upload + paste-to-attach), reused by create & reply.
function Composer({ value, onChange, attachments, setAttachments, placeholder }) {
  const fileRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  async function add(files) {
    const list = [...files].filter(Boolean);
    if (!list.length) return;
    setUploading(true);
    try {
      const uploaded = await Promise.all(list.map(uploadFile));
      setAttachments((a) => [...a, ...uploaded]);
    } catch { /* ignore failed upload */ } finally { setUploading(false); }
  }
  function onPaste(e) {
    const imgs = [...(e.clipboardData?.items || [])].filter((it) => it.type.startsWith('image/')).map((it) => it.getAsFile());
    if (imgs.length) { e.preventDefault(); add(imgs); }
  }
  return (
    <div>
      <textarea
        rows={3} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} onPaste={onPaste}
        className="w-full rounded-lg border border-slate-300 p-2.5 text-sm focus:border-brand-500 focus:outline-none"
      />
      <Attachments items={attachments} onRemove={(i) => setAttachments((a) => a.filter((_, j) => j !== i))} />
      <div className="mt-1.5 flex items-center gap-3 text-xs text-slate-500">
        <button type="button" onClick={() => fileRef.current?.click()} className="font-medium text-brand-600 hover:text-brand-700">📎 Attach files</button>
        <span>or paste a screenshot</span>
        {uploading && <span>uploading…</span>}
        <input ref={fileRef} type="file" multiple accept="image/*,.pdf,.txt,.doc,.docx" className="hidden" onChange={(e) => add(e.target.files)} />
      </div>
    </div>
  );
}

export default function Support() {
  const { ticketId } = useParams();
  return ticketId ? <TicketDetail ticketId={ticketId} /> : <TicketList />;
}

function statusPill(status) {
  const map = { open: 'bg-amber-100 text-amber-700', answered: 'bg-green-100 text-green-700', closed: 'bg-slate-200 text-slate-600' };
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium uppercase ${map[status] || 'bg-slate-100 text-slate-500'}`}>{status}</span>;
}

function TicketList() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [tickets, setTickets] = useState([]);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [emails, setEmails] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  const load = () => api.tickets().then((d) => setTickets(d.tickets || [])).catch(() => {});
  useEffect(() => { load(); }, []);

  async function submit(e) {
    e.preventDefault();
    if (!subject.trim() || !message.trim()) { setNote({ err: true, text: 'Subject and message are required.' }); return; }
    setBusy(true); setNote(null);
    try {
      const additionalEmails = emails.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
      const { ticket } = await api.createTicket(subject.trim(), message.trim(), additionalEmails, attachments);
      navigate(`/support/${encodeURIComponent(ticket.ticketId)}`);
    } catch (err) {
      setNote({ err: true, text: err.message });
    } finally { setBusy(false); }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-bold">Support</h1>
      <p className="mt-1 text-slate-600">Open a ticket and our team will follow up. Track replies here and in your notifications.</p>

      <form onSubmit={submit} className="card mt-6 space-y-4 p-5">
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Subject *</span>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Short summary"
            className="mt-1.5 w-full rounded-lg border border-slate-300 p-2.5 text-sm focus:border-brand-500 focus:outline-none" />
        </label>
        <div>
          <span className="text-sm font-medium text-slate-700">Message *</span>
          <div className="mt-1.5"><Composer value={message} onChange={setMessage} attachments={attachments} setAttachments={setAttachments} placeholder="Describe the issue… paste a screenshot if it helps." /></div>
        </div>
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Also alert these emails</span>
          <input value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="teammate@company.com, manager@company.com"
            className="mt-1.5 w-full rounded-lg border border-slate-300 p-2.5 text-sm focus:border-brand-500 focus:outline-none" />
          <span className="mt-1 block text-xs text-slate-400">Updates always go to <strong>{user.email}</strong>. Add more here to CC them.</span>
        </label>
        <div className="flex items-center justify-between">
          {note ? <span className={`text-sm ${note.err ? 'text-red-600' : 'text-green-600'}`}>{note.text}</span> : <span />}
          <button className="btn-primary" disabled={busy}>{busy ? 'Submitting…' : 'Submit ticket'}</button>
        </div>
      </form>

      <h2 className="mt-8 text-lg font-semibold">Your tickets</h2>
      <div className="mt-3 space-y-2">
        {tickets.length === 0 && <div className="card p-6 text-center text-slate-400">No tickets yet.</div>}
        {tickets.map((t) => (
          <Link key={t.ticketId} to={`/support/${encodeURIComponent(t.ticketId)}`} className="card flex items-center gap-3 p-4 transition hover:border-brand-300">
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{t.subject}</div>
              <div className="text-xs text-slate-400">{t.id} · {new Date(t.lastActivityAt || t.ts).toLocaleString()}</div>
            </div>
            {statusPill(t.status)}
            <span className="text-brand-500">Open →</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

function TicketDetail({ ticketId }) {
  const [ticket, setTicket] = useState(null);
  const [reply, setReply] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [busy, setBusy] = useState(false);

  const load = () => api.ticket(ticketId).then((d) => setTicket(d.ticket)).catch(() => setTicket(false));
  useEffect(() => { load(); }, [ticketId]);

  async function send(e) {
    e.preventDefault();
    if (!reply.trim() && !attachments.length) return;
    setBusy(true);
    try {
      const { ticket: t } = await api.replyTicket(ticketId, reply.trim(), attachments);
      setTicket(t); setReply(''); setAttachments([]);
    } catch { /* ignore */ } finally { setBusy(false); }
  }
  async function close() {
    setBusy(true);
    try { await api.closeTicket(ticketId); setTicket((t) => ({ ...t, status: 'closed' })); } finally { setBusy(false); }
  }

  if (ticket === false) return <div className="mx-auto max-w-3xl"><Link to="/support" className="text-sm text-slate-500">← Support</Link><p className="mt-4 text-red-600">Ticket not found.</p></div>;
  if (!ticket) return <p className="text-slate-400">Loading…</p>;

  return (
    <div className="mx-auto max-w-3xl">
      <Link to="/support" className="text-sm text-slate-500 hover:text-slate-800">← All tickets</Link>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">{ticket.subject}</h1>
        {statusPill(ticket.status)}
        <span className="text-xs text-slate-400">{ticket.id}</span>
        {ticket.status !== 'closed' && <button onClick={close} disabled={busy} className="ml-auto text-sm text-slate-500 hover:text-slate-800">Close ticket</button>}
      </div>
      {ticket.additionalEmails?.length > 0 && (
        <p className="mt-1 text-xs text-slate-400">Also alerting: {ticket.additionalEmails.join(', ')}</p>
      )}

      <div className="mt-5 space-y-3">
        {(ticket.messages || []).map((m) => (
          <div key={m.id} className={`card p-4 ${m.author === 'agent' ? 'border-brand-200 bg-brand-50/40' : ''}`}>
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <span className="font-semibold text-slate-600">{m.author === 'agent' ? 'Support' : 'You'}</span>
              <span>· {new Date(m.ts).toLocaleString()}</span>
            </div>
            {m.body && <p className="mt-1.5 whitespace-pre-wrap text-sm text-slate-700">{m.body}</p>}
            <Attachments items={m.attachments} />
          </div>
        ))}
      </div>

      <form onSubmit={send} className="card mt-4 p-4">
        <Composer value={reply} onChange={setReply} attachments={attachments} setAttachments={setAttachments}
          placeholder={ticket.status === 'closed' ? 'Reply to reopen this ticket…' : 'Write a reply… paste a screenshot if it helps.'} />
        <div className="mt-3 flex justify-end">
          <button className="btn-primary" disabled={busy}>{busy ? 'Sending…' : 'Send reply'}</button>
        </div>
      </form>
    </div>
  );
}
