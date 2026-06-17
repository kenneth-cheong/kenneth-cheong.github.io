import json
import os
import re
import requests

# --- Persona Configuration ---
SOCIAL_MEDIA_PROMPT = (
    "You are acting as a senior community manager and reputation strategist for [Brand Name] on [Platform], "
    "with responsibility for protecting public trust, brand credibility, and audience confidence. "
    "You must assess not just what the user said, but why they are saying it and what the public response should achieve.\n\n"

    "Your task is to:\n"
    "1) Interpret the commenter's likely intent (complaint, confusion, provocation, feedback, scam/misinformation, request for help).\n"
    "2) Assess reputational, compliance, and escalation risk (low/medium/high) and whether to move to private channels.\n"
    "3) Decide the appropriate public response strategy (clarify, correct misinformation, de-escalate, set boundaries, invite offline follow-up).\n"
    "4) Generate a response that serves both the commenter and the wider audience observing the exchange.\n\n"

    "You must:\n"
    "- Reference verified public information, standard industry practices, or established response patterns where relevant.\n"
    "- Correct misinformation calmly and factually, without amplifying hostility or repeating inflammatory phrasing.\n"
    "- Be firm when necessary, empathetic when appropriate, and procedural when risk is high.\n"
    "- Align with governance standards, public-facing accountability, and institutional communications best practices.\n"
    "- Provide clear next steps when action is required (what the user should do, where to go, what details to share privately).\n\n"

    "You must not:\n"
    "- Over-apologise when fault is not established.\n"
    "- Speculate, argue, or personalise the issue.\n"
    "- Escalate tone unnecessarily or engage in back-and-forth debate.\n\n"

    "If relevant, draw on comparable public responses by credible organisations and established crisis/community management best practices.\n\n"

    "Output requirements:\n"
    "- Produce ONLY the final public-facing reply (no analysis, no risk labels, no internal notes).\n"
    "- Keep it concise, calm, authoritative, and aligned with the brand voice.\n"
    "- If personal data, sensitive cases, or verification is required, redirect politely to private channels.\n"
    "- If misinformation/scams are present, correct factually and signpost safe official channels.\n"
    "- Remain neutral and institutional in tone.\n"
    "- Reinforce the organisation's role and official mechanisms/programmes ONLY when relevant to the comment.\n"
)

SENSITIVITY_GUIDANCE = {
    "routine": (
        "Sensitivity: Routine. Use standard service tone. Provide a clear, helpful answer and straightforward next step."
    ),
    "heightened": (
        "Sensitivity: Heightened. Treat as repeated complaint or sensitive topic. De-escalate, clarify, and avoid defensiveness. "
        "Offer structured next steps and invite private resolution if details are needed."
    ),
    "high_risk": (
        "Sensitivity: High-risk. Treat as potential legal/safety/regulatory/viral issue. Be procedural, minimal, and careful. "
        "Avoid admissions. Request specifics via private channel and signpost official escalation route."
    ),
}

OBJECTIVE_GUIDANCE = {
    "de_escalate": "Objective: De-escalate. Reduce heat, acknowledge, clarify, and guide to resolution.",
    "correct_misinformation": "Objective: Correct misinformation. Calmly correct with facts and point to official sources.",
    "demonstrate_accountability": "Objective: Demonstrate accountability. State what is known, what will be done next, and where updates will be shared.",
    "protect_brand_reputation": "Objective: Protect brand reputation. Set boundaries, correct inaccuracies, and reinforce governance and process.",
    "redirect_to_private_resolution": "Objective: Redirect to private resolution. Minimise public detail and move to DM/email/hotline for verification.",
}

PLATFORM_GUIDANCE = {
    "meta": "Platform: Meta/Facebook. Keep it friendly, clear, and not overly long.",
    "instagram": "Platform: Instagram. Keep it short, human, and easy to read.",
    "linkedin": "Platform: LinkedIn. Keep it formal, measured, and governance-forward.",
    "tiktok": "Platform: TikTok. Keep it brief, direct, and de-escalatory.",
}


def clean_ai_text(text: str) -> str:
    """Removes AI artifacts, citations, and markdown/HTML for a clean social reply."""
    text = re.sub(r"【.*?】", "", text)
    text = text.replace("**", "")
    text = re.sub(r"<[^>]*>", "", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _parse_event_body(event: dict) -> dict:
    if isinstance(event, dict) and isinstance(event.get("body"), str):
        return json.loads(event["body"])
    if isinstance(event, dict) and isinstance(event.get("body"), dict):
        return event["body"]
    return event if isinstance(event, dict) else {}


def _build_instruction_block(body: dict) -> str:
    sensitivity       = (body.get("sensitivity") or "").strip()
    response_objective = (body.get("response_objective") or "").strip()
    response_platform  = (body.get("response_platform") or "").strip()
    additional         = (body.get("instruction") or body.get("instructions") or "").strip()

    parts = []
    if sensitivity:
        parts.append(SENSITIVITY_GUIDANCE.get(sensitivity, f"Sensitivity: {sensitivity}."))
    if response_objective:
        parts.append(OBJECTIVE_GUIDANCE.get(response_objective, f"Objective: {response_objective}."))
    if response_platform:
        parts.append(PLATFORM_GUIDANCE.get(response_platform, f"Platform: {response_platform}."))
    if additional:
        parts.append(f"Additional instructions/context (may be partial/unverified): {additional}")

    return "\n".join(parts).strip()


def _build_user_content(user_comment: str, attachments: list) -> object:
    """
    Returns a plain string for text-only requests, or a multi-modal content
    array (images + text) when image attachments are present.
    """
    if not attachments:
        return user_comment or "Please analyse the attached content and suggest a reply."

    content = []
    for att in attachments:
        media_type = att.get("type", "image/jpeg")
        data       = att.get("data", "")
        if not data:
            continue
        content.append({
            "type": "image",
            "source": {
                "type":       "base64",
                "media_type": media_type,
                "data":       data,
            }
        })

    text = user_comment or "Please analyse the attached image(s) and suggest an appropriate public reply."
    content.append({"type": "text", "text": text})
    return content


def lambda_handler(event, context):
    api_key = os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("CLAUDE_API_KEY")
    if not api_key:
        return {"statusCode": 500, "body": json.dumps({"error": "Missing ANTHROPIC_API_KEY env var."})}

    try:
        body = _parse_event_body(event)
    except Exception:
        return {"statusCode": 400, "body": json.dumps({"error": "Invalid JSON body."})}

    user_comment = (body.get("question") or body.get("comment") or "").strip()
    attachments  = body.get("attachments") or []

    if not user_comment and not attachments:
        return {"statusCode": 400, "body": json.dumps({"error": "No comment or attachments provided."})}

    instruction_block = _build_instruction_block(body)

    system_prompt = SOCIAL_MEDIA_PROMPT
    if instruction_block:
        system_prompt += "\n\n" + instruction_block

    user_content = _build_user_content(user_comment, attachments)

    payload = {
        "model":      "claude-haiku-4-5-20251001",
        "max_tokens": 1024,
        "system":     system_prompt,
        "messages":   [{"role": "user", "content": user_content}]
    }

    try:
        resp = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key":         api_key,
                "anthropic-version": "2023-06-01",
                "content-type":      "application/json"
            },
            json=payload,
            timeout=30
        )
        resp.raise_for_status()
        resp_json = resp.json()

        raw_answer  = resp_json["content"][0]["text"] if resp_json.get("content") else ""
        final_reply = clean_ai_text(raw_answer)

        return {
            "answer":      final_reply,
            "response_id": resp_json.get("id", "unknown")
        }

    except requests.exceptions.RequestException as e:
        print(f"Request error: {str(e)}")
        return {
            "answer": "Sorry, I couldn't generate a reply right now. Please try again.",
            "error":  str(e)
        }
    except Exception as e:
        print(f"Unhandled error: {str(e)}")
        return {
            "answer": "Sorry, I couldn't generate a reply right now. Please try again.",
            "error":  str(e)
        }
