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

def analyze_title(title):
    length = len(title)
    optimal_length = 50 <= length <= 60
    power_words = ["ultimate", "guide", "complete", "essential", "proven", "best", "top", "how to"]
    has_power_word = any(word.lower() in title.lower() for word in power_words)
    
    score = 10 if length < 40 or length > 70 else (30 if not optimal_length else 50)
    if has_power_word: score += 50
    
    return {
        "score": min(score, 100),
        "length": length,
        "recommendations": [] if score >= 80 else ["Consider adding power words", "Aim for 50-60 characters"]
    }

def analyze_headings(content):
    headings = extract_headings(content)
    h1_count = len(headings["h1"])
    h2_count = len(headings["h2"])
    
    score = 0
    recommendations = []
    
    if h1_count == 1: score += 40
    elif h1_count == 0: recommendations.append("Add one H1 heading")
    else: recommendations.append("Use only one H1 heading")
    
    if h2_count >= 2: score += 40
    elif h2_count == 1: score += 20; recommendations.append("Add more H2 headings")
    else: recommendations.append("Add H2 headings")
    
    if h2_count > 0: score += 20
    
    return {"score": min(score, 100), "recommendations": recommendations}

def analyze_readability(text):
    if not textstat:
        return {"score": 50, "level": "Calculation skipped (textstat missing)", "recommendations": ["Enable textstat for better analysis"]}
    
    try:
        flesch_score = textstat.flesch_reading_ease(text)
        normalized_score = 100 if flesch_score >= 60 else (0 if flesch_score <= 30 else ((flesch_score - 30) / 30) * 100)
        return {
            "score": round(normalized_score, 2),
            "level": "Easy" if flesch_score >= 60 else ("Moderate" if flesch_score >= 30 else "Difficult"),
            "recommendations": [] if flesch_score >= 60 else ["Simplify sentences"]
        }
    except:
        return {"score": 50, "level": "Error", "recommendations": ["Add more content"]}

def lambda_handler(event, context):
    try:
        content = event.get('content', '')
        title = event.get('title', '')
        use_ai = event.get('use_ai', False)
        
        plain_text = strip_html(content)
        word_count = count_words(plain_text)
        
        # Rule-based analysis
        title_res = analyze_title(title)
        heading_res = analyze_headings(content)
        readability_res = analyze_readability(plain_text)
        
        overall_score = (title_res['score'] + heading_res['score'] + readability_res['score']) / 3
        
        result = {
            "overall_score": round(overall_score, 2),
            "word_count": word_count,
            "title_analysis": title_res,
            "heading_analysis": heading_res,
            "readability_analysis": readability_res,
            "is_ai": False
        }

        # AI-based override if requested
        if use_ai and os.environ.get('OPENAI_API_KEY'):
            try:
                prompt = f"Perform deep SEO analysis. Title: {title}. Content: {plain_text[:2000]}"
                response = requests.post(
                    "https://api.openai.com/v1/chat/completions",
                    headers={"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}", "Content-Type": "application/json"},
                    json={
                        "model": "gpt-4o-mini",
                        "messages": [{"role": "system", "content": "You are an SEO analyst."}, {"role": "user", "content": prompt}],
                        "response_format": {"type": "json_object"}
                    },
                    timeout=25
                )
                ai_data = response.json()['choices'][0]['message']['content']
                # Merge or replace logic here depends on desired AI depth
                result["ai_feedback"] = json.loads(ai_data)
                result["is_ai"] = True
            except Exception as e:
                result["ai_error"] = str(e)

        return {
            'statusCode': 200,
            'headers': {'Access-Control-Allow-Origin': '*'},
            'body': json.dumps(result)
        }
    except Exception as e:
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)})
        }
