import json
import requests
import time
import os
import re
import urllib.request
from bs4 import BeautifulSoup
from urllib.error import HTTPError

def lambda_handler(event, context):
    target = event['url']
    if 'https://' not in target and 'http://' not in target:
        target = 'https://'+target
    keyword = event['keyword']
    gpt_key = os.environ['GPT_KEY']
    gpt_url = "https://api.openai.com/v1/chat/completions"
    output = {}

    try:
           
        url = "https://api.dataforseo.com/v3/on_page/content_parsing/live"
        payload=[{"url": target,
                "enable_javascript":True,
                "enable_browser_rendering":True}]
        headers = {
            'Authorization': 'Basic c3ViQG1lZGlhb25lLmNvOjliZGZkNDBjNzRmMmZjNTM=',
            'Content-Type': 'application/json'
        }
        response = requests.request("POST", url, headers=headers, json=payload)

        print(response.json())

        def extract_page_text(json_response):
            """
            Extracts all page text and headings from a JSON API response, handling missing keys gracefully.
            """
            try:
                headings = {level: [] for level in range(1, 7)}
                other_text = []

                for task in json_response['tasks']:
                    for result in task['result']:
                        for item in result['items']:
                            if item['type'] == 'content_parsing_element':
                                # Handle missing main_topic
                                main_topic = item['page_content'].get('main_topic')
                                if main_topic:
                                    for topic in main_topic:
                                        headings[topic['level']].append(topic['h_title'].replace('\n',' '))
                                        # Handle missing primary_content
                                        primary_content = topic.get('primary_content')
                                        if primary_content:
                                            for content in primary_content:
                                                other_text.append(content['text'].replace('\n',' '))

                                # Handle missing secondary_topic
                                secondary_topic = item['page_content'].get('secondary_topic')
                                if secondary_topic:
                                    for topic in secondary_topic:
                                        headings[topic['level']].append(topic['h_title'].replace('\n',' '))
                                        # Handle missing primary_content and secondary_content
                                        primary_content = topic.get('primary_content')
                                        if primary_content:
                                            for content in primary_content:
                                                other_text.append(content['text'].replace('\n',' '))
                                        secondary_content = topic.get('secondary_content')
                                        if secondary_content:
                                            for content in secondary_content:
                                                other_text.append(content['text'].replace('\n',' '))


                                #Improved header and footer handling
                                header = item['page_content'].get('header')
                                if header:
                                    primary_content = header.get('primary_content')
                                    if primary_content:
                                        for content in primary_content:
                                            other_text.append(content.get('text', ' ')) #Handle missing text
                                    secondary_content = header.get('secondary_content')
                                    if secondary_content:
                                        for content in secondary_content:
                                            other_text.append(content.get('text', ' ')) #Handle missing text


                                footer = item['page_content'].get('footer')
                                if footer:
                                    secondary_content = footer.get('secondary_content')
                                    if secondary_content:
                                        for content in secondary_content:
                                            other_text.append(content.get('text', '')) #Handle missing text


                return {'headings': headings, 'other_text': ' '.join(other_text)}
            except (KeyError, TypeError, IndexError) as e:
                print(f"Error processing JSON: {e}")
                return None
        extracted_data = extract_page_text(response.json())

        print(extracted_data)

        output = {}
        output[target] = {}
        word_count = 0
        for heading in extracted_data['headings'].keys():
            output[target]['h'+str(heading)] = extracted_data['headings'][heading]
            for line in extracted_data['headings'][heading]:
                word_count += len(line.split(' '))
        #output[target]['visible_text'] = extracted_data['other_text']
        output[target]['word_count'] = word_count + len(extracted_data['other_text'].split(' '))

        print(output)

        #getting GPT to summarise based on page content
        prompt = """You are an expert SEO analyst performing content comparison for keyword research. Your goal is to identify the key content elements of a webpage to understand what sections are necessary to rank for a given keyword. Analyze the following headings and text extracted from a webpage, paying particular attention to the headings.

        1.  **Identify Content Topics:** Extract 5-15 distinct content topics covered on the page. Estimate the word count dedicated to each topic. Do not include company-specific names, product names, or service names.
        2.  **Determine Page Type:** Classify the webpage into one of the following categories: blog article, e-commerce, news, forum, database directory, landing page, product/service page, or social media page.
        3.  **Call to Action (CTA) Analysis:** Critically evaluate the presence, placement, and effectiveness of any Call to Action (CTA) elements on the page. Determine:
            *   Are CTAs present? If so, where are they located (e.g., top, middle, bottom, within content)?
            *   What is the nature of the CTA (e.g., "Buy Now," "Learn More," "Sign Up")?
            *   How effective are the CTAs likely to be based on their visibility, clarity, and relevance to the page content?
            *   What improvements could be made to the CTAs to increase their effectiveness? Output the results in a python dictionary only, in lowercase in the format {page_type: page_type, topics:{topic 1: no. of words, topic 2: no. of words}}."""+ "The targeted keyword is "+keyword+".  Here is the page text:"+ json.dumps(output)
       
        querystring = {"model":"gpt-4o-mini",
        "messages":[{"role": "user", "content": prompt}]}
        headers = {
            "Content-Type": "application/json",
            'Authorization': gpt_key
            }
        
        response = requests.post(gpt_url, headers=headers, json=querystring)
        gpt_output = json.loads(response.json()['choices'][0]['message']['content'].replace("```python","").replace("```","").replace("\n","").replace("_"," ").replace("'",'"').replace("json",""))
        output[target]['topics'] = gpt_output['topics']
        output[target]['page_type'] = gpt_output['page type']
        return({'statusCode': 200,"body":output})
    except Exception as e:
        print(e)
        output[target] = {}
        output[target]['topics'] = ""
        output[target]['page_type'] = ""
        return({'statusCode': 200,"body":output})
