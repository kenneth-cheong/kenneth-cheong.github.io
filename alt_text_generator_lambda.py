"""altTextGenerator — proposes SEO alt text for one image, via Claude vision.

Behind API Gateway `ty3ndlwcnk` (stage `altTextGenerator`). Two callers, one
contract:

  request  {page_context, image_placement, primary_keyword, secondary_keywords,
            image_url | image_data (+ media_type)}
  response {result: "<alt text>"}   wrapped in the usual {statusCode, body} envelope

`result` is the key both callers read — index.html's Content Optimiser
(`parseLambdaResponse(...).result`) and the SaaS metering gateway
(`raw.result || raw.alt_text`). Renaming it silently empties the Proposed alt
column rather than erroring.

History: on 2026-07-09 this function was overwritten with the SE Ranking proxy
(deployed to the wrong --function-name; the real one is the `seRanking`
Lambda). It answered every request with SE Ranking's 403 "No token" for two
weeks, and because the gateway reads a missing `.result` as "no suggestion",
nothing logged an error. Hence the explicit non-2xx envelope on every failure
path here — a caller that only looks for `result` at least sees `error`.

Raw HTTP rather than the `anthropic` SDK: the shared `newLayer` layer carries
`requests` but not the SDK, and every other Python Lambda in this account calls
/v1/messages the same way.
"""

import base64
import json
import os
import time

import requests

CLAUDE_API_KEY = os.environ.get('CLAUDE_API_KEY')
CLAUDE_URL = 'https://api.anthropic.com/v1/messages'
MODEL = 'claude-opus-4-8'

# Alt text is a one-line description, so: no thinking, low effort, and an
# explicit final-answer-only instruction — with thinking off, Opus 4.8 will
# otherwise narrate its reasoning into the visible response.
SYSTEM = """You write alt text for images on web pages, for accessibility and image search.

Rules:
- Describe what is ACTUALLY VISIBLE in the image. Never guess at content you cannot see.
- One sentence, under 125 characters. Screen readers cut off past roughly that.
- Never start with "Image of", "Picture of", "Photo of" — assistive tech already announces it.
- Work the page's target keyword in ONLY where it honestly describes the image. A logo is a logo; do not call it a "digital marketing agency Singapore banner".
- Name the specific subject. If you can read a brand name or wordmark in the image, use it — "Canon logo", not "client logo"; "MediaOne team at the MARKies Awards", not "group photo". Generic alt text is the problem this replaces.
- If the image is a logo, icon, chart or screenshot, say which.
- Transparent images arrive flattened onto a plain grey backing so you can see them. That grey is not part of the image — never describe the background colour unless it is clearly part of the artwork.

Reply with the alt text alone. No preamble, no quotes, no explanation, no alternatives."""

MEDIA_TYPES = {'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
               'gif': 'image/gif', 'webp': 'image/webp'}
# Claude rejects anything larger; 5MB of base64 also pushes the request past
# what a 60s Lambda comfortably uploads.
MAX_IMAGE_BYTES = 5 * 1024 * 1024


class ImageUnreachable(Exception):
    """Anthropic could not download the image URL we passed it."""


def lambda_handler(event, context):
    body = event
    if isinstance(event, dict) and isinstance(event.get('body'), str):
        try:
            body = json.loads(event['body'])
        except Exception:
            pass
    if not isinstance(body, dict):
        return response(400, {'error': 'Body must be a JSON object'})

    if not CLAUDE_API_KEY:
        return response(500, {'error': 'CLAUDE_API_KEY not configured'})

    image_url = (body.get('image_url') or '').strip()
    image_data = body.get('image_data')
    if not image_url and not image_data:
        return response(400, {'error': 'image_url or image_data is required'})

    try:
        source = image_source(image_url, image_data, body.get('media_type'))
    except ValueError as e:
        return response(400, {'error': str(e)})

    try:
        try:
            alt = generate_alt(source, body)
        except ImageUnreachable:
            # Anthropic couldn't fetch the URL — hotlink protection, a bot filter
            # or a CDN that only answers browsers. We are auditing other people's
            # sites, so that is common enough to be worth one retry with the
            # bytes fetched from here (with a browser UA) rather than giving up
            # on the row.
            source = fetch_as_base64(image_url)
            alt = generate_alt(source, body)
    except requests.Timeout:
        return response(504, {'error': 'Claude timed out'})
    except Exception as e:
        print(f'alt_text_failed: {e}')
        return response(502, {'error': f'Claude request failed: {e}'})

    if not alt:
        return response(502, {'error': 'Claude returned no text'})
    return response(200, {'result': alt})


def image_source(image_url, image_data, media_type):
    """A Messages API image source block from whichever input the caller sent."""
    if image_url:
        if not image_url.lower().startswith(('http://', 'https://')):
            raise ValueError('image_url must be an absolute http(s) URL')
        # A URL source is cheaper — Anthropic fetches it, we upload nothing. But
        # a transparent PNG gets flattened onto WHITE before the model sees it,
        # and web logos are very often white artwork on transparency: MediaOne's
        # own logo, and every client logo in its strip, came back as "Blank white
        # image". Formats that can carry alpha are therefore fetched and
        # flattened here instead, onto grey. JPEG has no alpha, so it keeps the
        # cheap path.
        if not image_url.split('?')[0].lower().endswith(('.jpg', '.jpeg')):
            try:
                return fetch_as_base64(image_url)
            except Exception as e:
                # Not fatal: hand Anthropic the URL and let it try.
                print(f'alt_text_prefetch_failed: {image_url} {e}')
        return {'type': 'url', 'url': image_url}

    # index.html sends base64 for inline data: URIs, where there is no URL to fetch.
    data = str(image_data)
    if data.startswith('data:'):
        header, _, payload = data.partition(',')
        media_type = media_type or header[5:].split(';')[0] or None
        data = payload
    if not media_type:
        media_type = 'image/png'
    if media_type not in MEDIA_TYPES.values():
        media_type = MEDIA_TYPES.get(str(media_type).lower().lstrip('.'), 'image/png')
    try:
        base64.b64decode(data, validate=True)
    except Exception:
        raise ValueError('image_data is not valid base64')
    return {'type': 'base64', 'media_type': media_type, 'data': data}


def fetch_as_base64(image_url):
    """Download the image here and hand Claude the bytes instead of the URL."""
    res = requests.get(image_url, timeout=20, stream=True, headers={
        # Sites that block Anthropic's fetcher are usually blocking "no browser
        # UA", not us specifically.
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/png,image/jpeg,*/*',
    })
    if res.status_code != 200:
        raise RuntimeError(f'Image fetch returned {res.status_code}')

    content_type = (res.headers.get('Content-Type') or '').split(';')[0].strip().lower()
    if content_type not in MEDIA_TYPES.values():
        ext = image_url.rsplit('.', 1)[-1].split('?')[0].lower()
        content_type = MEDIA_TYPES.get(ext)
        if not content_type:
            raise RuntimeError(f'Not an image Claude accepts ({content_type or "unknown type"})')

    raw = b''
    for chunk in res.iter_content(65536):
        raw += chunk
        if len(raw) > MAX_IMAGE_BYTES:
            raise RuntimeError('Image is larger than 5MB')
    if not raw:
        raise RuntimeError('Image fetch returned no bytes')

    raw, content_type = flatten_transparency(raw, content_type)
    return {'type': 'base64', 'media_type': content_type,
            'data': base64.b64encode(raw).decode('ascii')}


def flatten_transparency(raw, content_type):
    """Composite a transparent image onto mid-grey, so it is actually visible.

    White-on-transparent is the standard way logos ship, and flattening those
    onto white (what happens by default) leaves the model looking at a blank
    rectangle — it then writes "Blank white image" as the alt text, which is
    both useless and, in the user's browser, contradicted by the thumbnail
    right next to it. Mid-grey keeps white artwork AND black artwork legible.
    Anything that fails to decode is passed through untouched — a worse
    description beats no row at all.
    """
    try:
        from PIL import Image
        import io

        im = Image.open(io.BytesIO(raw))
        if im.mode not in ('RGBA', 'LA', 'PA') and 'transparency' not in im.info:
            return raw, content_type
        im = im.convert('RGBA')
        flat = Image.new('RGB', im.size, (128, 128, 128))
        flat.paste(im, mask=im.getchannel('A'))
        out = io.BytesIO()
        flat.save(out, format='PNG')
        return out.getvalue(), 'image/png'
    except Exception as e:
        print(f'alt_text_flatten_failed: {e}')
        return raw, content_type


def generate_alt(source, body):
    page_context = (body.get('page_context') or '').strip()
    placement = (body.get('image_placement') or '').strip()
    primary = (body.get('primary_keyword') or '').strip()
    secondary = (body.get('secondary_keywords') or '').strip()

    lines = ['Write the alt text for this image.']
    if page_context:
        lines.append(f'Page: {page_context}')
    if placement:
        lines.append(f'Placement: {placement}')
    if primary:
        lines.append(f'Page target keyword: {primary}')
    if secondary:
        lines.append(f'Secondary keywords: {secondary}')

    payload = {
        'model': MODEL,
        'max_tokens': 300,
        'system': SYSTEM,
        'output_config': {'effort': 'low'},
        'messages': [{
            'role': 'user',
            'content': [
                {'type': 'image', 'source': source},
                {'type': 'text', 'text': '\n'.join(lines)},
            ],
        }],
    }

    # The gateway fans out 4 of these at a time across 30 images, which is
    # enough to draw 429s and 529s; a whole run once lost 7 of 30 rows to
    # transient "Overloaded". Retrying in here beats losing the row, since the
    # caller treats one failed image as "no suggestion" and moves on.
    res = None
    for attempt in range(3):
        if attempt:
            time.sleep(1.5 * attempt)
        res = requests.post(CLAUDE_URL, timeout=45, json=payload, headers={
            'x-api-key': CLAUDE_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
        })
        if res.status_code not in (429, 500, 502, 503, 504, 529):
            break

    if res.status_code != 200:
        # "Unable to download the file" is the one upstream error worth
        # retrying differently rather than reporting — see the caller.
        if res.status_code == 400 and 'download the file' in res.text.lower():
            raise ImageUnreachable(res.text[:200])
        raise RuntimeError(f'{res.status_code} {res.text[:300]}')

    data = res.json()
    # A safety decline returns HTTP 200 with an empty content array — reading
    # content[0] blind would turn that into an IndexError instead of a message.
    if data.get('stop_reason') == 'refusal':
        raise RuntimeError('Claude declined to describe this image')

    text = ''.join(b.get('text', '') for b in data.get('content', []) if b.get('type') == 'text')
    return clean(text)


def clean(text):
    """Strip the wrappers a model reaches for even when told not to."""
    alt = ' '.join(str(text or '').split()).strip()
    if len(alt) >= 2 and alt[0] == alt[-1] and alt[0] in '"“”\'':
        alt = alt[1:-1].strip()
    for prefix in ('Alt text:', 'Alt:'):
        if alt.lower().startswith(prefix.lower()):
            alt = alt[len(prefix):].strip()
    return alt


def response(status, body):
    return {
        'statusCode': status,
        'headers': {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Content-Type': 'application/json',
        },
        'body': json.dumps(body),
    }
