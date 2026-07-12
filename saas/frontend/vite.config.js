import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Lets the app import the same plans/tools catalog the backend enforces.
      '@shared': path.resolve(__dirname, '../shared'),
    },
  },
  server: { port: 5173 },
  build: {
    rollupOptions: {
      output: {
        // CSS gets a stable (un-hashed) name: Microsoft Clarity replays fetch
        // the stylesheet URL captured at record time, and content-hashed names
        // 404 as soon as the next deploy rotates them → unstyled playbacks.
        // public/customHttp.yml serves /assets/css/** with no-cache so browsers
        // revalidate instead of pinning a stale copy. JS/images stay hashed.
        assetFileNames: (info) => {
          const name = info.names?.[0] ?? info.name ?? '';
          return name.endsWith('.css')
            ? 'assets/css/[name][extname]'
            : 'assets/[name]-[hash][extname]';
        },
      },
    },
  },
});
