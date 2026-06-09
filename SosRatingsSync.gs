// SOS Logs → clientSatisfaction Lambda sync
// Reads ⭐ New Rating Received messages from Google Chat and pushes to Lambda/MongoDB.
//
// Setup:
//   1. Paste this file into a new Google Apps Script project (script.google.com)
//   2. Replace appsscript.json with the manifest below (Project Settings → show manifest)
//   3. Run syncAll() once to backfill historical ratings (authorize when prompted)
//   4. Add a time-based trigger: syncRatings → every 15 minutes

const SPACE_ID   = 'AAQAn2EGERg';
const LAMBDA_URL = 'https://lmxwxiqf19.execute-api.ap-southeast-1.amazonaws.com/';
const WRITE_KEY  = 'chatratings-sk-a8f2b3c1d4e5';

// ── Public entry points ───────────────────────────────────────────────────────

/** Triggered every 15 min — only fetches messages newer than last sync. */
function syncRatings() {
  const props = PropertiesService.getScriptProperties();
  const since = props.getProperty('lastSyncTime') || '2024-01-01T00:00:00Z';
  const latest = _fetchAndPush(since);
  if (latest) props.setProperty('lastSyncTime', latest);
}

/** Run once manually to backfill all historical ratings. */
function syncAll() {
  const latest = _fetchAndPush('2020-01-01T00:00:00Z');
  if (latest) PropertiesService.getScriptProperties().setProperty('lastSyncTime', latest);
  console.log('Backfill complete. lastSyncTime set to: ' + latest);
}

// ── Core logic ────────────────────────────────────────────────────────────────

function _fetchAndPush(since) {
  const token = ScriptApp.getOAuthToken();
  let pageToken = null;
  const ratings = [];
  let latestTime = null;

  do {
    const filter = 'createTime > "' + since + '"';
    let url = 'https://chat.googleapis.com/v1/spaces/' + SPACE_ID + '/messages'
      + '?pageSize=250&orderBy=createTime+asc&filter=' + encodeURIComponent(filter);
    if (pageToken) url += '&pageToken=' + encodeURIComponent(pageToken);

    const resp = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true,
    });

    if (resp.getResponseCode() !== 200) {
      console.error('Chat API error ' + resp.getResponseCode() + ': ' + resp.getContentText());
      break;
    }

    const data = JSON.parse(resp.getContentText());
    for (const msg of (data.messages || [])) {
      const text = msg.text || msg.formattedText || '';
      if (text.indexOf('New Rating Received') !== -1) {
        const parsed = _parseRating(text, msg);
        if (parsed) {
          ratings.push(parsed);
          latestTime = msg.createTime;
        }
      }
    }
    pageToken = data.nextPageToken || null;
  } while (pageToken);

  if (ratings.length > 0) {
    const resp = UrlFetchApp.fetch(LAMBDA_URL, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ action: 'save_ratings', ratings: ratings, write_key: WRITE_KEY }),
      muteHttpExceptions: true,
    });
    console.log('Pushed ' + ratings.length + ' ratings → HTTP ' + resp.getResponseCode());
    if (resp.getResponseCode() !== 200) console.error(resp.getContentText());
  } else {
    console.log('No new ratings since ' + since);
  }

  return latestTime;
}

function _parseRating(text, msg) {
  const ratingMatch = text.match(/\((\d+)\/5\)/);
  if (!ratingMatch) return null;

  function get(label) {
    const m = text.match(new RegExp(label + ':\\s*(.+)'));
    return m ? m[1].trim() : '';
  }

  return {
    message_id: msg.name,
    timestamp:  msg.createTime,
    type:       get('Type'),
    from:       get('From'),
    rating:     parseInt(ratingMatch[1], 10),
    context:    get('Context'),
    comment:    get('Comment'),
  };
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
    "https://www.googleapis.com/auth/chat.messages.readonly",
    "https://www.googleapis.com/auth/script.external_request"
  ]
}
*/
