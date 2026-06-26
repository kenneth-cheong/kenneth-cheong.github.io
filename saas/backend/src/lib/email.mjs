// Best-effort transactional email via SES. No-ops (returns false) when SES isn't
// configured, so a missing email setup never fails a request. @aws-sdk/client-ses
// ships with the nodejs20 Lambda runtime.
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

const ses = new SESClient({});
const FROM = process.env.SES_FROM;

export async function sendEmail({ to, subject, text, html }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!FROM || !recipients.length) return false;
  // SES requires at least one body part. Most callers send plain text; broadcast
  // emails pass `html` (with `text` as the multipart fallback for plain readers).
  const Body = {};
  if (text) Body.Text = { Data: text };
  if (html) Body.Html = { Data: html };
  if (!Body.Text && !Body.Html) return false;
  try {
    await ses.send(new SendEmailCommand({
      Source: FROM,
      Destination: { ToAddresses: recipients },
      Message: { Subject: { Data: subject }, Body },
    }));
    return true;
  } catch (e) {
    console.warn('email_send_failed', e.message);
    return false;
  }
}

export const SUPPORT_INBOX = process.env.SES_SUPPORT || '';
