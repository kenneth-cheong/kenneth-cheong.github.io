import httpx
from typing import Dict, List, Optional
from sqlalchemy.orm import Session
from app.models.plagiarism_check import PlagiarismCheck
from app.models.article import Article
from app.core.config import settings
from fastapi import HTTPException, status
import re


class PlagiarismService:
    """Service for plagiarism detection using Copyscape API."""
    
    # Copyscape API endpoints
    COPYSCAPE_API_URL = "https://www.copyscape.com/api/"
    
    @staticmethod
    def _clean_text(text: str) -> str:
        """Clean and prepare text for plagiarism checking."""
        # Remove extra whitespace
        text = re.sub(r'\s+', ' ', text)
        # Remove HTML tags if any
        text = re.sub(r'<[^>]+>', '', text)
        return text.strip()
    
    @staticmethod
    def _calculate_originality_score(matches: List[Dict], total_words: int) -> float:
        """
        Calculate originality score based on matches.
        Score is 100 - (percentage of content that matches elsewhere).
        """
        if not matches or total_words == 0:
            return 100.0
        
        # Calculate total matched words (avoiding double counting)
        matched_words = sum(match.get('matched_words', 0) for match in matches)
        match_percentage = min((matched_words / total_words) * 100, 100)
        
        # Originality score is inverse of match percentage
        originality_score = max(100 - match_percentage, 0)
        return round(originality_score, 2)
    
    @staticmethod
    async def check_with_copyscape(text: str, article_url: Optional[str] = None) -> Dict:
        """
        Check text for plagiarism using Copyscape API.
        
        Args:
            text: The text content to check
            article_url: Optional URL to exclude from results (if article is already published)
            
        Returns:
            Dict with plagiarism check results including matches and scores
        """
        if not hasattr(settings, 'COPYSCAPE_API_KEY') or not settings.COPYSCAPE_API_KEY:
            raise ValueError("Copyscape API key not configured. Please set COPYSCAPE_API_KEY in environment variables.")
        
        if not hasattr(settings, 'COPYSCAPE_USERNAME') or not settings.COPYSCAPE_USERNAME:
            raise ValueError("Copyscape username not configured. Please set COPYSCAPE_USERNAME in environment variables.")
        
        # Clean the text
        cleaned_text = PlagiarismService._clean_text(text)
        word_count = len(cleaned_text.split())
        
        if word_count < 10:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Text must contain at least 10 words for plagiarism checking."
            )
        
        # Prepare API request
        # Copyscape API uses specific parameters for text search
        params = {
            'u': settings.COPYSCAPE_USERNAME,
            'k': settings.COPYSCAPE_API_KEY,
            'o': 'csapiv2',  # API version
            't': cleaned_text,  # Text to check
            'e': 'UTF-8',  # Encoding
        }
        
        # Add optional URL to exclude
        if article_url:
            params['x'] = article_url
        
        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                response = await client.post(
                    f"{PlagiarismService.COPYSCAPE_API_URL}",
                    data=params
                )
                
                if response.status_code != 200:
                    raise HTTPException(
                        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                        detail=f"Copyscape API error: {response.text}"
                    )
                
                # Parse Copyscape response
                result_data = response.json() if response.headers.get('content-type', '').startswith('application/json') else {}
                
                # Copyscape returns XML by default, but we can request JSON
                # Parse the response based on their API documentation
                matches = []
                
                # Check if there are any matches in the response
                if 'result' in result_data:
                    results = result_data['result']
                    if isinstance(results, list):
                        for match in results:
                            matches.append({
                                'url': match.get('url', ''),
                                'title': match.get('title', ''),
                                'match_percentage': float(match.get('percentmatched', 0)),
                                'matched_words': int(match.get('minwordsmatched', 0)),
                                'total_words': word_count,
                                'text_snippet': match.get('textsnippet', '')[:500]  # Limit snippet length
                            })
                
                # Calculate originality score
                originality_score = PlagiarismService._calculate_originality_score(matches, word_count)
                
                return {
                    'originality_score': originality_score,
                    'matched_sources': matches,
                    'total_matches': len(matches),
                    'words_checked': word_count,
                    'query_cost': result_data.get('querycost', 0)  # Copyscape API cost
                }
                
        except httpx.TimeoutException:
            raise HTTPException(
                status_code=status.HTTP_504_GATEWAY_TIMEOUT,
                detail="Plagiarism check timed out. Please try again."
            )
        except httpx.RequestError as e:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"Failed to connect to plagiarism detection service: {str(e)}"
            )
    
    @staticmethod
    async def check_article_plagiarism(
        db: Session, 
        article_id: int, 
        text: Optional[str] = None
    ) -> PlagiarismCheck:
        """
        Check an article for plagiarism and save the results.
        
        Args:
            db: Database session
            article_id: ID of the article to check
            text: Optional text to check (if None, uses article content)
            
        Returns:
            PlagiarismCheck object with results
        """
        # Get the article
        article = db.query(Article).filter(Article.id == article_id).first()
        if not article:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Article not found"
            )
        
        # Use provided text or article content
        check_text = text if text else article.content
        
        if not check_text or len(check_text.strip()) < 10:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Article content is too short for plagiarism checking (minimum 10 words)."
            )
        
        # Perform plagiarism check with Copyscape
        result = await PlagiarismService.check_with_copyscape(
            check_text, 
            article.target_url
        )
        
        # Save results to database
        plagiarism_check = PlagiarismCheck(
            article_id=article_id,
            originality_score=result['originality_score'],
            matched_sources=result['matched_sources']
        )
        
        db.add(plagiarism_check)
        db.commit()
        db.refresh(plagiarism_check)
        
        return plagiarism_check
    
    @staticmethod
    def get_article_plagiarism_checks(db: Session, article_id: int) -> List[PlagiarismCheck]:
        """Get all plagiarism checks for an article."""
        return db.query(PlagiarismCheck).filter(
            PlagiarismCheck.article_id == article_id
        ).order_by(PlagiarismCheck.created_at.desc()).all()
    
    @staticmethod
    def get_latest_plagiarism_check(db: Session, article_id: int) -> Optional[PlagiarismCheck]:
        """Get the most recent plagiarism check for an article."""
        return db.query(PlagiarismCheck).filter(
            PlagiarismCheck.article_id == article_id
        ).order_by(PlagiarismCheck.created_at.desc()).first()




