// Generates the "Acceptance Record" PDF attached to the Free Trial + NDA
// notification email — a one-page proof-of-consent document with the trial
// user's submitted details, the account, and the electronic-acceptance metadata
// (timestamp, IP, device, NDA version). Pure JS (pdf-lib), bundles with esbuild.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { AGREEMENT_TITLE, AGREEMENT_INTRO, AGREEMENT_SECTIONS } from '../../../shared/agreement.mjs';

const BRAND = rgb(0.114, 0.306, 0.847); // #1d4ed8
const INK = rgb(0.06, 0.09, 0.16);
const MUTED = rgb(0.39, 0.45, 0.55);
const LINE = rgb(0.89, 0.91, 0.94);

const A4 = [595.28, 841.89]; // portrait (pt)
const M = 56; // page margin

/**
 * @param {object} r record: { formName, organisation, uen, telephone, formEmail,
 *   accountEmail, acceptedAt, ip, userAgent, version }
 * @returns {Promise<Uint8Array>} the PDF bytes
 */
// How the operating entity is described on the record. Apsolute.ai Pte Ltd owns
// AND operates Digimetrics — the MediaOne authorised-licensee layer was removed.
// Changing this only affects acceptances signed from now on; older records keep
// their own stored attribution (see LEGACY_ENTITY_ATTRIBUTION below).
export const ENTITY_ATTRIBUTION =
  'Apsolute.ai Pte Ltd — owner and operator of Digimetrics';
// Wording used before that correction. Acceptances signed under it are RE-RENDERED
// on demand by Admin -> Agreements, so they must keep the text that was live when
// the user actually accepted — a proof-of-consent record that silently rewrites
// itself is not proof of anything.
export const LEGACY_ENTITY_ATTRIBUTION =
  'MediaOne Business Group Pte Ltd — owner/operator of Digimetrics';

export async function buildAcceptancePdf(r) {
  const attribution = r.attribution || LEGACY_ENTITY_ATTRIBUTION;
  const doc = await PDFDocument.create();
  doc.setTitle('Digimetrics Free Trial + NDA — Acceptance Record');
  doc.setAuthor('Digimetrics (Apsolute.ai Pte Ltd)');
  doc.setSubject('Electronic acceptance record / proof of consent');

  const page = doc.addPage(A4);
  const { width, height } = page.getSize();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

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

  // Documents accepted. A new user accepts the base Terms and Conditions of Use
  // and the Privacy Notice in the SAME submit as the NDA, so a record naming
  // only the NDA understates what was agreed. `termsVersion` is absent for
  // acceptances taken before the two were combined — those list the NDA alone,
  // which is what actually happened.
  if (r.termsVersion) {
    page.drawText('Documents accepted', { x: M, y, size: 11, font: bold, color: INK });
    y -= 16;
    const docs = [
      `1.  Digimetrics Free Trial and Non-Disclosure Agreement (version ${r.version})`,
      `2.  Terms and Conditions of Use (version ${r.termsVersion})`,
      `3.  Privacy Notice (version ${r.termsVersion})`,
    ];
    for (const d of docs) {
      page.drawText(d, { x: M + 6, y, size: 9.5, font, color: INK });
      y -= 14;
    }
    y -= 4;
    for (const ln of wrap(
      'Items 2 and 3 form one instrument, published at platform.digimetrics.ai/legal/terms '
      + 'and /legal/privacy. Its full text is not reproduced here; the version above identifies '
      + 'the exact wording in force when this acceptance was recorded. Item 1 is reproduced in '
      + 'full from the next page.', font, 8.5, width - 2 * M - 6)) {
      page.drawText(ln, { x: M + 6, y, size: 8.5, font, color: MUTED });
      y -= 11;
    }
    y -= 16;
  }

  const rows = [
    ['Name', r.formName],
    ['Organisation', r.organisation],
    ['UEN', r.uen],
    ['Telephone', r.telephone],
    ['Email', r.formEmail],
    ['Account', r.accountEmail || '—'],
    ['Accepted at (UTC)', r.acceptedAt],
    ['NDA version', r.version],
    ...(r.termsVersion ? [['Terms / Privacy version', r.termsVersion]] : []),
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
    // Centre the divider in the gap: the previous row's descenders sit ~20pt
    // above the next baseline and the next row's cap-tops ~7pt above it, so y+13
    // clears both. (y+6 sliced through the following row's text.)
    page.drawLine({ start: { x: M, y: y + 13 }, end: { x: width - M, y: y + 13 }, thickness: 0.5, color: LINE });
  }

  y -= 14;
  const note =
    'No physical or handwritten signature is required for this Agreement to take effect.';
  const note2 =
    'This record may be relied upon by the Company as proof of consent.';
  page.drawText(note, { x: M, y, size: 8.5, font, color: MUTED }); y -= 12;
  page.drawText(note2, { x: M, y, size: 8.5, font, color: MUTED });

  // Footer
  page.drawText(attribution, {
    x: M, y: M - 8, size: 8, font, color: MUTED,
  });

  // Append a verbatim copy of the terms the Trial User accepted (the exact text
  // shown on screen), so the record is self-contained proof — see Agreement §15.
  drawAgreement(doc, font, bold, r.version);

  return doc.save();
}

// Renders the full Free Trial + NDA terms across as many pages as needed,
// flowing paragraphs and lettered lists with automatic page breaks.
function drawAgreement(doc, font, bold, version) {
  const width = A4[0];
  const bottom = M + 18; // leave room for the page footer
  const contentW = width - 2 * M;

  let page = doc.addPage(A4);
  let y = A4[1] - M;
  let pageNo = 0;

  const footer = () => {
    pageNo += 1;
    page.drawText(`Free Trial + NDA — Acceptance Record · terms accepted`, {
      x: M, y: M - 8, size: 7.5, font, color: MUTED,
    });
  };
  const newPage = () => { footer(); page = doc.addPage(A4); y = A4[1] - M; };
  // Ensure `need` pts of vertical space remain; otherwise break to a new page.
  const ensure = (need) => { if (y - need < bottom) newPage(); };

  // Draw wrapped text, breaking across pages line-by-line. Returns nothing.
  const flow = (text, { size = 9.5, lh, fnt = font, color = INK, x = M, maxW = contentW } = {}) => {
    const lineH = lh || size + 3.5;
    for (const ln of wrap(sanitize(text), fnt, size, maxW)) {
      ensure(lineH);
      page.drawText(ln, { x, y, size, font: fnt, color });
      y -= lineH;
    }
  };

  // Heading
  page.drawText('DIGIMETRICS', { x: M, y, size: 16, font: bold, color: BRAND });
  y -= 22;
  flow(AGREEMENT_TITLE, { size: 12, fnt: bold, color: INK });
  y -= 4;
  flow(`Acceptance version ${sanitize(String(version || ''))} — the terms below are the exact terms accepted.`, { size: 8.5, color: MUTED });
  y -= 8;
  page.drawLine({ start: { x: M, y }, end: { x: width - M, y }, thickness: 1, color: LINE });
  y -= 18;

  // Intro paragraphs
  for (const intro of AGREEMENT_INTRO) {
    flow(intro.text, { size: 9.5, color: INK });
    y -= 8;
  }
  y -= 2;

  // Numbered sections
  for (const sec of AGREEMENT_SECTIONS) {
    ensure(28); // keep the heading with at least its first line
    page.drawText(`${sec.n}. ${sanitize(sec.title)}`, { x: M, y, size: 10.5, font: bold, color: BRAND });
    y -= 16;
    for (const block of sec.blocks) {
      if (block.p) {
        flow(block.p, { size: 9.5, color: INK });
        y -= 6;
      } else if (block.list) {
        block.list.forEach((item, i) => {
          const marker = `(${String.fromCharCode(97 + i)})`;
          ensure(13);
          page.drawText(marker, { x: M + 8, y, size: 9.5, font, color: MUTED });
          flow(item, { size: 9.5, color: INK, x: M + 30, maxW: contentW - 30 });
          y -= 3;
        });
        y -= 5;
      }
    }
    y -= 6;
  }
  footer(); // footer for the final terms page
}

// pdf-lib's standard Helvetica encodes WinAnsi (CP1252). Curly quotes and en/em
// dashes are in that set, but any stray character outside it throws at draw
// time — map the few we might see to safe equivalents and drop the rest.
function sanitize(text) {
  return String(text == null ? '' : text)
    .replace(/[‘’‚′]/g, "'")   // single quotes / prime → '
    .replace(/[“”„″]/g, '"')   // double quotes / double-prime → "
    .replace(/[–—]/g, '-')               // en/em dash → hyphen
    .replace(/…/g, '...')                      // ellipsis
    .replace(/[   ]/g, ' ')          // non-breaking spaces
    .replace(/[•·]/g, '-')               // bullets → hyphen
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x09\x0A\x0D\x20-\xFF]/g, '');      // anything else outside Latin-1
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
