# Copilot Instructions for this repository

## What this repository is
- A static GitHub Pages site with root-level HTML pages, not a React/Next app.
- The main interactive app is `index.html`; other large entry points include `chatbot.html` and `testing.html`.
- The site makes heavy use of inline JavaScript and direct `fetch()` calls to AWS API Gateway / Lambda endpoints.

## Key architecture patterns
- Frontend code lives in root HTML files. Do not assume a `src/` or build artifact directory.
- Backend logic lives in Python files with `lambda_handler(event, context)`, often in the repo root and in `lambdas/`.
- Shared service modules appear in `optimiser/` and are not bundled by a frontend build.
- `amplify/` contains minimal Amplify backend definitions (`auth/resource.ts`, `data/resource.ts`), but the static frontend is deployed through GitHub Actions.

## Important workflows
- Install Node dependencies with `npm install` before editing Amplify/TypeScript files.
- Install Python dependencies with `pip install -r requirements.txt` for Lambda development.
- There is no local build command defined in `package.json`; deployment is handled by `.github/workflows/jekyll-gh-pages.yml` on push to `main`.
- `npm test` is the default placeholder and does not run project tests.

## Frontend conventions
- Preserve inline JS structure in HTML pages. Large files like `index.html` contain page-specific event handlers, state objects, and helper functions.
- Endpoint configuration is often hard-coded in page scripts. Example: `OPTIMISER_ENDPOINTS` in `index.html` and `fetch()` URLs in `chatbot.html`.
- Use existing response parsing patterns such as `parseLambdaResponse(data)` rather than inventing new JSON unwrap logic.
- Avoid refactoring inline scripts into a different architecture unless the change is strictly necessary.

## Backend conventions
- Lambda functions expect AWS-style payload objects, e.g. `event['max_pages']`, `event['action']`, or `event.get('total_pages', '10')`.
- Do not assume `.env` files are present; many functions are written for AWS Lambda environment variables.
- Large prompt constants and output rules in files like `lambdas/ai_optimiser_lambda.py` and `aiMention.py` are intentional and should be preserved when editing.

## Integration points to preserve
- GitHub Pages deployment via `.github/workflows/jekyll-gh-pages.yml`.
- AWS API Gateway endpoints in HTML pages (many `https://*.execute-api.ap-southeast-1.amazonaws.com/*` URLs).
- The Amplify backend definition in `amplify/backend.ts` and its resource files.
- External dependencies: AWS Amplify, OpenAI/Gemini/Claude wrappers, DataForSEO, Monday.com, SeRanking, Google APIs, `google-generativeai`, and `yt-dlp`.

## What not to do
- Do not rewrite the repo as a React/Next.js app.
- Do not assume the project has an existing test suite.
- Do not remove or replace AWS endpoint URLs without understanding the corresponding HTML page and Lambda contract.
- Do not add generic high-level guidance; focus on this repo's static HTML + Lambda pattern.

## Useful files
- `index.html` — main static app and API endpoint orchestration.
- `chatbot.html` / `testing.html` — additional UI pages with their own Lambda integration patterns.
- `amplify/backend.ts` — Amplify backend entrypoint.
- `lambdas/ai_optimiser_lambda.py` — example of the repo's AI prompt and Lambda conventions.
- `requirements.txt` — Python runtime dependencies.
- `.github/workflows/jekyll-gh-pages.yml` — deployment pipeline.
