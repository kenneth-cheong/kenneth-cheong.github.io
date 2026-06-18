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

    # 2. Extract Strategic Data
    post_role = event.get('post_role', "")
    strategy_fit = event.get('strategy_fit', "")
    core_message = event.get('core_message', "")
    brand_name = event.get('brand_name', "")
    brand_pov = event.get('brand_pov', "")
    constraints = event.get('constraints', "")
    language = event.get('language', "English")

    # --- Build the Prompt ---
    custom_prompt = event.get('custom_prompt') or event.get('prompt')

    if custom_prompt:
        prompt = custom_prompt
    else:
        # Strategist persona — not a generic content generator
        if language.lower() == 'xiaohongshu':
            persona = (
                "You are a senior social media strategist and copywriter with over 15 years of experience "
                "writing brand-led content specifically for Xiao Hong Shu (小红书 / RED). "
                "You write in a natural, peer-to-peer tone that feels like a genuine personal recommendation, "
                "not a brand advertisement. Use conversational Chinese, relatable storytelling, and relevant "
                "hashtags (话题标签) in the Xiao Hong Shu style. Avoid corporate or salesy language."
            )
            lang_instruction = "Write in a natural Xiao Hong Shu (小红书) style. "
        elif language.lower() == 'chinese':
            persona = (
                "You are a senior social media strategist and copywriter with over 15 years of experience "
                "writing brand-led, performance-aware social content for B2B and B2C brands in Chinese markets."
            )
            lang_instruction = f"Write in Chinese. "
        else:
            persona = (
                "You are a senior social media strategist and copywriter with over 15 years of experience "
                "writing brand-led, performance-aware social content for B2B and B2C brands."
            )
            lang_instruction = ""

        prompt = (
            f"{persona}\n\n"
            f"Your task is not to simply write a caption, but to decide how the caption should function "
            f"strategically within the brand's social media ecosystem.\n\n"
            f"You must:\n"
            f"- Identify the strategic role of the post\n"
            f"- Write with a clear audience intent in mind\n"
            f"- Reinforce brand positioning, not just deliver information\n"
            f"- Be concise, intentional, and purposeful\n\n"
            f"You must avoid: generic marketing language, over-explaining, and writing for engagement without "
            f"strategic value. Assume the reader is scrolling quickly. Every line must earn its place.\n\n"
            f"If trade-offs are required, prioritise: Clarity, Brand credibility, and Strategic intent.\n\n"
            f"The final caption must feel like it was written by a human strategist, not an automated generator.\n\n"
            f"Write a {content_type}. {lang_instruction}"
        )

    # Strategic Context
    if post_role:
        prompt += f"The primary role of this post is to {post_role}. "
    if strategy_fit:
        prompt += f"This post sits within the '{strategy_fit}' part of the content strategy. "
    if core_message:
        prompt += f"The single most important takeaway is: '{core_message}'. "

    # Brand
    if brand_name:
        prompt += f"\nBrand: {brand_name}. "

    # Main Content Info
    if post_info:
        prompt += f"\nMain Content Topic: {post_info}. "

    # Audience Targeting
    audience_parts = []
    if subgroups: audience_parts.append(f"Sub-group: {subgroups}")
    if painpoints: audience_parts.append(f"Pain points: {painpoints}")
    if audience_goal: audience_parts.append(f"Audience goal: {audience_goal}")
    if audience_parts:
        prompt += "\nTarget Audience: " + ", ".join(audience_parts) + ". "

    # Product and CTA
    if product_service:
        prompt += f"\nProduct/Service: {product_service}. "
    if usp:
        prompt += f"Unique Selling Point: {usp}. "
    if desired_action:
        prompt += f"Desired Action (CTA): {desired_action}. "

    # Style and Tone
    style_parts = []
    if tone: style_parts.append(f"Tone: {tone}")
    if brand_pov: style_parts.append(f"Brand stance: {brand_pov}")
    if pov: style_parts.append(f"Perspective: {pov}")
    if word_count: style_parts.append(f"Length: {word_count}")
    if style_parts:
        prompt += "\nStyle: " + ". ".join(style_parts) + ". "

    # Data Context
    def get_text_from_item(item):
        if isinstance(item, dict):
            for key in ['body', 'content', 'text', 'parsed_text']:
                if key in item and item[key]:
                    return str(item[key])
            return json.dumps(item)
        return str(item)

    if webpage_data:
        webpage_content = ' '.join([get_text_from_item(i) for i in webpage_data])
        prompt += f"\nContext from Reference Material: '{webpage_content}'. "

    if brand_guide_data:
        brand_guide_content = ' '.join([get_text_from_item(i) for i in brand_guide_data])
        prompt += f"\nBrand Guidelines: '{brand_guide_content}'. "

    if reference_post:
        prompt += f"\nReference Style (match the tone and voice, not the content): '{reference_post}'. "

    # Constraints (High Priority)
    if constraints:
        prompt += f"\nCRITICAL CONSTRAINTS — you must include or adhere to: {constraints}. "

    # Output format
    if content_type == 'blog-post':
        prompt += "\n\nThe output should be formatted as clean HTML (tags only, no markdown code blocks)."
    else:
        prompt += (
            "\n\nThe output should be plain text only. "
            "STRICTLY DO NOT use any HTML tags, markdown code blocks, or markdown formatting. "
            "Do not add section headers, bullet lists, or structural labels. "
            "Write the caption as flowing, natural copy only."
        )

    # API Call — DeepSeek if requested (OpenAI-compatible), else OpenAI (default).
    # Default preserves the original OpenAI behaviour, so flipping DeepSeek off
    # returns this tool to its normal engine.
    provider = (event.get('provider') or '').lower()
    if provider == 'deepseek':
        api_key = os.environ.get('DEEPSEEK_API_KEY')
        if not api_key:
            print("Error: DEEPSEEK_API_KEY not configured")
            return "Error: AI provider is not configured."
        url = "https://api.deepseek.com/chat/completions"
        model_id = 'deepseek-chat'
    else:
        api_key = os.environ.get('OPENAI_API_KEY')
        if not api_key:
            print("Error: OPENAI_API_KEY not configured")
            return "Error: AI provider is not configured."
        url = "https://api.openai.com/v1/chat/completions"
        model_id = os.environ.get('OPENAI_MODEL', 'gpt-4o-mini')

    json_data = {
        "model": model_id,
        "messages": [
            {"role": "user", "content": prompt}
        ],
        "max_tokens": 2000,
        "temperature": 0.7
    }

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}"
    }

    try:
        response = requests.post(url, headers=headers, json=json_data, timeout=120)
        response.raise_for_status()

        result_text = response.json()['choices'][0]['message']['content']
        output = result_text.replace('```html', '').replace('```json', '').replace('```', '').strip()

        return output
    except requests.exceptions.RequestException as e:
        print(f"Error making API call: {e}")
        return f"Error: Failed to generate content. {e}"
    except (KeyError, IndexError, ValueError) as e:
        print(f"Error parsing API response: {e}")
        return "Error: Failed to parse the AI response."
