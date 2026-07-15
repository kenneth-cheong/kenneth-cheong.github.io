// Browser-side text extraction for user-attached files.
//
// pdf.js + mammoth are bundled (npm) and dynamically imported on first use, so
// they stay out of the initial chunk and only download when a user actually
// attaches a PDF/DOCX. The pdf.js worker is a same-origin hashed asset
// (CSP-safe) via Vite's `?url` import.
let _pdfjs = null, _mammoth = null;

export async function getPdfjs() {
  if (_pdfjs) return _pdfjs;
  const pdfjsLib = await import('pdfjs-dist');
  pdfjsLib.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  _pdfjs = pdfjsLib;
  return pdfjsLib;
}

export async function getMammoth() {
  if (_mammoth) return _mammoth;
  const m = await import('mammoth/mammoth.browser');
  _mammoth = m.default || m;
  return _mammoth;
}

// Raw text out of one file. Throws so callers can decide how loud to be —
// extractFiles() swallows per-file errors, extractFileText() surfaces them.
// `cap` stops PDF paging once we already have more text than the caller will keep.
async function readOne(file, cap = Infinity) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf') {
    const pdfjsLib = await getPdfjs();
    const ab = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(ab) }).promise;
    const lines = [];
    let len = 0;
    for (let n = 1; n <= pdf.numPages; n++) {
      const c = await (await pdf.getPage(n)).getTextContent();
      const line = c.items.map((it) => it.str).join(' ');
      lines.push(line);
      len += line.length + 1;
      if (len > cap) break;
    }
    return lines.join('\n');
  }
  if (ext === 'docx') {
    const mammoth = await getMammoth();
    const ab = await file.arrayBuffer();
    return (await mammoth.extractRawText({ arrayBuffer: ab })).value;
  }
  return await file.text();
}

// Context uploads: several files concatenated with filename headers, capped so
// the request payload stays small. A file that fails is noted inline rather than
// failing the whole batch.
export async function extractFiles(files, maxPer = 12000, maxTotal = 40000) {
  if (!files || !files.length) return '';
  const parts = [];
  for (const file of files) {
    let text = '';
    try {
      text = await readOne(file, maxPer);
    } catch (err) { text = `[Could not read ${file.name}: ${err.message}]`; }
    parts.push(`### ${file.name}\n${(text || '').trim().slice(0, maxPer)}`);
  }
  return parts.join('\n\n').slice(0, maxTotal);
}

// Single draft upload: the file IS the content, so return its text alone (no
// filename header) and let the caller report failures.
export async function extractFileText(file, maxChars = 200000) {
  const text = await readOne(file, maxChars);
  const trimmed = (text || '').trim();
  if (!trimmed) {
    throw new Error('no readable text found — a scanned or image-only PDF needs OCR first');
  }
  return trimmed.slice(0, maxChars);
}
