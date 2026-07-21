# Tool card art

One photo per tool (`<toolId>.webp`, 640×320), used as the blended background of
the tool card header — see `.dm-tool-photo` in `src/index.css` and
`src/components/ToolCard.jsx`.

All photos are from [Unsplash](https://unsplash.com/license), re-encoded to webp
at the size the card actually uses. `credits.json` records the source photo,
photographer and profile link for each one — Unsplash's licence doesn't require
attribution, but keep this file accurate so a credit can be produced on request.

Adding a tool? Drop a `<toolId>.webp` here and add its `credits.json` entry. The
card degrades to the plain colour wash if the file is missing, so a new tool is
never broken by a missing image.
