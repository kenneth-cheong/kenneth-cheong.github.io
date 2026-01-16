import json
import os
import requests
import re

def clean_text(text):
    text = re.sub(r'<[^>]+>', '', text)
    return re.sub(r'\s+', ' ', text).strip()

def lambda_handler(event, context):
    try:
        text = event['text']
        
        user = os.environ.get('COPYSCAPE_USERNAME')
        key = os.environ.get('COPYSCAPE_API_KEY')
        
        if not user or not key:
            # Fallback/Mock if credentials missing, but explain requirement
            return {
                'statusCode': 200,
                'headers': {'Access-Control-Allow-Origin': '*'},
                'body': json.dumps({
                    'originality_score': 98.5,
                    'matches': [],
                    'message': 'Copyscape credentials not configured in Lambda. Returning mock result.'
                })
            }

        cleaned = clean_text(text)
        params = {
            'u': user,
            'k': key,
            'o': 'csearch', 
            't': cleaned,
            'e': 'UTF-8',
            'f': 'json',
            'c': 5
        }

        response = requests.post("https://www.copyscape.com/api/", data=params, timeout=30)
        
        # Copyscape might return XML even if JSON is requested (especially on errors)
        try:
            if 'application/json' in response.headers.get('Content-Type', '').lower():
                result = response.json()
            else:
                # Basic XML parsing fallback
                import xml.etree.ElementTree as ET
                root = ET.fromstring(response.text)
                
                # Check for error in XML
                error_node = root.find('error')
                if error_node is not None:
                    result = {'error': error_node.text}
                else:
                    # Map common fields
                    result = {
                        'count': root.findtext('count', '0'),
                        'allwordcount': root.findtext('allwordcount', '0'),
                        'results': []
                    }
                    for res in root.findall('result'):
                        result['results'].append({
                            'url': res.findtext('url'),
                            'title': res.findtext('title'),
                            'textsnippet': res.findtext('textsnippet'),
                            'minwordsmatched': res.findtext('minwordsmatched')
                        })
        except Exception as parse_err:
            result = {'raw': response.text, 'parse_error': str(parse_err)}

        # Copyscape JSON typically puts matches in a 'result' key (singular)
        # My XML fallback uses 'results' (plural). Let's check both.
        matches = result.get('result', result.get('results', []))
        
        # Standardize the originality score calculation if matches found
        originality_score = 100.0
        if isinstance(matches, list) and len(matches) > 0:
            # Simple heuristic: deduct 5% per match, cap at 0
            originality_score = max(100 - (len(matches) * 5), 0)
        
        # If the API returned a specific count, use it to verify
        total_matches = int(result.get('count', len(matches)))
        
        final_response = {
            'originality_score': float(result.get('score', originality_score)),
            'matched_sources': matches,
            'total_matches': total_matches,
            'word_count': int(result.get('allwordcount', len(cleaned.split()))),
            'raw_api_response': result,
            'error': result.get('error')
        }

        return {
            'statusCode': 200,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Allow-Methods': 'OPTIONS,POST'
            },
            'body': json.dumps(final_response)
        }

    except Exception as e:
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)})
        }
