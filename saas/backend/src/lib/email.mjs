// Best-effort transactional email via SES. No-ops (returns false) when SES isn't
// configured, so a missing email setup never fails a request. @aws-sdk/client-ses
// ships with the nodejs20 Lambda runtime.
import { SESClient, SendEmailCommand, SendRawEmailCommand } from '@aws-sdk/client-ses';

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

// Like sendEmail but with file attachments. Builds a multipart/mixed MIME
// message and sends via SES SendRawEmail. `attachments`: [{ filename,
// contentType, content: Uint8Array|Buffer }]. Optional `replyTo`. Best-effort
// (returns false on misconfig/failure) so it never breaks a request.
export async function sendRawEmail({ to, subject, text, html, attachments = [], replyTo }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!FROM || !recipients.length) return false;

  const boundary = `mix_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const altBoundary = `alt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const CRLF = '\r\n';

  const headers = [
    `From: ${FROM}`,
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
