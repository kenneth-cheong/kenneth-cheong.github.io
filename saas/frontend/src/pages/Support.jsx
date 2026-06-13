import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

export default function Support() {
  const [tickets, setTickets] = useState([]);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  const load = () => api.tickets().then((d) => setTickets(d.tickets || [])).catch(() => {});
  useEffect(() => { load(); }, []);

  async function submit(e) {
    e.preventDefault();
    if (!subject.trim() || !message.trim()) { setNote({ err: true, text: 'Subject and message are required.' }); return; }
    setBusy(true); setNote(null);
    try {
      const { ticket } = await api.createTicket(subject.trim(), message.trim());
      setNote({ text: `Ticket ${ticket.id} submitted — we'll follow up by email.` });
      setSubject(''); setMessage('');
      load();
    } catch (err) {
      setNote({ err: true, text: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-bold">Support</h1>
      <p className="mt-1 text-slate-600">Hit a snag? Open a ticket and our team will follow up.</p>

      <form onSubmit={submit} className="card mt-6 space-y-4 p-5">
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Subject *</span>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Short summary"
            className="mt-1.5 w-full rounded-lg border border-slate-300 p-2.5 text-sm focus:border-brand-500 focus:outline-none" />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-slate-700">Message *</span>
          <textarea rows={4} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Describe the issue…"
            className="mt-1.5 w-full rounded-lg border border-slate-300 p-2.5 text-sm focus:border-brand-500 focus:outline-none" />
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
          <div key={t.ticketId} className="card p-4">
            <div className="flex items-center gap-2">
              <span className="font-semibold">{t.subject}</span>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium uppercase text-slate-500">{t.status}</span>
              <span className="ml-auto text-xs text-slate-400">{new Date(t.ts).toLocaleString()}</span>
            </div>
            <p className="mt-1 text-sm text-slate-600">{t.message}</p>
            <p className="mt-1 text-xs text-slate-400">{t.id}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
