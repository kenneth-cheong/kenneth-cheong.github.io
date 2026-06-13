#!/usr/bin/env node
// Bundle each Lambda into a single self-contained ESM file under .build/<fn>/,
// inlining the shared catalog + npm deps (except the AWS SDK, which the
// nodejs20 runtime provides). template.yaml points CodeUri at these dirs, so
// `sam deploy` just zips them — no SAM esbuild builder needed.
import { build } from 'esbuild';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FUNCTIONS = ['authorizer', 'auth', 'me', 'metering', 'billing', 'admin', 'app', 'close'];

await rm(path.join(root, '.build'), { recursive: true, force: true });

for (const fn of FUNCTIONS) {
  const outdir = path.join(root, '.build', fn);
  await mkdir(outdir, { recursive: true });
  await build({
    entryPoints: [path.join(root, 'src', fn, 'index.mjs')],
    outfile: path.join(outdir, 'index.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    // The AWS SDK v3 ships with the Lambda nodejs20 runtime — don't bundle it.
    external: ['@aws-sdk/*'],
    // Some deps (jsonwebtoken, google-auth-library) use CommonJS `require`.
    banner: { js: "import{createRequire as ___cr}from'module';const require=___cr(import.meta.url);" },
    logLevel: 'info',
  });
  // Mark the bundle dir as ESM so Lambda loads index.mjs with `import`.
  await writeFile(path.join(outdir, 'package.json'), JSON.stringify({ type: 'module' }));
  console.log(`bundled ${fn}`);
}
console.log('✅ build complete → .build/');
