import json
import re
import os
import requests
from bs4 import BeautifulSoup

# Try to import textstat, but handle if not available (requires Lambda Layer)
try:
    import textstat
except ImportError:
    textstat = None

def strip_html(content):
    soup = BeautifulSoup(content, "html.parser")
    return soup.get_text()

def count_words(text):
    words = re.findall(r'\w+', text)
    return len(words)

def extract_headings(content):
    soup = BeautifulSoup(content, "html.parser")
    return {
        "h1": [h.get_text().strip() for h in soup.find_all("h1")],
        "h2": [h.get_text().strip() for h in soup.find_all("h2")],
        "h3": [h.get_text().strip() for h in soup.find_all("h3")],
    }

def analyze_title(title, primary_keyword):
    length = len(title)
    # Digimetrics: Primary Keyword Placement (75)
    score = 0
    recommendations = []
    
    # Length check (Classic SEO)
    if 50 <= length <= 60: score += 40
    elif 40 <= length <= 70: score += 20
    else: recommendations.append("Title length is suboptimal (aim for 50-60 chars)")
    
    # Keyword Placement (75 weightage factor)
    if primary_keyword.lower() in title.lower():
        score += 60
        if title.lower().startswith(primary_keyword.lower()):
            score += 10 # Bonus for front-loading
    else:
        recommendations.append(f"Primary keyword '{primary_keyword}' missing from title")
        
    return {
        "score": min(score, 100),
        "length": length,
        "recommendations": recommendations
    }

def analyze_headings(content, primary_keyword):
    headings = extract_headings(content)
    h1_count = len(headings["h1"])
    h2_count = len(headings["h2"])
    
    score = 0
    recommendations = []
    
    # H1 Rules
    if h1_count == 1:
        score += 30
        if primary_keyword.lower() in headings["h1"][0].lower():
            score += 20
        else:
            recommendations.append("Include primary keyword in H1 heading")
    elif h1_count == 0:
        recommendations.append("Add one H1 heading")
    else:
        recommendations.append("Use only one H1 heading")
    
    # H2 Rules (Structure & Coverage)
    if h2_count >= 3: score += 30
    elif h2_count >= 1: score += 15; recommendations.append("Add more H2 headings for better structure")
    
    # Semantic variants in H2/H3 (75 weightage)
    all_subheadings = " ".join(headings["h2"] + headings["h3"]).lower()
    if primary_keyword.lower() in all_subheadings:
        score += 20
        
    return {"score": min(score, 100), "recommendations": recommendations}

def analyze_readability(text):
    if not textstat:
        return {"score": 75, "level": "Analysis based on length", "recommendations": []}
    
    try:
        flesch_score = textstat.flesch_reading_ease(text)
        # Digimetrics: Clarity & Readability (90 weightage)
        normalized_score = 100 if flesch_score >= 60 else (0 if flesch_score <= 30 else ((flesch_score - 30) / 30) * 100)
        return {
            "score": round(normalized_score, 2),
            "level": "Easy" if flesch_score >= 60 else ("Moderate" if flesch_score >= 30 else "Difficult"),
            "recommendations": [] if flesch_score >= 60 else ["Simplify sentences for better engagement"]
        }
    except:
        return {"score": 50, "level": "Error", "recommendations": ["Add more content"]}

def analyze_intent_eeat(text, content_html):
    # Heuristic checks based on Digimetrics Factors (90 weightage)
    score = 0
    recommendations = []
    
    # E-E-A-T: First-hand experience (8)
    experience_signals = ["in my experience", "our tests", "we found", "i discovered", "case study", "experiment"]
    if any(sig in text.lower() for sig in experience_signals):
        score += 40
    else:
        recommendations.append("Add evidence of first-hand experience (e.g., 'our tests showed')")
        
    # E-E-A-T: Author/Trust signals (7)
    author_signals = ["about the author", "written by", "authored by", "author bio", "contributor", "credentials", "meet the team"]
    if any(sig in text.lower() for sig in author_signals):
        score += 30
    else:
        recommendations.append("Include an author bio or credentials to build trust")
        
    # LLM Discoverability: Q&A / FAQ (51, 52)
    soup = BeautifulSoup(content_html, "html.parser")
    # Improved FAQ detection: check for FAQ keyword or headings ending in "?"
    has_faq = "faq" in text.lower() or any(h.get_text().strip().endswith('?') for h in soup.find_all(['h2', 'h3']))
    if has_faq:
        score += 30
    else:
        recommendations.append("Add an FAQ section or use question-based headings for LLM visibility")
        
    return {
        "score": min(score, 100),
        "recommendations": recommendations
    }

def lambda_handler(event, context):
    try:
        content = event.get('content', '')
        title = event.get('title', '')
        use_ai = event.get('use_ai', False)
        primary_keyword = event.get('primary_keyword', '')
        secondary_keywords = event.get('secondary_keywords', '')
        
        plain_text = strip_html(content)
        word_count = count_words(plain_text)
        
        # Rule-based analysis (Enhanced with Digimetrics Factors)
        title_res = analyze_title(title, primary_keyword)
        heading_res = analyze_headings(content, primary_keyword)
        readability_res = analyze_readability(plain_text)
        intent_eeat_res = analyze_intent_eeat(plain_text, content)
        
        # Calculate overall score with Digimetrics-style weightings
        # Intent/EEAT (90), Readability (90), Title (75), Headings (75)
        overall_score = (
            (intent_eeat_res['score'] * 0.3) + 
            (readability_res['score'] * 0.3) + 
            (title_res['score'] * 0.2) + 
            (heading_res['score'] * 0.2)
        )
        
        # Consolidate Action Plan
        action_plan = []
        action_plan.extend(title_res.get('recommendations', []))
        action_plan.extend(heading_res.get('recommendations', []))
        action_plan.extend(readability_res.get('recommendations', []))
        action_plan.extend(intent_eeat_res.get('recommendations', []))
        
        result = {
            "overall_score": round(overall_score, 2),
            "word_count": word_count,
            "title_analysis": title_res,
            "heading_analysis": heading_res,
            "readability_analysis": readability_res,
            "intent_eeat_analysis": intent_eeat_res,
            "action_plan": list(set(action_plan)), # Basic de-duplication
            "is_ai": False
        }

        # AI-based override if requested
        if use_ai and os.environ.get('OPENAI_API_KEY'):
            try:
                keyword_context = f"Primary Keyword: {primary_keyword}. Secondary Keywords: {secondary_keywords}."
                prompt = (
                    f"Perform a senior-level SEO analysis based on these specific factors:\n"
                    f"1. Search Intent Match (90% weight): Does this accurately serve a {primary_keyword} searcher?\n"
                    f"2. E-E-A-T (90% weight): Does it show first-hand experience, unique data, or expert credentials?\n"
                    f"3. Topical Coverage (90% weight): Are core subtopics and related terms naturally covered?\n"
                    f"4. Originality (90% weight): Is this better than competitors or just rephrased?\n\n"
                    f"Details:\n"
                    f"Title: {title}\n"
                    f"Keywords: {keyword_context}\n"
                    f"Content Snippet: {plain_text[:3000]}\n\n"
                    f"Output a JSON object with 'score', 'intent_feedback', 'eeat_feedback', 'topical_gaps', 'keyword_usage', and 'urgent_action_plan' (a list of 2-5 specific improvements to reach score 100). "
                    f"IMPORTANT: Do NOT recommend using specific programming libraries like 'textstat' or technical implementation details involving Python. Only provide content and SEO strategy recommendations."
                )
                response = requests.post(
                    "https://api.openai.com/v1/chat/completions",
                    headers={"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}", "Content-Type": "application/json"},
                    json={
                        "model": "gpt-4o-mini",
                        "messages": [
                            {"role": "system", "content": "You are a world-class SEO strategist trained on Digimetrics SEO standards. Evaluate content for deep alignment, trust signals, and user value, not just keyword density. Provide clear, actionable steps to reach 100% SEO score."},
                            {"role": "user", "content": prompt}
                        ],
                        "response_format": {"type": "json_object"}
                    },
                    timeout=25
                )
                ai_data_raw = response.json()['choices'][0]['message']['content']
                ai_feedback = json.loads(ai_data_raw)
                
                # Update overall score if AI found major flaws
                ai_score = ai_feedback.get('score', overall_score)
                result["overall_score"] = round((overall_score * 0.4) + (ai_score * 0.6), 2)
                
                # Merge AI action plan if present
                if "urgent_action_plan" in ai_feedback:
                    # AI actions are prioritized
                    result["action_plan"] = ai_feedback["urgent_action_plan"] + [item for item in result["action_plan"] if item not in ai_feedback["urgent_action_plan"]]
                
                result["ai_feedback"] = ai_feedback
                result["is_ai"] = True
            except Exception as e:
                result["ai_error"] = str(e)

        return {
            'statusCode': 200,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            'body': json.dumps(result)
        }
    except Exception as e:
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)})
        }
