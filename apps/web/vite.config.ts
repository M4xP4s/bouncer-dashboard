/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Development only. The browser talks to Vite's origin and Vite forwards
    // API and socket traffic to the API on port 3000, so the dashboard uses
    // the same relative URLs as the built page, which the API serves itself,
    // and there is no CORS configuration in either mode.
    proxy: {
      '/api': 'http://localhost:3000',
      '/socket.io': { target: 'http://localhost:3000', ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test-setup.ts',
  },
});
