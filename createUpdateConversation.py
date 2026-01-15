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
        conversation_id = event['conversation_id']
    except:
        conversation_id = ""
    try:
        messages = event['messages']
    except:
        messages = []

    uri = "mongodb+srv://kenneth:S8942769z@digimetrics.gns7b.mongodb.net/?retryWrites=true&w=majority&appName=digimetrics"
    client = MongoClient(uri)
    database = client["chatbot"]
    collection = database["conversations"]

    # Use Asia/Singapore timezone directly
    pacific = timezone("Asia/Singapore")
    local_datetime = datetime.datetime.now(pacific)  # Correct way to get current time in timezone

    # Add 8 hours to local_datetime
    local_datetime_plus_8 = local_datetime + datetime.timedelta(hours=8)

    if conversation_id != "":
        collection.update_one({"_id": ObjectId(conversation_id)}, { "$set" : {"messages":messages,"last_updated":local_datetime_plus_8}})

    elif conversation_id == "":
        result = collection.insert_one({
            "user": user,
            "last_updated": local_datetime_plus_8,
            "title": event['title'],
            "messages": messages
        })

        print(result.acknowledged)

        print(str(result.inserted_id))

        return(str(result.inserted_id))
