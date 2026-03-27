import json
import boto3
import os

def lambda_handler(event, context):
    """
    Lambda function to filter personas from s3://digimetricsfileupload/nemotron_personas_singapore.json
    using S3 Select for high performance on large files.
    """
    # Handle Lambda Proxy Integration (event['body'] is a string)
    if 'body' in event and event['body']:
        try:
            payload = json.loads(event['body'])
            filters = payload.get('filters', [])
            limit = payload.get('limit', 20)
        except:
            filters = []
            limit = 20
    else:
        filters = event.get('filters', [])
        limit = event.get('limit', 20)
    
    headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
        'Content-Type': 'application/json'
    }
    
    bucket = 'digimetricsfileupload'
    key = 'nemotron_personas_singapore.jsonl'
    
    s3 = boto3.client('s3')
    
    try:
        # Get streaming response
        response = s3.get_object(Bucket=bucket, Key=key)
        body = response['Body']
        
        results = []
        total_matches = 0
        total_records = 0
        partial_line = ""
        
        # Stream the file in chunks to avoid memory issues
        for chunk in body.iter_chunks(chunk_size=1024 * 1024): # 1MB chunks
            text = chunk.decode('utf-8', errors='ignore')
            lines = (partial_line + text).split('\n')
            partial_line = lines.pop() # Keep the last (potentially incomplete) line
            
            for line in lines:
                if not line.strip(): continue
                
                total_records += 1
                
                # Fast string-based pre-filter if we have filters
                match = True
                low_line = line.lower()
                for f in filters:
                    val = str(f.get('value', '')).lower()
                    if val and val not in low_line:
                        match = False
                        break
                
                if match:
                    try:
                        record = json.loads(line)
                        # Perform more precise filtering after parsing
                        precise_match = True
                        for f in filters:
                            field = f.get('field')
                            op = f.get('op', '=')
                            val = f.get('value')
                            
                            if not field or val is None: continue
                            
                            if field == 'any':
                                str_val = str(val).lower()
                                field_match = False
                                for k, v in record.items():
                                    if str_val in str(v).lower():
                                        field_match = True
                                        break
                                if not field_match:
                                    precise_match = False
                                    break
                            else:
                                rec_val = record.get(field)
                                if rec_val is None:
                                    precise_match = False
                                    break
                                
                                # Simple logic for common cases
                                str_rec_val = str(rec_val).lower()
                                str_val = str(val).lower()
                                
                                if op == '=' and str_rec_val != str_val:
                                    precise_match = False
                                elif op == 'contains' and str_val not in str_rec_val:
                                    precise_match = False
                                elif op == '>' or op == '<':
                                    try:
                                        num_rec = float(rec_val)
                                        num_val = float(val)
                                        if op == '>' and not (num_rec > num_val): precise_match = False
                                        if op == '<' and not (num_rec < num_val): precise_match = False
                                    except: precise_match = False
                            
                            if not precise_match: break
                            
                        if precise_match:
                            total_matches += 1
                            if len(results) < limit:
                                results.append(record)
                    except: continue
                
        return {
            'statusCode': 200,
            'headers': headers,
            'body': json.dumps({
                'data': results,
                'total_matches': total_matches,
                'total_records': total_records
            })
        }
        
    except Exception as e:
        print(f"Error streaming from S3: {str(e)}")
        return {
            'statusCode': 500,
            'headers': headers,
            'body': json.dumps({'error': str(e)})
        }
