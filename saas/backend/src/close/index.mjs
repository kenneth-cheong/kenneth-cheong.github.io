// Scheduled job (EventBridge, daily): maintain support tickets per the
// admin-configured lifecycle settings —
//   1. Auto-close any non-closed ticket inactive for ticketAutoCloseDays.
//   2. While we're waiting on the CLIENT (status 'answered' = support replied
//      last), nudge them every ticketReminderDays until they reply or it closes.
// Both notify the owner in-app + by email. Either behaviour is off when its
// setting is 0.
import { getSettings, scanOpenTickets, setTicketStatus, addNotification, markTicketReminded } from '../lib/dynamo.mjs';
import { sendNotice, SUPPORT_INBOX } from '../lib/email.mjs';

const APP_ORIGIN = process.env.APP_ORIGIN || '';
const DAY = 86400_000;

export const handler = async () => {
  const s = await getSettings();
  // Legacy env var is the floor default if settings somehow can't be read.
  const closeDays = Number.isFinite(s.ticketAutoCloseDays) ? s.ticketAutoCloseDays : Number(process.env.AUTO_CLOSE_DAYS || 7);
  const remindDays = Number.isFinite(s.ticketReminderDays) ? s.ticketReminderDays : 0;
  const now = Date.now();
  const tickets = await scanOpenTickets();
  let closed = 0, reminded = 0;

  for (const t of tickets) {
    const inactiveDays = (now - new Date(t.lastActivityAt || t.ts).getTime()) / DAY;
    const to = [t.userEmail, ...(t.additionalEmails || [])].filter(Boolean);

    // 1. Auto-close after the configured inactivity window.
    if (closeDays > 0 && inactiveDays >= closeDays) {
      await setTicketStatus(t.userId, t.ticketId, 'closed');
      await addNotification({ userId: t.userId, title: `Ticket ${t.id} auto-closed`, body: `Closed after ${closeDays} days of inactivity — reply to reopen.`, ticketId: t.ticketId });
      await sendNotice({
        to,
        replyTo: SUPPORT_INBOX || undefined,
        subject: `Ticket ${t.id} closed`,
        text: `Your ticket "${t.subject}" was closed after ${closeDays} days of inactivity. Reply in-app to reopen it.`,
      });
      closed++;
      continue;
    }

    // 2. Otherwise nudge the client — only while the ball is in their court
    //    (we replied last) and only once per ticketReminderDays.
    if (remindDays > 0 && t.status === 'answered') {
      const sinceNudge = (now - new Date(t.lastReminderAt || t.lastActivityAt || t.ts).getTime()) / DAY;
      if (sinceNudge >= remindDays) {
        await addNotification({ userId: t.userId, title: `Reminder: ticket ${t.id} is awaiting your reply`, body: `Support is waiting on your response${closeDays > 0 ? ` — the ticket auto-closes after ${closeDays} days of no reply` : ''}.`, ticketId: t.ticketId });
        await sendNotice({
          to,
          replyTo: SUPPORT_INBOX || undefined,
          subject: `Reminder: your support ticket ${t.id} is awaiting your reply`,
          text: `Hi,\n\nWe're still waiting on your response to support ticket ${t.id} — "${t.subject}".\n\nReply here: ${APP_ORIGIN}/support/${encodeURIComponent(t.ticketId)}\n${closeDays > 0 ? `\nIf we don't hear back, the ticket will automatically close after ${closeDays} days of no reply.` : ''}`,
        });
        await markTicketReminded(t.userId, t.ticketId);
        reminded++;
      }
    }
  }

  console.log(`ticket_maintenance done: closed ${closed}, reminded ${reminded} of ${tickets.length}`);
  return { closed, reminded };
};
