# Campaign Info Repository - Quick Debugging Guide

## Issue Summary
The Campaign Info Repository (Campaigns tab) in `backlinks.html` is not loading/displaying campaigns from Monday.com.

## What Was Fixed

### ✅ Frontend Fixes (backlinks.html)

1. **`renderCampaigns()` function** - Added empty state handling
   - Now shows "No campaigns found" message instead of crashing
   - Safely handles missing properties with defaults

2. **`fetchCampaigns()` function** - Enhanced error handling
   - Added console.log for debugging
   - Handles null/undefined responses gracefully
   - Updates campaign count after load

3. **`renderMondayItems()` function** - Fixed early exit
   - **CRITICAL FIX:** Now renders table structure even when no items loaded
   - Updates title to show "0 items" when empty
   - Shows helpful message: "No campaigns loaded. Click 'Get From Monday' to import"

### ✅ Backend Fixes (backlinks_persistence_lambda.py)

1. **MongoDB Connection (`get_db()` function)**
   - Added connection verification with ping test
   - Set 5-second timeout to catch hanging connections
   - Throws clear error if `MONGODB_URI` not configured

2. **All database handlers** - Added ObjectId serialization
   - `handle_get_campaigns()` - ✅ Fixed
   - `handle_get_backlinks()` - ✅ Fixed  
   - `handle_get_users()` - ✅ Fixed
   - All now handle MongoDB ObjectId → JSON string conversion

3. **Error Handling** - All functions now have try/catch blocks
   - Errors logged to CloudWatch
   - Proper HTTP status codes returned
   - Error messages included in response

---

## Step-by-Step Debugging

### Step 1: Check Browser Console for Errors
```
1. Open backlinks.html
2. Press F12 to open DevTools
3. Go to "Console" tab
4. Click "Campaigns" tab
5. Look for any red error messages
6. Click "Get From Monday" button
7. Check for new errors
```

**Expected Logs:**
```
Campaign data received: Array(5)  [or similar]
OR
No data received from get_campaigns
```

**If you see errors like:**
- "Cannot read property 'length' of undefined" → state.campaigns is null
- "Fetch failed" → Network connectivity issue
- "401 Unauthorized" → API credentials missing

---

### Step 2: Check Network Requests
```
1. Press F12 → "Network" tab
2. Filter by "Fetch/XHR"
3. Click "Get From Monday" button
4. Look for request to:
   - https://1rxrp7gth2.execute-api.ap-southeast-1.amazonaws.com/monday
   - https://0ed5sd7nn5.execute-api.ap-southeast-1.amazonaws.com/backlinksDatabase
5. Click each request and check:
   - Status: Should be 200
   - Response: Should contain data
   - Headers: Check for Content-Type: application/json
```

**Expected Response Format:**
```json
{
  "statusCode": 200,
  "body": "{\"items\": [...], \"cursor\": null}",
  "headers": {...}
}
```

---

### Step 3: Verify AWS Lambda Configuration

**For Monday.com Lambda** (URL ending in `/monday`):
```bash
1. Go to AWS Console → Lambda
2. Find function "backlinks-monday" or similar
3. Check "Environment variables" section
4. Verify these exist:
   - MONDAY_API_KEY = [not empty]
   - MONDAY_BOARD_ID = [not empty]
5. Check CloudWatch Logs:
   - Look for recent invocations
   - Look for error messages
   - Check if Lambda is being called at all
```

**For Backlinks Persistence Lambda** (URL ending in `/backlinksDatabase`):
```bash
1. Go to AWS Console → Lambda
2. Find function related to backlinks persistence
3. Check "Environment variables" section
4. Verify:
   - MONGODB_URI = [not empty, valid connection string]
5. Test MongoDB connection:
   - Open CloudWatch Logs
   - Look for "MongoDB connection error" or "ping" messages
6. If connection fails:
   - Verify connection string syntax
   - Check MongoDB cluster whitelist includes Lambda IPs
   - Test connection string locally with mongosh
```

---

### Step 4: Test Monday.com API Directly

```bash
# Using curl (macOS/Linux)
curl -X POST https://1rxrp7gth2.execute-api.ap-southeast-1.amazonaws.com/monday \
  -H "Content-Type: application/json" \
  -d '{
    "action": "get_board_items",
    "data": {"cursor": null}
  }'

# Expected response:
# {"items": [...], "cursor": null}  or
# {"error": "..."}
```

If you get a 500 error, check CloudWatch logs for the Lambda.

---

### Step 5: Test MongoDB Connection Directly

**From Lambda Console:**
```python
# Can be run in Lambda Test window
import os
from pymongo import MongoClient

MONGODB_URI = os.environ.get('MONGODB_URI')
client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
try:
    client.admin.command('ping')
    print("MongoDB connection OK")
except Exception as e:
    print(f"MongoDB connection FAILED: {e}")
```

---

## Common Issues & Solutions

| Issue | Cause | Solution |
|-------|-------|----------|
| "Get From Monday" button does nothing | Monday Lambda not responding | Check Lambda logs, verify API key |
| Table shows "0 items" but should show data | Monday API not returning items | Check if board exists, user has access |
| "Cannot read property 'name'" error | Campaign objects missing fields | Check Lambda response format |
| MongoDB connection timeout | Network issue or wrong credentials | Whitelist Lambda security group in MongoDB Atlas |
| "MONGODB_URI not configured" error | Environment variable missing | Set MONGODB_URI in Lambda config |
| Table header doesn't update | renderMondayItems() exiting early | Already fixed - deploy latest code |

---

## Deployment Checklist

- [ ] Deploy updated `backlinks_persistence_lambda.py` to AWS
- [ ] Deploy updated `backlinks.html` to GitHub Pages
- [ ] Verify `MONGODB_URI` environment variable is set in Lambda
- [ ] Verify `MONDAY_API_KEY` environment variable is set in Monday Lambda
- [ ] Clear browser cache (Ctrl+Shift+Delete)
- [ ] Test in fresh incognito window
- [ ] Monitor CloudWatch logs during test
- [ ] Check browser console for errors (F12)
- [ ] Verify "Get From Monday" button works
- [ ] Verify campaigns appear in table

---

## Rapid Test Script

**Paste in browser console (F12) to diagnose:**
```javascript
// Test 1: Check if state object exists
console.log("state.campaigns:", state.campaigns);
console.log("state.mondayItems:", state.mondayItems);

// Test 2: Check table elements exist
console.log("campaignsTable:", document.getElementById('campaignsTable'));
console.log("campaignsBody:", document.getElementById('campaignsBody'));

// Test 3: Check Lambda URLs
console.log("PERSISTENCE_URL:", PERSISTENCE_URL);
console.log("MONDAY_URL:", MONDAY_URL);

// Test 4: Manually call fetch
fetch(MONDAY_URL, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({action: 'get_board_items', data: {cursor: null}})
})
.then(r => r.json())
.then(d => {
    console.log("Monday API Response:", d);
    if (d.body) console.log("Parsed body:", JSON.parse(d.body));
})
.catch(e => console.error("Fetch error:", e));
```

---

## Support Information

When reporting issues, collect:
1. Browser console output (F12 → Console)
2. Network requests (F12 → Network)
3. AWS CloudWatch logs from Monday Lambda
4. AWS CloudWatch logs from Persistence Lambda
5. MongoDB connection status (if applicable)
6. Date/time of error occurrence
