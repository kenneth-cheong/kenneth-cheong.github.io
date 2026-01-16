"""
Keyword frequency extraction service using external SpaCy API.

Calls an external AWS Lambda endpoint that provides NLP-based keyword extraction.
"""

import httpx
from typing import Dict, Any
from bs4 import BeautifulSoup


SPACY_API_URL = "https://mxyyoh5y2d.execute-api.ap-southeast-1.amazonaws.com/spacy"
REQUEST_TIMEOUT = 30  # seconds


class KeywordFrequencyService:
    @staticmethod
    def strip_html(content: str) -> str:
        """Remove HTML tags from content."""
        soup = BeautifulSoup(content, "html.parser")
        return soup.get_text()
    
    @staticmethod
    async def extract_keywords(text: str) -> Dict[str, Any]:
        """
        Extract keyword frequencies from text using external SpaCy API.
        
        Args:
            text: The text content to analyze (HTML will be stripped)
        
        Returns:
            Dict containing keywords, frequencies, and metadata
        
        Raises:
            httpx.HTTPError: If the API request fails
        """
        # Strip HTML if present
        plain_text = KeywordFrequencyService.strip_html(text)
        
        if not plain_text or len(plain_text.strip()) == 0:
            return {
                "keywords": [],
                "total_words": 0,
                "unique_words": 0
            }
        
        # Prepare request payload
        payload = {
            "text": plain_text
        }
        
        headers = {
            "Content-Type": "application/json"
        }
        
        # Call external SpaCy API
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
            response = await client.post(
                SPACY_API_URL,
                json=payload,
                headers=headers
            )
            response.raise_for_status()
            
            api_result = response.json()
            
            # Transform the API response into expected format
            # The SpaCy API returns a flat dict like: {'startup': 20, 'singapore': 17, ...}
            # We need to transform it to: {keywords: [...], total_words: N, unique_words: M}
            
            if isinstance(api_result, dict):
                # Check if it's already in the expected format
                if "keywords" in api_result and "total_words" in api_result:
                    return api_result
                
                # Transform flat keyword dict to structured format
                keywords_list = []
                total_count = 0
                
                for keyword, count in api_result.items():
                    keywords_list.append({
                        "keyword": keyword,
                        "count": int(count) if isinstance(count, (int, float)) else 1,
                        "frequency": float(count) if isinstance(count, (int, float)) else 1.0
                    })
                    total_count += int(count) if isinstance(count, (int, float)) else 1
                
                # Sort by count (descending)
                keywords_list.sort(key=lambda x: x["count"], reverse=True)
                
                return {
                    "keywords": keywords_list,
                    "total_words": total_count,
                    "unique_words": len(keywords_list)
                }
            
            # Fallback if unexpected format
            return {
                "keywords": [],
                "total_words": 0,
                "unique_words": 0
            }

