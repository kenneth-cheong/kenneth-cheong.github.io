# Frozen stylesheet copies for Microsoft Clarity replays

Clarity session recordings replay the DOM captured at record time and re-fetch
stylesheets from their original URLs. Amplify manual deploys replace the whole
`/assets` folder, so the content-hashed CSS names below died with each deploy
and every older recording played back unstyled (grey, raw-links "no CSS" look).

These files are the exact CSS bundles of past deploys — recovered from Amplify
job artifacts 188–201 (Jul 2026) — restored at their original URLs so those
recordings render again.

Since Jul 2026 the build emits CSS at a stable `/assets/css/<name>.css` URL
(see `vite.config.js` + the `/assets/css/**` no-cache rule in
`public/customHttp.yml`), so newer recordings never break and nothing new
needs to be added here.

Safe to delete once Clarity's recording retention has passed for Jul 2026
(30 days on the free plan → any time after mid-Aug 2026).
