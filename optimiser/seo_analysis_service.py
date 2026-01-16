import re
from typing import Dict, List, Any
from bs4 import BeautifulSoup
import textstat
from collections import Counter
from app.models.article import Article
from app.models.seo_analysis import SEOAnalysis
from sqlalchemy.orm import Session
from openai import OpenAI
from app.core.config import settings
import json


class SEOAnalysisService:
    @staticmethod
    def strip_html(content: str) -> str:
        """Remove HTML tags from content."""
        soup = BeautifulSoup(content, "html.parser")
        return soup.get_text()
    
    @staticmethod
    def count_words(text: str) -> int:
        """Count words in text."""
        words = re.findall(r'\w+', text)
        return len(words)
    
    @staticmethod
    def extract_headings(content: str) -> Dict[str, List[str]]:
        """Extract headings from HTML content."""
        soup = BeautifulSoup(content, "html.parser")
        headings = {
            "h1": [h.get_text().strip() for h in soup.find_all("h1")],
            "h2": [h.get_text().strip() for h in soup.find_all("h2")],
            "h3": [h.get_text().strip() for h in soup.find_all("h3")],
        }
        return headings
    
    @staticmethod
    def analyze_title(title: str) -> Dict[str, Any]:
        """Analyze article title."""
        length = len(title)
        optimal_length = 50 <= length <= 60
        
        # Check for power words
        power_words = ["ultimate", "guide", "complete", "essential", "proven", "best", "top", "how to"]
        has_power_word = any(word.lower() in title.lower() for word in power_words)
        
        # Calculate score
        score = 0
        if optimal_length:
            score += 50
        elif 40 <= length <= 70:
            score += 30
        else:
            score += 10
        
        if has_power_word:
            score += 50
        
        return {
            "score": min(score, 100),
            "length": length,
            "optimal_length": optimal_length,
            "has_power_word": has_power_word,
            "recommendations": [] if score >= 80 else ["Consider adding power words", "Aim for 50-60 characters"]
        }
    
    @staticmethod
    def analyze_headings(content: str) -> Dict[str, Any]:
        """Analyze heading structure."""
        headings = SEOAnalysisService.extract_headings(content)
        
        h1_count = len(headings["h1"])
        h2_count = len(headings["h2"])
        h3_count = len(headings["h3"])
        
        # Calculate score
        score = 0
        recommendations = []
        
        # Check H1
        if h1_count == 1:
            score += 40
        elif h1_count == 0:
            recommendations.append("Add one H1 heading")
        else:
            recommendations.append("Use only one H1 heading")
        
        # Check H2
        if h2_count >= 2:
            score += 40
        elif h2_count == 1:
            score += 20
            recommendations.append("Add more H2 headings for better structure")
        else:
            recommendations.append("Add H2 headings to organize content")
        
        # Check hierarchy
        if h2_count > 0 or h3_count == 0:
            score += 20
        
        return {
            "score": min(score, 100),
            "h1_count": h1_count,
            "h2_count": h2_count,
            "h3_count": h3_count,
            "recommendations": recommendations
        }
    
    @staticmethod
    def analyze_readability(text: str) -> Dict[str, Any]:
        """Analyze content readability."""
        try:
            flesch_score = textstat.flesch_reading_ease(text)
            
            # Normalize to 0-100 scale (60-100 Flesch = 100 score, 0-30 = 0 score)
            if flesch_score >= 60:
                normalized_score = 100
            elif flesch_score <= 30:
                normalized_score = 0
            else:
                normalized_score = ((flesch_score - 30) / 30) * 100
            
            # Readability interpretation
            if flesch_score >= 60:
                level = "Easy to read"
            elif flesch_score >= 30:
                level = "Moderate difficulty"
            else:
                level = "Difficult to read"
            
            return {
                "score": normalized_score,
                "flesch_score": flesch_score,
                "level": level,
                "recommendations": [] if flesch_score >= 60 else ["Simplify sentences", "Use shorter words"]
            }
        except:
            return {
                "score": 50,
                "flesch_score": 50,
                "level": "Unable to calculate",
                "recommendations": ["Add more content for accurate analysis"]
            }
    
    @staticmethod
    def analyze_keyword_density(text: str, top_n: int = 10) -> Dict[str, Any]:
        """Analyze keyword density."""
        # Extract words
        words = re.findall(r'\b[a-z]{3,}\b', text.lower())
        
        # Common stop words to exclude
        stop_words = {"the", "and", "for", "are", "but", "not", "you", "all", "can", "her", "was", "one", "our", "out", "day", "has", "had", "how", "its", "may", "new", "now", "old", "see", "two", "way", "who", "boy", "did", "get", "him", "his", "man", "she", "too", "any"}
        
        # Filter words
        filtered_words = [word for word in words if word not in stop_words]
        
        # Count frequency
        word_freq = Counter(filtered_words)
        top_keywords = word_freq.most_common(top_n)
        
        # Calculate density
        total_words = len(filtered_words)
        keyword_data = []
        
        for word, count in top_keywords:
            density = (count / total_words * 100) if total_words > 0 else 0
            keyword_data.append({
                "keyword": word,
                "count": count,
                "density": round(density, 2)
            })
        
        # Score based on having well-distributed keywords
        max_density = keyword_data[0]["density"] if keyword_data else 0
        if 1 <= max_density <= 3:
            score = 100
        elif max_density < 1:
            score = 50
        else:
            score = max(0, 100 - (max_density - 3) * 10)
        
        return {
            "score": score,
            "keywords": keyword_data,
            "total_words": total_words,
            "recommendations": [] if 1 <= max_density <= 3 else ["Optimize keyword usage (1-3% density)"]
        }
    
    @staticmethod
    def analyze_article_with_ai(db: Session, article: Article) -> SEOAnalysis:
        """Perform AI-powered SEO analysis on an article."""
        from app.admin.services.seo_config_service import get_or_create_config
        
        # Get plain text
        plain_text = SEOAnalysisService.strip_html(article.content or "")
        word_count = SEOAnalysisService.count_words(plain_text)
        
        # Extract headings for context
        headings = SEOAnalysisService.extract_headings(article.content or "")
        
        # Get active SEO configuration
        seo_config = get_or_create_config(db)
        enabled_factors = seo_config.get_enabled_factors()
        weights = seo_config.get_weights()
        
        # Build comprehensive analysis criteria based on config
        analysis_criteria = []
        
        # Search Intent Match
        if enabled_factors["search_intent"]["query_intent_classification"]:
            analysis_criteria.append("- **Query Intent Classification**: Identify whether the content matches informational, commercial, transactional, or local intent")
        if enabled_factors["search_intent"]["page_type_alignment"]:
            analysis_criteria.append("- **Page Type Alignment**: Ensure format (blog, product page, guide, tool) matches what Google ranks for the query")
        if enabled_factors["search_intent"]["funnel_stage_cta_alignment"]:
            analysis_criteria.append("- **Funnel Stage & CTA Alignment**: Match calls-to-action to user's buying journey stage")
        
        # Topical Relevance & Coverage
        if enabled_factors["topical_relevance"]["core_topic_coverage"]:
            analysis_criteria.append("- **Core Topic Coverage**: Ensure main topic is explained clearly and completely")
        if enabled_factors["topical_relevance"]["subtopic_faq_coverage"]:
            analysis_criteria.append("- **Subtopic & FAQ Coverage**: Cover related subtopics, FAQs, and edge cases")
        if enabled_factors["topical_relevance"]["entity_jargon_coverage"]:
            analysis_criteria.append("- **Entity & Jargon Coverage**: Mention key entities (brands, tools, locations) and domain-specific terms")
        
        # E-E-A-T Signals
        if enabled_factors["eeat_signals"]["author_identity"]:
            analysis_criteria.append("- **Author Identity & Credentials**: Display who wrote content and their qualifications")
        if enabled_factors["eeat_signals"]["firsthand_experience"]:
            analysis_criteria.append("- **First-Hand Experience Evidence**: Demonstrate real-world use with photos, screenshots, case studies")
        if enabled_factors["eeat_signals"]["brand_trust_signals"]:
            analysis_criteria.append("- **Brand & Site Trust Signals**: Check for clear contact details, policies, testimonials")
        if enabled_factors["eeat_signals"]["citation_quality"]:
            analysis_criteria.append("- **Citation & Source Quality**: Link to reputable sources and official documents")
        
        # Content Quality
        if enabled_factors["content_quality"]["clarity_readability"]:
            analysis_criteria.append("- **Clarity & Readability**: Clear, easy-to-read content with short sentences and good structure")
        if enabled_factors["content_quality"]["originality_value"]:
            analysis_criteria.append("- **Originality & Added Value**: Original insights, proprietary data, unique frameworks")
        if enabled_factors["content_quality"]["practical_usefulness"]:
            analysis_criteria.append("- **Practical Usefulness**: Step-by-step instructions, checklists, templates, actionable guidance")
        
        # On-Page Keyword Targeting
        if enabled_factors["keyword_targeting"]["primary_keyword_placement"]:
            analysis_criteria.append("- **Primary Keyword Placement**: Main keyword in title, H1, intro, and URL")
        if enabled_factors["keyword_targeting"]["semantic_variants"]:
            analysis_criteria.append("- **Semantic Variants & Related Terms**: Use related phrases to cover user phrasing variations")
        if enabled_factors["keyword_targeting"]["internal_anchor_optimization"]:
            analysis_criteria.append("- **Internal Anchor Text Optimization**: Use descriptive internal anchors to signal page topics")
        
        # Search Snippet Relevance
        if enabled_factors["snippet_relevance"]["title_tag_message_match"]:
            analysis_criteria.append("- **Title Tag Message Match**: Title reflects keyword and core benefit")
        if enabled_factors["snippet_relevance"]["meta_description_compelling"]:
            analysis_criteria.append("- **Meta Description Compellingness**: Strong meta description to improve CTR")
        if enabled_factors["snippet_relevance"]["snippet_content_consistency"]:
            analysis_criteria.append("- **Snippet-Content Consistency**: Content matches promise made in snippet")
        
        criteria_text = "\n".join(analysis_criteria)
        
        # Build AI prompt with custom instructions if provided
        custom_instructions = seo_config.analysis_instructions or ""
        
        prompt = f"""Analyze this article for comprehensive SEO based on the following enabled criteria.

**Article Title:** {article.title}
**Word Count:** {word_count}
**Headings:**
- H1: {', '.join(headings['h1']) if headings['h1'] else 'None'}
- H2: {', '.join(headings['h2']) if headings['h2'] else 'None'}
- H3: {', '.join(headings['h3']) if headings['h3'] else 'None'}

**Content Preview (first 800 words):**
{' '.join(plain_text.split()[:800])}

**Analysis Criteria (Enabled Factors):**
{criteria_text}

**Category Weights:**
- Search Intent Match: {weights['search_intent']*100:.0f}%
- Topical Relevance & Coverage: {weights['topical_relevance']*100:.0f}%
- E-E-A-T Signals: {weights['eeat_signals']*100:.0f}%
- Content Quality: {weights['content_quality']*100:.0f}%
- On-Page Keyword Targeting: {weights['keyword_targeting']*100:.0f}%
- Search Snippet Relevance: {weights['snippet_relevance']*100:.0f}%

{f"**Custom Instructions:** {custom_instructions}" if custom_instructions else ""}

Provide detailed scores (0-100) for each enabled category and specific factors. Return ONLY a JSON object with this structure:
{{
  "overall_score": 0-100,
  "category_scores": {{
    "search_intent": 0-100,
    "topical_relevance": 0-100,
    "eeat_signals": 0-100,
    "content_quality": 0-100,
    "keyword_targeting": 0-100,
    "snippet_relevance": 0-100
  }},
  "factor_scores": {{
    "query_intent_classification": 0-100,
    "page_type_alignment": 0-100,
    "funnel_stage_cta_alignment": 0-100,
    "core_topic_coverage": 0-100,
    "subtopic_faq_coverage": 0-100,
    "entity_jargon_coverage": 0-100,
    "author_identity": 0-100,
    "firsthand_experience": 0-100,
    "brand_trust_signals": 0-100,
    "citation_quality": 0-100,
    "clarity_readability": 0-100,
    "originality_value": 0-100,
    "practical_usefulness": 0-100,
    "primary_keyword_placement": 0-100,
    "semantic_variants": 0-100,
    "internal_anchor_optimization": 0-100,
    "title_tag_message_match": 0-100,
    "meta_description_compelling": 0-100,
    "snippet_content_consistency": 0-100
  }},
  "recommendations": {{
    "search_intent": ["recommendation 1", "recommendation 2"],
    "topical_relevance": ["recommendation 1", "recommendation 2"],
    "eeat_signals": ["recommendation 1", "recommendation 2"],
    "content_quality": ["recommendation 1", "recommendation 2"],
    "keyword_targeting": ["recommendation 1", "recommendation 2"],
    "snippet_relevance": ["recommendation 1", "recommendation 2"]
  }},
  "top_keywords": [
    {{"keyword": "word", "importance": "high/medium/low", "density": "1.2%"}}
  ],
  "overall_feedback": "2-3 sentence summary of the SEO quality and main areas for improvement"
}}"""

        try:
            # Call OpenAI with increased token limit for comprehensive analysis
            client = OpenAI(api_key=settings.OPENAI_API_KEY)
            response = client.chat.completions.create(
                model="gpt-4o-mini",  # Using mini for faster/cheaper analysis
                messages=[
                    {
                        "role": "system",
                        "content": "You are an expert SEO analyst specializing in comprehensive content analysis. Evaluate articles based on search intent, topical relevance, E-E-A-T signals, content quality, keyword targeting, and snippet optimization. Provide detailed, actionable recommendations. Always return valid JSON only."
                    },
                    {
                        "role": "user",
                        "content": prompt
                    }
                ],
                temperature=0.3,
                max_tokens=3000,  # Increased for comprehensive analysis
                response_format={"type": "json_object"}
            )
            
            # Parse AI response
            ai_result = json.loads(response.choices[0].message.content)
            
            # Extract category scores
            category_scores = ai_result.get("category_scores", {})
            factor_scores = ai_result.get("factor_scores", {})
            recommendations = ai_result.get("recommendations", {})
            
            # Compile comprehensive analysis data
            analysis_data = {
                "word_count": word_count,
                "headings": {
                    "h1_count": len(headings["h1"]),
                    "h2_count": len(headings["h2"]),
                    "h3_count": len(headings["h3"]),
                    "h1_list": headings["h1"],
                    "h2_list": headings["h2"][:5],  # First 5 H2s
                },
                "category_scores": category_scores,
                "factor_scores": factor_scores,
                "recommendations": recommendations,
                "top_keywords": ai_result.get("top_keywords", []),
                "overall_feedback": ai_result.get("overall_feedback", ""),
                "enabled_factors": enabled_factors,
                "weights": weights,
                "analyzed_with_ai": True,
                "config_id": seo_config.id
            }
            
            # Calculate weighted overall score from category scores
            overall_score = (
                category_scores.get("search_intent", 50) * weights["search_intent"] +
                category_scores.get("topical_relevance", 50) * weights["topical_relevance"] +
                category_scores.get("eeat_signals", 50) * weights["eeat_signals"] +
                category_scores.get("content_quality", 50) * weights["content_quality"] +
                category_scores.get("keyword_targeting", 50) * weights["keyword_targeting"] +
                category_scores.get("snippet_relevance", 50) * weights["snippet_relevance"]
            )
            
            # Update article word count
            article.word_count = word_count
            
            # Create SEO analysis record with backward compatibility
            seo_analysis = SEOAnalysis(
                article_id=article.id,
                overall_score=round(overall_score, 2),
                title_score=round(factor_scores.get("title_tag_message_match", 50), 2),
                heading_score=round(category_scores.get("topical_relevance", 50), 2),
                readability_score=round(factor_scores.get("clarity_readability", 50), 2),
                keyword_density=0,  # AI provides qualitative analysis
                analysis_data=analysis_data
            )
            
            db.add(seo_analysis)
            db.commit()
            db.refresh(seo_analysis)
            
            return seo_analysis
            
        except Exception as e:
            # Fallback to rule-based if AI fails
            print(f"AI analysis failed, falling back to rule-based: {str(e)}")
            return SEOAnalysisService.analyze_article_rule_based(db, article)
    
    @staticmethod
    def analyze_article_rule_based(db: Session, article: Article) -> SEOAnalysis:
        """Fallback: Perform rule-based SEO analysis on an article."""
        # Get plain text
        plain_text = SEOAnalysisService.strip_html(article.content or "")
        
        # Run individual analyses
        title_analysis = SEOAnalysisService.analyze_title(article.title)
        heading_analysis = SEOAnalysisService.analyze_headings(article.content or "")
        readability_analysis = SEOAnalysisService.analyze_readability(plain_text)
        keyword_analysis = SEOAnalysisService.analyze_keyword_density(plain_text)
        
        # Calculate overall score (weighted average)
        overall_score = (
            title_analysis["score"] * 0.25 +
            heading_analysis["score"] * 0.25 +
            readability_analysis["score"] * 0.25 +
            keyword_analysis["score"] * 0.25
        )
        
        # Compile analysis data
        analysis_data = {
            "title_analysis": title_analysis,
            "heading_analysis": heading_analysis,
            "readability_analysis": readability_analysis,
            "keyword_analysis": keyword_analysis,
            "word_count": SEOAnalysisService.count_words(plain_text),
            "analyzed_with_ai": False
        }
        
        # Update article word count
        article.word_count = analysis_data["word_count"]
        
        # Create SEO analysis record
        seo_analysis = SEOAnalysis(
            article_id=article.id,
            overall_score=round(overall_score, 2),
            title_score=round(title_analysis["score"], 2),
            heading_score=round(heading_analysis["score"], 2),
            readability_score=round(readability_analysis["score"], 2),
            keyword_density=round(keyword_analysis["keywords"][0]["density"] if keyword_analysis["keywords"] else 0, 2),
            analysis_data=analysis_data
        )
        
        db.add(seo_analysis)
        db.commit()
        db.refresh(seo_analysis)
        
        return seo_analysis
    
    @staticmethod
    def analyze_article(db: Session, article: Article) -> SEOAnalysis:
        """Perform SEO analysis - uses AI by default, falls back to rule-based if needed."""
        return SEOAnalysisService.analyze_article_with_ai(db, article)

