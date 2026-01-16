from typing import Optional, Dict, Any
from sqlalchemy.orm import Session
from openai import OpenAI
from anthropic import Anthropic
from app.models.ai_generation import AIGeneration
from app.models.article import Article
from app.core.config import settings


class AIContentService:
    def __init__(self, api_key: Optional[str] = None, provider: str = "openai"):
        self.provider = provider
        if provider == "openai":
            api_key_to_use = api_key or settings.OPENAI_API_KEY
            if not api_key_to_use:
                raise ValueError(
                    "OpenAI API key is not configured. Please set OPENAI_API_KEY in your .env file."
                )
            self.client = OpenAI(api_key=api_key_to_use)
        elif provider == "anthropic":
            api_key_to_use = api_key or settings.ANTHROPIC_API_KEY
            if not api_key_to_use:
                raise ValueError(
                    "Anthropic API key is not configured. Please set ANTHROPIC_API_KEY in your .env file."
                )
            self.client = Anthropic(api_key=api_key_to_use)
    
    def generate_content(
        self,
        db: Session,
        user_id: int,
        prompt: str,
        article_id: Optional[int] = None,
        max_tokens: int = 1000
    ) -> Dict[str, Any]:
        """Generate new content from prompt."""
        print(f"[AI Content Service] Generating content for user {user_id}")
        print(f"[AI Content Service] Prompt length: {len(prompt)} chars")
        print(f"[AI Content Service] Provider: {self.provider}")
        try:
            if self.provider == "openai":
                response = self.client.chat.completions.create(
                    model="gpt-4o-mini",
                    messages=[
                        {"role": "system", "content": "You are an expert content writer specializing in SEO-optimized articles."},
                        {"role": "user", "content": prompt}
                    ],
                    max_tokens=max_tokens,
                    temperature=0.7,
                    timeout=55.0  # Set timeout to 55 seconds (less than frontend's 60s)
                )
                
                generated_text = response.choices[0].message.content
                tokens_used = response.usage.total_tokens
            
            elif self.provider == "anthropic":
                response = self.client.messages.create(
                    model="claude-3-sonnet-20240229",
                    max_tokens=max_tokens,
                    messages=[
                        {"role": "user", "content": f"You are an expert content writer. {prompt}"}
                    ]
                )
                
                generated_text = response.content[0].text
                tokens_used = response.usage.input_tokens + response.usage.output_tokens
            
            # Save generation history
            ai_generation = AIGeneration(
                user_id=user_id,
                article_id=article_id,
                prompt=prompt,
                response=generated_text,
                tokens_used=tokens_used
            )
            db.add(ai_generation)
            db.commit()
            db.refresh(ai_generation)
            
            return {
                "content": generated_text,
                "tokens_used": tokens_used,
                "generation_id": ai_generation.id
            }
        
        except Exception as e:
            import traceback
            print(f"[AI Content Service] ERROR: {str(e)}")
            print(f"[AI Content Service] Traceback: {traceback.format_exc()}")
            raise Exception(f"AI generation failed: {str(e)}")
    
    def rewrite_content(
        self,
        db: Session,
        user_id: int,
        content: str,
        instructions: Optional[str] = None,
        article_id: Optional[int] = None
    ) -> Dict[str, Any]:
        """Rewrite existing content with optional instructions."""
        prompt = f"Rewrite the following content"
        if instructions:
            prompt += f" with these instructions: {instructions}\n\n"
        else:
            prompt += " to improve clarity and engagement:\n\n"
        prompt += content
        
        return self.generate_content(db, user_id, prompt, article_id)
    
    def generate_seo_suggestions(
        self,
        db: Session,
        user_id: int,
        article: Article,
        analysis_data: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Generate SEO optimization suggestions based on analysis."""
        prompt = f"""
        Analyze this article and provide specific SEO optimization suggestions:
        
        Title: {article.title}
        Content: {article.content[:1000]}...
        
        Current SEO scores:
        - Overall: {analysis_data.get('overall_score', 0)}/100
        - Title: {analysis_data.get('title_score', 0)}/100
        - Headings: {analysis_data.get('heading_score', 0)}/100
        - Readability: {analysis_data.get('readability_score', 0)}/100
        
        Provide 5 specific, actionable suggestions to improve the SEO score.
        """
        
        return self.generate_content(db, user_id, prompt, article.id, max_tokens=1000)
    
    def expand_content(
        self,
        db: Session,
        user_id: int,
        content: str,
        instructions: Optional[str] = None,
        article_id: Optional[int] = None
    ) -> Dict[str, Any]:
        """Expand content with more details and information."""
        prompt = "Expand the following text with more details, examples, and supporting information. "
        prompt += "Make it comprehensive and informative while maintaining readability and flow"
        if instructions:
            prompt += f". Additional instructions: {instructions}"
        prompt += f":\n\n{content}"
        
        return self.generate_content(db, user_id, prompt, article_id, max_tokens=2500)
    
    def continue_writing(
        self,
        db: Session,
        user_id: int,
        existing_content: str,
        context: Optional[str] = None,
        article_id: Optional[int] = None
    ) -> Dict[str, Any]:
        """Continue writing based on existing content."""
        # Take last 500 words for context
        words = existing_content.split()
        context_text = " ".join(words[-500:]) if len(words) > 500 else existing_content
        
        prompt = f"""Continue writing from where this text left off. Maintain the same tone, style, and topic. 
        Write the next 200-300 words that naturally flow from the existing content.
        
        Existing content (last part):
        {context_text}
        
        Continue writing here:"""
        
        if context:
            prompt = f"{context}\n\n{prompt}"
        
        return self.generate_content(db, user_id, prompt, article_id, max_tokens=1500)

