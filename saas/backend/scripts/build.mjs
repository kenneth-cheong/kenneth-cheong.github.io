#!/usr/bin/env node
// Bundle each Lambda into a single self-contained ESM file under .build/<fn>/,
// inlining the shared catalog + npm deps (except the AWS SDK, which the
// nodejs20 runtime provides). template.yaml points each CodeUri at these dirs,
// so `aws cloudformation package` just zips + uploads them (no SAM CLI). See
// ../DEPLOY.md step 3 for the full deploy flow.
import { build } from 'esbuild';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FUNCTIONS = ['authorizer', 'auth', 'me', 'metering', 'billing', 'admin', 'app', 'close', 'track', 'refill'];

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
    // The big AWS SDK v3 clients ship with the nodejs20 runtime — keep them
    // external. But bundle the smaller utils (e.g. @aws-sdk/s3-request-presigner
    // and its signing helpers), which are NOT guaranteed in the runtime.
    plugins: [{
      name: 'aws-sdk-external',
      setup(b) {
        b.onResolve({ filter: /^@aws-sdk\// }, (args) => (
          /^@aws-sdk\/(client-|lib-)/.test(args.path)
            ? { path: args.path, external: true }
            : undefined // bundle util-*, s3-request-presigner, signature-v4*, etc.
        ));
      },
    }],
    // Some deps (jsonwebtoken, google-auth-library) use CommonJS `require`.
    banner: { js: "import{createRequire as ___cr}from'module';const require=___cr(import.meta.url);" },
    logLevel: 'info',
  });
  // Mark the bundle dir as ESM so Lambda loads index.mjs with `import`.
  await writeFile(path.join(outdir, 'package.json'), JSON.stringify({ type: 'module' }));
  console.log(`bundled ${fn}`);
}
console.log('✅ build complete → .build/');
