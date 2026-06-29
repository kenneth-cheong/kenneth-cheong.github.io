// Generates the "Acceptance Record" PDF attached to the Free Trial + NDA
// notification email — a one-page proof-of-consent document with the trial
// user's submitted details, the account, and the electronic-acceptance metadata
// (timestamp, IP, device, NDA version). Pure JS (pdf-lib), bundles with esbuild.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const BRAND = rgb(0.114, 0.306, 0.847); // #1d4ed8
const INK = rgb(0.06, 0.09, 0.16);
const MUTED = rgb(0.39, 0.45, 0.55);
const LINE = rgb(0.89, 0.91, 0.94);

/**
 * @param {object} r record: { formName, organisation, uen, telephone, formEmail,
 *   accountEmail, acceptedAt, ip, userAgent, version }
 * @returns {Promise<Uint8Array>} the PDF bytes
 */
export async function buildAcceptancePdf(r) {
  const doc = await PDFDocument.create();
  doc.setTitle('Digimetrics Free Trial + NDA — Acceptance Record');
  doc.setAuthor('Digimetrics (MediaOne Business Group Pte Ltd)');
  doc.setSubject('Electronic acceptance record / proof of consent');

  const page = doc.addPage([595.28, 841.89]); // A4 portrait (pt)
  const { width, height } = page.getSize();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const M = 56; // margin
  let y = height - M;

  // Header
  page.drawText('DIGIMETRICS', { x: M, y, size: 20, font: bold, color: BRAND });
  page.drawText('Free Trial + NDA — Acceptance Record', { x: M, y: y - 20, size: 11, font, color: MUTED });
  y -= 46;
  page.drawLine({ start: { x: M, y }, end: { x: width - M, y }, thickness: 1, color: LINE });
  y -= 30;

  page.drawText('Electronic acceptance / proof of consent', { x: M, y, size: 13, font: bold, color: INK });
  y -= 18;
  const intro =
    'The Trial User confirmed they are authorised to accept the Digimetrics Free Trial';
  const intro2 =
    'and Non-Disclosure Agreement on behalf of themselves and/or their organisation.';
  page.drawText(intro, { x: M, y, size: 9.5, font, color: MUTED }); y -= 13;
  page.drawText(intro2, { x: M, y, size: 9.5, font, color: MUTED });
  y -= 30;

  const rows = [
    ['Name', r.formName],
    ['Organisation', r.organisation],
    ['UEN', r.uen],
    ['Telephone', r.telephone],
    ['Email', r.formEmail],
    ['Account', r.accountEmail || '—'],
    ['Accepted at (UTC)', r.acceptedAt],
    ['NDA version', r.version],
    ['IP address', r.ip || '—'],
    ['Device / browser', r.userAgent || '—'],
  ];

  const labelX = M;
  const valueX = M + 150;
  const valueWidth = width - valueX - M;
  for (const [label, valueRaw] of rows) {
    const value = String(valueRaw == null ? '' : valueRaw);
    page.drawText(label, { x: labelX, y, size: 10, font: bold, color: INK });
    const lines = wrap(value, font, 10, valueWidth);
    for (let i = 0; i < lines.length; i++) {
      page.drawText(lines[i], { x: valueX, y: y - i * 13, size: 10, font, color: INK });
    }
    y -= Math.max(13, lines.length * 13) + 9;
    page.drawLine({ start: { x: M, y: y + 6 }, end: { x: width - M, y: y + 6 }, thickness: 0.5, color: LINE });
  }

  y -= 14;
  const note =
    'No physical or handwritten signature is required for this Agreement to take effect.';
  const note2 =
    'This record may be relied upon by the Company as proof of consent.';
  page.drawText(note, { x: M, y, size: 8.5, font, color: MUTED }); y -= 12;
  page.drawText(note2, { x: M, y, size: 8.5, font, color: MUTED });

  // Footer
  page.drawText('MediaOne Business Group Pte Ltd — owner/operator of Digimetrics', {
    x: M, y: M - 8, size: 8, font, color: MUTED,
  });

  return doc.save();
}

// Greedy word-wrap to a pixel width for the given font/size.
function wrap(text, font, size, maxWidth) {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let line = words[0];
  for (let i = 1; i < words.length; i++) {
    const trial = `${line} ${words[i]}`;
    if (font.widthOfTextAtSize(trial, size) <= maxWidth) line = trial;
    else { lines.push(line); line = words[i]; }
  }
  lines.push(line);
  // Hard-break any single token still too wide (e.g. a long user-agent string).
  const out = [];
  for (const l of lines) {
    if (font.widthOfTextAtSize(l, size) <= maxWidth) { out.push(l); continue; }
    let chunk = '';
    for (const ch of l) {
      if (font.widthOfTextAtSize(chunk + ch, size) <= maxWidth) chunk += ch;
      else { out.push(chunk); chunk = ch; }
    }
    if (chunk) out.push(chunk);
  }
  return out;
}
