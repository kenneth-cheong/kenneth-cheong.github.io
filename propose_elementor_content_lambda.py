import json
import requests
import os
import time
import re
import ast

def lambda_handler(event, context):

    gpt_key = os.environ['GPT_KEY']

    # Access 'strings' directly as it's already a list
    strings = event['strings']

    num_strings = len(strings)

    print(num_strings)

    company_name = event['company_name']

    additional_instructions = event['instructions']

    input_messages = [
        {
            "role": "system",
            "content":
            f'''
            You are an SEO-trained website developer replacing the webpage template visible text to suit the use case of the client. 
            Step 1: Find out what you can about {company_name} from the internet.
            Step 2: Change the list of strings into the recommended text for the webpage. 

            Here are the additional instructions: {additional_instructions}.

            You MUST return a Python list containing EXACTLY {num_strings} strings. The number of strings in the output list MUST match the number of strings in the input list.
            If no changes are required for a specific string, return the same string in the output list.
            Don't add any additional labelling like numbers.
            Preserve any <br> tags.
            Use British spelling unless otherwise instructed.
            '''
        },
        {"role": "user", "content": str(strings)}
    ]


    # DeepSeek if requested (OpenAI-compatible), else OpenAI/GPT (default → switch-back).
    provider = (event.get('provider') or '').lower()
    if provider == 'deepseek':
        data = {"model": "deepseek-chat", "messages": input_messages}
        url = "https://api.deepseek.com/chat/completions"
        headers = {
            "Authorization": f"Bearer {os.environ.get('DEEPSEEK_API_KEY', '')}",
            "Content-Type": "application/json"
        }
    else:
        data = {"model": "gpt-4o-mini", "messages": input_messages}
        url = "https://api.openai.com/v1/chat/completions"
        headers = {
            "Authorization": gpt_key,
            "Content-Type": "application/json"
        }

    response = requests.post(url, headers=headers, json=data)
    print(response.json())

    try: # added try except block for error handling
        output = response.json()['choices'][0]['message']['content'] #New API retrieval path

        #output = response.json()['output'][0]['content'][0]['text'].replace('\n','').replace('```','').replace('python','') # old

        print(output)
        cleaned_output = output.replace('\n', '').replace('```', '').replace('python', '')  # Clean output

        print(len(ast.literal_eval(cleaned_output)))

        return ast.literal_eval(cleaned_output) # convert to python output

    except (KeyError, ValueError) as e:
        print(f"Error processing response: {e}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e), 'full_response': response.json()})
        }