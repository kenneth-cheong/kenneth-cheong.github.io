import json
import re
from collections import Counter
from bs4 import BeautifulSoup

def strip_html(content):
    soup = BeautifulSoup(content, "html.parser")
    return soup.get_text()

def lambda_handler(event, context):
    try:
        content = event.get('content', '')
        text = strip_html(content).lower()
        # Clean text: remove punctuation and split into words
        words = re.findall(r'\b[a-z]{2,}\b', text)
        
        stop_words = {"the", "and", "for", "are", "but", "not", "you", "all", "can", "her", "was", "one", "our", "out", "day", "has", "had", "how", "its", "may", "new", "now", "old", "see", "two", "way", "who", "boy", "did", "get", "him", "his", "man", "she", "too", "any", "with", "this", "that", "from", "in", "to", "of", "is", "it", "on", "as", "at", "be", "by", "or", "an"}
        
        # Generate n-grams (2 & 3 word phrases)
        phrases = []
        for i in range(len(words) - 1):
            w1, w2 = words[i], words[i+1]
            if w1 not in stop_words and w2 not in stop_words:
                phrases.append(f"{w1} {w2}")
                # Add trigram if available
                if i < len(words) - 2:
                    w3 = words[i+2]
                    if w3 not in stop_words:
                        phrases.append(f"{w1} {w2} {w3}")
        
        total_words = len(text.split())
        freq = Counter(phrases)
        top_kws = [{"keyword": k, "count": v, "density": round((v / total_words * 100), 2) if total_words > 0 else 0} 
                   for k, v in freq.most_common(20)]
        
        return {
            'statusCode': 200,
            'headers': {'Access-Control-Allow-Origin': '*'},
            'body': json.dumps({
                "keywords": top_kws,
                "total_words": total_words,
                "unique_words": len(freq)
            })
        }
    except Exception as e:
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)})
        }
