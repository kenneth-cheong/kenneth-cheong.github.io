function getSEOConsoleSnippet() {
  const snippet = `(function() {
    console.log('%c SEO Extraction Script Active ', 'background: #222; color: #bada55; padding: 5px; font-size: 14px; border-radius: 4px;');

    const data = {};

    // 1. Current URL
    data.url = window.location.href;

    // 2. Canonical Tag
    data.canonical = document.querySelector('link[rel="canonical"]')?.href || 'None found';

    // 3. Meta Title
    data.metaTitle = document.title;

    // 5. Meta Description
    data.metaDescription = document.querySelector('meta[name="description"]')?.content || 'None found';

    // 6. Headers (In Order of Appearance)
    const headerElements = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'));
    data.headers = headerElements.map(h => ({
        tag: h.tagName.toLowerCase(),
        text: h.innerText.trim()
    }));

    // 7. Internal Links / anchor text
    const currentDomain = window.location.hostname;
    const internalLinks = Array.from(document.querySelectorAll('a[href]'))
        .filter(a => {
            const href = a.getAttribute('href');
            if (!href) return false;
            if (href.startsWith('/') || href.startsWith('.') || href.includes(currentDomain)) {
                return true;
            }
            return false;
        })
        .map(a => ({
            text: a.innerText.trim(),
            href: a.href
        }))
        .slice(0, 100); 
    data.internalLinks = internalLinks;

    // 8. Schema Markup (JSON-LD)
    const schemaScripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
    data.schemaMarkup = schemaScripts.map(s => {
        try {
            return JSON.parse(s.innerText);
        } catch (e) {
            return 'Invalid JSON';
        }
    });

    // 9. Image URLs and Alt text
    data.images = Array.from(document.querySelectorAll('img')).map(img => ({
        src: img.src,
        alt: img.alt || '(No alt text)'
    })).slice(0, 50);

    console.log('--- SEO Data Extracted ---');
    console.table({
        URL: data.url,
        Canonical: data.canonical,
        Title: data.metaTitle,
        Description: data.metaDescription,
        Headers: data.headers.length + ' found',
        Links: data.internalLinks.length + ' internal found',
        Schema: data.schemaMarkup.length + ' blocks found',
        Images: data.images.length + ' found'
    });
    
    console.log('Full Data:', data);

    // Auto-copy to clipboard
    if (typeof copy === 'function') {
        copy(JSON.stringify(data, null, 2));
        console.log('%c Results auto-copied to clipboard! ', 'color: #10b981; font-weight: bold;');
    } else {
        console.log('Use copy(JSON.stringify(data, null, 2)) if you need the raw JSON.');
    }

    alert('SEO Data Extracted! Check the console and your clipboard.');
})();`;

  return snippet;
}

/**
 * Automatically runs when the spreadsheet or script project is opened.
 * Adds a custom menu to the UI.
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('🚀 SEO Tools')
      .addItem('Get Extraction Script', 'showSEOSnippetDialog')
      .addSeparator()
      .addItem('Paste Results to Sheet', 'showPasteDialog')
      .addToUi();
}

function showSEOSnippetDialog() {
  const snippet = getSEOConsoleSnippet();
  const htmlOutput = HtmlService.createHtmlOutput(
    '<html>' +
    '<head>' +
    '<style>' +
    'body { font-family: "Segoe UI", Roboto, Helvetica, Arial, sans-serif; padding: 20px; line-height: 1.5; color: #333; }' +
    '.step { margin-bottom: 20px; background: #f8f9fa; padding: 15px; border-radius: 8px; border-left: 4px solid #1a73e8; }' +
    '.step-title { font-weight: bold; color: #1a73e8; margin-bottom: 8px; display: block; }' +
    'code { background: #e8eaed; padding: 2px 5px; border-radius: 4px; font-family: monospace; }' +
    'textarea { width: 100%; height: 150px; font-family: monospace; font-size: 11px; margin-top: 10px; border: 1px solid #dadce0; border-radius: 4px; padding: 10px; }' +
    '.btn-container { margin-top: 15px; display: flex; gap: 10px; }' +
    '.btn { background: #1a73e8; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; font-weight: 500; }' +
    '.btn:hover { background: #1765cc; }' +
    '</style>' +
    '</head>' +
    '<body>' +
    '<h3>How to Extract SEO Data</h3>' +
    
    '<div class="step">' +
    '<span class="step-title">Step 1: Open Chrome Console</span>' +
    'Go to the website you want to audit. Press <code>F12</code> (or <code>Cmd+Opt+I</code> on Mac).' +
    '</div>' +

    '<div class="step">' +
    '<span class="step-title">Step 2: Allow Pasting (First time only)</span>' +
    'If Chrome says "Warning: Don\'t paste code...", type <code>allow pasting</code> into the console and press <b>Enter</b>.' +
    '</div>' +

    '<div class="step">' +
    '<span class="step-title">Step 3: Copy & Run Script</span>' +
    'Copy the script below, paste it into the console, and press <b>Enter</b>.' +
    '<textarea id="snippet" readonly>' + snippet + '</textarea>' +
    '<div class="btn-container">' +
    '<button class="btn" onclick="copyToClipboard()">📋 Copy Script</button>' +
    '</div>' +
    '</div>' +

    '<div class="step">' +
    '<span class="step-title">Step 4: Paste Results to Sheet</span>' +
    'Once the script finishes and extracts the data, return to this sheet. Go to <b>🚀 SEO Tools &gt; Paste Results to Sheet</b> and paste the data to show the extracted data.' +
    '</div>' +


    '<script>' +
    'function copyToClipboard() {' +
    '  var copyText = document.getElementById("snippet");' +
    '  copyText.select();' +
    '  document.execCommand("copy");' +
    '  alert("Script copied! Now paste into Chrome Console.");' +
    '}' +
    '</script>' +
    '</body>' +
    '</html>'
  )
  .setWidth(650)
  .setHeight(600)
  .setTitle('SEO Extraction Instructions');
  
  SpreadsheetApp.getUi().showModalDialog(htmlOutput, 'SEO Extraction instructions');
}

/**
 * Shows a dialog to paste the JSON results.
 */
function showPasteDialog() {
  const htmlOutput = HtmlService.createHtmlOutput(
    '<html>' +
    '<head>' +
    '<style>' +
    'body { font-family: sans-serif; padding: 20px; }' +
    'textarea { width: 100%; height: 300px; margin-bottom: 15px; border: 1px solid #ccc; border-radius: 4px; }' +
    'button { background: #1a73e8; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; width: 100%; }' +
    '</style>' +
    '</head>' +
    '<body>' +
    '<p>Paste the JSON results from the console here:</p>' +
    '<textarea id="jsonInput" placeholder=\'[Paste JSON here...]\'></textarea>' +
    '<button onclick="submitData()">Import into New Sheet</button>' +
    '<script>' +
    'function submitData() {' +
    '  const text = document.getElementById("jsonInput").value;' +
    '  google.script.run' +
    '    .withSuccessHandler(() => google.script.host.close())' +
    '    .withFailureHandler(err => alert("Error: " + err.message))' +
    '    .importSEOData(text);' +
    '}' +
    '</script>' +
    '</body>' +
    '</html>'
  )
  .setWidth(500)
  .setHeight(450)
  .setTitle('Paste SEO Data');
  
  SpreadsheetApp.getUi().showModalDialog(htmlOutput, 'Paste Results');
}

/**
 * Processes the JSON and creates a new sheet with formatted data.
 */
function importSEOData(jsonString) {
  try {
    const data = JSON.parse(jsonString);
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const timestamp = new Date().toLocaleTimeString();
    const sheetName = data.url + ' ' + timestamp;
    const sheet = ss.insertSheet(sheetName);
    
    const rows = [];
    
    // Header section
    rows.push(['URL EXTRACTION RESULTS', '']);
    rows.push(['Extracted at:', new Date().toLocaleString()]);
    rows.push(['Source URL:', data.url]);
    rows.push(['Canonical:', data.canonical]);
    rows.push(['Meta Title:', data.metaTitle]);
    rows.push(['Meta Description:', data.metaDescription]);
    rows.push(['', '']);
    
    // Headings (In Order)
    rows.push(['--- HEADINGS (In Order of Appearance) ---', '']);
    data.headers.forEach(h => {
        rows.push([h.text,h.tag]);
    });
    rows.push(['', '']);

    // Images
    rows.push(['--- IMAGES (Top 50) ---', '']);
    rows.push(['Alt Text', 'Source URL']);
    data.images.forEach(img => {
        rows.push([img.src, img.alt]);
    });
    rows.push(['', '']);
    
    // Internal Links
    rows.push(['--- INTERNAL LINKS (Top 100) ---', '']);
    rows.push(['Anchor Text', 'URL']);
    data.internalLinks.forEach(l => {
        rows.push([l.text, l.href]);
    });
    rows.push(['', '']);
    
    
    // Schema Markup (Simplified)
    rows.push(['--- SCHEMA BLOCKS ---', '']);
    data.schemaMarkup.forEach((s, i) => {
        rows.push(['Block #' + (i+1), typeof s === 'object' ? JSON.stringify(s).substring(0, 5000) : s]);
    });
    
    sheet.getRange(1, 1, rows.length, 2).setValues(rows);
    
    // Formatting
    sheet.getRange('A1').setFontSize(14).setFontWeight('bold');
    sheet.getRange('A1:B1').merge().setBackground('#e8f0fe');
    
    const boldRows = [8, 8 + data.headers.length + 2, 8 + data.headers.length + data.internalLinks.length + 5];
    boldRows.forEach(row => {
        if (row <= rows.length) {
            sheet.getRange(row, 1).setFontWeight('bold').setBackground('#f1f3f4');
        }
    });
    
    sheet.setColumnWidth(1, 200);
    sheet.setColumnWidth(2, 600);
    sheet.setFrozenRows(1);
    
    SpreadsheetApp.getUi().alert('Imported ' + data.headers.length + ' headings and ' + data.internalLinks.length + ' links successfully into sheet: ' + sheetName);
    
  } catch (e) {
    throw new Error('Failed to parse JSON: ' + e.message);
  }
}