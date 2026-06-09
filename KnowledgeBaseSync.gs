// Question Bank Sheet → monday Lambda → MongoDB knowledge_base (RAG source)
// Reads every tab of the support question-bank spreadsheet and pushes the
// Question/Answer/Tags rows to the Lambda, which embeds + upserts them into the
// `knowledge_base` collection used by the chatbot's search_knowledge_base tool.
//
// Setup:
//   1. Paste this file into a new Google Apps Script project (script.google.com)
//      that is bound to — or has read access to — the question-bank spreadsheet.
//   2. Replace appsscript.json with the manifest at the bottom of this file.
//   3. Make sure the Lambda env var KB_WRITE_KEY matches WRITE_KEY below.
//   4. Run syncAll() once to backfill (authorize when prompted).
//   5. Add a time-based trigger: syncKnowledgeBase → every 30 minutes.

const SPREADSHEET_ID = '1aiAaELbN-pv9jq_CQ1TDoWazRTcVPCFGX-N8Dr_1UEY';
const LAMBDA_URL     = 'https://1rxrp7gth2.execute-api.ap-southeast-1.amazonaws.com/monday';
const WRITE_KEY      = 'kb-sk-7f3a9c21e4b8';   // must equal Lambda env var KB_WRITE_KEY

// ── Public entry points ───────────────────────────────────────────────────────

/** Triggered on a timer and for manual backfill — pushes the full sheet each run.
 *  The Lambda only re-embeds rows whose content changed, so repeated runs are cheap. */
function syncKnowledgeBase() {
  const rows = _readAllRows();
  if (!rows.length) {
    console.log('No rows found in spreadsheet — nothing to sync.');
    return;
  }
  const resp = UrlFetchApp.fetch(LAMBDA_URL, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      action:    'sync_knowledge_base',
      write_key: WRITE_KEY,
      full_sync: true,        // reconcile deletions: rows removed from the sheet are dropped
      rows:      rows,
    }),
    muteHttpExceptions: true,
  });
  const code = resp.getResponseCode();
  console.log('Pushed ' + rows.length + ' rows → HTTP ' + code);
  console.log(resp.getContentText());
  if (code !== 200) throw new Error('Sync failed: ' + resp.getContentText());
}

/** Alias for the first manual backfill. */
function syncAll() {
  syncKnowledgeBase();
}

// ── Core logic ────────────────────────────────────────────────────────────────

/** Reads every sheet/tab, mapping the Question / Answer / Tags columns by header. */
function _readAllRows() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const out = [];

  ss.getSheets().forEach(function (sheet) {
    const tab = sheet.getName();
    const values = sheet.getDataRange().getValues();
    if (values.length < 2) return;

    // Locate the header row (first row containing a "question" cell)
    let headerIdx = -1;
    for (let i = 0; i < Math.min(values.length, 5); i++) {
      const lower = values[i].map(function (c) { return String(c).trim().toLowerCase(); });
      if (lower.indexOf('question') !== -1 && lower.indexOf('answer') !== -1) {
        headerIdx = i;
        break;
      }
    }
    if (headerIdx === -1) return;

    const header = values[headerIdx].map(function (c) { return String(c).trim().toLowerCase(); });
    const qCol = header.indexOf('question');
    const aCol = header.indexOf('answer');
    const tCol = header.indexOf('tags');

    for (let r = headerIdx + 1; r < values.length; r++) {
      const row = values[r];
      const q = qCol > -1 ? String(row[qCol] || '').trim() : '';
      const a = aCol > -1 ? String(row[aCol] || '').trim() : '';
      if (!q || !a) continue;
      out.push({
        question:  q,
        answer:    a,
        tags:      tCol > -1 ? String(row[tCol] || '').trim() : '',
        sheet_tab: tab,
      });
    }
  });

  return out;
}

/*
── appsscript.json manifest ──────────────────────────────────────────────────
Replace the contents of appsscript.json with:

{
  "timeZone": "Asia/Singapore",
  "dependencies": {},
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8",
  "oauthScopes": [
    "https://www.googleapis.com/auth/spreadsheets.readonly",
    "https://www.googleapis.com/auth/script.external_request"
  ]
}
*/
