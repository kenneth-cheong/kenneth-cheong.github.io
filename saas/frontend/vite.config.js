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
});
