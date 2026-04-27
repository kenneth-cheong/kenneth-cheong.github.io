import json
import os
from datetime import datetime
import uuid
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
            client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
            client.admin.command('ping')
        except Exception as e:
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

        db = get_db()

        if action == 'save_conversation':
            return handle_save_conversation(db, data, headers)
        elif action == 'fetch_conversations':
            return handle_fetch_conversations(db, data, headers)
        elif action == 'get_conversation':
            return handle_get_conversation(db, data, headers)
        elif action == 'delete_conversation':
            return handle_delete_conversation(db, data, headers)
        else:
            return response(400, {"error": f"Unsupported action: {action}"}, headers)

    except Exception as e:
        print(f"Error: {str(e)}")
        return response(500, {"error": f"Internal Server Error: {str(e)}"}, headers)

def handle_save_conversation(db, data, headers):
    user_id = data.get('userId', 'global_user')
    conv_id = data.get('conversationId')
    
    if not conv_id:
        conv_id = str(uuid.uuid4())
    
    messages = data.get('messages', [])
    title = data.get('title')
    
    if not title and messages:
        # Generate a title from the first user message
        first_user_msg = next((m for m in messages if m.get('role') == 'user'), None)
        if first_user_msg:
            title = first_user_msg.get('content', '')[:50] + '...'
        else:
            title = "New Conversation"

    update_doc = {
        "conversationId": conv_id,
        "userId": user_id,
        "title": title or "Untitled",
        "messages": messages,
        "threadId": data.get('threadId'),
        "mode": data.get('mode'),
        "lastUpdated": datetime.utcnow()
    }
    
    db.conversations.update_one(
        {"conversationId": conv_id, "userId": user_id},
        {"$set": update_doc},
        upsert=True
    )
    
    return response(200, {"success": True, "conversationId": conv_id}, headers)

def handle_fetch_conversations(db, data, headers):
    user_id = data.get('userId', 'global_user')
    try:
        # Return only metadata for the list
        cursor = db.conversations.find(
            {"userId": user_id},
            {"conversationId": 1, "title": 1, "lastUpdated": 1, "mode": 1}
        ).sort("lastUpdated", -1)
        
        conversations = list(cursor)
        return response(200, {"conversations": conversations}, headers)
    except Exception as e:
        return response(500, {"error": str(e)}, headers)

def handle_get_conversation(db, data, headers):
    user_id = data.get('userId', 'global_user')
    conv_id = data.get('conversationId')
    
    if not conv_id:
        return response(400, {"error": "Missing conversationId"}, headers)
        
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
