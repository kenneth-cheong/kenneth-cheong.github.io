// Branded transactional billing emails: subscription confirmation and
// cancellation confirmation. Table-based, inline-styled HTML (the only layout
// that survives Outlook/Gmail) with a plain-text fallback — mirrors the look of
// welcome-email.mjs. email.mjs is imported lazily inside the send* helpers so
// the pure template renderers stay testable off-Lambda (email.mjs pulls in the
// SES SDK that only exists in the Lambda runtime). Best-effort like every other
// notice: a mail failure never blocks or fails the billing event.

const WEBSITE_URL = 'https://platform.digimetrics.ai';

function appOrigin() {
  return (process.env.APP_ORIGIN || '').replace(/\/$/, '');
}
function dashUrl() {
  return appOrigin() || WEBSITE_URL;
}

function esc(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Friendly first name: prefer display name, fall back to the email local part,
// drop separators/digits ("jane.doe1" → "Jane").
function firstName(user = {}) {
  const raw = String(user.name || '').trim() || String(user.email || '').split('@')[0] || '';
  const first = raw.split(/[\s._-]+/).filter(Boolean)[0] || '';
  const clean = first.replace(/\d+/g, '');
  return clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : 'there';
}

// Stripe amounts are minor units (cents). Catalog prices are all USD, but guard
// the symbol so a non-USD currency isn't mislabelled with a "$".
export function formatMoney(minorUnits, currency = 'usd') {
  if (minorUnits == null || Number.isNaN(Number(minorUnits))) return '';
  const major = (Number(minorUnits) / 100).toFixed(2);
  const cur = String(currency || 'usd').toUpperCase();
  return cur === 'USD' ? `$${major} USD` : `${major} ${cur}`;
}

// "August 24, 2026" from an ISO string (or epoch-seconds number). Empty on junk.
export function formatDate(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(typeof value === 'number' ? value * 1000 : value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function detailRow(label, value, last) {
  return `
                      <tr>
                        <td style="${last ? '' : 'padding-bottom:10px; '}font-size:14px; color:#6B7280;">${esc(label)}</td>
                        <td style="${last ? '' : 'padding-bottom:10px; '}font-size:14px; font-weight:600; color:#111827; text-align:right;">${esc(value)}</td>
                      </tr>`;
}

// Shared branded shell: logo header, hero greeting, an optional details/info
// card, a CTA button and the standard footer. `rows` are the detail card rows
// ([label, value] pairs); pass [] to omit the card.
function shell({ title, preheader, name, heading, introHtml, cardTitle, rows = [], noteHtml, ctaLabel, ctaUrl }) {
  const cardHtml = rows.length
    ? `
          <tr>
            <td style="padding:24px 40px 0 40px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #EEF0F5; border-radius:12px;">
                <tr>
                  <td style="padding:20px 22px;">
                    ${cardTitle ? `<p style="margin:0 0 14px 0; font-size:13px; font-weight:700; letter-spacing:0.3px; color:#111827; text-transform:uppercase;">${esc(cardTitle)}</p>` : ''}
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows.map(([l, v], i) => detailRow(l, v, i === rows.length - 1)).join('')}
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>`
    : '';
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
              <p style="margin:0 0 6px 0; font-size:14px; color:#6B7280;">Hi ${esc(name)},</p>
              <h1 style="margin:0 0 12px 0; font-size:24px; line-height:32px; font-weight:700; color:#111827;">${heading}</h1>
              <p style="margin:0; font-size:15px; line-height:24px; color:#4B5563;">${introHtml}</p>
            </td>
          </tr>
${cardHtml}
          <!-- CTA button -->
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

          <!-- Help note -->
          <tr>
            <td style="padding:20px 40px 36px 40px;">
              <p style="margin:0; font-size:13px; line-height:20px; color:#6B7280; text-align:center;">${noteHtml}</p>
            </td>
          </tr>

          <!-- Footer -->
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

// ── Subscription confirmation ────────────────────────────────────────────────
// opts: { planName, monthlyCredits, amountText, nextBillingText }
export function subscribeEmailHtml(user = {}, opts = {}) {
  const rows = [
    ['Plan', `Digimetrics ${opts.planName}`],
    ['Monthly credits', Number(opts.monthlyCredits || 0).toLocaleString('en-US')],
  ];
  if (opts.amountText) rows.push(['Amount paid', opts.amountText]);
  if (opts.nextBillingText) rows.push(['Next billing date', opts.nextBillingText]);
  return shell({
    title: `Your Digimetrics ${opts.planName} subscription is active`,
    preheader: `Your Digimetrics ${opts.planName} plan is now active — here's your summary.`,
    name: esc(firstName(user)),
    heading: `You're all set — welcome to ${esc('Digimetrics ' + (opts.planName || ''))}! &#127881;`,
    introHtml: `Thank you for subscribing. Your plan is now active and your monthly credits are ready to use. Here's a summary of your subscription:`,
    cardTitle: 'Subscription summary',
    rows,
    noteHtml: `Questions about your subscription or billing? Just reply to this email — we're happy to help.`,
    ctaLabel: 'Go to your dashboard',
    ctaUrl: dashUrl(),
  });
}

export function subscribeEmailText(user = {}, opts = {}) {
  const lines = [
    `Hi ${firstName(user)},`,
    '',
    `Thank you for subscribing to Digimetrics ${opts.planName}! Your plan is now active and your monthly credits are ready to use.`,
    '',
    'Subscription summary:',
    `  Plan: Digimetrics ${opts.planName}`,
    `  Monthly credits: ${Number(opts.monthlyCredits || 0).toLocaleString('en-US')}`,
  ];
  if (opts.amountText) lines.push(`  Amount paid: ${opts.amountText}`);
  if (opts.nextBillingText) lines.push(`  Next billing date: ${opts.nextBillingText}`);
  lines.push('', `Go to your dashboard: ${dashUrl()}`, '',
    "Questions about your subscription or billing? Just reply to this email.", '',
    'Best regards,', 'The Digimetrics Team', WEBSITE_URL);
  return lines.join('\n');
}

// ── Cancellation confirmation ────────────────────────────────────────────────
// opts: { planName, endsAtText }  (endsAtText empty ⇒ effective immediately)
export function cancelEmailHtml(user = {}, opts = {}) {
  const intro = opts.endsAtText
    ? `We've cancelled your Digimetrics ${esc(opts.planName)} subscription. You'll keep full ${esc(opts.planName)} access until <strong>${esc(opts.endsAtText)}</strong>, after which your account moves to the Free plan. Your projects, run history and data stay safe — nothing is deleted, and you can resubscribe anytime to pick up right where you left off.`
    : `We've cancelled your Digimetrics ${esc(opts.planName)} subscription and your account has moved to the Free plan. Your projects, run history and data stay safe — nothing is deleted, and you can resubscribe anytime to pick up right where you left off.`;
  return shell({
    title: 'Your Digimetrics subscription has been cancelled',
    preheader: opts.endsAtText
      ? `Cancelled — you keep access until ${opts.endsAtText}.`
      : `Your subscription has been cancelled.`,
    name: esc(firstName(user)),
    heading: 'Your subscription has been cancelled',
    introHtml: intro,
    rows: [],
    noteHtml: `Changed your mind, or cancelled by mistake? Just reply to this email and we'll help you sort it out.`,
    ctaLabel: 'Reactivate your plan',
    ctaUrl: `${dashUrl()}/pricing`,
  });
}

export function cancelEmailText(user = {}, opts = {}) {
  const intro = opts.endsAtText
    ? `We've cancelled your Digimetrics ${opts.planName} subscription. You'll keep full ${opts.planName} access until ${opts.endsAtText}, after which your account moves to the Free plan.`
    : `We've cancelled your Digimetrics ${opts.planName} subscription and your account has moved to the Free plan.`;
  return [
    `Hi ${firstName(user)},`,
    '',
    intro,
    '',
    'Your projects, run history and data stay safe — nothing is deleted, and you can resubscribe anytime to pick up right where you left off.',
    '',
    `Reactivate your plan: ${dashUrl()}/pricing`,
    '',
    "Changed your mind, or cancelled by mistake? Just reply to this email and we'll help.",
    '',
    'Best regards,',
    'The Digimetrics Team',
    WEBSITE_URL,
  ].join('\n');
}

// ── Upcoming renewal / cancellation reminder ─────────────────────────────────
// One email sent a set number of days before a paid subscription's period end.
// Two shapes off the same template:
//   • renewing (default) — "renews on X, card will be charged" → manage/update card
//   • ending (opts.ending, i.e. cancel-at-period-end) — "access ends on X" → resubscribe
// opts: { planName, renewalDateText, amountText, monthlyCredits, daysLeft, ending }
function renewalCopy(opts = {}) {
  const days = Number(opts.daysLeft) || 0;
  const plural = days === 1 ? 'day' : 'days';
  const when = days <= 0 ? 'today' : `in ${days} ${plural}`;
  if (opts.ending) {
    return {
      subject: `Your Digimetrics ${opts.planName} plan ends ${when}`,
      heading: `Your ${esc(opts.planName)} plan ends ${when}`,
      introHtml: `Your subscription is set to cancel on <strong>${esc(opts.renewalDateText)}</strong>, after which your account moves to the Free plan. Nothing is deleted — your projects, run history and data stay safe, and resubscribing picks up right where you left off.`,
      cardTitle: 'Subscription',
      rows: [['Plan', `Digimetrics ${opts.planName}`], ['Access ends', opts.renewalDateText]],
      noteHtml: `Meant to keep it? Reactivate any time before it ends and nothing changes.`,
      ctaLabel: 'Keep my plan',
      ctaUrl: `${dashUrl()}/account`,
    };
  }
  const rows = [['Plan', `Digimetrics ${opts.planName}`], ['Renews on', opts.renewalDateText]];
  if (opts.amountText) rows.push(['Amount', opts.amountText]);
  return {
    subject: `Your Digimetrics ${opts.planName} plan renews ${when}`,
    heading: `Your ${esc(opts.planName)} plan renews ${when}`,
    introHtml: `Just a heads-up that your subscription renews on <strong>${esc(opts.renewalDateText)}</strong>${opts.amountText ? ` and your card will be charged <strong>${esc(opts.amountText)}</strong>` : ''}. No action is needed to continue — you can update your card or change your plan any time before then.`,
    cardTitle: 'Subscription',
    rows,
    noteHtml: `Need to update your card or change plans? Manage everything from your account, or just reply to this email.`,
    ctaLabel: 'Manage subscription',
    ctaUrl: `${dashUrl()}/account`,
  };
}

export function renewalEmailHtml(user = {}, opts = {}) {
  const c = renewalCopy(opts);
  return shell({
    title: c.subject,
    preheader: c.subject,
    name: esc(firstName(user)),
    heading: c.heading,
    introHtml: c.introHtml,
    cardTitle: c.cardTitle,
    rows: c.rows,
    noteHtml: c.noteHtml,
    ctaLabel: c.ctaLabel,
    ctaUrl: c.ctaUrl,
  });
}

export function renewalEmailText(user = {}, opts = {}) {
  const c = renewalCopy(opts);
  const lines = [`Hi ${firstName(user)},`, ''];
  if (opts.ending) {
    lines.push(`Your Digimetrics ${opts.planName} subscription is set to cancel on ${opts.renewalDateText}, after which your account moves to the Free plan. Nothing is deleted — resubscribe any time to pick up where you left off.`);
  } else {
    lines.push(`Your Digimetrics ${opts.planName} subscription renews on ${opts.renewalDateText}${opts.amountText ? ` and your card will be charged ${opts.amountText}` : ''}. No action is needed to continue — you can update your card or change your plan any time before then.`);
  }
  lines.push('', `${c.ctaLabel}: ${c.ctaUrl}`, '', 'Best regards,', 'The Digimetrics Team', WEBSITE_URL);
  return lines.join('\n');
}

// ── One-time credit top-up confirmation ──────────────────────────────────────
// opts: { packName, credits, amountText, balanceText }
// amountText is already display-ready ("$45.00 USD", or "Free (promo code)" when
// a code zeroed the charge — the case where Stripe issues no receipt, making
// this email the only proof of purchase the customer gets).
export function topupEmailHtml(user = {}, opts = {}) {
  const rows = [
    ['Pack', opts.packName || 'Credit top-up'],
    ['Credits added', Number(opts.credits || 0).toLocaleString('en-US')],
  ];
  if (opts.amountText) rows.push(['Amount', opts.amountText]);
  if (opts.balanceText) rows.push(['Top-up balance', opts.balanceText]);
  return shell({
    title: 'Your Digimetrics credits are ready',
    preheader: `${Number(opts.credits || 0).toLocaleString('en-US')} credits have been added to your account.`,
    name: esc(firstName(user)),
    heading: 'Your credits are ready &#127881;',
    introHtml: `Thanks for your top-up. We've added <strong>${esc(Number(opts.credits || 0).toLocaleString('en-US'))} credits</strong> to your account — they never expire and are used only after your monthly allowance runs out. Here's a summary:`,
    cardTitle: 'Top-up summary',
    rows,
    noteHtml: `Questions about your purchase or billing? Just reply to this email — we're happy to help.`,
    ctaLabel: 'Go to your dashboard',
    ctaUrl: dashUrl(),
  });
}

export function topupEmailText(user = {}, opts = {}) {
  const lines = [
    `Hi ${firstName(user)},`,
    '',
    `Thanks for your top-up. We've added ${Number(opts.credits || 0).toLocaleString('en-US')} credits to your account — they never expire and are used only after your monthly allowance runs out.`,
    '',
    'Top-up summary:',
    `  Pack: ${opts.packName || 'Credit top-up'}`,
    `  Credits added: ${Number(opts.credits || 0).toLocaleString('en-US')}`,
  ];
  if (opts.amountText) lines.push(`  Amount: ${opts.amountText}`);
  if (opts.balanceText) lines.push(`  Top-up balance: ${opts.balanceText}`);
  lines.push('', `Go to your dashboard: ${dashUrl()}`, '',
    'Questions about your purchase or billing? Just reply to this email.', '',
    'Best regards,', 'The Digimetrics Team', WEBSITE_URL);
  return lines.join('\n');
}

// ── Senders (best-effort; never throw) ───────────────────────────────────────
export async function sendSubscribeEmail(user, opts = {}) {
  if (!user?.email) return false;
  try {
    const { sendNotice, noticeFrom } = await import('./email.mjs');
    return await sendNotice({
      to: user.email,
      subject: `Your Digimetrics ${opts.planName} subscription is active 🎉`,
      text: subscribeEmailText(user, opts),
      html: subscribeEmailHtml(user, opts),
      from: noticeFrom('Digimetrics'),
    });
  } catch (e) {
    console.warn('subscribe_email_failed', e.message);
    return false;
  }
}

export async function sendCancelEmail(user, opts = {}) {
  if (!user?.email) return false;
  try {
    const { sendNotice, noticeFrom } = await import('./email.mjs');
    return await sendNotice({
      to: user.email,
      subject: 'Your Digimetrics subscription has been cancelled',
      text: cancelEmailText(user, opts),
      html: cancelEmailHtml(user, opts),
      from: noticeFrom('Digimetrics'),
    });
  } catch (e) {
    console.warn('cancel_email_failed', e.message);
    return false;
  }
}

export async function sendTopupEmail(user, opts = {}) {
  if (!user?.email) return false;
  try {
    const { sendNotice, noticeFrom } = await import('./email.mjs');
    return await sendNotice({
      to: user.email,
      subject: `Your Digimetrics credits are ready — ${Number(opts.credits || 0).toLocaleString('en-US')} added 🎉`,
      text: topupEmailText(user, opts),
      html: topupEmailHtml(user, opts),
      from: noticeFrom('Digimetrics'),
    });
  } catch (e) {
    console.warn('topup_email_failed', e.message);
    return false;
  }
}

export async function sendRenewalEmail(user, opts = {}) {
  if (!user?.email) return false;
  try {
    const { sendNotice, noticeFrom } = await import('./email.mjs');
    return await sendNotice({
      to: user.email,
      subject: renewalCopy(opts).subject,
      text: renewalEmailText(user, opts),
      html: renewalEmailHtml(user, opts),
      from: noticeFrom('Digimetrics'),
    });
  } catch (e) {
    console.warn('renewal_email_failed', e.message);
    return false;
  }
}
