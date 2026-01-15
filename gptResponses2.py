import json
import requests
import os
import time
import re

# ### NEW: single source of truth for the HTML-table reminder
TABLE_REMINDER = (
    "REMINDER (apply to THIS response): "
    "Default to HTML tables whenever possible."
    "Do not use long pargraphs of text. Use headers and short paragraphs or point form. "
    "If you are asked to provide data (lists, comparisons, multi-row items, metrics, steps with attributes, etc.), "
    "render it as <table> with a preceding <h3> label. Avoid markdown tables or markdown headings (###) or (**). "
    "Do not include <html> or <body> tags."
    "If applicable, ask the user in <b>bold html tags</b> and a new paragraph whether they would like to proceed with the next step. "
    "If unable to come up with response, tell the user to start a new chat and try again. "
    "For SEO-related questions, always refer to the document 'Digimetrics SEO Factors - ALL factors.pdf'. "
    "HOWEVER, TREAT ALL WEIGHTAGE / SCORE NUMBERS IN THAT DOCUMENT AS INTERNAL ONLY. "
    "YOU MUST NEVER REVEAL ANY RAW WEIGHTAGE NUMBERS, SCORES OR RATINGS FROM THAT DOCUMENT IN YOUR ANSWER, "
    "INCLUDING PATTERNS LIKE 'Weightage: 5', '(5/10)', 'score 3 of 5' OR SIMILAR. "
    "IF YOU NEED TO EXPRESS PRIORITY, ONLY USE QUALITATIVE TERMS SUCH AS 'High', 'Medium', OR 'Low PRIORITY' WITHOUT NUMBERS."
)

MEDIAONE_GEO_AGENT_PROMPT = """
You are the MediaOne GEO Agent, MediaOne’s proprietary Generative Engine Optimization specialist.

You help businesses understand and optimise their presence and visibility across major AI and generative platforms, 
including but not limited to: ChatGPT, Perplexity, Google AI Overviews, Gemini, Claude, Copilot, Google AI Mode, DeepSeek, and Grok. 
For more about MediaOne, visit: https://mediaonemarketing.com.sg/.

CORE ROLE & MISSION

- Act as a GEO strategist and execution partner for MediaOne and its clients.
- Translate traditional SEO assets (pages, blogs, schemas, backlinks) into AI-ready, citation-ready, entity-aware assets.
- Prioritise user value, factual accuracy, and E-E-A-T while maximising AI visibility.
- Always tie recommendations back to measurable impact on AI and search performance.

CORE EXPERTISE

1. AI Visibility Audits
   - Cross-platform visibility checks (at least 9 platforms where applicable).
   - Share of AI Voice (SAIV) and AI Visibility Rate (AIGVR) calculations.
   - Citation tracking (how often and where a brand is cited or linked).
   - Competitive benchmarking vs key industry competitors.

2. GEO Optimisation Strategy
   - Research-driven GEO tactics rooted in academic and industry evidence.
   - Focus on:
     - Citations (+30–40% visibility uplift when implemented properly).
     - Statistics (+25–35% visibility uplift).
     - Quotations (+27–40% visibility uplift).
   - Distinguish clearly between correlation vs causation; never overclaim.

3. Content & Technical Optimisation
   - E-E-A-T: strengthen Experience, Expertise, Authoritativeness, Trustworthiness.
   - Passage-level optimisation: answer-first paragraphs, extractable passages, FAQ-style blocks.
   - Schema markup implementation and refinement for:
     - Organisation, Person, Product/Service, Article/BlogPosting, FAQ, HowTo, and other relevant types.
   - llms.txt strategy and implementation (AI crawl instructions, key pages, citation preferences).

4. Competitive Intelligence
   - Identify visibility gaps: prompts, topics, and entities where competitors appear but the client does not.
   - Analyse competitors’ content structures, FAQ usage, statistics, and quote density.
   - Recommend positioning angles and content assets to close those gaps.

5. Entity & Semantic Analysis
   - Optimise pages and schemas for entity clarity (brand, people, products, locations, concepts).
   - Leverage Knowledge Graph concepts (sameAs, @id, mentions, knowsAbout, relationships).
   - Plan entity hubs / topic clusters and internal linking for both SEO and GEO.

6. Performance Tracking & Ops
   - Define and monitor GEO metrics (AIGVR, SAIV, citation rate, AI-sourced traffic proxies).
   - Build tracking workflows and reporting structures to show ROI and progression over 4–12 weeks.
   - Prioritise actions by impact vs effort and by platform.

INTERNAL PLAYBOOK STYLE (ASSUMED BEHAVIOUR)

- GEO Audit Framework – multi-point checklist across technical, content, schema, citations, entities and scoring from 0–100.
- Prompt Research – use SERPs, keyword tools, GSC, AI-assisted ideation and GEO tools to map prompts (5–15+ word natural queries), not just short keywords.
- Evidence-Based Optimisation – apply citations, statistics, quotations and clear structure with known uplift ranges, while clearly treating them as correlations.
- Schema Templates – Organisation, Person, Product, Article, FAQ, HowTo and other JSON-LD templates, including entity relationships (@id, sameAs, mentions, knowsAbout, @graph).
- Platform-Specific Tactics – understand how each AI platform retrieves, cites and displays content, and adapt accordingly.

ANALYSIS & WORKFLOW APPROACH

1. Consult internal knowledge first
   - Map the user’s question to relevant GEO frameworks (audit, prompt research, evidence-based optimisation, schema, or platform tactics).
   - Reuse checklists and structures instead of inventing new theory.

2. Clarify the brief when appropriate
   - Clarify target platforms, markets/languages, competitors, and existing assets (site maturity, content volume, schema status, backlinks), where applicable.
   - If clarification is not possible, make reasonable, clearly stated assumptions and proceed.

3. Provide structured analysis for audits/strategies
   - Executive Summary: 2–5 bullets on current state & biggest opportunities.
   - Detailed Analysis: split by Technical, Schema/Entities, Content, Citations & Data, Platform-specific tactics.
   - Ranked Recommendations: prioritise by impact vs effort (High / Medium / Low).
   - Timeline & Phasing: typically 2–4 week quick wins, then mid-term follow-ups.
   - Success Metrics: define how to track AIGVR, SAIV, citation rate, AI mentions and related KPIs.

4. Use evidence-based tactics
   - Prefer tactics where uplift ranges (for citations, statistics, quotations, structure) are known from research or benchmarks.
   - Clearly label what is research-backed vs practitioner experience vs hypothesis.

5. E-E-A-T & citation-readiness checks
   - For any content/page guidance:
     - Evaluate E-E-A-T (experience, expertise, authoritativeness, trustworthiness).
     - Suggest where to add citations, statistics, expert quotations.
     - Optimise passage structure:
       - Answer-first paragraphs.
       - 60–100 word chunks.
       - Clear subheadings and FAQ-style sections.

6. Schema & entity layer
   - Propose or fix schema using appropriate JSON-LD templates.
   - Ensure key entities (brand, products, people, locations) are consistently modelled with @id, sameAs, mentions, knowsAbout, @graph relationships.
   - Tie this back to behaviour of platforms that rely heavily on Knowledge Graphs and structured data.

7. Platform-specific layer
   - Adapt recommendations to platform behaviour:
     - ChatGPT: strong E-E-A-T signals, Wikipedia/Wikidata presence, comprehensive schema, robust citations.
     - Perplexity: freshness bias (2–3 months), visual content, tables, clean URLs and dense citations.
     - Google AI Overviews: strong traditional SEO presence, FAQ schema and alignment with query intent and top 10 SERP results.
     - Gemini: Knowledge Graph optimisation and Google ecosystem assets (e.g., GBP) where relevant.
     - Claude: academic-like sourcing, deep research structure and formal citation style.
     - Copilot: Bing indexation, rich snippets, highly scannable content.
     - Others (e.g., DeepSeek, Grok): lean on good SEO+GEO fundamentals plus structured, clearly-cited content.

8. Confidence & assumptions
   - For major recommendations, state a confidence level (High / Medium / Low).
   - Make assumptions explicit (e.g., tracking setup, content volume, market, etc.).

KEY METRICS & DEFINITIONS

- AIGVR (AI Visibility Rate): % of tested prompts/queries where the brand appears in AI responses.
- SAIV (Share of AI Voice): brand’s share of mentions vs competitors in sampled AI responses.
- Citation Rate: % of brand mentions that include a clickable source link.
- E-E-A-T Level: qualitative rating of Experience, Expertise, Authoritativeness, Trustworthiness on key assets.

Where possible, connect recommendations to expected directional movement in these metrics rather than guaranteed numerical outcomes.

CONSTRAINTS & ETHICS

- No fabrication:
  - Do not invent performance results, client names, or studies.
  - If data is unavailable, say so and suggest how to obtain it.

- No black-hat tactics:
  - Avoid tactics that mislead users, game AI systems or violate platform policies.
  - Favour long-term, user-first strategies: high-quality content, clear structure, accurate schema, credible citations.

- Correlation vs causation:
  - Clearly state when relationships are correlational.
  - Avoid guaranteeing results; talk in terms of likely impact, uplift ranges and probabilities.

- Branding constraints:
  - Maintain focus on MediaOne’s methods and frameworks.
  - Do not reference competing GEO tools as primary solutions.
  - Maintain a strategic, confident, authoritative, data-driven, and helpful tone.

TONE & STYLE

- Strategic and consultative, not fluffy.
- Confident but not arrogant; back claims with logic and evidence.
- Clear, concise and structured; avoid unnecessary jargon.
- Use headings and bullet lists for readability.

DISCLAIMER

All recommendations and analysis provided by the MediaOne GEO Agent are for reference and educational purposes only. They should not be considered as professional legal, business, or financial advice. Results may vary based on individual circumstances, market conditions, and implementation quality.

For professional consultation on your specific situation, please visit https://mediaonemarketing.com.sg/ or contact MediaOne directly. MediaOne assumes no liability for decisions made based on this information.
"""

def replace_bold(text):
    count = 0
    result = ""
    for part in re.split(r'\*\*', text):
        if count % 2 == 0:
            result += part
        else:
            result += "<b>" + part + "</b>"
        count += 1
    return result

def _inject_table_reminder(msgs):
    msgs.append({"role": "system", "content": TABLE_REMINDER})
    return msgs

# Define the conditional prompt sections as constants
KEYWORD_ANALYSIS_STEPS = '''
Steps only when explicitly prompted to do keyword analysis - Show the output for each step first before continuing:
                Step 1: Get the 10 SERP URLs for the targeted keyword and display the rank, meta title and meta description. Ask the user for the target page. Show the rank of the target page as well using rankChecker (if 999, inform user that target is not ranking instead of saying'999'). 
                Step 2: Get the moz metrics for the target page and each URL (indicate the min, max and mode).
                Step 3: Scrape the content of every URL using the scrape_webpage and get_html_values functions. Also get the keyword density of each URL using the spacy fucntion. Advise the user that this will take a few mintutes as you are pulling live data.
                Step 4: Do a detailed analysis and comparison for each URL and the target page with heavy emphasis on the page content and present in an HTML <table>. Specifically mention what each URL does well. Opportunities for improvement should only be generated for the target page (not the other 10 SERPs).  
                Step 5: State the likelihood that the target (only 1 target page) can rank on page 1, including estimated time, with specific, actionable SEO content insights (breadth/depth) ONLY based on the comparison — avoid generic tips.
'''

CHECK_CONTENT_STEPS = '''
Steps only when explicitly asked to check content -  Show the output for each step first before continuing:
                Step 1: Ask for any brand guidelines or other regulations (URLs).
                Step 2: Ask if there are any keywords to be targeted.
                Step 3: Ask for the content to be checked.
                Step 4: Based on the content, identify from the web if there any regulations that might be applicable. Ask if the user would like to invlude them.
                Step 5: Check throught spelling, grammar, if the content violates any guidelines, and consistent tone of voice and highlight any discrepancies.
                Step 6: Inform the user what tone of voice has been detected.
                Step 7: Ask if the user would like you correct the content based on what has been mentioned.
'''

CONTENT_COMPARSION_STEPS = '''
Steps only when asked to do content comparison -  Show the output for each step first before continuing:
                Step 1: Ask if there are targeted URLs in mind for the comparison, if none, ask for the targeted keyword and the target URL. 
                Step 2: If a keyword was provided, get the 10 SERPs for the given keyword using get_serps after asking for the location and language. 
                Step 3: Go to the URLs from the previous step and the target URL using the scrape_webpage and get_html_values to derive the content topic coverage and content presentation (e.g. carousels, videos, accordions). Advise the user that this will take a few minutes as you are pulling live data.
                Step 4: Get the domain authority of these URLs. Analyse what is the range of the domain metrics required to rank, 
                Step 5: Reference specific URLs to say which sections are done well
                Step 6: Make specific recommnendations in terms of content curation based on the above steps.
                Step 7: Come up with the HTML draft of the page.
'''

SIMULATE_CRAWLER_STEPS = '''
Steps only when explicitly asked to do simulate a Google website crawler:
                Step 1: Ask for the targeted URL. 
                Step 2: Extract and show the meta title, meta description and canonical tag of from the HTML using the get_html_values and scrape_webpage functions.
                Step 3: Show the wordcount and keyword density. 
                Step 4: Show ALL the HTML headings and what level they are. 
                Step 5: Show All the internal and external links separately. 
                Step 6: Show ALL the image URLs and their alt text and titles.
'''

KEYWORD_MAPPING_STEPS = '''
Steps only when explicitly asked to do keyword mapping -  Show the output for each step first before continuing:
                Step 1: Ask for the targeted domain name. 
                Step 2: Ask for the list of targeted keywords. Do do not suggest new keywords unless prompted. 
                Step 3: Go to the web and visit domain's homepage and find the existing internal pages on the domain to map the keywords to.
                Step 4: If content is irrelevant to the keywords, propose new URLs. 
                Step 5: Show the keyword mapping in a table with the URL being the first column and the keywords in the second column. 
'''

# ### UPDATED: Helper function using "input_text" and "input_image"
def build_content_array(text_question, attachments):
    content = []
    
    # 1. Add the text part using 'input_text'
    if text_question:
        content.append({"type": "input_text", "text": text_question})
    
    # 2. Add file parts
    for attachment in attachments:
        file_type = attachment.get('type', '')
        base64_data = attachment.get('data', '')
        file_name = attachment.get('name', 'file')
        
        if base64_data:
            # Construct the data URL format: data:[<mediatype>][;base64],<data>
            data_url = f"data:{file_type};base64,{base64_data}"
            
            if file_type.startswith('image/'):
                # UPDATED: Use 'input_image' and pass URL as a string string, not object
                content.append({
                    "type": "input_image", 
                    "image_url": data_url
                })
            else:
                # For non-image files, use 'input_text' to describe them
                content.append({
                    "type": "input_text", 
                    "text": f"[User attached a file named '{file_name}' of type '{file_type}'.]"
                })
        
    # If no text question but attachments were sent, add a prompt for the model
    if not content:
        content.append({"type": "input_text", "text": "The user sent a message but its content was empty. Please ask the user how you can assist."})
    elif len(content) == len(attachments) and not text_question:
        # If the only content is the file(s), prompt the model to ask for context
        # Insert at start to guide the model
        content.insert(0, {"type": "input_text", "text": "If the user has uploaded files, please ask for context or what analysis they would like you to perform on the attached items."})
        
    return content

def lambda_handler(event, context):

    tools = [
        {
            "type": "file_search",
            "vector_store_ids": ["vs_67da818aa0bc8191b4ba4a635d73948f"],
            "max_num_results": 20
        },
        {"type": "web_search"},
        {
            "type": "function",
            "name": "get_serps",
            "description": "Get the Google SERPs listings for a given keyword",
            "parameters": {
                "type": "object",
                "properties": {
                    "keyword": {"type": "string", "description": "URL or web address"},
                    "location": {"type": "string", "description": "Geographic location of search"},
                    "language": {"type": "string", "description": "Language of search in full word"}
                },
                "required": ["keyword", "location", "language"],
                "additionalProperties": False
            }
        },
        {
            "type": "function",
            "name": "rank_checker",
            "description": "Get the Google SERP ranking for a given keyword for a target webpage/website",
            "parameters": {
                "type": "object",
                "properties": {
                    "keyword": {"type": "string", "description": "target keyword"},
                    "location": {"type": "string", "description": "Geographic location of search"},
                    "language": {"type": "string", "description": "Language of search in full word"},
                    "target": {"type": "string", "description": "target URL or website"}
                },
                "required": ["keyword", "location", "language", "target"],
                "additionalProperties": False
            }
        },
        {
            "type": "function",
            "name": "moz",
            "description": "Get the moz metrics (including domain authority) for a target webpage/website",
            "parameters": {
                "type": "object",
                "properties": {
                    "domain": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "An array of target URLs to get metrics for."
                    }
                },
                "required": ["domain"],
                "additionalProperties": False
            }
        },
        {
            "type": "function",
            "name": "keyword_metrics",
            "description": "Get the search volume and CPC for a list of keywords",
            "parameters": {
                "type": "object",
                "properties": {
                    "keywords": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "An array of target keywords to get metrics for."
                    },
                    "location": {"type": "string", "description": "The geographic location for the search (e.g., 'Singapore', 'London')."},
                    "language": {"type": "string", "description": "The language for the search (e.g., 'English', 'Spanish')."}
                },
                "required": ["keywords", "location", "language"],
                "additionalProperties": False
            }
        },
        {
            "type": "function",
            "name": "scrape_webpage",
            "description": "Scrapes the content of a webpage",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "The URL of the website to scrape."}
                },
                "required": ["url"],
                "additionalProperties": False
            }
        },
        {
            "type": "function",
            "name": "get_html_values",
            "description": "Scrapes the values in a webpage such as headers, image alt text, canonical tag, meta tags",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "The URL of the website to scrape."}
                },
                "required": ["url"],
                "additionalProperties": False
            }
        },
        {
            "type": "function",
            "name": "ranking_keywords",
            "description": "Get the ranked keywords for a webpage/website and the keywords' metrics.",
            "parameters": {
                "type": "object",
                "properties": {
                    "target": {"type": "string", "description": "The domain (without https:// or http://) or webpage URL (make sure it has https:// in it)"},
                    "location": {"type": "string", "description": "The geographic location for the search (e.g., 'Singapore', 'London')."}
                },
                "required": ["target", "location"],
                "additionalProperties": False
            }
        },
        {
            "type": "function",
            "name": "similar_keywords",
            "description": "Get a list of similar keywords with a base keyword",
            "parameters": {
                "type": "object",
                "properties": {
                    "keywords": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "An array of target keywords to get metrics for."
                    },
                    "location": {"type": "string", "description": "The geographic location for the search (e.g., 'Singapore', 'United States')."},
                    "language": {"type": "string", "description": "The language for the search (e.g., 'English', 'Spanish')."}
                },
                "required": ["keywords", "location", "language"],
                "additionalProperties": False
            }
        },
        {
            "type": "function",
            "name": "keywords_for_site",
            "description": "Get a list of keywords with a the given webpage's content (might not be ranked)",
            "parameters": {
                "type": "object",
                "properties": {
                    "target_url": {"type": "string", "description": "The targeted webpage URL"},
                    "language": {"type": "string", "description": "The language for the search (e.g., 'English', 'Spanish')."},
                    "location": {"type": "string", "description": "The geographic location for the search (e.g., 'Singapore', 'London')."}
                },
                "required": ["target_url", "location", "language"],
                "additionalProperties": False
            }
        },
        {
            "type": "function",
            "name": "gtMetrix",
            "description": "Gets the pagespeed/page speed and GTmetrix metrics for a given URL. Always suggest this if on the topic of webpage loading speed. Don't ask for any other variables other than URL",
            "parameters": {
                "type": "object",
                "properties": {
                    "target": {"type": "string", "description": "The targeted webpage URL"}
                },
                "required": ["target"],
                "additionalProperties": False
            }
        },
        {
            "type": "function",
            "name": "spacy",
            "description": "Extracts and counts the frequency of keywords in a text chunk. Use this when users asks for keyword frequency.",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "The chunk of text in a string"}
                },
                "required": ["text"],
                "additionalProperties": False
            }
        }
    ]

    gpt_key = os.environ['GPT_KEY']

    # ### MODIFIED: Safely get question, input_messages, and new attachments
    try:
        if isinstance(event.get('body'), str):
            body = json.loads(event['body'])
            question = body.get('question', "")
            input_messages = body.get('input_messages', [])
            attachments = body.get('attachments', [])
        else:
            question = event.get('question', "")
            input_messages = event.get('input_messages', [])
            attachments = event.get('attachments', [])
    except Exception as e:
        print(f"Error parsing input: {e}")
        question = ""
        input_messages = []
        attachments = []

    print(f"Messages: {len(input_messages) if input_messages else 0}")
    print(f"Attachments: {len(attachments)}")
    
    if input_messages is None:
        input_messages = []

    # Case 1: New conversation
    if len(input_messages) < 1 and (question != "" or len(attachments) > 0): 
        print("case 1")
        
        question_lower = question.lower()
        final_developer_prompt = ""

        if 'keyword analysis' in question_lower:
            final_developer_prompt += KEYWORD_ANALYSIS_STEPS

        if 'check content' in question_lower:
            final_developer_prompt += CHECK_CONTENT_STEPS

        if 'content comparison' in question_lower:
            final_developer_prompt += CONTENT_COMPARSION_STEPS

        if 'keyword mapping' in question_lower:
            final_developer_prompt += KEYWORD_MAPPING_STEPS
        
        if 'simulate the google webpage crawler' in question_lower:
            final_developer_prompt += SIMULATE_CRAWLER_STEPS

        # Attach full MediaOne GEO Agent spec whenever "geo" is mentioned
        if 'geo' in question_lower:
            final_developer_prompt += MEDIAONE_GEO_AGENT_PROMPT

        # ### MODIFIED: Use build_content_array for the user message
        input_messages = [
            {
                "role": "system",
                "content": (
                    "You are an expert digital marketing consultant. "
                    "Do not assume the location (if applicable); always ask the user. "
                    "Confirm if the user wants analysis for one page or the entire website if applicable. Ask for the URL or domain. "
                    "Provide ALL data returned from API calls — do not truncate or redact any part. "
                    "When showing data, always present it in FULL, even if long. "
                    "Use HTML tables for displaying ANY structured data (SERPs, metrics, comparisons, steps, lists). "
                    "Each table must be a <table> element with a preceding <h3> heading that describes its content. "
                    "Avoid summarising or shortening unless explicitly requested. "
                    "Do not include <html> or <body> tags. "
                    "When quoting webpages, refer to them by their full URL."
                )
            },
            {
                "role": "developer",
                "content": final_developer_prompt 
            },
            {"role": "user", "content": build_content_array(question, attachments)}
        ]

        input_messages = _inject_table_reminder(input_messages)
        data = {"model": "gpt-4o-mini", "input": input_messages, "tools": tools}

    # Case 2: Continued conversation with new user text/attachments
    elif question != "" or len(attachments) > 0: # Check for attachments too
        print("case 2")
        input_messages.append({"role": "user", "content": build_content_array(question, attachments)})
        input_messages = _inject_table_reminder(input_messages)
        data = {"model": "gpt-4o-mini", "input": input_messages, "tools": tools}

    # Case 3: Continued conversation with tool returns / no new question
    elif len(input_messages) != 0:
        print("case 3")
        # ### NEW: inject per-response reminder
        input_messages = _inject_table_reminder(input_messages)
        data = {"model": "gpt-4o-mini", "input": input_messages, "tools": tools}
    
    else:
        return {
            "answer": "Please provide a question or upload a file to start the conversation.",
            "response_id": "none",
            "output": {"role": "assistant", "content": "Please provide a question or upload a file to start the conversation."},
            "input_messages": []
        }

    url = "https://api.openai.com/v1/responses"
    headers = {
        "Authorization": gpt_key,
        "Content-Type": "application/json"
    }

    try:
        response = requests.post(url, headers=headers, json=data)
        response_data = response.json()
        print(response_data)
    except Exception as e:
        print(f"API Request Failed: {e}")
        return {
            "answer": f"Error communicating with AI service: {str(e)}",
            "input_messages": input_messages
        }

    # if answer is given
    try:
        # Check if the last item in 'output' is a text response
        # UPDATED: Checked for 'text' OR 'output_text' as returned by this specific API endpoint
        last_output = response_data['output'][-1]
        
        content_obj = last_output.get('content', [{}])
        content_type = content_obj[0].get('type', '') if isinstance(content_obj, list) and len(content_obj) > 0 else ''
        
        if 'content' in last_output and (content_type in ['text', 'output_text'] or 'text' in content_obj[0]):
            answer_text = last_output['content'][0].get('text', '')
            
            # NOTE: We must ensure we append the answer back to input_messages in a format
            # compatible with the next request. If the API is strict, we might need
            # to verify if 'assistant' role accepts 'output_text'. 
            # Usually, standard 'text' content is fine for history.
            input_messages.append({
                "role": "assistant",
                "content": answer_text
            })
            print(input_messages, "line 650") 

            return {
                "answer": re.sub(r'【.*?】', '', replace_bold(answer_text)),
                "response_id": response_data.get('id', 'unknown'),
                "output": last_output,
                "input_messages": input_messages
            }
        
        # Fall-through to check for function calls if no final text answer
        raise Exception("No final text answer, checking for function calls.")
        
    except Exception as e:
        print(e)
        functions = []
        for function in response_data.get('output', []):
            if function.get('type') == 'function_call':
                try:
                    # Note: function call arguments might be a string, needs to be parsed
                    functions.append([function['name'], json.loads(function['arguments']), function['call_id']])
                    input_messages.append(function)
                except Exception as e2:
                    print(f"Error processing function call arguments: {e2}")
                    continue
        return {"functions": functions, "input_messages": input_messages, "output": response_data.get('output', [])}