import json
import os
from datetime import datetime
from pymongo import MongoClient
import bson
from bson import ObjectId

# Environment Variables (Configure these in AWS Lambda)
# Fallback to hardcoded URI for development if env var is missing
MONGODB_URI = os.environ.get('MONGODB_URI')
MONGODB_DATABASE = 'tender_ai_db'

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
        if action == 'fetch_projects':
            return handle_fetch_projects(db, data, headers)
        elif action == 'save_projects':
            return handle_save_projects(db, data, headers)
        elif action == 'fetch_all_projects':
            return handle_fetch_all_projects(db, data, headers)
        else:
            return response(400, {"error": f"Unsupported action: {action}"}, headers)

    except Exception as e:
        print(f"Error: {str(e)}")
        return response(500, {"error": f"Internal Server Error: {str(e)}"}, headers)

# --- Handlers ---

def handle_fetch_projects(db, data, headers):
    user_id = data.get('userId', 'mediaone_global_workspace')
    try:
        print(f"Fetching projects for user: {user_id}")
        user_data = db.projects.find_one({"userId": user_id})
        
        if not user_data:
            return response(200, {"projects": [], "message": "No projects found"}, headers)
            
        return response(200, {
            "projects": user_data.get('projects', []),
            "globalTeam": user_data.get('globalTeam', []),
            "globalThemes": user_data.get('globalThemes', []),
            "proofBank": user_data.get('proofBank', []),
            "aiAgents": user_data.get('aiAgents', []),
            "globalSubmissions": user_data.get('globalSubmissions', [])
        }, headers)
    except Exception as e:
        print(f"Error in handle_fetch_projects: {str(e)}")
        return response(500, {"error": str(e)}, headers)

def handle_fetch_all_projects(db, data, headers):
    requester_id = data.get('userId', '')
    try:
        print(f"Fetching all projects for org view (requester: {requester_id})")
        all_docs = list(db.projects.find({}))
        team_projects = []
        for doc in all_docs:
            owner_id = doc.get('userId', 'unknown')
            if owner_id == requester_id:
                continue  # skip own projects, already loaded
            for p in doc.get('projects', []):
                p_copy = dict(p)
                p_copy['_ownerId'] = owner_id
                team_projects.append(p_copy)
        return response(200, {"teamProjects": team_projects}, headers)
    except Exception as e:
        print(f"Error in handle_fetch_all_projects: {str(e)}")
        return response(500, {"error": str(e)}, headers)

def handle_save_projects(db, data, headers):
    user_id = data.get('userId', 'mediaone_global_workspace')
    if not user_id:
        return response(400, {"error": "Missing userId"}, headers)
        
    try:
        # Prepare document for upsert
        update_doc = {
            "userId": user_id,
            "projects": data.get('projects', []),
            "globalTeam": data.get('globalTeam', []),
            "globalThemes": data.get('globalThemes', []),
            "proofBank": data.get('proofBank', []),
            "aiAgents": data.get('aiAgents', []),
            "globalSubmissions": data.get('globalSubmissions', []),
            "lastUpdated": datetime.utcnow()
        }
        
        db.projects.update_one(
            {"userId": user_id},
            {"$set": update_doc},
            upsert=True
        )
        
        return response(200, {"success": True, "message": "Projects saved successfully"}, headers)
    except Exception as e:
        print(f"Error in handle_save_projects: {str(e)}")
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
