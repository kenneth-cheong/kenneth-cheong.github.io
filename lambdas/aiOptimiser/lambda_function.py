import json
import os
import re
import requests
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

# ==============================================================================
# SYSTEM MESSAGE 1: STATIC CONSTITUTION
# This never changes between requests. It defines the AI's identity,
# universal quality standards, and absolute rules.
# ==============================================================================
SYSTEM_MSG_CONSTITUTION = """
You are an expert SEO & GEO content editor trained on the latest Search Quality 
Rater Guidelines (E-E-A-T). Your goal is to create high-quality, authoritative 
content that genuinely serves readers while being optimized for both traditional 
search engines and AI-powered search (ChatGPT, Gemini, Perplexity).

IMPORTANT OUTPUT RULE:
DO NOT wrap your response in markdown code blocks like ```markdown or ```.
Return raw text/markdown content only.

================================================================
UNIVERSAL QUALITY STANDARDS
================================================================

TONE & VOICE RULES (apply to ALL content types):
- Write in third-person, objective language by default
- In conversational formats (lifestyle, food, parenting), a warmer tone 
  is acceptable — but never fabricate first-person anecdotes or personal 
  experience claims to simulate authority
- Never invent statistics, ratings, or performance figures without a 
  cited, verifiable source. If no source exists, rephrase as general 
  market context or remove the claim entirely
- Maintain consistent tone throughout — do not shift between formal 
  technical writing and casual blog writing within the same article
- Eliminate filler phrases that carry no real informational value:
    * "This is very important for many people"
    * "In today's fast-paced world..."
    * "More and more people are choosing..."
    * "This is a must-have for anyone who..."
    * "In conclusion, [TOPIC] is very important for everyone"

================================================================
REQUIRED STRUCTURAL ELEMENTS (adapt to content type)
================================================================

Every article must include the following, adapted to suit the topic:

1. DEFINITION & OVERVIEW
   - Precise definition or description of what the topic is
   - Who it is for and what problem it solves
   - Bulleted list of primary features, functions, or offerings
   - Scope boundaries: what it is NOT or does NOT cover

2. HOW IT WORKS / WHAT TO EXPECT
   - For products: operating principle or underlying technology
   - For services: step-by-step service delivery or customer journey
   - For experiences (restaurants, travel): flow from arrival to completion
   - Break into sub-types if the process differs significantly between variants

3. TYPES, VARIANTS, OR TIERS
   - Use recognized industry/market classifications only
   - For each type: what it is, who it suits, advantages, limitations
   - Do NOT invent classification categories

4. COMPARISON TABLE
   - 4–6 leading options, providers, brands, or variants
   - Consistent columns relevant to the content type
   - Flag indicative values that are subject to change
   - Do NOT fabricate reviews, ratings, or scores

5. SELECTION / HOW TO CHOOSE GUIDE
   - Numbered, decision-oriented steps
   - Frame each step as a question the reader should ask themselves
   - Include at least one reference table, checklist, or decision framework
   - Address contextual factors: budget, location, use case, environment

6. PRACTICAL GUIDE (installation / onboarding / visit tips)
   - Numbered steps for sequential processes
   - Bullet points for non-sequential tips or precautions

7. TROUBLESHOOTING / COMMON ISSUES TABLE
   - Minimum 5–6 entries
   - Three columns adapted to content type:
     * Products:     Symptom | Probable Cause | Recommended Action
     * Services:     Common Concern | Why It Happens | What To Do
     * Experiences:  Common Disappointment | Likely Reason | How To Avoid

8. STANDARDS, ACCREDITATIONS, OR CREDENTIALS (where applicable)
   - Table format: Standard/Body | Region | What It Means for the Reader
   - Explain certifications in plain terms
   - Note that requirements vary by market

9. FAQ SECTION
   - Minimum 10 questions using natural language phrasing
   - Must include at least:
     * One question about cost or pricing expectations
     * One question about a common misconception
     * One question about evaluating quality or making the right choice
     * One question about what happens when things go wrong
     * One question about an edge case or exception

================================================================
TECHNICAL ACCURACY RULES
================================================================

- Only use classifications recognized within the relevant industry
- Where behavior or quality varies by provider/model/location, 
  state this explicitly rather than generalizing
- Distinguish between what is universal/standard vs. provider-dependent
- Do not overstate capabilities, guarantees, or outcomes
- Note limitations and exceptions honestly
- Describe mechanism chains accurately 
  (cause → physical/process effect → detection → response)
  rather than oversimplifying to "sensor detects and triggers"

================================================================
E-E-A-T CONTENT GUIDELINES
================================================================

1. EXPERIENCE: Include reviews, use cases, or anecdotal evidence 
   where possible. Use phrases like "Based on reported findings" 
   or "In documented cases" — never fabricated personal claims.
2. EXPERTISE: Provide deep, focused subject matter coverage 
   confined to the intent of the keyword/topic.
3. AUTHORITATIVENESS: Reference credible sources and cite them 
   using absolute HTML hyperlinks (<a href="URL">text</a>).
   Do NOT use bracketed placeholders like [Source: Name].
4. TRUSTWORTHINESS: Be honest about limitations, scope boundaries,
   and where professional advice should be sought.
5. READABILITY: Write for clarity. Use simple language, avoid 
   unnecessary jargon, and keep sentences and paragraphs short.

================================================================
FORMATTING RULES
================================================================

- Use clear header hierarchy: H2 for major sections, H3 for subsections
- Use bulleted lists for unordered items, numbered lists for steps
- Use Markdown tables for comparisons and structured data
- Include media placeholders with descriptive captions:
    [IMAGE: description of what the image should show]
    [INFOGRAPHIC: description of data to visualize]
    [VIDEO: description of process to demonstrate]
- Avoid multiple empty lines between sections
- Every article must include at minimum:
    * 1 comparison table
    * 1 selection reference table or decision checklist
    * 1 troubleshooting or common issues table

================================================================
SEO & GEO OPTIMIZATION RULES
================================================================

- Place the primary focus keyword in the H1 title
- Use long-tail keyword variants naturally in H2/H3 subheadings, 
  FAQ phrasing, and opening/closing of major sections
- Do NOT keyword-stuff — every instance must serve the reader first
- Write FAQ entries as full natural-language questions that mirror 
  how people actually search (voice search friendly)
- Write to function as pillar/cornerstone content: comprehensive 
  enough to be cited by AI systems as an authoritative source
- The Definition/Overview section must be self-contained enough 
  to be used as a direct answer snippet

================================================================
ABSOLUTE PROHIBITIONS
================================================================

Never include the following regardless of content type:
- First-person anecdotes presented as fact or expertise
- Unverified statistics or outcome figures
- Classification categories not recognized by the relevant industry
- Vague advice without specific, actionable guidance
- Filler sentences that restate the obvious
- Redundant section summaries that only repeat what was just said
- Hype language without evidence: "world-class", "revolutionary", 
  "unparalleled", "best-in-class"
- Content that reads like it was written to fill word count 
  rather than answer a real reader question
"""


def build_dynamic_system_msg(
    content_type, target_reader, tone_register,
    primary_keyword, secondary_keywords,
    settings, linking_guidelines
):
    """
    SYSTEM MESSAGE 2: DYNAMIC ASSIGNMENT BRIEF
    Built per-request. Tells the AI what KIND of content it is writing,
    who it is writing for, and what the keyword/commercial context is.
    This separates the stable rules (Message 1) from the variable
    parameters (Message 2).
    """

    content_type_guidance = {
        "hardware":     "Apply full technical depth. Use IEC/ISO/ANSI/UL/JIS standards where relevant. Include formulas, spec tables, and wiring/installation guidance.",
        "software":     "Focus on use cases, integration steps, pricing tiers, and compatibility. Avoid over-technical implementation detail unless audience is developer-level.",
        "service":      "Focus on service delivery process, provider comparison, onboarding steps, and outcome expectations. Avoid fabricated testimonials.",
        "educational":  "Focus on curriculum, teaching methodology, student outcomes, enrolment process, and how to evaluate quality. Address both student and parent perspectives.",
        "fnb":          "Focus on cuisine, dining experience, menu highlights, ambience, and practical visit planning. Include dietary options and reservation tips.",
        "healthcare":   "Maintain clinical accuracy. Avoid making diagnostic or treatment claims. Always recommend consulting a qualified professional for individual cases.",
        "travel":       "Focus on practical logistics, experience quality, and situational advice. Include seasonal considerations and accessibility notes.",
        "ecommerce":    "Focus on product specifications, use cases, buyer considerations, and return/warranty policies. Avoid fabricated reviews.",
        "general":      "Apply universal quality standards. Match depth and vocabulary to the specified target reader and tone register."
    }.get(content_type.lower(), "Apply universal quality standards appropriate to the content type.")

    msg = f"""
================================================================
ASSIGNMENT BRIEF FOR THIS REQUEST
================================================================

CONTENT TYPE: {content_type}
CONTENT TYPE GUIDANCE: {content_type_guidance}

TARGET READER: {target_reader}
TONE REGISTER: {tone_register}

KEYWORD TARGETING:
{f"- PRIMARY FOCUS KEYWORD: '{primary_keyword}' — prioritize in H1, definition section, FAQ phrasing, and section openings." if primary_keyword else "- No primary keyword specified. Write for topical authority and reader value."}
{f"- SECONDARY KEYWORDS: {secondary_keywords} — include naturally only where they serve the reader. Do not force them." if secondary_keywords else ""}

AUDIENCE CONTEXT:
- Target Audience: {settings.get('audience', 'General')}
- Brand Tone: {settings.get('brandTone', 'Professional')}
- Target Market / Locale: {settings.get('locale', 'Global')}
- Industry: {settings.get('industry', 'General')}

{linking_guidelines}
"""
    return msg.strip()


def build_linking_guidelines(settings, action):
    """Builds the external linking strategy block if applicable."""
    if not (settings.get('suggestExternalLinks', False) or action == "add_links"):
        return ""

    target_locale   = settings.get('locale', 'Global')
    target_industry = settings.get('industry', 'General')

    return f"""
EXTERNAL LINKING STRATEGY:
1. CITATIONS: Proactively suggest links to credible external sources 
   to back up claims, statistics, or statements.
   - PREFERRED SOURCES: Government (.gov), Educational (.edu), 
     Major News Outlets, and established Industry Authorities.
2. COMPETITOR AVOIDANCE:
   - Target Market: {target_locale}
   - Industry: {target_industry}
   - RULE: Do NOT link to commercial entities that are direct 
     competitors in the {target_industry} space within {target_locale}.
   - ACCEPTABLE: You MAY link to commercial sources if they are 
     clearly NOT direct competitors in the target market 
     (e.g. tools, complementary services, or global brands 
     if targeting a local audience).
"""


def build_user_msg(action, content, prompt_override):
    """
    USER MESSAGE: Task instruction only.
    Kept deliberately lean — all quality rules and context
    live in the system messages above.
    """
    if action == "generate":
        if "CURRENT CONTENT:" in prompt_override:
            return (
                f"Task: Generate ONLY the specific additions required by "
                f"this SEO recommendation:\n\n{prompt_override}\n\n"
                f"RULES:\n"
                f"1. Do NOT return the entire article.\n"
                f"2. Do NOT duplicate existing content.\n"
                f"3. Return ONLY the new HTML fragment.\n"
                f"4. Ensure the style matches the provided context "
                f"but acts as a standalone addition."
            )
        return (
            f"Generate comprehensive, structured content following all "
            f"the guidelines above based on this prompt:\n\n{prompt_override}"
        )

    elif action == "rewrite":
        return (
            f"Rewrite the following content to strictly follow all quality, "
            f"E-E-A-T, and formatting guidelines above:\n\n{content}"
        )

    elif action == "expand":
        return (
            f"Expand the following content with greater depth, additional "
            f"sections where missing (refer to required structure above), "
            f"media placeholders, and a fuller FAQ section:\n\n{content}"
        )

    elif action == "shorten":
        return (
            f"Shorten the following content while preserving all E-E-A-T "
            f"principles, key facts, and grade-school readability. "
            f"Remove filler and redundancy first:\n\n{content}"
        )

    elif action == "simplify":
        return (
            f"Simplify the language of the following content for a "
            f"grade-school reading level. Preserve all factual accuracy, "
            f"structure, and meaning:\n\n{content}"
        )

    elif action == "continue":
        return (
            f"Continue writing the following content. The next sections "
            f"must follow all required structural elements and formatting "
            f"rules defined above. Do not repeat what has already been "
            f"written:\n\n{content}"
        )

    elif action == "add_links":
        return (
            f"Review the following HTML content and insert credible "
            f"external citations following the linking strategy above.\n\n"
            f"RULES:\n"
            f"1. PRESERVE all existing HTML tags exactly as they are.\n"
            f"2. INSERT at least 3–10 real, credible external links "
            f"embedded directly into sentence structure.\n"
            f"3. FORMAT: <a href=\"URL\" title=\"URL\">anchor text</a>\n"
            f"4. Do NOT append bracketed sources.\n"
            f"5. Return the full content as a valid HTML fragment.\n\n"
            f"CONTENT:\n{content}"
        )

    elif action == "translate":
        return (
            f"Translate the following content to English. Maintain all "
            f"structural elements (Markdown headers, lists, tables) and "
            f"original meaning precisely.\n\n"
            f"CONTENT:\n{content if content else prompt_override}"
        )

    elif action == "outline":
        return (
            f"Generate a detailed article outline for the following topic. "
            f"Use hierarchical headers (H2, H3) and descriptive bullet "
            f"points only. Reference the required structural elements above "
            f"to ensure no major section is missed. Do NOT write full "
            f"paragraphs, introductions, or FAQs unless specifically "
            f"requested.\n\nTOPIC: {prompt_override}"
        )

    return None


# ── STRUCTURED ACTIONS ────────────────────────────────────────────────────────
# Prompts for these actions are built server-side from structured data.
# The frontend sends only dynamic parameters — never the raw prompt text.

_STRUCTURED_ACTIONS = {
    'news_classify', 'html_fragment', 'luxury_copy', 'serp_analysis',
    'content_outline', 'content_section', 'content_polish', 'strategy_url_research',
    'image_alt_rationale'
}


def build_structured_prompt(action, body):
    """Return (system_str, user_str) for a structured action, or (None, None) if unknown."""

    if action == 'news_classify':
        articles = body.get('articles', [])
        date_str = body.get('date', '')
        article_list = '\n'.join(
            '[{i}] title: "{t}" | source: "{s}" | date: "{d}" | url: "{u}" | description: "{desc}"'.format(
                i=idx + 1,
                t=a.get('title', ''),
                s=a.get('source', ''),
                d=a.get('date', ''),
                u=a.get('url', ''),
                desc=(a.get('description') or '').replace('"', "'")
            )
            for idx, a in enumerate(articles)
        )
        system = (
            "You are an SEO Expert classifying and prioritising real SEO news articles "
            "for a digital marketing agency."
        )
        user = (
            "The following articles were fetched live from trusted SEO publication RSS feeds. "
            "Each has a REAL, VERIFIED URL from the feed — you MUST copy each URL EXACTLY as provided, "
            "with NO modifications.\n\n"
            f"ARTICLES TO CLASSIFY:\n{article_list}\n\n"
            f"Today's date is {date_str}.\n\n"
            "Your task: Select the 20–25 most important/relevant articles from the list above and classify each one.\n"
            "RULES:\n"
            "- DO NOT invent new articles — only use articles from the list above.\n"
            "- DO NOT modify URLs — copy the \"url\" field verbatim for each article.\n"
            "- Exclude generic SEO tips, clickbait, speculative rumours without corroboration.\n"
            "- Prioritise: Google algorithm updates, SERP changes, AI Overview/SGE news, ranking volatility, technical SEO changes.\n"
            "- Do NOT include low-quality articles that are merely opinion pieces without substance.\n"
            "- Ensure date coverage across the full date range if possible.\n"
            "- Return ONLY a JSON array (no markdown), each item having:\n"
            '  - "id": original article index (1-based)\n'
            '  - "title": verbatim from article\n'
            '  - "source": verbatim from article\n'
            '  - "date": verbatim from article\n'
            '  - "url": verbatim from article — NEVER modify\n'
            '  - "category": one of "Google Algorithm","SERP Changes","AI & Search","Technical SEO",'
            '"Content & E-E-A-T","Link Building","Tools & Platforms","Industry News"\n'
            '  - "subcategory": optional refined label\n'
            '  - "summary": your 1-2 sentence summary based on title and description\n'
            '  - "impact_score": integer 1-10\n'
            '  - "confidence_score": integer 1-10 (10 = official Google confirmation, 1 = unverified rumour)\n'
            '  - "immediate_risk": one of "Critical","High","Medium","Low","Monitor Only"\n'
            '  - "affected_factors": array from: ["Content Quality & Relevance","Backlink Authority",'
            '"Technical SEO","On-Page Optimisation","UX Signals","SERP / External Context"]\n'
            '  - "affected_industries": array of most affected industries\n'
            '  - "what_happened": 1-2 sentence factual description\n'
            '  - "why_it_matters": 1-2 sentence explanation of agency impact\n'
            '  - "what_to_monitor": specific metric or signal to watch\n'
            '  - "recommended_actions": array of 1-3 concrete specific actions (NOT generic advice)\n'
            '  - "urgency": one of "Immediate","High","Medium","Low"\n\n'
            "Return ONLY a JSON array, no other text."
        )
        return system, user

    elif action == 'html_fragment':
        recommendation  = body.get('recommendation', '')
        specific_hints  = body.get('specificHints', '')
        persona_context = body.get('personaContext', '')
        selected_topics = body.get('selectedTopics', '')
        persona_block   = f"\nSTRICTLY ADHERE TO THESE TARGET PERSONAS:\n{persona_context}" if persona_context else ''
        topics_block    = f"\nPRIORITIZE ADDRESSING THESE COMPETITOR TOPICS:\n{selected_topics}" if selected_topics else ''
        system = "You are an expert SEO content specialist generating targeted HTML fragments."
        user = (
            f'SEO RECOMMENDATION TO IMPLEMENT: "{recommendation}"{specific_hints}\n\n'
            "TASK: Generate ONLY the new HTML fragment needed to fulfill this recommendation.\n"
            f"{persona_block}{topics_block}\n\n"
            "PLACEMENT INSTRUCTION: Also determine the ideal placement for this new content. "
            "Prepend your response with a tag:\n"
            "- [PLACEMENT: TOP] for titles/intros.\n"
            "- [PLACEMENT: BOTTOM] for bios/FAQs.\n"
            "- [PLACEMENT: AFTER_H2: (exact text of heading)] for middle-section expansions.\n\n"
            "IMPORTANT: DO NOT return the original article headings or paragraphs. "
            "Return ONLY the tag and the new HTML fragment."
        )
        return system, user

    elif action == 'luxury_copy':
        content_type_label = body.get('contentTypeLabel', 'caption')
        f                  = body.get('fields', {})
        sample_text        = body.get('sampleText', '')
        brand_guide_text   = body.get('brandGuideText', '')
        webpage_text       = body.get('webpageText', '')
        creative_name      = body.get('creativeName', '')
        creative_inst      = body.get('creativeInstruction', '')

        def _line(label, val):
            return f"- {label}: {val}\n" if val else ''

        tone       = (f.get('tone') or '').strip()
        pov        = (f.get('pov') or '').strip()
        brand_name = (f.get('brandName') or '').strip()
        tone_lower = tone.lower()

        # ── 1. Dynamic system prompt derived from platform + tone + brand ─────
        platform_role = {
            'instagram-caption': 'Instagram caption writer',
            'linkedin-post':     'LinkedIn content strategist',
            'facebook-post':     'Facebook community copywriter',
            'blog-article':      'long-form blog writer',
        }.get(content_type_label, 'social media copywriter')

        tone_descriptor = tone if tone else 'engaging and on-brand'
        brand_clause    = f' for {brand_name}' if brand_name else ''
        context_clause  = (
            ' Derive your voice strictly from the brand guide and sample reference provided.'
            if (brand_guide_text or sample_text)
            else ' Infer brand positioning from the brief and write accordingly.'
        )
        system = (
            f"You are an expert {platform_role}{brand_clause}. "
            f"Your writing voice is {tone_descriptor}.{context_clause}"
        )

        # ── 2. Platform-specific base rules ───────────────────────────────────
        PLATFORM_RULES = {
            'instagram-caption': [
                "Hook the reader in the very first sentence — no warm-up, no brand name opener.",
                "Write for a visual medium: the image carries context, so words amplify mood rather than describe what's shown.",
                "Structure as 2–3 short punchy paragraphs with natural line breaks for mobile readability.",
                "End with a soft CTA or open question that invites saves, shares, or comments.",
            ],
            'linkedin-post': [
                "Open with a single bold insight or statement that earns the scroll-stop — no brand name opener, no 'We are excited to...'",
                "Structure: hook → insight or story → value → CTA. Use generous line breaks for feed readability.",
                "Write with authority but without jargon — precision and clarity outperform buzzwords.",
                "End with a question or directive that invites comments or shares.",
            ],
            'facebook-post': [
                "Open conversationally — speak directly to the reader's situation or emotion.",
                "Keep paragraphs to 1–2 sentences for mobile readability.",
                "Balance promotional intent with genuine community value; prioritise connection over conversion.",
                "CTA should feel like a natural next step, not a hard sell.",
            ],
            'blog-article': [
                "Open with a compelling scene, stat, or question that frames the topic — never a brand introduction.",
                "Use clear subheadings; each section should deliver standalone value.",
                "Vary sentence length to maintain reading pace — mix long and short.",
                "Close with a synthesis or CTA that ties back to the opening hook.",
            ],
        }
        rules = list(PLATFORM_RULES.get(content_type_label, [
            "Open with something that earns the reader's attention — never the brand name.",
            "Structure content with a clear arc: hook → value → CTA.",
            "Vary sentence rhythm for readability.",
            "End with a purposeful call to action.",
        ]))

        # ── 3. Tone-aware rules (additive, matched against tone field) ────────
        TONE_RULES = [
            (('playful', 'fun', 'irreverent', 'witty', 'humorous', 'cheeky'), [
                "Use unexpected turns of phrase, wordplay, or light humour where it fits naturally.",
                "Keep energy high — short sentences, active voice, zero stiffness.",
            ]),
            (('luxury', 'premium', 'aspirational', 'elegant', 'sophisticated', 'high-end'), [
                "Lead with sensory, atmospheric language — immerse the reader before informing them.",
                "Every word earns its place; remove anything generic or filler.",
                "Speak to the reader's identity and aspirations, not to features or specs.",
            ]),
            (('professional', 'corporate', 'formal', 'authoritative', 'expert'), [
                "Be specific and substantive — precision over flourish.",
                "Avoid superlatives without evidence; credibility comes from clarity.",
            ]),
            (('warm', 'friendly', 'conversational', 'approachable', 'human', 'casual'), [
                "Write like you're talking to someone you know — genuine, not salesy.",
                "Use contractions and natural speech patterns where it feels right.",
            ]),
            (('inspirational', 'motivational', 'empowering', 'bold'), [
                "Speak to the reader's potential and transformation, not the brand's features.",
                "Use inclusive language ('we', 'you') to make the reader part of the story.",
            ]),
            (('educational', 'informative', 'helpful', 'practical'), [
                "Lead with the most useful insight — don't bury the takeaway.",
                "Use plain language; define any specialist terms in context.",
            ]),
        ]
        for keywords, tone_additions in TONE_RULES:
            if any(k in tone_lower for k in keywords):
                rules.extend(tone_additions)
                break

        # ── 4. Brand context and voice consistency rules ───────────────────────
        if brand_guide_text or sample_text:
            rules.append(
                "Voice must reflect the brand guide and sample reference precisely — "
                "adopt their vocabulary, rhythm, and register. Do not default to a generic style."
            )
        elif brand_name:
            rules.append(
                f"Infer {brand_name}'s editorial tone from your knowledge of the brand. "
                "Never default to a generic style."
            )

        rules.append(
            "Weave the brand name naturally mid-copy or in the closing line — never as the sentence opener."
            if brand_name else
            "Do not open with the brand name."
        )

        # ── 5. Format mechanics ───────────────────────────────────────────────
        emojis_val   = (f.get('emojis') or '').strip().lower()
        hashtags_val = (f.get('hashtags') or '').strip().lower()
        if emojis_val in ('yes', 'true', '1', 'include'):
            rules.append("Include 1–3 relevant emojis placed naturally within the copy — never clustered at the end.")
        else:
            rules.append("Do not include emojis.")
        if hashtags_val in ('yes', 'true', '1', 'include'):
            rules.append("Add 5–10 relevant hashtags as a separate block after the caption body.")
        else:
            rules.append("Do not include hashtags.")

        rules_text = '\n'.join(f"{i + 1}. {r}" for i, r in enumerate(rules))

        # ── 6. User message ───────────────────────────────────────────────────
        user = (
            f"Generate a {content_type_label} based on the brief below.\n\n"
            "STRATEGY\n"
            f"{_line('Post Role', f.get('postRole'))}"
            f"{_line('Strategy Context', f.get('strategyFit'))}"
            f"{_line('Core Message', f.get('coreMessage'))}"
            "AUDIENCE\n"
            f"{_line('Brand Name', brand_name)}"
            f"{_line('Target Sub-Groups', f.get('subgroups'))}"
            f"{_line('Pain Points', f.get('painpoints'))}"
            f"{_line('Audience Goals', f.get('audienceGoal'))}"
            "CONTENT BRIEF\n"
            f"{_line('Product / Service', f.get('productService'))}"
            f"{_line('Core Topic', f.get('postInfo'))}"
            f"{_line('Desired CTA', f.get('desiredAction'))}"
            f"{_line('USP', f.get('usp'))}"
            f"{_line('Constraints / Mandatories', f.get('constraints'))}"
            "BRAND & FORMAT\n"
            f"{_line('Brand POV', pov)}"
            f"{_line('Tone of Voice', tone)}"
            f"{_line('Language', f.get('language'))}"
            f"{_line('Word Count', f.get('wordCount'))}"
            f"{'SAMPLE REFERENCE (match this style and voice exactly):' + chr(10) + sample_text + chr(10) if sample_text else ''}"
            f"{'BRAND GUIDE CONTEXT:' + chr(10) + brand_guide_text + chr(10) if brand_guide_text else ''}"
            f"{'REFERENCE CONTENT:' + chr(10) + webpage_text + chr(10) if webpage_text else ''}"
            f"WRITING RULES — apply every rule without exception:\n{rules_text}\n"
            f"{'CREATIVE APPROACH FOR THIS VARIATION — ' + creative_name.upper() + ': ' + creative_inst + chr(10) if creative_name else ''}"
            f"\nOutput ONLY the finished {content_type_label} — no meta-commentary, no explanations, no labels. "
            "Ready to publish."
        )
        return system, user

    elif action == 'serp_analysis':
        serp_results  = body.get('serpResults', [])
        target_domain = body.get('targetDomain', '')
        keyword       = body.get('keyword', '')
        all_keywords  = body.get('allKeywords', [keyword])
        all_kw_label  = ', '.join(all_keywords)
        multi         = len(all_keywords) > 1
        kw_label      = (
            f'keywords "{all_kw_label}" (SERP fetched for primary: "{keyword}")'
            if multi else f'keyword "{keyword}"'
        )
        target_kw   = f'all of the target keywords ({all_kw_label})' if multi else f'"{keyword}"'
        multi_block = (
            f'\nALL TARGET KEYWORDS: {all_kw_label}\n'
            'Optimise recommendations for ALL target keywords, not just the primary one.\n'
        ) if multi else ''

        system = (
            "You are an expert SEO strategist specializing in SERP analysis and competitive intelligence."
        )
        user = (
            f"Analyse the following top {len(serp_results)} Google SERP results for the {kw_label} "
            "and provide a SERP competitor analysis with URL mapping recommendation.\n\n"
            f"TARGET DOMAIN (our site): {target_domain}\n"
            f"{multi_block}"
            f"SERP RESULTS:\n{json.dumps(serp_results, indent=2)}\n\n"
            "YOUR TASKS:\n"
            '1. For each SERP result, classify its page_type as one of: "blog", "service", "product", '
            '"homepage", "category", "other". Root domain URLs MUST be classified as "homepage".\n'
            "2. Identify the competitor with the LOWEST domain authority (DA) ranking in the top 20.\n"
            f'3. On the target domain "{target_domain}", determine the most relevant existing URL that could rank '
            f"for {target_kw}. If none exists, suggest creating a new page.\n"
            '4. If suggesting a new page, classify it as: "Blog Page", "Service Page", or "Product Page" '
            "based on keyword intent.\n\n"
            "Return ONLY valid JSON in this exact format:\n"
            "{\n"
            '  "serp_results": [\n'
            '    { "rank": 1, "url": "...", "title": "...", "description": "...", "da": 0, '
            '"page_type": "blog|service|product|homepage|category|other" }\n'
            "  ],\n"
            '  "recommendation": {\n'
            '    "target_url": "<URL on target domain or suggested new URL path>",\n'
            '    "existing_or_new": "Existing|New",\n'
            '    "suggested_page_type": "Blog Page|Service Page|Product Page|N/A",\n'
            '    "weakest_competitor": { "url": "...", "da": 0, "page_type": "..." },\n'
            '    "rationale": "<explanation>",\n'
            '    "suggested_improvements": "<SEO/content recommendations>"\n'
            "  }\n"
            "}"
        )
        return system, user

    elif action == 'content_outline':
        topic           = body.get('topic', '')
        keyword         = body.get('keyword', '')
        page_type       = body.get('pageTypeContext', 'Any')
        persona_context = body.get('personaContext', '')
        deep_compare    = body.get('deepCompareContext', '')
        selected_topics = body.get('selectedTopics', '')
        target_wc       = int(body.get('targetWordCount', 0) or 0)
        locale          = body.get('locale', 'Global')
        wc_block = (
            f"⚠️ MANDATORY TARGET WORD COUNT: {target_wc} words. You MUST plan enough sections and depth "
            f"to achieve this word count. Each section should average ~{round(target_wc / 8)} words. "
            "If the target is high, add more H2 sections and deeper H3 sub-topics. This is a hard requirement.\n"
        ) if target_wc > 0 else ''
        persona_block = (
            f"THE OUTLINE MUST BE SPECIFICALLY TAILORED TO THESE PERSONAS:\n{persona_context}\n"
        ) if persona_context else ''

        system = (
            "You are an expert SEO content strategist specializing in structured article outlines "
            "optimized for search and E-E-A-T signals."
        )
        user = (
            "Generate a structured article outline (H1, H2, H3) for the following topic and keyword.\n"
            f"TARGET PAGE TYPE: {page_type}\n"
            f"{persona_block}"
            f"{deep_compare}\n"
            f"PRIORITIZE INCLUDING THESE CHERRY-PICKED TOPICS IDENTIFIED FROM COMPETITOR RESEARCH:\n{selected_topics}\n\n"
            f'TOPIC: "{topic}"\n'
            f'PRIMARY KEYWORD: "{keyword}"\n\n'
            f"{wc_block}"
            "INSTRUCTIONS:\n"
            "1. Ensure the outline is unique and high-value.\n"
            "2. Cover the cherry-picked topics comprehensively.\n"
            "3. Account for EEAT principles.\n"
            '4. Include a single consolidated "Frequently Asked Questions (FAQ)" as the LAST H2 section '
            "with 4-6 relevant questions as H3 sub-items. Do NOT scatter FAQ-style content across other sections.\n"
            "5. The Conclusion/Summary section MUST be the SECOND-TO-LAST H2, appearing right before the FAQ. "
            "Do NOT place any conclusion/wrap-up content in the middle of the outline.\n"
            "6. Output in a clear, editable text format.\n\n"
            f'LOCALE: "{locale}"\n'
            "Write content nuanced for this locale: use local spelling, terminology, cultural references, "
            "and units of measurement."
        )
        return system, user

    elif action == 'content_section':
        topic               = body.get('topic', '')
        primary_keyword     = body.get('primaryKeyword', '')
        secondary_keywords  = body.get('secondaryKeywords', '')
        page_type           = body.get('pageTypeContext', 'Any')
        persona_instruction = body.get('personaInstruction', '')
        compliance_instr    = body.get('complianceInstruction', '')
        deep_compare        = body.get('deepCompareContext', '')
        outline             = body.get('outline', '')
        recent_content      = body.get('recentContent', '')
        section_header      = body.get('sectionHeader', '')
        section_context     = body.get('sectionContext', '')
        ref_urls            = body.get('refUrls', '')
        section_target      = int(body.get('sectionTarget', 0) or 0)
        total_target        = int(body.get('totalTarget', 0) or 0)
        section_index       = int(body.get('sectionIndex', 0) or 0)
        total_sections      = int(body.get('totalSections', 1) or 1)
        wc_block = (
            f"⚠️ MANDATORY WORD COUNT REQUIREMENT: You MUST write AT LEAST {section_target} words for "
            f"this section (section {section_index + 1} of {total_sections}). "
            f"The total article target is {total_target} words. "
            "This is a HARD MINIMUM — if your output is shorter, it will be rejected and you will be asked to rewrite. "
            "Write comprehensive, in-depth content to meet this target. "
            "Do NOT pad with filler — add genuine depth, examples, analysis, and detail.\n"
        ) if section_target > 0 else ''

        retry_text       = body.get('retryText', '')
        retry_word_count = int(body.get('retryWordCount', 0) or 0)

        system = (
            "You are an expert SEO content writer creating high-quality, "
            "E-E-A-T optimized article sections."
        )
        base_user = (
            "Generate only the following section of a comprehensive, structured SEO article.\n"
            f"TARGET PAGE TYPE: {page_type}\n"
            f'TOPIC: "{topic}"\n'
            f'PRIMARY KEYWORD: "{primary_keyword}"\n'
            f'SECONDARY KEYWORDS: "{secondary_keywords}"\n'
            f"{compliance_instr}{persona_instruction}\n"
            f"{deep_compare}\n\n"
            f"{wc_block}"
            f"FULL APPROVED OUTLINE (FOR FLOW CONTEXT):\n{outline}\n\n"
            "PREVIOUSLY WRITTEN CONTENT (DO NOT REPEAT, USE FOR TRANSITION):\n"
            f"{recent_content or 'None (This is the start of the article)'}\n\n"
            f"CURRENT SECTION TO WRITE:\n{section_header}\n{section_context}\n\n"
            f"REFERENCE URLS (IF APPLICABLE):\n{ref_urls or 'None provided'}\n\n"
            "CRITICAL CONTENT GUIDELINES (EEAT):\n"
            "1. EXPERIENCE (E): Write with a first-person perspective or direct experience.\n"
            "2. EXPERTISE (E): Provide deep, focused coverage of the intent.\n"
            "3. AUTHORITATIVENESS (A): Reference credible sources (placeholders like [Source: Name])."
        )
        if retry_text:
            user = (
                f"Your previous output for this section was only {retry_word_count} words, "
                f"which is below the required minimum of {section_target} words.\n\n"
                "Please REWRITE and EXPAND this section to meet the word count target. "
                "Add more depth, examples, analysis, case studies, and detail. "
                "Do NOT simply pad — add genuinely useful content.\n\n"
                f"Your previous output:\n{retry_text}\n\n---\n\nOriginal instructions:\n{base_user}"
            )
        else:
            user = base_user
        return system, user

    elif action == 'content_polish':
        full_content = body.get('fullContent', '')
        system = (
            "You are an expert editor specializing in harmonizing AI-generated SEO articles "
            "into polished, cohesive content."
        )
        user = (
            "Below is a raw, section-by-section generated SEO article. "
            "It may contain redundant headers, repetitive introductions, or disjointed transitions "
            "due to the partitioned generation process.\n\n"
            "TASK:\n"
            "1. Harmonise the tone across the entire article.\n"
            '2. Remove redundant introductory phrases (e.g. "Definition and Importance" repeated across sections).\n'
            "3. Ensure logical transitions between sections.\n"
            "4. Keep all original information, but refine the formatting (Markdown H1, H2, H3) to be consistent and clean.\n"
            '5. Fix any "frankenstein" characteristics where paragraphs feel disconnected.\n'
            "6. Return ONLY the final polished Markdown article.\n\n"
            f"RAW ARTICLE CONTENT:\n{full_content}"
        )
        return system, user

    elif action == 'strategy_url_research':
        input_val     = body.get('input', '')
        is_url        = '.' in input_val or input_val.startswith('http')
        canonical_url = (
            (input_val if input_val.startswith('http') else 'https://' + input_val)
            if is_url else None
        )
        system = (
            "You are an expert SEO researcher analyzing companies and websites "
            "to build accurate SEO profiles."
        )
        if canonical_url:
            user = (
                f"Go to {canonical_url} and read the page. Based ONLY on what you find at that exact URL, "
                "fill in this SEO profile. Do not guess or substitute a different company.\n"
                "Return ONLY a valid JSON object (no markdown, no explanation):\n"
                "{\n"
                '  "client_profile": "Exact industry and core offerings from the site",\n'
                '  "target_audience": "Key customer personas based on site content",\n'
                '  "market_context": "Main competitors and market trends for this specific business",\n'
                '  "objectives": ["lead_generation","brand_authority","local_visibility",'
                '"ecommerce_revenue","service_enquiries","niche_dominance"],\n'
                '  "seed_keywords": "keyword1, keyword2, keyword3, keyword4, keyword5",\n'
                '  "top_competitor_domains": ["domain1.com","domain2.com","domain3.com","domain4.com","domain5.com"],\n'
                '  "seo_keywords": ["primary keyword 1","primary keyword 2","primary keyword 3"]\n'
                "}"
            )
        else:
            user = (
                f'Research the company "{input_val}" and build an accurate SEO profile.\n'
                "Return ONLY a valid JSON object (no markdown, no explanation):\n"
                "{\n"
                '  "client_profile": "Specific industry and core offerings",\n'
                '  "target_audience": "Key customer personas",\n'
                '  "market_context": "Main competitors and market trends",\n'
                '  "objectives": ["lead_generation","brand_authority","local_visibility",'
                '"ecommerce_revenue","service_enquiries","niche_dominance"],\n'
                '  "seed_keywords": "keyword1, keyword2, keyword3, keyword4, keyword5",\n'
                '  "top_competitor_domains": ["domain1.com","domain2.com","domain3.com","domain4.com","domain5.com"],\n'
                '  "seo_keywords": ["primary keyword 1","primary keyword 2","primary keyword 3"],\n'
                "  \"client_website\": \"the company's primary website domain e.g. example.com\"\n"
                "}"
            )
        return system, user

    elif action == 'image_alt_rationale':
        images             = body.get('images', [])
        primary_keyword    = body.get('primary_keyword', '')
        secondary_keywords = body.get('secondary_keywords', '')
        ranked_keywords    = body.get('ranked_keywords', [])
        page_context       = body.get('page_context', '')

        def _esc(v):
            return str(v if v is not None else '').replace('"', "'")

        ranked_kw_str = ', '.join(_esc(k) for k in ranked_keywords) if ranked_keywords else 'N/A'

        image_list = '\n'.join(
            'id={i} | current_alt: "{c}" | proposed_alt: "{p}" | already_optimised: {ao} | ranked_keyword: "{rk}" | image_url: "{u}"'.format(
                i=img.get('id', idx),
                c=_esc(img.get('current_alt', '')),
                p=_esc(img.get('proposed_alt', '')),
                ao='true' if img.get('already_optimised') else 'false',
                rk=_esc(img.get('ranked_keyword', '')),
                u=_esc(img.get('image_url', ''))
            )
            for idx, img in enumerate(images)
        )

        system = (
            "You are an SEO and web-accessibility expert reviewing image alt text. "
            "You explain, concisely and concretely, why a proposed alt text is an "
            "improvement for both accessibility (screen readers) and SEO , or why an "
            "existing alt text was deliberately left unchanged."
        )
        user = (
            "For each image below you are given its CURRENT alt text (may be empty), a "
            "PROPOSED alt text, an ALREADY_OPTIMISED flag, and (if applicable) the "
            "RANKED_KEYWORD the current alt already targets.\n\n"
            f"PAGE CONTEXT: {page_context or 'N/A'}\n"
            f"PRIMARY KEYWORD: {primary_keyword or 'N/A'}\n"
            f"SECONDARY KEYWORDS: {secondary_keywords or 'N/A'}\n"
            f"KEYWORDS THIS PAGE ALREADY RANKS FOR: {ranked_kw_str}\n\n"
            f"IMAGES:\n{image_list}\n\n"
            "For each image, write ONE specific sentence (max ~30 words):\n"
            "- If already_optimised is true: explain that the current alt text was kept UNCHANGED "
            "because it already targets the ranking keyword (name it), so altering it could weaken "
            "an existing ranking. Do NOT propose changes for these.\n"
            "- Otherwise: explain why the proposed alt is better, grounded in the actual difference "
            "between current and proposed (e.g. 'was empty', 'was a filename', 'lacked the subject', "
            "'now describes X and includes the keyword naturally'). Mention a keyword ONLY if the "
            "proposed alt genuinely and naturally uses it; never claim keyword usage that isn't there.\n"
            "Do NOT be generic or repeat the same sentence. If current and proposed are effectively "
            "identical (and not already_optimised), say the existing alt is already appropriate and "
            "needs no change.\n\n"
            "Return ONLY a JSON array (no markdown), each item having:\n"
            '  - "id": the integer image index exactly as given above (e.g. 0, 1, 2 , a bare number, not "[0]")\n'
            '  - "rationale": your one-sentence explanation\n\n'
            "Return ONLY the JSON array, no other text."
        )
        return system, user

    return None, None


# ── SEO RSS Feed Fetcher ───────────────────────────────────────────────────────

SEO_RSS_FEEDS = [
    ('Search Engine Journal', 'https://www.searchenginejournal.com/feed/'),
    ('Search Engine Land', 'https://searchengineland.com/feed'),
    ('Google Search Central', 'https://developers.google.com/search/blog/rss.xml'),
    ('Moz Blog', 'https://moz.com/blog/feed'),
    ('Ahrefs Blog', 'https://ahrefs.com/blog/feed/'),
    ('SEMrush Blog', 'https://www.semrush.com/blog/feed/'),
    ('Barry Schwartz (RustyBrick)', 'https://www.seroundtable.com/rss.xml'),
]

_NS = {
    'atom': 'http://www.w3.org/2005/Atom',
    'content': 'http://purl.org/rss/1.0/modules/content/',
    'dc': 'http://purl.org/dc/elements/1.1/',
    'media': 'http://search.yahoo.com/mrss/',
}


def _text(el, tag):
    child = el.find(tag)
    return (child.text or '').strip() if child is not None else ''


def _parse_feed_date(date_str):
    """Parse RSS pub date to ISO date string; returns '' on failure."""
    if not date_str:
        return ''
    for fmt in (
        '%a, %d %b %Y %H:%M:%S %z',
        '%a, %d %b %Y %H:%M:%S %Z',
        '%Y-%m-%dT%H:%M:%S%z',
        '%Y-%m-%dT%H:%M:%SZ',
    ):
        try:
            return datetime.strptime(date_str.strip(), fmt).strftime('%Y-%m-%d')
        except ValueError:
            pass
    return date_str[:10] if len(date_str) >= 10 else date_str


def fetch_seo_feeds_handler(event):
    days_back = int(event.get('days_back', 90))
    cutoff = datetime.now(tz=timezone.utc) - timedelta(days=days_back)
    articles = []

    for source_name, feed_url in SEO_RSS_FEEDS:
        try:
            resp = requests.get(feed_url, timeout=10, headers={'User-Agent': 'Mozilla/5.0'})
            if resp.status_code != 200:
                continue
            root = ET.fromstring(resp.content)

            # Handle both RSS 2.0 (<channel><item>) and Atom (<entry>)
            channel = root.find('channel')
            items = channel.findall('item') if channel is not None else root.findall('{http://www.w3.org/2005/Atom}entry')

            for item in items:
                title = _text(item, 'title') or _text(item, '{http://www.w3.org/2005/Atom}title')
                url = _text(item, 'link') or _text(item, '{http://www.w3.org/2005/Atom}link')
                if not url:
                    link_el = item.find('{http://www.w3.org/2005/Atom}link')
                    url = link_el.get('href', '') if link_el is not None else ''
                pub_date = _text(item, 'pubDate') or _text(item, '{http://www.w3.org/2005/Atom}published')
                description = _text(item, 'description') or _text(item, '{http://www.w3.org/2005/Atom}summary')
                # Strip HTML tags from description
                description = re.sub(r'<[^>]+>', '', description).strip()[:300]

                date_str = _parse_feed_date(pub_date)

                # Filter by cutoff if we can parse the date
                if date_str and len(date_str) == 10:
                    try:
                        item_date = datetime.strptime(date_str, '%Y-%m-%d').replace(tzinfo=timezone.utc)
                        if item_date < cutoff:
                            continue
                    except ValueError:
                        pass

                if title and url:
                    articles.append({
                        'title': title,
                        'url': url,
                        'source': source_name,
                        'date': date_str,
                        'description': description,
                    })
        except Exception:
            continue

    return {
        'statusCode': 200,
        'headers': {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Allow-Methods': 'OPTIONS,POST',
        },
        'body': json.dumps({'articles': articles}),
    }


def lambda_handler(event, context):
    try:
        # ── Input parsing ──────────────────────────────────────────────────
        action             = event.get('action', 'optimize')

        # ── Non-AI actions ─────────────────────────────────────────────────
        if action == 'fetch_seo_feeds':
            return fetch_seo_feeds_handler(event)

        # ── Structured actions: build prompt server-side ───────────────────
        if action in _STRUCTURED_ACTIONS:
            api_key = os.environ.get('ANTHROPIC_API_KEY') or os.environ.get('CLAUDE_API_KEY')
            if not api_key:
                return {'statusCode': 500, 'body': json.dumps({'error': 'API key not configured'})}

            system_str, user_str = build_structured_prompt(action, event)
            if system_str is None:
                return {
                    'statusCode': 400,
                    'body': json.dumps({'error': f"Unknown structured action: '{action}'"})
                }

            settings_s   = event.get('settings', {})
            max_tokens_s = int(settings_s.get('maxTokens', event.get('max_tokens', 8096)))
            request_body = {
                'model':      'claude-haiku-4-5-20251001',
                'max_tokens': max_tokens_s,
                'system':     system_str,
                'messages':   [{'role': 'user', 'content': user_str}]
            }
            temperature_s = settings_s.get('temperature')
            if temperature_s is not None:
                request_body['temperature'] = float(temperature_s)

            resp = requests.post(
                'https://api.anthropic.com/v1/messages',
                headers={
                    'x-api-key':           api_key,
                    'anthropic-version':   '2023-06-01',
                    'content-type':        'application/json'
                },
                json=request_body,
                timeout=90
            )
            resp_json   = resp.json()
            result_text = (
                resp_json['content'][0]['text']
                if 'content' in resp_json else ''
            )
            return {
                'statusCode': 200,
                'headers': {
                    'Access-Control-Allow-Origin':  '*',
                    'Access-Control-Allow-Headers': 'Content-Type',
                    'Access-Control-Allow-Methods': 'OPTIONS,POST'
                },
                'body': json.dumps({'result': result_text})
            }

        content            = event.get('content', '')
        prompt_override    = event.get('prompt', '')
        settings           = event.get('settings', {})
        primary_keyword    = event.get('primary_keyword', '')
        secondary_keywords = event.get('secondary_keywords', '')

        # ── Read content_type, target_reader, tone_register from settings ──
        # Frontend sends these inside the settings object (camelCase keys).
        # Fallback to top-level event keys for backward compatibility,
        # then to sensible defaults.
        content_type = (
            settings.get('contentType')
            or event.get('content_type')
            or 'general'
        )
        target_reader = (
            settings.get('targetReader')
            or event.get('target_reader')
            or 'General public'
        )
        tone_register = (
            event.get('tone_register')
            or settings.get('brandTone', 'Professional')
        )

        # ── API key ────────────────────────────────────────────────────────
        api_key = os.environ.get('ANTHROPIC_API_KEY') or os.environ.get('CLAUDE_API_KEY')
        if not api_key:
            return {
                'statusCode': 500,
                'body': json.dumps({'error': 'API key not configured'})
            }

        # ── Build message layers ───────────────────────────────────────────
        linking_guidelines = build_linking_guidelines(settings, action)

        dynamic_system_msg = build_dynamic_system_msg(
            content_type       = content_type,
            target_reader      = target_reader,
            tone_register      = tone_register,
            primary_keyword    = primary_keyword,
            secondary_keywords = secondary_keywords,
            settings           = settings,
            linking_guidelines = linking_guidelines
        )

        user_msg = build_user_msg(action, content, prompt_override)

        if user_msg is None:
            return {
                'statusCode': 400,
                'body': json.dumps({'error': f"Invalid action: '{action}'"})
            }

        # ── Compose message array ──────────────────────────────────────────
        # Translate gets a lightweight override — no quality framework needed
        if action == "translate":
            system_str = (
                "You are a professional translator. "
                "Translate content accurately while preserving "
                "all structural elements (Markdown headers, lists, "
                "tables, HTML tags). Do not add commentary."
            )
        else:
            # Merge constitution + dynamic brief into a single system string
            system_str = SYSTEM_MSG_CONSTITUTION + "\n\n" + dynamic_system_msg

        # ── Call Anthropic ─────────────────────────────────────────────────
        print(f"Sending request to Anthropic — action: {action}, "
              f"content_type: {content_type}, "
              f"target_reader: {target_reader}")

        response = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json"
            },
            json={
                "model": "claude-haiku-4-5-20251001",
                "max_tokens": 8096,
                "system": system_str,
                "messages": [{"role": "user", "content": user_msg}]
            },
            timeout=90
        )

        resp_json   = response.json()
        result_text = (
            resp_json['content'][0]['text']
            if 'content' in resp_json else ""
        )

        # ── Post-processing for targeted fragment generation ───────────────
        if action == "generate" and "CURRENT CONTENT:" in prompt_override:
            placement_match = re.search(
                r'\[PLACEMENT:.*?\]', result_text, re.IGNORECASE
            )
            placement_tag = (
                placement_match.group(0) + "\n" if placement_match else ""
            )
            if "```" in result_text:
                result_text = (
                    result_text.split("```html")[-1]
                               .split("```")[-1]
                               .split("```")[0]
                               .strip()
                )
            else:
                result_text = re.sub(
                    r'\[PLACEMENT:.*?\]', '', result_text,
                    flags=re.IGNORECASE
                ).strip()

            result_text = placement_tag + result_text

        # ── Response ───────────────────────────────────────────────────────
        return {
            'statusCode': 200,
            'headers': {
                'Access-Control-Allow-Origin':  '*',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Allow-Methods': 'OPTIONS,POST'
            },
            'body': json.dumps({'result': result_text})
        }

    except Exception as e:
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)})
        }
