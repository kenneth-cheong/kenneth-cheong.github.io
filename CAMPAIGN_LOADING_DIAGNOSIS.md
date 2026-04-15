# Campaign Info Repository - Loading Issues & Solutions

## Root Causes Identified

### 1. **Early Exit in `renderMondayItems()` Function**
**Location:** `backlinks.html`, line 2171
```javascript
function renderMondayItems() {
    const items = state.mondayItems || [];
    if (items.length === 0) return;  // <-- EXITS HERE if no Monday items loaded
    // ... rest of function never executes
}
```

**Problem:** If Monday.com sync fails or hasn't completed, `state.mondayItems` is empty, so the function exits early and:
- The table title never updates to show "Integrated Campaign Info Repository"
- Users see the static default message: "Click 'Import from Monday' to load board items"
- No error is displayed

**Fix:** Always render the table structure even if no items exist, to provide feedback.

---

### 2. **Lambda Connection Issues**
**API Endpoint:** `https://1rxrp7gth2.execute-api.ap-southeast-1.amazonaws.com/monday`

**Potential Issues:**
- Monday.com API credentials not configured in Lambda environment variables
- Lambda IAM role doesn't have permission to invoke the Monday API
- Network connectivity or timeout issues
- Missing error logging in the Lambda function

**To Debug:**
1. Check AWS CloudWatch logs for the Lambda function
2. Verify `MONDAY_API_KEY` and `MONDAY_BOARD_ID` environment variables are set
3. Test the Lambda directly via AWS Console

---

### 3. **MongoDB Connection in Backlinks Persistence Lambda**
**File:** `backlinks_persistence_lambda.py`
**Issue:** `MONGODB_URI` environment variable not configured or connection timing out

**Fixed Version Includes:**
- ✅ MongoDB connection verification with `client.admin.command('ping')`
- ✅ Server selection timeout (5 seconds)
- ✅ ObjectId serialization fixes for clean JSON responses
- ✅ Try/catch blocks around all database operations
- ✅ Better error messages for debugging

---

## Frontend Fixes Applied

### 1. Enhanced `renderCampaigns()` - `backlinks.html` line ~1397
Added:
- ✅ Check for empty arrays
- ✅ Fallback message when no campaigns exist
- ✅ Safe property access with defaults (e.g., `c.name || 'Unnamed'`)

### 2. Enhanced `fetchCampaigns()` - `backlinks.html` line ~1366
Added:
- ✅ Console logging for debugging data flow
- ✅ Proper error handling and empty state handling
- ✅ Call to `updateCampaignsCount()` after successful load
- ✅ Try/catch wrapper for network errors

### 3. Fix for `renderMondayItems()` - NEEDED
**Current Problem:** Line 2171 exits early if no items
**Solution:** Add empty state handling that still shows UI feedback

---

## Backend Fixes Applied

### 1. `backlinks_persistence_lambda.py`
**Fixed Functions:**
- ✅ `get_db()` - Now verifies MongoDB connection with ping test
- ✅ `handle_get_campaigns()` - Added error handling and ObjectId serialization
- ✅ `handle_get_backlinks()` - Added error handling and ObjectId serialization  
- ✅ `handle_get_users()` - Added error handling and ObjectId serialization

**Changes:**
- MongoDB connection timeout set to 5 seconds
- All functions wrapped in try/catch
- ObjectId fields converted to strings for JSON serialization
- Error responses return proper status codes and messages

---

## Diagnostic Steps

### To Test if Monday.com Sync is Working:
1. Open browser DevTools (F12)
2. Go to "Console" tab
3. Check for errors when clicking "Get From Monday" button
4. Look for logs showing `Campaign data received:` in console

### To Check MongoDB Connection:
1. SSH into AWS Lambda or check CloudWatch logs
2. Look for "MongoDB connection error" messages
3. Verify `MONGODB_URI` is set in Lambda environment variables
4. Test connection string locally: `mongosh "YOUR_CONNECTION_STRING"`

### To Monitor API Calls:
1. Open DevTools → Network tab
2. Click "Get From Monday"
3. Look for request to `monday` endpoint
4. Check response status and body
5. Check request to `backlinksDatabase` endpoint
6. Verify response format matches expected structure

---

## Configuration Needed

### AWS Lambda Environment Variables

**For `backlinks_persistence_lambda.py`:**
```
MONGODB_URI = "mongodb+srv://user:pass@cluster.mongodb.net/?retryWrites=true&w=majority"
```

**For Monday.com Lambda:**
```
MONDAY_API_KEY = "your_monday_api_key"
MONDAY_BOARD_ID = "your_board_id"
```

---

## Files Modified

1. ✅ `backlinks_persistence_lambda.py` - MongoDB connection and serialization fixes
2. ✅ `backlinks.html` - Enhanced `renderCampaigns()` and `fetchCampaigns()` functions

## Files Needing Attention

- `renderMondayItems()` in `backlinks.html` - Add empty state handling  
- Monday.com Lambda function - Verify configuration and add logging

---

## Next Steps

1. **Test MongoDB Connection:**
   - Deploy the fixed `backlinks_persistence_lambda.py`
   - Check CloudWatch logs for connection verification messages

2. **Test Monday.com API:**
   - Click "Get From Monday" button
   - Monitor console for errors
   - Check AWS Lambda logs for API call failures

3. **Verify Credentials:**
   - Confirm all environment variables are set correctly
   - Test API keys and connection strings directly

4. **Monitor Campaign Loading:**
   - After sync, check if campaigns appear in the table
   - Verify table title updates to show item count
