import json
import os
from datetime import datetime
import uuid
import certifi
import urllib.request
import urllib.parse
from pymongo import MongoClient
import bson
from bson import ObjectId

# Environment Variables (Configure these in AWS Lambda)
MONGODB_URI = os.environ.get('MONGODB_URI')
MONGODB_DATABASE = 'chatbot_ai_db'

# Global client to reuse connection
client = None

def get_db():
    global client
    if client is None:
        if not MONGODB_URI:
            raise Exception("MONGODB_URI environment variable not configured")
        try:
            client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000, tlsCAFile=certifi.where())
            client.admin.command('ping')
        except Exception as e:
            client = None
            print(f"MongoDB connection error: {str(e)}")
            raise
    return client[MONGODB_DATABASE]

def lambda_handler(event, context):
    headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    }

    if event.get('httpMethod') == 'OPTIONS':
        return {'statusCode': 200, 'headers': headers}

    try:
        body = event
        if 'body' in event and isinstance(event['body'], str):
            try:
                body = json.loads(event['body'])
            except:
                pass
        
        action = body.get('action')
        data = body.get('data', {})
        
        if not action and isinstance(body.get('body'), dict):
            body = body['body']
            action = body.get('action')
            data = body.get('data', {})

        if not action:
            return response(400, {"error": "Missing action"}, headers)

        if action == 'get_config':
            return response(200, {
                "googleClientId": os.environ.get('GOOGLE_CLIENT_ID', '')
            }, headers)

        db = get_db()

        if action == 'save_conversation':
            return handle_save_conversation(db, data, headers)
        elif action == 'fetch_conversations':
            return handle_fetch_conversations(db, data, headers)
        elif action == 'get_conversation':
            return handle_get_conversation(db, data, headers)
        elif action == 'delete_conversation':
            return handle_delete_conversation(db, data, headers)
        elif action == 'save_insights':
            return handle_save_insights(db, body, headers)
        elif action == 'get_insights':
            return handle_get_insights(db, body, headers)
        elif action == 'save_app_setting':
            return handle_save_app_setting(db, body, headers)
        elif action == 'get_app_setting':
            return handle_get_app_setting(db, body, headers)
        elif action == 'save_monday_key':
            return handle_save_monday_key(db, body, headers)
        elif action == 'get_monday_key':
            return handle_get_monday_key(db, body, headers)
        else:
            return response(400, {"error": f"Unsupported action: {action}"}, headers)

    except Exception as e:
        print(f"Error: {str(e)}")
        return response(500, {"error": f"Internal Server Error: {str(e)}"}, headers)

def _first_user_content(msgs):
    """First user message's content, normalised to a comparable string.
    Vision turns carry a list/dict content, so serialise those deterministically."""
    for m in (msgs or []):
        if isinstance(m, dict) and m.get('role') == 'user':
            c = m.get('content')
            return c if isinstance(c, str) else json.dumps(c, sort_keys=True, default=str)
    return ''

def handle_save_conversation(db, data, headers):
    user_id = data.get('userId', 'global_user')
    conv_id = data.get('conversationId')

    if not conv_id:
        conv_id = str(uuid.uuid4())

    messages = data.get('messages', [])
    title = data.get('title')

    # Inline rename: a title-only update legitimately carries no messages, so it must NOT
    # hit the empty-message guard below (which would skip it and silently drop the rename).
    # Patch just the title across every copy of this id (drifted dupes) without touching
    # messages or lastUpdated, so renaming doesn't reorder the history list.
    if data.get('isTitleOnly'):
        if not title:
            return response(400, {"error": "Missing title for title-only update"}, headers)
        result = db.conversations.update_many(
            {"conversationId": conv_id},
            {"$set": {"title": title}}
        )
        return response(200, {
            "success": True, "conversationId": conv_id,
            "titleOnly": True, "matched": result.matched_count
        }, headers)

    # ── Data-loss guards ─────────────────────────────────────────────────────
    # Two failure modes have wiped real threads, both from a client that loaded
    # blank/partial history (usually the Atlas shard read hiccup) and then autosaved
    # over a good doc sharing this conversationId. Find the richest stored copy across
    # EVERY userId spelling for this id (a past userId-format change left some
    # conversations duplicated) and refuse a save that would shrink it.
    richest = None
    stored_rev = 0
    for c in db.conversations.find({"conversationId": conv_id}, {"messages": 1, "rev": 1}):
        if richest is None or len(c.get('messages') or []) > len(richest.get('messages') or []):
            richest = c
        stored_rev = max(stored_rev, int(c.get('rev') or 0))
    stored_msgs = (richest or {}).get('messages') or []

    # Guard 1: an empty save must never clobber a thread that already has content.
    if not messages:
        if stored_msgs:
            return response(200, {
                "success": True, "conversationId": conv_id,
                "skipped": "empty_messages_guard"
            }, headers)

    # Guard 2: a *non-empty but shrinking* save can still wipe a richer thread — e.g.
    # a 2-message "wheres my summary" thread written over a long NTUC strategy under
    # the same id (30 Jun 2026). Guard 1 misses it because the save isn't empty. If a
    # stored copy has MORE messages AND starts with a DIFFERENT first user message, the
    # incoming thread is a different (blank-loaded) conversation reusing the id, so keep
    # the richer copy. Same-thread growth (len >= stored) and same-thread edits
    # (regenerate / edit-and-resend keep the first user message) pass straight through.
    elif len(stored_msgs) > len(messages):
        stored_first = _first_user_content(stored_msgs).strip()
        incoming_first = _first_user_content(messages).strip()
        if stored_first and stored_first != incoming_first:
            return response(200, {
                "success": True, "conversationId": conv_id,
                "skipped": "shrink_guard"
            }, headers)

    # Guard 3 (optimistic concurrency): if the client says which revision it based its
    # edit on and the server has since moved past it (another device/tab saved in
    # between), refuse to overwrite. Hand back the current server thread + rev so the
    # client can merge its pending messages and retry. This closes the same-thread
    # cross-device shrink the first-message heuristic can't catch. Clients that omit
    # baseRev (older cached builds) skip this and still get the shrink/empty guards.
    base_rev = data.get('baseRev')
    if base_rev is not None and richest is not None and int(base_rev) != stored_rev:
        return response(200, {
            "success": False, "conflict": True, "conversationId": conv_id,
            "rev": stored_rev, "messages": stored_msgs
        }, headers)

    if not title and messages:
        # Generate a title from the first user message
        first_user_msg = next((m for m in messages if m.get('role') == 'user'), None)
        if first_user_msg:
            title = first_user_msg.get('content', '')[:50] + '...'
        else:
            title = "New Conversation"

    new_rev = stored_rev + 1
    update_doc = {
        "conversationId": conv_id,
        "userId": user_id,
        "title": title or "Untitled",
        "messages": messages,
        "threadId": data.get('threadId'),
        "mode": data.get('mode'),
        "rev": new_rev,
        "lastUpdated": datetime.utcnow()
    }

    db.conversations.update_one(
        {"conversationId": conv_id, "userId": user_id},
        {"$set": update_doc},
        upsert=True
    )

    return response(200, {"success": True, "conversationId": conv_id, "rev": new_rev}, headers)

def handle_fetch_conversations(db, data, headers):
    user_id = data.get('userId', 'global_user')
    fetch_all = data.get('fetchAll', False) or user_id == 'ALL_USERS'

    try:
        query = {} if fetch_all else {"userId": user_id}
        cursor = db.conversations.find(
            query,
            {"conversationId": 1, "userId": 1, "title": 1, "lastUpdated": 1, "mode": 1}
        ).sort("lastUpdated", -1).limit(300)

        # Collapse duplicate documents that share a conversationId (artifacts of a past
        # userId-format change). conversationId is unique per conversation, so the cursor
        # is already sorted newest-first — keep the first (most recent) sighting of each.
        conversations = []
        seen = set()
        for c in cursor:
            cid = c.get("conversationId")
            if cid in seen:
                continue
            seen.add(cid)
            uid = c.get("userId") or ""
            conversations.append({
                "conversationId": cid,
                "userId": uid,
                "userLabel": uid.replace("user_", ""),
                "title": c.get("title") or "Untitled",
                "updatedAt": c.get("lastUpdated"),
                "mode": c.get("mode")
            })

        return response(200, {"conversations": conversations}, headers)
    except Exception as e:
        return response(500, {"error": str(e)}, headers)

def handle_get_conversation(db, data, headers):
    user_id = data.get('userId', 'global_user')
    conv_id = data.get('conversationId')
    fetch_all = data.get('fetchAll', False)

    if not conv_id:
        return response(400, {"error": "Missing conversationId"}, headers)

    if fetch_all:
        # When viewing by ID (own load or admin view), there may be more than one
        # document for this conversationId: a past userId-format change (e.g.
        # "user_x" vs "user__x_") left some conversations with duplicate records.
        # conversationId is a UUID unique per conversation — shared copies are forked
        # with a fresh id (see chatbot.html) — so any duplicates are the SAME person's
        # drifted records. A plain find_one() could return the empty twin and open the
        # chat blank, so prefer the requester's own non-empty copy, then fall back to
        # the richest copy by message count, then most recent.
        candidates = list(db.conversations.find({"conversationId": conv_id}))
        if not candidates:
            return response(404, {"error": "Conversation not found"}, headers)
        own = [c for c in candidates if c.get("userId") == user_id and (c.get("messages") or [])]
        pool = own or candidates
        conv = max(pool, key=lambda c: (len(c.get("messages") or []), str(c.get("lastUpdated") or "")))
    else:
        conv = db.conversations.find_one({"conversationId": conv_id, "userId": user_id})
        if not conv:
            return response(404, {"error": "Conversation not found"}, headers)

    return response(200, {"conversation": conv}, headers)

def handle_delete_conversation(db, data, headers):
    user_id = data.get('userId', 'global_user')
    conv_id = data.get('conversationId')
    
    if not conv_id:
        return response(400, {"error": "Missing conversationId"}, headers)
        
    db.conversations.delete_one({"conversationId": conv_id, "userId": user_id})
    return response(200, {"success": True}, headers)

def handle_save_insights(db, body, headers):
    email = body.get('email')
    incoming = body.get('insights', [])
    deleted_ids = body.get('deleted_ids', [])
    if not email:
        return response(400, {"error": "Email missing"}, headers)

    # Merge by id instead of replacing the whole array. A blind $set let any
    # client (especially the shared "global_shared_insights" doc) clobber items
    # added/edited by other sessions since its last pull. We union the stored
    # array with the incoming one (incoming wins on id collision), then apply
    # tombstones so real deletions still propagate.
    existing_doc = db.insights.find_one({"email": email.lower()}) or {}
    existing = existing_doc.get('insights', [])

    # PERSISTENT tombstones. Deletions used to live only in the deleting browser's
    # localStorage, so a different (or stale) client that still held the item would
    # re-push it on its next sync and resurrect it for everyone. We now persist the
    # tombstone set on the shared doc and union prior + incoming ids, so once an id
    # is deleted it stays deleted no matter who pushes a stale copy later.
    tombstones = set(str(t) for t in existing_doc.get('deleted_ids', []))
    for did in (deleted_ids or []):
        tombstones.add(str(did))

    merged = {}
    for ins in existing:
        if isinstance(ins, dict) and 'id' in ins:
            merged[str(ins['id'])] = ins
    for ins in incoming:
        if isinstance(ins, dict) and 'id' in ins:
            merged[str(ins['id'])] = ins  # incoming wins (edits/new)

    for did in tombstones:
        merged.pop(did, None)

    insights = list(merged.values())
    # Cap the tombstone list so it cannot grow without bound (ids are unique
    # timestamps, so dropping the oldest can never collide with a live item).
    tomb_list = sorted(tombstones)[-3000:]

    db.insights.update_one(
        {"email": email.lower()},
        {"$set": {"insights": insights, "deleted_ids": tomb_list,
                  "updated_at": datetime.utcnow()}},
        upsert=True
    )
    return response(200, {"status": "success", "insights": insights,
                          "deleted_ids": tomb_list}, headers)

def handle_get_insights(db, body, headers):
    email = body.get('email')
    if not email:
        return response(400, {"error": "Email missing"}, headers)
    doc = db.insights.find_one({"email": email.lower()})
    if not doc:
        return response(200, {"insights": [], "deleted_ids": []}, headers)
    # Defensively strip tombstoned ids (in case an old write left them in the
    # array) and hand the tombstone list back so clients can converge their own
    # localStorage instead of re-pushing deleted items.
    tombstones = set(str(t) for t in doc.get('deleted_ids', []))
    items = [i for i in doc.get('insights', [])
             if not (isinstance(i, dict) and str(i.get('id')) in tombstones)]
    return response(200, {"insights": items, "deleted_ids": sorted(tombstones)}, headers)

def handle_save_app_setting(db, body, headers):
    # Shared, account-wide key/value settings (one doc per name, NOT scoped to a user)
    # so the whole team edits in one place — e.g. the client report-format template.
    name = body.get('name')
    value = body.get('value')
    if not name:
        return response(400, {"error": "Missing setting name"}, headers)
    db.app_settings.update_one(
        {"name": name},
        {"$set": {"value": value,
                  "updated_by": body.get('updatedBy') or body.get('updated_by') or '',
                  "updated_at": datetime.utcnow()}},
        upsert=True
    )
    return response(200, {"status": "success", "name": name}, headers)

def handle_get_app_setting(db, body, headers):
    name = body.get('name')
    if not name:
        return response(400, {"error": "Missing setting name"}, headers)
    doc = db.app_settings.find_one({"name": name})
    return response(200, {
        "name": name,
        "value": (doc.get('value') if doc else None),
        "updated_by": (doc.get('updated_by') if doc else None),
        "updated_at": (doc.get('updated_at') if doc else None),
    }, headers)

# ── Per-user Monday API key sync (Google-verified only) ──────────────────────
# The Monday key is a personal CREDENTIAL, so it is never keyed by a client-
# asserted email. The frontend must send a Google ID token (JWT); we verify it
# against Google and derive the identity server-side, so a key can only be
# stored/read under the cryptographically-verified email that owns it.
GOOGLE_TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo"

def _verify_google_email(id_token):
    """Verify a Google ID token via Google's tokeninfo endpoint. Returns the
    lowercased, verified email on success, or None if the token is missing,
    invalid, expired, unverified, or minted for a different OAuth client."""
    if not id_token or not isinstance(id_token, str):
        return None
    try:
        url = GOOGLE_TOKENINFO_URL + "?" + urllib.parse.urlencode({"id_token": id_token})
        # tokeninfo returns HTTP 400 for a bad/expired token, which raises here.
        with urllib.request.urlopen(url, timeout=5) as r:
            info = json.loads(r.read().decode("utf-8"))
    except Exception as e:
        print(f"[GOOGLE-VERIFY] tokeninfo failed: {e}")
        return None
    # Audience must be OUR OAuth client — reject tokens minted for other apps.
    expected_aud = os.environ.get("GOOGLE_CLIENT_ID", "")
    if expected_aud and info.get("aud") != expected_aud:
        print(f"[GOOGLE-VERIFY] aud mismatch (got {info.get('aud')})")
        return None
    if str(info.get("email_verified")).lower() not in ("true", "1"):
        return None
    email = (info.get("email") or "").strip().lower()
    return email if "@" in email else None

def handle_save_monday_key(db, body, headers):
    email = _verify_google_email(body.get("idToken"))
    if not email:
        return response(401, {"error": "Google verification required"}, headers)
    value = body.get("value")
    if value is None:
        return response(400, {"error": "Missing value"}, headers)
    db.monday_keys.update_one(
        {"email": email},
        {"$set": {"value": value, "updated_at": datetime.utcnow()}},
        upsert=True
    )
    return response(200, {"status": "success"}, headers)

def handle_get_monday_key(db, body, headers):
    email = _verify_google_email(body.get("idToken"))
    if not email:
        return response(401, {"error": "Google verification required"}, headers)
    doc = db.monday_keys.find_one({"email": email})
    return response(200, {
        "value": (doc.get("value") if doc else None),
        "updated_at": (doc.get("updated_at") if doc else None),
    }, headers)

class JSONEncoder(json.JSONEncoder):
    def default(self, o):
        if isinstance(o, ObjectId): return str(o)
        if isinstance(o, datetime): return o.isoformat()
        return super(JSONEncoder, self).default(o)

def response(status, body, headers):
    return {
        'statusCode': status,
        'body': json.dumps(body, cls=JSONEncoder),
        'headers': headers
    }
