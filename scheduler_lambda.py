import json
import boto3
import os
from datetime import datetime

# Initialize AWS clients
lambda_client = boto3.client('lambda')
scheduler_client = boto3.client('scheduler')
events_client = boto3.client('events')

def lambda_handler(event, context):
    print("Event:", json.dumps(event))
    
    # Support API Gateway Proxy Integration
    path = event.get('path', '')
    http_method = event.get('httpMethod', '')
    
    # Set up CORS headers so your frontend can call this Lambda
    headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type,Authorization,x-api-key",
        "Access-Control-Allow-Methods": "OPTIONS,POST,GET"
    }
    
    if http_method == 'OPTIONS':
        return {"statusCode": 200, "headers": headers, "body": ""}
        
    # Parse body for action
    # If using Lambda Proxy Integration, body is a string inside event['body']
    # If not, the frontend JSON payload might be passed directly as the event dictionary
    if 'action' in event:
        body = event
    else:
        body_str = event.get('body', '{}')
        if not body_str: body_str = '{}'
        try:
            body = json.loads(body_str)
        except Exception:
            body = {}
        
    action = body.get('action')
        
    try:
        if action == 'list_lambdas':
            return get_lambdas(headers)
            
        elif action == 'get_lambda_detail':
            function_name = body.get('functionName')
            if not function_name:
                return {"statusCode": 400, "headers": headers, "body": json.dumps({"error": "functionName is required"})}
            return get_lambda_detail(function_name, headers)
            
        # TODO: Implement 'create_lambda', 'create_schedule', etc.
        
        return {"statusCode": 404, "headers": headers, "body": json.dumps({"error": f"Action '{action}' not supported yet"})}
        
    except Exception as e:
        print("Error:", str(e))
        return {
            "statusCode": 500,
            "headers": headers,
            "body": json.dumps({"error": str(e)})
        }

def get_lambdas(headers):
    # Fetch all lambda functions using pagination
    paginator = lambda_client.get_paginator('list_functions')
    functions = []
    
    for page in paginator.paginate():
        for fn in page['Functions']:
            functions.append({
                "functionName": fn['FunctionName'],
                "functionArn": fn['FunctionArn'],
                "runtime": fn.get('Runtime', 'Unknown'),
                "region": boto3.session.Session().region_name or "us-east-1",
                "handler": fn['Handler'],
                "roleArn": fn['Role'],
                "timeout": fn['Timeout'],
                "memorySize": fn['MemorySize'],
                "lastModified": fn['LastModified'],
                "description": fn.get('Description', ''),
                "hasSchedule": False,
                "scheduleCount": 0,
                "scheduleSources": [],
                "status": "Active" # Assuming active if listed
            })
            
    # Fetch schedules from EventBridge Scheduler to correlate with Lambdas
    schedules_paginator = scheduler_client.get_paginator('list_schedules')
    try:
        for page in schedules_paginator.paginate():
            for sch in page['Schedules']:
                target = sch.get('Target', {})
                arn = target.get('Arn', '')
                
                # Link schedule to the corresponding Lambda function
                for f in functions:
                    if f['functionArn'] in arn or arn.endswith(':' + f['functionName']):
                        f['hasSchedule'] = True
                        f['scheduleCount'] += 1
                        if 'EventBridge Scheduler' not in f['scheduleSources']:
                            f['scheduleSources'].append('EventBridge Scheduler')
    except Exception as e:
        print("Could not list EventBridge schedules:", str(e))
                        
    return {
        "statusCode": 200,
        "headers": headers,
        "body": json.dumps(functions, default=str)
    }

def get_lambda_detail(function_name, headers):
    # Fetch Lambda configuration
    resp = lambda_client.get_function(FunctionName=function_name)
    fn = resp['Configuration']
    tags = resp.get('Tags', {})
    
    # Try to extract the source code from the deployment package
    code_url = resp.get('Code', {}).get('Location')
    code_content = None
    if code_url:
        try:
            import urllib.request
            import zipfile
            from io import BytesIO
            
            req = urllib.request.urlopen(code_url)
            zip_ref = zipfile.ZipFile(BytesIO(req.read()))
            
            handler = fn.get('Handler', '')
            main_file = ''
            if '.' in handler:
                main_file_stem = handler.split('.')[0]
                for f in zip_ref.namelist():
                    if f.startswith(main_file_stem + '.') and '/' not in f:
                        main_file = f
                        break
            
            if main_file:
                code_content = zip_ref.read(main_file).decode('utf-8')
            elif len(zip_ref.namelist()) > 0:
                code_content = zip_ref.read(zip_ref.namelist()[0]).decode('utf-8')
        except Exception as e:
            code_content = f"// Could not extract source code: {str(e)}"
    
    detail = {
        "functionName": fn['FunctionName'],
        "functionArn": fn['FunctionArn'],
        "runtime": fn.get('Runtime', 'Unknown'),
        "region": boto3.session.Session().region_name or "us-east-1",
        "handler": fn['Handler'],
        "roleArn": fn['Role'],
        "timeout": fn['Timeout'],
        "memorySize": fn['MemorySize'],
        "lastModified": fn['LastModified'],
        "description": fn.get('Description', ''),
        "tags": tags,
        "code": code_content,
        "schedules": []
    }
    
    # Find EventBridge Schedules targeting this specific Lambda
    schedules_paginator = scheduler_client.get_paginator('list_schedules')
    for page in schedules_paginator.paginate():
        for sch in page['Schedules']:
            target_arn = sch.get('Target', {}).get('Arn', '')
            if target_arn == detail['functionArn'] or target_arn.endswith(':' + function_name):
                # Fetch full schedule for details (payload, timezone)
                sch_detail = scheduler_client.get_schedule(Name=sch['Name'], GroupName=sch.get('GroupName', 'default'))
                
                expr = sch_detail['ScheduleExpression']
                expr_type = "cron" if "cron" in expr else ("rate" if "rate" in expr else "at")
                
                detail['schedules'].append({
                    "scheduleName": sch_detail['Name'],
                    "source": "EventBridge Scheduler",
                    "expressionType": expr_type,
                    "expression": expr,
                    "timezone": sch_detail.get('ScheduleExpressionTimezone', 'UTC'),
                    "state": sch_detail['State'],
                    "nextRun": "-", 
                    "payload": sch_detail['Target'].get('Input', '{}'),
                    "lastUpdated": sch_detail.get('LastModificationDate', sch_detail.get('CreationDate'))
                })
                
    return {
        "statusCode": 200,
        "headers": headers,
        "body": json.dumps(detail, default=str)
    }
