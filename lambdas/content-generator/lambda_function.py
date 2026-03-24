import os
import requests
import json

def lambda_handler(event, context):
    apikey = os.environ.get('API_KEY_2')
    
    # 1. Extract Existing Data
    reference_post = event.get('reference_post', "")
    content_type = event.get('content_type', "blog-post")
    post_info = event.get('post_info', "")
    subgroups = event.get('subgroups', "")
    painpoints = event.get('painpoints', "")
    audience_goal = event.get('audience_goal', "")
    product_service = event.get('product_service', "")
    desired_action = event.get('desired_action', "")
    post_objectives = event.get('post_objectives', "")
    word_count = event.get('word_count', "")
    tone = event.get('tone', "")
    usp = event.get('usp', "")
    pov = event.get('pov', "")
    brand_guide_data = event.get('brand_guide', [])
    webpage_data = event.get('webpage_data', [])

    # 2. Extract NEW Strategic Data (Matching HTML IDs)
    post_role = event.get('post_role', "")
    strategy_fit = event.get('strategy_fit', "")
    core_message = event.get('core_message', "")
    brand_pov = event.get('brand_pov', "")
    constraints = event.get('constraints', "")
    language = event.get('language', "English") # Default to English

    # --- Build the Prompt ---
    custom_prompt = event.get('custom_prompt') or event.get('prompt')
    
    if custom_prompt:
        prompt = custom_prompt
    else:
        # Start with Persona and Language
        prompt = f"You are an expert digital marketer. Write a {content_type} in {language}. "

    # Strategic Context
    if post_role:
        prompt += f"The primary role of this post is to {post_role}. "
    if strategy_fit:
        prompt += f"This post sits within the '{strategy_fit}' part of the content strategy. "
    if core_message:
        prompt += f"The single most important takeaway (Core Message) is: '{core_message}'. "

    # Main Content Info
    if post_info:
        prompt += f"\n\nMain Content Topic: {post_info}. "
    
    # Audience Targeting
    prompt += "\nTarget Audience Details: "
    if subgroups: prompt += f"Sub-group: {subgroups}, "
    if painpoints: prompt += f"Pain points: {painpoints}, "
    if audience_goal: prompt += f"Audience Goal: {audience_goal}, "

    # Product and CTA
    if product_service:
        prompt += f"\nProduct/Service: {product_service}. "
    if usp:
        prompt += f"Unique Selling Point: {usp}. "
    if desired_action:
        prompt += f"Desired Action: {desired_action}. "

    # Style and Tone
    prompt += f"\nStyle Requirements: "
    if tone: prompt += f"Tone: {tone}. "
    if brand_pov: prompt += f"Brand Stance/POV: {brand_pov}. "
    if pov: prompt += f"Perspective: {pov}. "
    if word_count: prompt += f"Length: {word_count}. "

    # Data Context
    if webpage_data:
        webpage_content = ' '.join(webpage_data)
        prompt += f"\nContext from Website: '{webpage_content}'. "

    if brand_guide_data:
        brand_guide_content = ' '.join(brand_guide_data)
        prompt += f"\nBrand Guidelines: '{brand_guide_content}'. "

    if reference_post:
        prompt += f"\nReference Style: Match the style of this example: '{reference_post}'. "

    # Constraints (High Priority - Added toward end)
    if constraints:
        prompt += f"\nCRITICAL CONSTRAINTS: You must adhere to these rules: {constraints}. "

    # Formatting Instructions based on Content Type
    if content_type == 'blog-post':
        prompt += "\n\nThe output should be formatted as clean HTML (tags only, no markdown code blocks)."
    else:
        prompt += "\n\nThe output should be plain text only. STRICTLY DO NOT use any HTML tags, markdown code blocks, or markdown formatting (like asterisks for bold)."

    # API Call to 1min.ai
    url = "https://api.1min.ai/api/features"
    json_data = {
        "type": "CHAT_WITH_AI",
        "model": "gpt-4o-mini",
        "promptObject": {
            "prompt": prompt,
            "isMixed": False,
            "webSearch": True,
            "numOfSite": 1,
            "maxWord": 1200 # Increased slightly for longer content
        }
    }

    headers = {
        "Content-Type": "application/json",
        'API-KEY': "2154bdde6d17a2d600ef5d662e1ddca1ac0272679402a08832a0c0fdc652cc61" # Note: Usually move this to Environment Variables
    }

    try:
        response = requests.post(url, headers=headers, json=json_data)
        response.raise_for_status()
        
        # Clean the response to ensure it is raw HTML
        result_text = response.json()['aiRecord']['aiRecordDetail']['resultObject'][0]
        output = result_text.replace('```html','').replace('```','').strip()
        
        return output
    except requests.exceptions.RequestException as e:
        print(f"Error making API call: {e}")
        return f"Error: Failed to generate content. {e}"
    except (KeyError, IndexError, ValueError) as e:
        print(f"Error parsing API response: {e}")
        return "Error: Failed to parse the AI response."