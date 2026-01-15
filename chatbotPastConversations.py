import requests
import json
from pymongo.mongo_client import MongoClient
from pymongo.server_api import ServerApi
import datetime
from pytz import timezone
import pymongo
from bson import ObjectId

def lambda_handler(event, context):
    try:
        user = event['user']
    except:
        user = ""

    try:
        conversation_id = event.get('conversation_id', "")
    except:
        conversation_id = ""

    uri = "mongodb+srv://kenneth:S8942769z@digimetrics.gns7b.mongodb.net/?retryWrites=true&w=majority&appName=digimetrics"
    client = MongoClient(uri)
    database = client["chatbot"]
    collection = database["conversations"]

    # --- Case 1: Fetch single conversation with full messages ---
    if conversation_id != "":
        conv = collection.find_one({"_id": ObjectId(conversation_id)})
        if conv:
            return {
                "id": str(conv['_id']),
                "user": conv['user'],
                "last_updated": str(conv['last_updated']),
                "title": conv['title'],
                "messages": conv['messages']
            }
        return {"error": "Conversation not found"}

    # --- Case 2: Fetch list of conversations (Optimized) ---
    raw = []
    output = []
    if user != "":
        results = collection.find({ "user" : user })
    else:
        results = collection.find()
    for document in results:
        raw.append(document)

    raw.reverse()

    for i in raw:
        # Get only the first user message for preview to keep payload small
        first_user_msg = next((m['content'] for m in i.get('messages', []) if m.get('role') == 'user'), "No messages yet")
        
        output.append({
            "id":str(i['_id']),
            'user':i['user'],
            'last_updated':str(i['last_updated']),
            'title':i['title'],
            'first_message': first_user_msg,
            # Full messages excluded for performance
        })

    return (output)