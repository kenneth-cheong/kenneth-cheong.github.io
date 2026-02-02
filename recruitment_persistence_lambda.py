import json
import os
from datetime import datetime
from pymongo import MongoClient
import bson
from bson import ObjectId

# Environment Variables (Configure these in AWS Lambda)
MONGODB_URI = os.environ.get('MONGODB_URI') # e.g. mongodb+srv://user:pass@cluster.mongodb.net/
MONGODB_DATABASE = os.environ.get('MONGODB_DATABASE', 'recruitment')

# Global client to reuse connection across warm Lambda invocations
client = None

def get_db():
    global client
    if client is None:
        client = MongoClient(MONGODB_URI)
    return client[MONGODB_DATABASE]

def lambda_handler(event, context):
    # Enable CORS
    headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    }

    if event.get('httpMethod') == 'OPTIONS':
        return {'statusCode': 200, 'headers': headers}

    try:
        # Support both Proxy and direct invocations
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
            return response(400, f"Missing action in request body. Payload: {json.dumps(body)}", headers)

        db = get_db()

        if action == 'get_jobs':
            return handle_get_jobs(db, headers)
        elif action == 'upsert_job':
            return handle_upsert_job(db, data, current_user, headers)
        elif action == 'delete_job':
            return handle_delete_job(db, data.get('id'), current_user, headers)
        elif action == 'restore_job':
            return handle_restore_job(db, data.get('id'), current_user, headers)
        elif action == 'get_candidates':
            return handle_get_candidates(db, data, headers)
        elif action == 'get_candidate_detail' or action == 'get_candidate_details':
            return handle_get_candidate_detail(db, data.get('id'), headers)
        elif action == 'get_dashboard_stats' or action == 'get_candidates_summary':
            return handle_get_dashboard_stats(db, headers)
        elif action == 'add_candidate':
            return handle_add_candidate(db, data, current_user, headers)
        elif action == 'upsert_candidate':
            return handle_upsert_candidate(db, data, current_user, headers)
        elif action == 'delete_candidate':
            return handle_delete_candidate(db, data.get('id'), current_user, headers)
        elif action == 'restore_candidate':
            return handle_restore_candidate(db, data.get('id'), current_user, headers)
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

# --- Helper Functions ---

class JSONEncoder(json.JSONEncoder):
    def default(self, o):
        if isinstance(o, ObjectId):
            return str(o)
        if isinstance(o, datetime):
            return o.isoformat()
        return super(JSONEncoder, self).default(o)

def response(status, body, headers):
    return {
        'statusCode': status,
        'body': json.dumps(body, cls=JSONEncoder),
        'headers': headers
    }

def log_audit(db, action, target_type, target_id, user, details=""):
    try:
        db.audit_logs.insert_one({
            "action": action,
            "targetType": target_type,
            "targetId": str(target_id),
            "user": user,
            "timestamp": datetime.utcnow(),
            "details": details
        })
    except Exception as e:
        print(f"Log Error: {str(e)}")

# --- Handlers ---

def handle_get_jobs(db, headers):
    jobs = list(db.jobs.find({"deleted": {"$ne": True}}))
    for job in jobs:
        jid = job.get('id')
        if jid:
            # Efficiently counting without loading documents
            job['applicants'] = db.candidates.count_documents({"jobId": jid, "deleted": {"$ne": True}})
            job['shortlisted'] = db.candidates.count_documents({"jobId": jid, "status": "Shortlisted", "deleted": {"$ne": True}})
    return response(200, jobs, headers)

def handle_upsert_job(db, job_data, user, headers):
    job_id = job_data.get('id')
    if job_id:
        db.jobs.update_one({"id": job_id}, {"$set": job_data}, upsert=True)
        log_audit(db, "update", "job", job_id, user, f"Updated job: {job_data.get('title')}")
    else:
        job_id = str(datetime.utcnow().timestamp())
        job_data['id'] = job_id
        job_data['deleted'] = False
        db.jobs.insert_one(job_data)
        log_audit(db, "create", "job", job_id, user, f"Created job: {job_data.get('title')}")
    return response(200, {"success": True, "job": job_data}, headers)

def handle_delete_job(db, job_id, user, headers):
    db.jobs.update_one({"id": job_id}, {"$set": {"deleted": True}})
    log_audit(db, "soft_delete", "job", job_id, user, f"Job soft-deleted ID: {job_id}")
    return response(200, {"success": True}, headers)

def handle_restore_job(db, job_id, user, headers):
    db.jobs.update_one({"id": job_id}, {"$set": {"deleted": False}})
    log_audit(db, "restore", "job", job_id, user, f"Job restored ID: {job_id}")
    return response(200, {"success": True}, headers)

def handle_get_candidates(db, data, headers):
    job_id = data.get('jobId')
    
    # Support both page/limit and skip/limit
    limit = int(data.get('limit', 20))
    if 'skip' in data:
        skip = int(data.get('skip', 0))
        page = (skip // limit) + 1 if limit > 0 else 1
    else:
        page = int(data.get('page', 1))
        skip = (page - 1) * limit
    
    query = {"deleted": {"$ne": True}}
    if job_id:
        query["jobId"] = str(job_id)
    
    # Optimization: Exclude heavy fields from list view
    projection = {
        "fullText": 0,
        "cvData": 0,
        "cvBinary": 0,
        "cvDataBase64": 0,
        "cvTextContent": 0,
        "summary": 0,
        "reasons": 0,
        "interviewGuide": 0,
        "hopperDetails": 0
    }
    
    total = db.candidates.count_documents(query)
    # Using allow_disk_use=True for large sorts
    candidates = list(db.candidates.find(query, projection, allow_disk_use=True).sort("createdAt", -1).skip(skip).limit(limit))
    
    return response(200, {
        "candidates": candidates,
        "total": total,
        "page": page,
        "limit": limit
    }, headers)

def handle_get_candidate_detail(db, cand_id, headers):
    if not cand_id:
        return response(400, "Missing candidate ID", headers)
    candidate = db.candidates.find_one({"id": str(cand_id)})
    if candidate:
        return response(200, candidate, headers)
    else:
        return response(404, {"error": "Candidate not found"}, headers)

def handle_get_dashboard_stats(db, headers):
    # Overall counts for dashboard without fetching details
    total_active = db.candidates.count_documents({"deleted": {"$ne": True}})
    high_quality = db.candidates.count_documents({"deleted": {"$ne": True}, "aiScore": {"$gt": 80}})
    total_jobs = db.jobs.count_documents({"deleted": {"$ne": True}})
    
    return response(200, {
        "totalActive": total_active,
        "highQuality": high_quality,
        "highQualityLeads": high_quality, # Alias for compatibility
        "totalApplicants": total_active,  # Alias for compatibility
        "totalJobs": total_jobs
    }, headers)

def handle_add_candidate(db, cand_data, user, headers):
    cand_id = str(datetime.utcnow().timestamp())
    cand_data['id'] = cand_id
    cand_data['deleted'] = False
    cand_data['createdAt'] = datetime.utcnow()
    db.candidates.insert_one(cand_data)
    log_audit(db, "add", "candidate", cand_id, user, f"Added candidate: {cand_data.get('name')}")
    return response(200, {"success": True, "candidate": cand_data}, headers)

def handle_delete_candidate(db, cand_id, user, headers):
    db.candidates.update_one({"id": cand_id}, {"$set": {"deleted": True}})
    log_audit(db, "soft_delete", "candidate", cand_id, user, f"Candidate soft-deleted ID: {cand_id}")
    return response(200, {"success": True}, headers)

def handle_restore_candidate(db, cand_id, user, headers):
    db.candidates.update_one({"id": cand_id}, {"$set": {"deleted": False}})
    log_audit(db, "restore", "candidate", cand_id, user, f"Candidate restored ID: {cand_id}")
    return response(200, {"success": True}, headers)

def handle_upsert_candidate(db, cand_data, user, headers):
    cand_id = cand_data.get('id')
    if cand_id:
        if '_id' in cand_data: del cand_data['_id']
        db.candidates.update_one({"id": cand_id}, {"$set": cand_data}, upsert=True)
        log_audit(db, "update", "candidate", cand_id, user, f"Updated candidate: {cand_data.get('name')}")
    else:
        return handle_add_candidate(db, cand_data, user, headers)
    return response(200, {"success": True}, headers)

def handle_get_users(db, headers):
    users = list(db.users.find({}))
    return response(200, users, headers)

def handle_upsert_user(db, user_data, current_user, headers):
    uid = user_data.get('id')
    if '_id' in user_data:
        del user_data['_id']
    if uid:
        db.users.update_one({"id": uid}, {"$set": user_data}, upsert=True)
        log_audit(db, "update", "user", uid, current_user, f"Updated user: {user_data.get('name')}")
    else:
        uid = str(datetime.utcnow().timestamp())
        user_data['id'] = uid
        db.users.insert_one(user_data)
        log_audit(db, "create", "user", uid, current_user, f"Created user: {user_data.get('name')}")
    return response(200, {"success": True}, headers)

def handle_delete_user(db, user_data, current_user, headers):
    uid = user_data.get('id')
    db.users.delete_one({"id": uid})
    log_audit(db, "delete", "user", uid, current_user, f"Deleted user ID: {uid}")
    return response(200, {"success": True}, headers)

def handle_get_audit_logs(db, headers):
    logs = list(db.audit_logs.find({}).sort("timestamp", -1).limit(100))
    return response(200, logs, headers)
