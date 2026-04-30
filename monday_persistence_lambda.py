import json
import os
from datetime import datetime
from pymongo import MongoClient
import bson
from bson import ObjectId

# Environment Variables (Configure these in AWS Lambda)
# Fallback to hardcoded URI for development if env var is missing
MONGODB_URI = os.environ.get('MONGODB_URI')
MONGODB_DATABASE = 'monday_db'

# Global client to reuse connection
client = None

def get_db():
    global client
    if client is None:
        if not MONGODB_URI:
            raise Exception("MONGODB_URI environment variable not configured")
        try:
            client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
            # Verify connection
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
        # Support both direct Lambda calls and Lambda Proxy (API Gateway)
        body = event
        if 'body' in event and isinstance(event['body'], str):
            try:
                body = json.loads(event['body'])
            except:
                pass
        
        action = body.get('action')
        data = body.get('data', {})
        
        # In some cases, the payload might be double-wrapped or direct
        if not action and isinstance(body.get('body'), dict):
            body = body['body']
            action = body.get('action')
            data = body.get('data', {})

        if not action:
            return response(400, {"error": "Missing action"}, headers)

        db = get_db()

        # Route actions
        if action == 'fetch_boards':
            return handle_fetch_boards(db, data, headers)
        elif action == 'save_boards':
            return handle_save_boards(db, data, headers)
        else:
            return response(400, {"error": f"Unsupported action: {action}"}, headers)

    except Exception as e:
        print(f"Error: {str(e)}")
        return response(500, {"error": f"Internal Server Error: {str(e)}"}, headers)

# --- Handlers ---

def handle_fetch_boards(db, data, headers):
    user_id = data.get('userId', 'default_workspace')
    try:
        print(f"Fetching boards for user: {user_id}")
        user_data = db.boards.find_one({"userId": user_id})
        
        if not user_data:
            # Return empty boards if no user document exists
            return response(200, {"boards": [], "message": "No boards found"}, headers)
            
        return response(200, {
            "boards": user_data.get('boards', [])
        }, headers)
    except Exception as e:
        print(f"Error in handle_fetch_boards: {str(e)}")
        return response(500, {"error": str(e)}, headers)

def handle_save_boards(db, data, headers):
    user_id = data.get('userId', 'default_workspace')
    if not user_id:
        return response(400, {"error": "Missing userId"}, headers)
        
    try:
        # Prepare document for upsert
        update_doc = {
            "userId": user_id,
            "boards": data.get('boards', []),
            "lastUpdated": datetime.utcnow()
        }
        
        db.boards.update_one(
            {"userId": user_id},
            {"$set": update_doc},
            upsert=True
        )
        
        return response(200, {"success": True, "message": "Boards saved successfully"}, headers)
    except Exception as e:
        print(f"Error in handle_save_boards: {str(e)}")
        return response(500, {"error": str(e)}, headers)

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
