import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { MessageCircle } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { Attachments } from '../components/Attachments.jsx';
import { TicketComposer as Composer } from '../components/TicketComposer.jsx';
import DiagnosticsPanel from '../components/DiagnosticsPanel.jsx';

const CATEGORIES = [
  'Billing & credits',
  'Account & login',
  'Tool not working / bug',
  'Integrations & data (GSC / GA4 / Ads)',
  'Results quality / how-to',
  'Feature request',
  'Other',
];

const openAssistant = () => window.dispatchEvent(new Event('dm:open-chat'));

export default function Support() {
  const { ticketId } = useParams();
  return ticketId ? <TicketDetail ticketId={ticketId} /> : <TicketList />;
}

function statusPill(status) {
  const map = { open: 'bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300', answered: 'bg-green-100 dark:bg-green-500/15 text-green-700 dark:text-green-300', closed: 'bg-overlay text-dim' };
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium uppercase ${map[status] || 'bg-sunken text-muted'}`}>{status}</span>;
}

function AssistantNudge() {
  return (
    <div className="mt-6 flex items-center gap-3 rounded-xl border border-brand-200 dark:border-brand-500/30 bg-brand-50/60 p-4">
      <MessageCircle size={24} className="shrink-0 text-brand-600 dark:text-brand-400" aria-hidden />
      <div className="flex-1">
        <div className="font-semibold text-brand-800 dark:text-brand-300">Need a quick answer? Ask the assistant first.</div>
        <div className="text-sm text-dim">It replies instantly, knows every tool, and can read your connected Search Console / GA4 / Ads data — most questions don't need a ticket.</div>
      </div>
      <button onClick={openAssistant} className="btn-primary whitespace-nowrap px-3 py-1.5 text-sm">Ask the assistant</button>
    </div>
  );
}

function TicketList() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [tickets, setTickets] = useState([]);
  const [subject, setSubject] = useState('');
  const [category, setCategory] = useState(CATEGORIES[0]);
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
      const { ticket } = await api.createTicket(subject.trim(), message.trim(), { additionalEmails, attachments, category });
      navigate(`/support/${encodeURIComponent(ticket.ticketId)}`);
    } catch (err) { setNote({ err: true, text: err.message }); } finally { setBusy(false); }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-bold">Support</h1>
      <p className="mt-1 text-dim">Open a ticket and our team will follow up. Track the conversation here and in your notifications.</p>

      <AssistantNudge />

      <form onSubmit={submit} className="card mt-6 space-y-4 p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-sm font-medium text-body">Category</span>
            <select value={category} onChange={(e) => setCategory(e.target.value)}
              className="dm-select mt-1.5 w-full rounded-lg border border-edge py-2.5 pl-2.5 pr-9 text-sm focus:border-brand-500 focus:outline-none">
              {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-sm font-medium text-body">Subject *</span>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Short summary"
              className="mt-1.5 w-full rounded-lg border border-edge p-2.5 text-sm focus:border-brand-500 focus:outline-none" />
          </label>
        </div>
        <div>
          <span className="text-sm font-medium text-body">Message *</span>
          <div className="mt-1.5"><Composer value={message} onChange={setMessage} attachments={attachments} setAttachments={setAttachments} placeholder="Describe the issue… paste a screenshot if it helps." /></div>
        </div>
        <label className="block">
          <span className="text-sm font-medium text-body">Also alert these emails</span>
          <input value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="teammate@company.com, manager@company.com"
            className="mt-1.5 w-full rounded-lg border border-edge p-2.5 text-sm focus:border-brand-500 focus:outline-none" />
          <span className="mt-1 block text-xs text-faint">Updates always go to <strong>{user.email}</strong>. Add more here to CC them.</span>
        </label>
        <div className="flex items-center justify-between">
          {note ? <span className={`text-sm ${note.err ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}`}>{note.text}</span> : <span />}
          <button className="btn-primary" disabled={busy}>{busy ? 'Submitting…' : 'Start ticket'}</button>
        </div>
      </form>

      <h2 className="mt-8 text-lg font-semibold">Your tickets</h2>
      <div className="mt-3 space-y-2">
        {tickets.length === 0 && <div className="card p-6 text-center text-faint">No tickets yet.</div>}
        {tickets.map((t) => (
          <Link key={t.ticketId} to={`/support/${encodeURIComponent(t.ticketId)}`} className="card flex items-center gap-3 p-4 transition hover:border-brand-300 dark:hover:border-brand-500/40">
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{t.subject}</div>
              <div className="text-xs text-faint">{t.id}{t.category ? ` · ${t.category}` : ''} · {new Date(t.lastActivityAt || t.ts).toLocaleString()}</div>
            </div>
            {statusPill(t.status)}
            <span className="text-brand-500">Open →</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

// Chat-style conversation view: bubbles + a sticky composer at the bottom.
function TicketDetail({ ticketId }) {
  const [ticket, setTicket] = useState(null);
  const [reply, setReply] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [busy, setBusy] = useState(false);
  const threadRef = useRef(null);

  const load = () => api.ticket(ticketId).then((d) => setTicket(d.ticket)).catch(() => setTicket(false));
  useEffect(() => { load(); }, [ticketId]);
  useEffect(() => { if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight; }, [ticket]);

  async function send() {
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

  if (ticket === false) return <div className="mx-auto max-w-3xl"><Link to="/support" className="text-sm text-muted">← Support</Link><p className="mt-4 text-red-600 dark:text-red-400">Ticket not found.</p></div>;
  if (!ticket) return <p className="text-faint">Loading…</p>;

  return (
    <div className="mx-auto flex h-[calc(100vh-9rem)] max-w-3xl flex-col">
      <Link to="/support" className="text-sm text-muted hover:text-strong">← All tickets</Link>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-bold">{ticket.subject}</h1>
        {statusPill(ticket.status)}
        {ticket.category && <span className="rounded-full bg-sunken px-2 py-0.5 text-xs text-muted">{ticket.category}</span>}
        <span className="text-xs text-faint">{ticket.id}</span>
        {ticket.status !== 'closed' && <button onClick={close} disabled={busy} className="ml-auto text-sm text-muted hover:text-strong">Close ticket</button>}
      </div>
      {ticket.additionalEmails?.length > 0 && <p className="mt-1 text-xs text-faint">Also alerting: {ticket.additionalEmails.join(', ')}</p>}

      <DiagnosticsPanel diagnostics={ticket.diagnostics} />

      {/* Conversation */}
      <div ref={threadRef} className="mt-3 flex-1 space-y-3 overflow-y-auto rounded-xl border border-line bg-raised p-4">
        {(ticket.messages || []).map((m) => {
          const mine = m.author !== 'agent';
          return (
            <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] rounded-2xl px-3.5 py-2.5 ${mine ? 'rounded-br-sm bg-brand-600 text-white' : 'rounded-bl-sm bg-surface text-strong shadow-sm ring-1 ring-line'}`}>
                <div className={`mb-0.5 text-[11px] ${mine ? 'text-white/70' : 'text-faint'}`}>{mine ? 'You' : (m.authorName || 'Support')} · {new Date(m.ts).toLocaleString()}</div>
                {m.body && <div className="whitespace-pre-wrap text-sm">{m.body}</div>}
                <Attachments items={m.attachments} light={mine} />
              </div>
            </div>
          );
        })}
      </div>

      {/* Composer */}
      <div className="mt-3 rounded-xl border border-line bg-surface p-3">
        <Composer value={reply} onChange={setReply} attachments={attachments} setAttachments={setAttachments} onSubmit={send}
          placeholder={ticket.status === 'closed' ? 'Reply to reopen this ticket…' : 'Type a message…  (⌘/Ctrl + Enter to send)'} />
        <div className="mt-2 flex items-center justify-between">
          <button onClick={openAssistant} className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300"><MessageCircle size={13} aria-hidden /> Ask the assistant instead</button>
          <button onClick={send} className="btn-primary" disabled={busy}>{busy ? 'Sending…' : 'Send'}</button>
        </div>
      </div>
    </div>
  );
}
