import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Point Tailwind at its config explicitly: the plugin otherwise resolves
// tailwind.config.js from the process CWD, which breaks when Vite is launched
// from the repo root with this app as a root argument (dev-preview tooling).
const here = dirname(fileURLToPath(import.meta.url));

export default {
  plugins: { tailwindcss: { config: join(here, 'tailwind.config.js') }, autoprefixer: {} },
};
