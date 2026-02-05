import json
import os
from datetime import datetime
from pymongo import MongoClient
import bson
from bson import ObjectId

# Environment Variables (Configure these in AWS Lambda)
MONGODB_URI = os.environ.get('MONGODB_URI')
MONGODB_DATABASE = 'backlinks_db'

# Global client to reuse connection
client = None

def get_db():
    global client
    if client is None:
        client = MongoClient(MONGODB_URI)
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
        current_user = body.get('currentUser', 'System')

        if not action:
            return response(400, "Missing action", headers)

        db = get_db()

        # Route actions
        if action == 'get_campaigns':
            return handle_get_campaigns(db, headers)
        elif action == 'upsert_campaign':
            return handle_upsert_campaign(db, data, current_user, headers)
        elif action == 'get_backlinks':
            return handle_get_backlinks(db, data, headers)
        elif action == 'upsert_backlink':
            return handle_upsert_backlink(db, data, current_user, headers)
        elif action == 'get_users':
            return handle_get_users(db, headers)
        elif action == 'upsert_user':
            return handle_upsert_user(db, data, current_user, headers)
        elif action == 'delete_user':
            return handle_delete_user(db, data, current_user, headers)
        elif action == 'get_audit_logs':
            return handle_get_audit_logs(db, headers)
        else:
            return response(400, f"Unknown action: {action}", headers)

    except Exception as e:
        print(f"Error: {str(e)}")
        return response(500, f"Internal Server Error: {str(e)}", headers)

# --- Handlers ---

def handle_get_campaigns(db, headers):
    campaigns = list(db.campaigns.find({"deleted": {"$ne": True}}))
    return response(200, campaigns, headers)

def handle_upsert_campaign(db, data, user, headers):
    cid = data.get('id')
    if cid:
        db.campaigns.update_one({"id": cid}, {"$set": data}, upsert=True)
    else:
        cid = str(datetime.utcnow().timestamp())
        data['id'] = cid
        data['createdAt'] = datetime.utcnow()
        db.campaigns.insert_one(data)
    return response(200, {"success": True, "campaign": data}, headers)

def handle_get_backlinks(db, data, headers):
    query = {"deleted": {"$ne": True}}
    if data.get('campaignId'):
        query['campaignId'] = data['campaignId']
    if data.get('vendorId'):
        query['vendorId'] = data['vendorId']
    
    backlinks = list(db.backlinks.find(query).sort("createdAt", -1))
    return response(200, backlinks, headers)

def handle_upsert_backlink(db, data, user, headers):
    bid = data.get('id')
    if bid:
        db.backlinks.update_one({"id": bid}, {"$set": data}, upsert=True)
    else:
        bid = str(datetime.utcnow().timestamp())
        data['id'] = bid
        data['createdAt'] = datetime.utcnow()
        db.backlinks.insert_one(data)
    return response(200, {"success": True, "backlink": data}, headers)

def handle_get_users(db, headers):
    users = list(db.users.find({}))
    return response(200, users, headers)

def handle_upsert_user(db, data, current_user, headers):
    uid = data.get('id')
    if uid:
        db.users.update_one({"id": uid}, {"$set": data}, upsert=True)
    else:
        uid = str(datetime.utcnow().timestamp())
        data['id'] = uid
        db.users.insert_one(data)
    return response(200, {"success": True}, headers)

def handle_delete_user(db, data, current_user, headers):
    uid = data.get('id')
    db.users.delete_one({"id": uid})
    return response(200, {"success": True}, headers)

def handle_get_audit_logs(db, headers):
    logs = list(db.audit_logs.find({}).sort("timestamp", -1).limit(100))
    return response(200, logs, headers)

# --- Helpers ---

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
