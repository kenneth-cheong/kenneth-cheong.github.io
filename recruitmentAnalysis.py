import json
import os
import requests
import base64

def lambda_handler(event, context):
    try:
        # Get data from event
        cv_text = event.get('cv_text', '')
        image_base64 = event.get('image_base64', '')
        image_ext = event.get('image_ext', 'png')
        job_desc = event.get('job_desc', '')
        job_kpi = event.get('job_kpi', '')
        
        evaluation_criteria = event.get('evaluation_criteria', [])
        
        # Format weights/criteria for the prompt
        if evaluation_criteria:
            criteria_section = "EVALUATION CRITERIA & WEIGHTS:\n"
            for c in evaluation_criteria:
                criteria_section += f"- {c.get('text', 'N/A')}: {c.get('weight', 0)}%\n"
        else:
            weights = event.get('weights', {'exp': 25, 'skills': 25, 'resp': 25, 'kpi': 25})
            criteria_section = f"WEIGHTS: Experience: {weights.get('exp') or 25}%, Skills: {weights.get('skills') or 25}%, Resp Fit: {weights.get('resp') or 25}%, KPI Fit: {weights.get('kpi') or 25}%"
        
        api_key = event.get('api_key') or os.environ.get('OPENAI_API_KEY')
        if not api_key:
            return {
                'statusCode': 401,
                'headers': cors_headers(),
                'body': json.dumps({'error': 'OpenAI API Key not provided in payload or environment'})
            }

        # Construct the prompt
        prompt = f"""
        You are an expert HR recruiter. YOUR PRIMARY GOAL is to extract the candidate's real full name from the CV text or image provided.
        
        Analyze the following CV against the specified Job Description and Evaluation Criteria.
        
        JOB DESCRIPTION:
        {job_desc}
        
        RESPONSIBILITIES & KPIs:
        {job_kpi}
        
        {criteria_section}
        
        JOB HOPPER RULE:
        Flag as "job hopper" if the candidate has at least 3 positions in the recent period (last 5-7 years) where tenure was less than 12 months.
        
        SCORING INSTRUCTIONS:
        Calculate the final 'score' (0-100) based strictly on the EVALUATION CRITERIA weights provided above.
        Each criterion should be scored 0-100, then multiplied by its percentage weight to form the total.
        
        Return ONLY a valid JSON object with the following structure:
        {{
            "name": "FULL NAME EXTRACTED FROM CV (DO NOT USE HOLDER TEXT)",
            "email": "CANDIDATE EMAIL ADDRESS",
            "phone": "CANDIDATE PHONE NUMBER",
            "score": 0-100,
            "breakdown": {{
                "Criterion Name 1": 0-100,
                "Criterion Name 2": 0-100
            }},
            "summary": "Short 2-3 sentence overview highlighting how they fit the specific criteria listed.",
            "reasons": ["Top reason 1", "Top reason 2", "Top reason 3", "Top reason 4", "Top reason 5"],
            "job_hopper": true/false,
            "hopper_details": "Explain tenure pattern if flagged (e.g., '3 roles under 1 year since 2021')"
        }}
        Note: The keys in "breakdown" MUST match the 1-3 word summaries or names of the EVALUATION CRITERIA provided above.
        """

        messages = []
        if image_base64:
            messages = [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:image/{image_ext};base64,{image_base64}"}
                        }
                    ]
                }
            ]
        else:
            messages = [
                {
                    "role": "user",
                    "content": prompt + "\n\nCV TEXT:\n" + cv_text
                }
            ]

        # Call OpenAI
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }
        
        payload = {
            "model": "gpt-4o-mini",
            "messages": messages,
            "response_format": {"type": "json_object"}
        }

        response = requests.post(
            "https://api.openai.com/v1/chat/completions",
            headers=headers,
            json=payload
        )

        resp_json = response.json()
        if 'error' in resp_json:
            return {
                'statusCode': 400,
                'headers': cors_headers(),
                'body': json.dumps({'error': resp_json['error']['message']})
            }

        analysis = json.loads(resp_json['choices'][0]['message']['content'])

        return (analysis)

    except Exception as e:
        return {
            'statusCode': 500,
            'headers': cors_headers(),
            'body': json.dumps({'error': str(e)})
        }

def cors_headers():
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'OPTIONS,POST'
    }
