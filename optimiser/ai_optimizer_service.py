from typing import Dict, Any, Optional
from openai import OpenAI
from app.core.config import settings
import json

class AIOptimizerService:
    """Service for AI-powered article optimization and SEO analysis."""
    
    def __init__(self):
        if not settings.OPENAI_API_KEY:
            raise ValueError(
                "OPENAI_API_KEY is not configured. Please set the OPENAI_API_KEY environment variable. "
                "Get your API key from: https://platform.openai.com/api-keys"
            )
        self.client = OpenAI(api_key=settings.OPENAI_API_KEY)
    
    def optimize_article(
        self,
        article_content: str,
        title: str = "",
        description: str = "",
        industry: str = "general",
        risk_level: str = "low",
        jurisdictions: list = None,
        target_keywords: list = None,
        audience: str = "",
        search_intent: str = "informational",
        locale: str = "en-US",
        voice_tone: str = "professional",
        brand_guidelines: str = "",
        content_brief: str = "",
        focus_urls: list = None,
        mandatory_terms: list = None,
        banned_terms: list = None,
        competitor_urls: list = None,
        mode: str = "full"  # 'full' or 'power'
    ) -> Dict[str, Any]:
        """
        Perform comprehensive SEO article review and optimization.
        
        Args:
            article_content: The full article text
            title: Article title
            description: Meta description
            industry: Industry type (health, finance, legal, general)
            risk_level: Compliance risk (low, med, high)
            jurisdictions: List of countries/states
            target_keywords: Primary and secondary keywords
            audience: Target audience description
            search_intent: User intent type
            locale: Language variant (en-US, en-GB, etc.)
            voice_tone: Brand voice
            brand_guidelines: Brand guidelines text
            content_brief: Content brief
            focus_urls: Focus products/services URLs
            mandatory_terms: Required words/phrases
            banned_terms: Forbidden words/phrases
            competitor_urls: Competitor page URLs
            mode: 'full' or 'power' version
            
        Returns:
            Dict containing scores, compliance report, optimized content, and JSON summary
        """
        
        jurisdictions = jurisdictions or ["US"]
        target_keywords = target_keywords or []
        focus_urls = focus_urls or []
        mandatory_terms = mandatory_terms or []
        banned_terms = banned_terms or []
        competitor_urls = competitor_urls or []
        
        # Build the comprehensive prompt
        if mode == "power":
            prompt = self._build_power_prompt(
                article_content, title, description, industry, risk_level,
                jurisdictions, target_keywords, audience, search_intent,
                locale, voice_tone, brand_guidelines, content_brief,
                focus_urls, mandatory_terms, banned_terms, competitor_urls
            )
        else:
            prompt = self._build_full_prompt(
                article_content, title, description, industry, risk_level,
                jurisdictions, target_keywords, audience, search_intent,
                locale, voice_tone, brand_guidelines, content_brief,
                focus_urls, mandatory_terms, banned_terms, competitor_urls
            )
        
        try:
            response = self.client.chat.completions.create(
                model="gpt-4o",  # or gpt-4-turbo
                messages=[
                    {
                        "role": "system",
                        "content": "You are a senior SEO & editorial lead specializing in E-E-A-T optimization and regulatory compliance."
                    },
                    {
                        "role": "user",
                        "content": prompt
                    }
                ],
                temperature=0.7,
                max_tokens=4000,
            )
            
            result_text = response.choices[0].message.content
            
            # Parse the response
            return {
                "raw_response": result_text,
                "tokens_used": response.usage.total_tokens,
                "model": response.model,
            }
            
        except Exception as e:
            raise Exception(f"AI optimization failed: {str(e)}")
    
    def _build_full_prompt(
        self, article_content, title, description, industry, risk_level,
        jurisdictions, target_keywords, audience, search_intent,
        locale, voice_tone, brand_guidelines, content_brief,
        focus_urls, mandatory_terms, banned_terms, competitor_urls
    ) -> str:
        """Build the full detailed prompt."""
        
        prompt = f"""# SEO Article Review & Optimiser (Regulated-Industry Ready)

**Role**: You are a senior SEO & editorial lead. Read the ENTIRE article and: score E-E-A-T, uniqueness, and usefulness; fix language issues; enforce brand/brief; improve keyword targeting; suggest image alt text; and perform a regulatory & claims compliance check appropriate to the client's industry and jurisdictions. Deliver both a structured report and an optimised article.

## Inputs:

**Article**: 
{article_content}

**Title**: {title or "Not provided"}
**Description**: {description or "Not provided"}

**Industry & Risk Level**: {industry} | {risk_level}
**Jurisdictions**: {', '.join(jurisdictions)}
**Target Keywords**: {', '.join(target_keywords)}
**Audience & Intent**: {audience} | {search_intent}
**Locale & Style**: {locale} | Reading Level: Grade 8-10
**Voice & Tone**: {voice_tone}

**Brand Guidelines**: {brand_guidelines or "Not provided"}
**Content Brief**: {content_brief or "Not provided"}

**Focus Products / Services / Home Page**: {', '.join(focus_urls) if focus_urls else "Not provided"}
**DO Use Words / Required Positioning**: {', '.join(mandatory_terms) if mandatory_terms else "Not provided"}
**DO NOT Use Words / Banned Positioning**: {', '.join(banned_terms) if banned_terms else "Not provided"}

**Competitor URLs**: {', '.join(competitor_urls) if competitor_urls else "Not provided"}

## Hard Rules:
1. Do not fabricate facts or citations. If evidence is missing, flag and suggest credible sources.
2. Apply {locale} for spelling, punctuation, units, and dates.
3. Compliance first: If claims are unsubstantiated or non-compliant, preserve meaning but add [[VERIFY/LEGAL REVIEW]] and propose compliant alternatives.
4. Respect mandatory terms and never use banned terms. If conflicts arise, flag them.

## Deliverables:

### 1) Scored Audit (0–10 each)
- Expertise
- Authoritativeness  
- Trustworthiness
- Uniqueness
- Usefulness
- Final Score: (E + A + T + U + U2) × 0.2
- Priority issue list (P0 critical, P1 high, P2 nice-to-have)

### 2) Grammar, Spelling & Clarity
- Proofread in {locale}
- Fix grammar/clarity
- Show 3–5 before → after samples
- Tag uncertain facts with [[VERIFY]]

### 3) Brand & Brief Compliance
- Check alignment to guidelines and brief
- Verify focus pages are referenced
- Ensure DO use words are included
- Ensure DO NOT use words are avoided
- Provide corrected examples

### 4) Regulatory & Claims Compliance
- Review for {industry} compliance in {', '.join(jurisdictions)}
- Flag non-compliant claims
- Provide compliant rewrites
- Add required disclaimers
- Mark unresolved items with [[LEGAL REVIEW]]

### 5) Keyword Targeting & On-Page SEO
- Validate topic/intent
- Recommend: Title, H1, H2/H3 outline, meta description, slug
- Provide Keyword Table with placements

### 6) Image Alt Text Suggestions
- Descriptive alt text (≤125 chars)
- Incorporate key entities naturally

### 7) Revised Article (Optimised)
- Deliver fully edited Markdown article
- Include front-matter with metadata
- Insert recommended links
- Add disclaimers

### 8) JSON Summary
Provide structured JSON with scores, compliance flags, keyword plan, links, images, and metadata.

Please provide your comprehensive analysis and optimized article now."""

        return prompt
    
    def _build_power_prompt(
        self, article_content, title, description, industry, risk_level,
        jurisdictions, target_keywords, audience, search_intent,
        locale, voice_tone, brand_guidelines, content_brief,
        focus_urls, mandatory_terms, banned_terms, competitor_urls
    ) -> str:
        """Build the compact power version prompt."""
        
        prompt = f"""Read the full article and produce: E-E-A-T/Uniqueness/Usefulness scores (0–10 each), grammar fixes in {locale}, brand & brief compliance (include focus products/services/home page, reference pages, DO/DO NOT words), regulatory & claims compliance for {industry} in {', '.join(jurisdictions)} with required disclaimers/risk warnings and [[LEGAL REVIEW]] tags, keyword plan (title/H1/H2s/meta/FAQ/schema/internal & external links), alt text for images, and a fully revised Markdown article with front-matter. Include a final weighted score and a JSON summary. Do not invent facts; preserve meaning; enforce mandatory terms: {', '.join(mandatory_terms) if mandatory_terms else "none"} and avoid banned terms: {', '.join(banned_terms) if banned_terms else "none"}.

**Article**: 
{article_content}

**Title**: {title}
**Description**: {description}
**Keywords**: {', '.join(target_keywords)}
**Audience**: {audience} | {search_intent}
**Voice**: {voice_tone}
**Industry**: {industry} ({risk_level} risk)

Provide comprehensive analysis and optimized article now."""

        return prompt
    
    def rewrite_selection(
        self,
        selected_text: str,
        instruction: str = "improve",
        brand_tone: str = "Professional",
        target_audience: str = "",
        search_intent: str = "Informational",
        reading_level: str = "Grade 8-10 (Medium)",
        locale: str = "en-US",
        industry: str = "General",
        risk_level: str = "Low",
        jurisdictions: str = "SG",
        do_use_words: str = "",
        do_not_use_words: str = "",
        focus_products: str = "",
        schema_type: str = "Article",
        require_compliance: bool = False
    ) -> str:
        """Rewrite a selected text portion with configuration."""
        
        try:
            # Build context-aware prompt
            system_prompt = f"You are an expert content editor for the {industry} industry (Risk: {risk_level}). "
            system_prompt += f"Write in a {brand_tone} tone using {locale} language conventions. "
            system_prompt += f"Target reading level: {reading_level}. "
            system_prompt += f"Search intent: {search_intent}. "
            if require_compliance:
                system_prompt += f"Ensure compliance with regulations in {jurisdictions}. "
            
            user_prompt = f"Rewrite this text to {instruction}.\n\n"
            
            if target_audience:
                user_prompt += f"Target audience: {target_audience}\n"
            if focus_products:
                user_prompt += f"Focus on these products/services: {focus_products}\n"
            if do_use_words:
                user_prompt += f"MUST include these terms: {do_use_words}\n"
            if do_not_use_words:
                user_prompt += f"AVOID these terms: {do_not_use_words}\n"
            if require_compliance:
                user_prompt += f"Add compliance disclaimers where appropriate.\n"
            
            user_prompt += f"\nText to rewrite:\n{selected_text}"
            
            response = self.client.chat.completions.create(
                model="gpt-4o",
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                temperature=0.7,
                max_tokens=500,
            )
            
            tokens_used = response.usage.total_tokens if response.usage else 0
            return {
                "text": response.choices[0].message.content or selected_text,
                "tokens_used": tokens_used,
                "model": response.model
            }
            
        except Exception as e:
            raise Exception(f"Rewrite failed: {str(e)}")
    
    def expand_text(
        self,
        selected_text: str,
        brand_tone: str = "Professional",
        target_audience: str = "",
        search_intent: str = "Informational",
        reading_level: str = "Grade 8-10 (Medium)",
        locale: str = "en-US",
        industry: str = "General",
        risk_level: str = "Low",
        jurisdictions: str = "SG",
        focus_products: str = "",
        schema_type: str = "Article",
        require_compliance: bool = False
    ) -> str:
        """Expand selected text with more details and configuration."""
        
        try:
            # Build context-aware prompt
            system_prompt = f"You are an expert content writer for the {industry} industry (Risk: {risk_level}). "
            system_prompt += f"Write in a {brand_tone} tone using {locale} language conventions. "
            system_prompt += f"Target reading level: {reading_level}. "
            system_prompt += f"Search intent: {search_intent}. "
            if require_compliance:
                system_prompt += f"Ensure compliance with regulations in {jurisdictions}. "
            
            user_prompt = "Expand this text with more details, examples, and explanations.\n\n"
            
            if target_audience:
                user_prompt += f"Target audience: {target_audience}\n"
            if focus_products:
                user_prompt += f"Focus on these products/services: {focus_products}\n"
            if require_compliance:
                user_prompt += f"Add compliance disclaimers where appropriate.\n"
            
            user_prompt += f"\nText to expand:\n{selected_text}"
            
            response = self.client.chat.completions.create(
                model="gpt-4o",
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                temperature=0.7,
                max_tokens=800,
            )
            
            tokens_used = response.usage.total_tokens if response.usage else 0
            return {
                "text": response.choices[0].message.content or selected_text,
                "tokens_used": tokens_used,
                "model": response.model
            }
            
        except Exception as e:
            raise Exception(f"Expand failed: {str(e)}")
    
    def shorten_text(
        self,
        selected_text: str,
        brand_tone: str = "Professional",
        search_intent: str = "Informational",
        reading_level: str = "Grade 8-10 (Medium)",
        locale: str = "en-US",
        industry: str = "General",
        risk_level: str = "Low",
        jurisdictions: str = "SG"
    ) -> str:
        """Shorten selected text while keeping key points and using configuration."""
        
        try:
            # Build context-aware prompt
            system_prompt = f"You are an expert content editor for the {industry} industry (Risk: {risk_level}). "
            system_prompt += f"Write in a {brand_tone} tone using {locale} language conventions. "
            system_prompt += f"Target reading level: {reading_level}. "
            system_prompt += f"Search intent: {search_intent}. "
            system_prompt += "Make text concise while preserving key information."
            
            user_prompt = f"Shorten this text while keeping the main points:\n\n{selected_text}"
            
            response = self.client.chat.completions.create(
                model="gpt-4o",
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                temperature=0.7,
                max_tokens=300,
            )
            
            tokens_used = response.usage.total_tokens if response.usage else 0
            return {
                "text": response.choices[0].message.content or selected_text,
                "tokens_used": tokens_used,
                "model": response.model
            }
            
        except Exception as e:
            raise Exception(f"Shorten failed: {str(e)}")
    
    def generate_alt_text(
        self,
        context: str,
        current_alt: str = "",
        brand_tone: str = "Professional",
        industry: str = "General",
        target_audience: str = ""
    ) -> str:
        """Generate SEO-friendly alt text for images based on surrounding context."""
        
        try:
            system_prompt = f"You are an expert SEO and accessibility specialist for the {industry} industry. "
            system_prompt += "Generate concise, descriptive alt text for images that is both SEO-friendly and accessible. "
            system_prompt += "Alt text should be under 125 characters, descriptive, and include relevant keywords naturally."
            
            user_prompt = "Generate alt text for an image based on the surrounding article context.\n\n"
            user_prompt += f"Article context:\n{context}\n\n"
            
            if current_alt:
                user_prompt += f"Current alt text (improve if needed): {current_alt}\n\n"
            
            if target_audience:
                user_prompt += f"Target audience: {target_audience}\n"
            
            user_prompt += "\nProvide ONLY the alt text (no quotes, no explanation), maximum 125 characters."
            
            response = self.client.chat.completions.create(
                model="gpt-4o",
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                temperature=0.7,
                max_tokens=100,
            )
            
            # Clean up the response - remove quotes if present
            alt_text = response.choices[0].message.content or ""
            alt_text = alt_text.strip().strip('"').strip("'")
            
            # Ensure it's under 125 characters
            if len(alt_text) > 125:
                alt_text = alt_text[:122] + "..."
            
            tokens_used = response.usage.total_tokens if response.usage else 0
            return {
                "alt_text": alt_text,
                "tokens_used": tokens_used,
                "model": response.model
            }
            
        except Exception as e:
            raise Exception(f"Alt text generation failed: {str(e)}")

