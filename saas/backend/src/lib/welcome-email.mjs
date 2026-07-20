// Onboarding welcome email, sent once when an account first becomes usable:
// Google first sign-in, or email/password verification (the point where the
// free credits land). Table-based, inline-styled HTML — the only layout that
// survives Outlook/Gmail — with a plain-text fallback for text-only clients.
// Best-effort like every other notice: a mail failure never blocks the login.
// email.mjs is imported lazily inside sendWelcomeEmail: it pulls in
// @aws-sdk/client-ses, which only exists in the Lambda runtime, so a static
// import would make the (pure) template renderers untestable off-Lambda.
import { PLANS } from '../../../shared/catalog.mjs';

// The footer link (and the fallback when APP_ORIGIN is unset) points at the app
// itself, not the marketing domain — every reader of this email already has an
// account, so the useful destination is the platform.
const WEBSITE_URL = 'https://platform.digimetrics.ai';

// Read at call time, not module load: the value is only meaningful once the
// Lambda env is populated, and tests need to vary it.
function appOrigin() {
  return (process.env.APP_ORIGIN || '').replace(/\/$/, '');
}

function esc(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// A friendly first name from the account: prefer the display name, fall back to
// the local part of the email, and drop separators/digits ("jane.doe1" → "Jane").
function firstName(user = {}) {
  const raw = String(user.name || '').trim() || String(user.email || '').split('@')[0] || '';
  const first = raw.split(/[\s._-]+/).filter(Boolean)[0] || '';
  const clean = first.replace(/\d+/g, '');
  return clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : 'there';
}

const STEPS = [
  'Complete your profile <span style="color:#9CA3AF;">(optional)</span>',
  'Add your first website',
  'Run your first website analysis',
  'Follow the recommended improvements',
  'Track your progress as your website improves',
];

const PERKS = [
  `${PLANS.free.monthlyCredits} free credits every month`,
  'No credit card required',
  'Access to powerful SEO and website analysis tools',
  'AI-powered recommendations to help improve your rankings',
];

function stepRow(label, n, last) {
  return `
                <tr>
                  <td style="padding-bottom:${last ? 4 : 14}px;">
                    <table role="presentation" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="width:26px; height:26px; border-radius:50%; background-color:#4F46E5; color:#FFFFFF; font-size:12px; font-weight:700; text-align:center; vertical-align:middle;">${n}</td>
                        <td style="padding-left:12px; font-size:14px; color:#374151; vertical-align:middle;">${label}</td>
                      </tr>
                    </table>
                  </td>
                </tr>`;
}

function perkRow(label, last) {
  return `
                      <tr>
                        <td style="${last ? '' : 'padding-bottom:10px; '}font-size:14px; color:#374151;">
                          <span style="color:#22C55E; font-weight:700;">&#10003;</span>&nbsp; ${esc(label)}
                        </td>
                      </tr>`;
}

export function welcomeEmailHtml(user = {}) {
  const name = esc(firstName(user));
  const dashboardUrl = appOrigin() || WEBSITE_URL;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Welcome to Digimetrics</title>
</head>
<body style="margin:0; padding:0; background-color:#F3F4F8; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">

  <!-- Preheader (hidden preview text) -->
  <div style="display:none; max-height:0; overflow:hidden; opacity:0;">
    Welcome to Digimetrics — let's get your first website analysis running.
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F3F4F8; padding:32px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%; background-color:#FFFFFF; border-radius:16px; overflow:hidden; box-shadow:0 1px 3px rgba(16,24,40,0.06);">

          <!-- Logo header -->
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

          <!-- Hero / greeting -->
          <tr>
            <td style="padding:36px 40px 8px 40px;">
              <p style="margin:0 0 6px 0; font-size:14px; color:#6B7280;">Hi ${name},</p>
              <h1 style="margin:0 0 12px 0; font-size:24px; line-height:32px; font-weight:700; color:#111827;">
                Welcome to Digimetrics! &#127881;
              </h1>
              <p style="margin:0; font-size:15px; line-height:24px; color:#4B5563;">
                We're excited to have you on board. Digimetrics is designed to make SEO and website optimization simple, even if you're just getting started. Instead of overwhelming you with hundreds of reports, we'll help you focus on what matters most and guide you step by step toward improving your website.
              </p>
            </td>
          </tr>

          <!-- Streak-style callout, echoing dashboard card -->
          <tr>
            <td style="padding:20px 40px 0 40px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#EEF1FF; border-radius:12px;">
                <tr>
                  <td style="padding:18px 20px;">
                    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                      <tr>
                        <td width="40" style="vertical-align:middle;">
                          <table role="presentation" cellpadding="0" cellspacing="0">
                            <tr>
                              <td style="width:36px; height:36px; border-radius:10px; background-color:#E0E7FF; text-align:center; vertical-align:middle; font-size:16px;">&#128640;</td>
                            </tr>
                          </table>
                        </td>
                        <td style="vertical-align:middle; padding-left:8px;">
                          <p style="margin:0; font-size:11px; font-weight:700; letter-spacing:0.4px; color:#4F46E5; text-transform:uppercase;">Up next</p>
                          <p style="margin:2px 0 0 0; font-size:15px; font-weight:600; color:#111827;">Add your first website</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Getting started steps -->
          <tr>
            <td style="padding:32px 40px 0 40px;">
              <h2 style="margin:0 0 16px 0; font-size:15px; font-weight:700; color:#111827;">Here's how to get started</h2>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${STEPS.map((s, i) => stepRow(s, i + 1, i === STEPS.length - 1)).join('')}
              </table>
            </td>
          </tr>

          <!-- Free account features card -->
          <tr>
            <td style="padding:28px 40px 0 40px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #EEF0F5; border-radius:12px;">
                <tr>
                  <td style="padding:20px 22px;">
                    <p style="margin:0 0 14px 0; font-size:13px; font-weight:700; letter-spacing:0.3px; color:#111827; text-transform:uppercase;">Your free account includes</p>

                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${PERKS.map((p, i) => perkRow(p, i === PERKS.length - 1)).join('')}
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- CTA button -->
          <tr>
            <td style="padding:32px 40px 8px 40px;" align="center">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="border-radius:10px; background-color:#4F46E5;">
                    <a href="${esc(dashboardUrl)}" target="_blank" style="display:inline-block; padding:14px 32px; font-size:15px; font-weight:600; color:#FFFFFF; text-decoration:none; border-radius:10px;">
                      Log in to your dashboard &rarr;
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Help note -->
          <tr>
            <td style="padding:20px 40px 36px 40px;">
              <p style="margin:0; font-size:13px; line-height:20px; color:#6B7280; text-align:center;">
                Need help? Simply reply to this email — we'd love to hear your feedback and are always looking for ways to improve Digimetrics.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:22px 40px; border-top:1px solid #EEF0F5;" align="center">
              <p style="margin:0 0 4px 0; font-size:13px; color:#374151;">Thank you for choosing Digimetrics.</p>
              <p style="margin:0 0 14px 0; font-size:13px; color:#374151;">We're excited to help you build a better website.</p>
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

export function welcomeEmailText(user = {}) {
  const dashboardUrl = appOrigin() || WEBSITE_URL;
  return [
    `Hi ${firstName(user)},`,
    '',
    'Welcome to Digimetrics!',
    '',
    "We're excited to have you on board. Digimetrics makes SEO and website optimisation simple — instead of overwhelming you with hundreds of reports, we help you focus on what matters most.",
    '',
    "Here's how to get started:",
    ...STEPS.map((s, i) => `  ${i + 1}. ${s.replace(/<[^>]+>/g, '')}`),
    '',
    'Your free account includes:',
    ...PERKS.map((p) => `  - ${p}`),
    '',
    `Log in to your dashboard: ${dashboardUrl}`,
    '',
    "Need help? Simply reply to this email — we'd love to hear your feedback.",
    '',
    'Best regards,',
    'The Digimetrics Team',
    WEBSITE_URL,
  ].join('\n');
}

// Send the welcome email. Best-effort: swallows every failure so onboarding
// never breaks on a mail problem.
export async function sendWelcomeEmail(user) {
  if (!user?.email) return false;
  try {
    const { sendNotice, noticeFrom } = await import('./email.mjs');
    return await sendNotice({
      to: user.email,
      subject: 'Welcome to Digimetrics 🎉',
      text: welcomeEmailText(user),
      html: welcomeEmailHtml(user),
      from: noticeFrom('Digimetrics'),
    });
  } catch (e) {
    console.warn('welcome_email_failed', e.message);
    return false;
  }
}
