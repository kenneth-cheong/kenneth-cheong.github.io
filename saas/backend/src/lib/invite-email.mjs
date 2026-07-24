// Branded "your account is ready" email, sent when staff provisions an account
// for someone (Admin → Users, with "send invite"). This is the pre-activation
// notice — the onboarding welcome email (welcome-email.mjs) still fires later
// when they actually sign in. Same look as the other transactional emails;
// email.mjs is imported lazily so the pure renderers stay testable off-Lambda.
// Self-contained shell (a small, deliberate duplication of billing-emails.mjs's
// shell) so this doesn't couple AdminFn to the billing module.

const WEBSITE_URL = 'https://platform.digimetrics.ai';

function appOriginEnv() {
  return (process.env.APP_ORIGIN || '').replace(/\/$/, '');
}
function esc(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function firstName(user = {}) {
  const raw = String(user.name || '').trim() || String(user.email || '').split('@')[0] || '';
  const first = raw.split(/[\s._-]+/).filter(Boolean)[0] || '';
  const clean = first.replace(/\d+/g, '');
  return clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : 'there';
}

function shell({ title, preheader, name, heading, introHtml, noteHtml, ctaLabel, ctaUrl }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
</head>
<body style="margin:0; padding:0; background-color:#F3F4F8; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">

  <div style="display:none; max-height:0; overflow:hidden; opacity:0;">${esc(preheader)}</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F3F4F8; padding:32px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%; background-color:#FFFFFF; border-radius:16px; overflow:hidden; box-shadow:0 1px 3px rgba(16,24,40,0.06);">

          <tr>
            <td style="padding:28px 40px 20px 40px; border-bottom:1px solid #EEF0F5;">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="vertical-align:middle; padding-right:8px;">
                    <span style="display:inline-block; width:10px; height:10px; border-radius:50%; background-color:#22C55E;"></span>
                  </td>
                  <td style="vertical-align:middle;">
                    <span style="font-size:16px; font-weight:700; letter-spacing:0.5px; color:#111827;">DIGIMETRICS</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:36px 40px 8px 40px;">
              <p style="margin:0 0 6px 0; font-size:14px; color:#6B7280;">Hi ${esc(name)},</p>
              <h1 style="margin:0 0 12px 0; font-size:24px; line-height:32px; font-weight:700; color:#111827;">${heading}</h1>
              <p style="margin:0; font-size:15px; line-height:24px; color:#4B5563;">${introHtml}</p>
            </td>
          </tr>

          <tr>
            <td style="padding:32px 40px 8px 40px;" align="center">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="border-radius:10px; background-color:#4F46E5;">
                    <a href="${esc(ctaUrl)}" target="_blank" style="display:inline-block; padding:14px 32px; font-size:15px; font-weight:600; color:#FFFFFF; text-decoration:none; border-radius:10px;">${esc(ctaLabel)} &rarr;</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:20px 40px 36px 40px;">
              <p style="margin:0; font-size:13px; line-height:20px; color:#6B7280; text-align:center;">${noteHtml}</p>
            </td>
          </tr>

          <tr>
            <td style="padding:22px 40px; border-top:1px solid #EEF0F5;" align="center">
              <p style="margin:0; font-size:12px; color:#9CA3AF;">
                Best regards,<br>The Digimetrics Team<br>
                <a href="${esc(WEBSITE_URL)}" style="color:#4F46E5; text-decoration:none;">${esc(WEBSITE_URL.replace(/^https?:\/\//, ''))}</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>

</body>
</html>`;
}

// opts: { role: 'client'|'staff', appOrigin }
export function inviteEmailHtml(user = {}, opts = {}) {
  const url = (opts.appOrigin || appOriginEnv() || WEBSITE_URL).replace(/\/$/, '');
  const staff = opts.role === 'staff';
  return shell({
    title: 'Your Digimetrics account is ready',
    preheader: 'An account has been set up for you at Digimetrics — sign in to get started.',
    name: esc(firstName(user)),
    heading: 'Your Digimetrics account is ready',
    introHtml: `An account has been set up for you at Digimetrics${staff ? ' as a staff member' : ''}. To get started, sign in with Google using your email address <strong>${esc(user.email || '')}</strong> — that's the username for your account.`,
    noteHtml: `Didn't expect this? You can safely ignore this email, or just reply and let us know.`,
    ctaLabel: 'Sign in to Digimetrics',
    ctaUrl: url,
  });
}

export function inviteEmailText(user = {}, opts = {}) {
  const url = (opts.appOrigin || appOriginEnv() || WEBSITE_URL).replace(/\/$/, '');
  const staff = opts.role === 'staff';
  return [
    `Hi ${firstName(user)},`,
    '',
    `An account has been set up for you at Digimetrics${staff ? ' as a staff member' : ''}.`,
    '',
    `To get started, sign in with Google using your email address (${user.email || ''}) — that's the username for your account:`,
    url,
    '',
    "Didn't expect this? You can safely ignore this email, or just reply and let us know.",
    '',
    'Best regards,',
    'The Digimetrics Team',
    WEBSITE_URL,
  ].join('\n');
}

// Best-effort branded send via the authenticated SMTP path (support@digimetrics.ai).
export async function sendInviteEmail(user, opts = {}) {
  if (!user?.email) return false;
  try {
    const { sendNotice, noticeFrom } = await import('./email.mjs');
    return await sendNotice({
      to: user.email,
      subject: 'Your Digimetrics account is ready',
      text: inviteEmailText(user, opts),
      html: inviteEmailHtml(user, opts),
      from: noticeFrom('Digimetrics'),
    });
  } catch (e) {
    console.warn('invite_email_failed', e.message);
    return false;
  }
}
