// Best-effort transactional email via SES. No-ops (returns false) when SES isn't
// configured, so a missing email setup never fails a request. @aws-sdk/client-ses
// ships with the nodejs20 Lambda runtime.
import { SESClient, SendEmailCommand, SendRawEmailCommand } from '@aws-sdk/client-ses';
import nodemailer from 'nodemailer';

const ses = new SESClient({});
const FROM = process.env.SES_FROM;

// Authenticated SMTP (e.g. Gmail / Google Workspace). Configured via env:
//   SMTP_HOST (default smtp.gmail.com), SMTP_PORT (default 587),
//   SMTP_USER, SMTP_PASS (a Google App Password), SMTP_FROM (header From).
// Gmail forces the From header to match the authenticated mailbox, so to send
// as an @mediaone.co address (and pass DMARC) SMTP_USER must BE that Workspace
// mailbox. Lazily built + reused across warm invocations.
const SMTP_FROM = process.env.SMTP_FROM;
let _smtp = null;
export function smtpConfigured() {
  return Boolean(process.env.SMTP_USER && process.env.SMTP_PASS);
}
function smtpTransport() {
  if (_smtp) return _smtp;
  const port = Number(process.env.SMTP_PORT) || 587;
  _smtp = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port,
    secure: port === 465, // implicit TLS on 465; STARTTLS on 587
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return _smtp;
}

// Send via authenticated SMTP. Same shape as sendRawEmail (supports attachments,
// replyTo). Best-effort: returns false when SMTP isn't configured or on error,
// so a mail failure never breaks the request. `attachments`: [{ filename,
// contentType, content: Uint8Array|Buffer }].
export async function sendSmtpEmail({ to, subject, text, html, attachments = [], replyTo, from }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  const source = from || SMTP_FROM || process.env.SMTP_USER;
  if (!smtpConfigured() || !source || !recipients.length) return false;
  try {
    await smtpTransport().sendMail({
      from: source,
      to: recipients.join(', '),
      replyTo: replyTo || undefined,
      subject,
      text: text || undefined,
      html: html || undefined,
      attachments: attachments.map((a) => ({
        filename: a.filename,
        content: Buffer.from(a.content),
        contentType: a.contentType || 'application/octet-stream',
      })),
    });
    return true;
  } catch (e) {
    console.warn('email_smtp_send_failed', e.message);
    return false;
  }
}

// Best-effort transactional notice that PREFERS authenticated SMTP. SMTP sends
// from a real @mediaone.co mailbox (SMTP_FROM, e.g. no-reply@mediaone.co), so it
// isn't subject to the SES sandbox and passes DMARC — the same path the Free
// Trial + NDA notifications use. Falls back to SES only when SMTP isn't
// configured (or the SMTP send fails). Same shape as sendEmail plus optional
// attachments/replyTo. Returns true if any transport accepted the message.
export async function sendNotice({ to, subject, text, html, attachments = [], replyTo, from }) {
  if (smtpConfigured()) {
    const sent = await sendSmtpEmail({ to, subject, text, html, attachments, replyTo, from });
    if (sent) return true;
  }
  if (attachments.length) return sendRawEmail({ to, subject, text, html, attachments, replyTo, from });
  return sendEmail({ to, subject, text, html, from });
}

export async function sendEmail({ to, subject, text, html, from }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  const source = from || FROM;
  if (!source || !recipients.length) return false;
  // SES requires at least one body part. Most callers send plain text; broadcast
  // emails pass `html` (with `text` as the multipart fallback for plain readers).
  const Body = {};
  if (text) Body.Text = { Data: text };
  if (html) Body.Html = { Data: html };
  if (!Body.Text && !Body.Html) return false;
  try {
    await ses.send(new SendEmailCommand({
      Source: source,
      Destination: { ToAddresses: recipients },
      Message: { Subject: { Data: subject }, Body },
    }));
    return true;
  } catch (e) {
    console.warn('email_send_failed', e.message);
    return false;
  }
}

// Like sendEmail but with file attachments. Builds a multipart/mixed MIME
// message and sends via SES SendRawEmail. `attachments`: [{ filename,
// contentType, content: Uint8Array|Buffer }]. Optional `replyTo`. Best-effort
// (returns false on misconfig/failure) so it never breaks a request.
export async function sendRawEmail({ to, subject, text, html, attachments = [], replyTo, from }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  const source = from || FROM;
  if (!source || !recipients.length) return false;

  const boundary = `mix_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const altBoundary = `alt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const CRLF = '\r\n';

  const headers = [
    `From: ${source}`,
    `To: ${recipients.join(', ')}`,
    replyTo ? `Reply-To: ${replyTo}` : null,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ].filter(Boolean).join(CRLF);

  // Body part: a nested multipart/alternative (plain + optional html).
  let body = `--${boundary}${CRLF}`;
  body += `Content-Type: multipart/alternative; boundary="${altBoundary}"${CRLF}${CRLF}`;
  body += `--${altBoundary}${CRLF}`;
  body += `Content-Type: text/plain; charset=UTF-8${CRLF}Content-Transfer-Encoding: 7bit${CRLF}${CRLF}${text || ''}${CRLF}`;
  if (html) {
    body += `--${altBoundary}${CRLF}`;
    body += `Content-Type: text/html; charset=UTF-8${CRLF}Content-Transfer-Encoding: 7bit${CRLF}${CRLF}${html}${CRLF}`;
  }
  body += `--${altBoundary}--${CRLF}`;

  for (const a of attachments) {
    const b64 = Buffer.from(a.content).toString('base64').replace(/(.{76})/g, `$1${CRLF}`);
    body += `--${boundary}${CRLF}`;
    body += `Content-Type: ${a.contentType || 'application/octet-stream'}; name="${a.filename}"${CRLF}`;
    body += `Content-Transfer-Encoding: base64${CRLF}`;
    body += `Content-Disposition: attachment; filename="${a.filename}"${CRLF}${CRLF}`;
    body += `${b64}${CRLF}`;
  }
  body += `--${boundary}--${CRLF}`;

  const raw = `${headers}${CRLF}${CRLF}${body}`;
  try {
    await ses.send(new SendRawEmailCommand({ RawMessage: { Data: Buffer.from(raw) } }));
    return true;
  } catch (e) {
    console.warn('email_raw_send_failed', e.message);
    return false;
  }
}

// RFC 2047 encode a header value only if it contains non-ASCII (keeps simple
// subjects readable; safely encodes anything else).
function encodeHeader(s = '') {
  return /[^\x20-\x7E]/.test(s)
    ? `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`
    : s;
}

export const SUPPORT_INBOX = process.env.SES_SUPPORT || '';
