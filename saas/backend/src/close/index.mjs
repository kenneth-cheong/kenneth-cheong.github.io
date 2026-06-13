// Scheduled job (EventBridge, daily): auto-close support tickets that have had
// no activity for AUTO_CLOSE_DAYS. Notifies the owner in-app + by email.
import { scanOpenTickets, setTicketStatus, addNotification } from '../lib/dynamo.mjs';
import { sendEmail } from '../lib/email.mjs';

const DAYS = Number(process.env.AUTO_CLOSE_DAYS || 7);

export const handler = async () => {
  const cutoff = Date.now() - DAYS * 86400_000;
  const tickets = await scanOpenTickets();
  let closed = 0;
  for (const t of tickets) {
    const last = new Date(t.lastActivityAt || t.ts).getTime();
    if (!(last < cutoff)) continue;
    await setTicketStatus(t.userId, t.ticketId, 'closed');
    await addNotification({ userId: t.userId, title: `Ticket ${t.id} auto-closed`, body: `Closed after ${DAYS} days of inactivity — reply to reopen.`, ticketId: t.ticketId });
    await sendEmail({
      to: [t.userEmail, ...(t.additionalEmails || [])].filter(Boolean),
      subject: `Ticket ${t.id} closed`,
      text: `Your ticket "${t.subject}" was closed after ${DAYS} days of inactivity. Reply in-app to reopen it.`,
    });
    closed++;
  }
  console.log(`auto_close done: ${closed}/${tickets.length}`);
  return { closed };
};
