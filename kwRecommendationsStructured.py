import json
import requests
import os

def lambda_handler(event, context):
    target_content = event['target_content']
    serps_dict = event['serps_dict']
    keyword = event['keyword']
    GPT_KEY = os.environ.get('OPENAI_API_KEY')

    print(target_content)

    #getting GPT to give suggestions to rank
    url = "https://api.openai.com/v1/chat/completions"

    prompt = "You are a SEO consultant giving professional, indepth recommendations to a client. Based on the targeted URLs and their curent ranking for the keyword (try to pick the target URL with a better rank), and their content "+json.dumps(target_content)+" (or you suggest a new url if none are applicable and indicate that it is a new URL instead of an existing one), choose the most suitable URL (output the URL plainly instead of as a hyperlink) to map to and critically evaluate the content on this target page and tell me what needs to be improved / be created to rank on google page 1 SERPs for the keyword "+keyword+" after comparing to what the SERPs have as content on their page. Under each content topic / area that is recommended, tell me which of the URLs (include the targeted pages and SERPs listings) have them (can be more than one) and their estimated word count (based from my input) for that topic, and the recommended word count for this topic.  Do not give any generic recommendations. Classify the SERP URLs into one of the following [blog posts, articles, product pages, category pages, landing pages, homepage] and recommend the type which the target page should be. Choose one of the following as the estimated time required to rank as top 10 on google SERPs with little/moderate effort: [0-3 months, 3-6 months, 6-9 months, 9-12 months, more than 12 months] based on all of these mentioned factors paying special regard to the weightage below. If the keyword is totally irrelevant to the the targeted URLs' content, choose 'more than 12 months'. Comment about the domain rank, backlinks, backlinks spam score, referring doamins, internal/external links count, image counts, presence of schema, keyword frequency in visible text, keyword in URL, keyword in meta title, keyword in meta description, keyword in h/h2/h3 headings, keyword in alt text, content formatting in comparison to those of the top 10 SERPs as well. The top 10 SERPs listings content are as follows: "+json.dumps(serps_dict) + ". This is the weightage for the evaluation of time to rank: relevance of content on targeted page to keyword: 0.1, Current Rank: 0.05, Domain Rank: 0.05,  Backlinks: 0.02,  Backlinks Spam Score: 0.05,  Referring Domains: 0.05,  Mobile Score (PSI): 0.05,  Desktop Score (PSI): 0.03,  word count: 0.01,  internal links: 0.01,  external links: 0.01,  KW in URL: 0.08,  KW in Title: 0.05,  KW in Desc: 0.05,  KW in H1: 0.05,  KW in H2: 0.02,  KW in H3: 0.01,  Lists: 0.03,  Tables: 0.02,  Videos: 0.02,  Images: 0.03,  KW in Alt Text: 0.05,  Flesch Score: 0.03,  <p> Tags: 0.06,  Schema: 0.03,  Targeted KW Frequency: 0.04.  Output in html format"

    querystring = {"model":"gpt-4o-mini",
                "messages":[{"role": "user", "content": prompt}]}

    headers = {
        "Content-Type": "application/json",
        'Authorization': 'Bearer ' + GPT_KEY
    }

    response_2 = requests.post(url, headers=headers, json=querystring)

    try:
        print(response_2.json()['choices'][0]['message']['content'])

    except:
        print(response_2.json())
    try:
        return {
            'statusCode': 200,
            'body': response_2.json()['choices'][0]['message']['content'].replace('```html','').replace('```','').replace('\n', '')
        }
    except:
        return {
            'body': response_2.json()
        }
