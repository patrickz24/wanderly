import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type ProxyOptions } from 'vite';

/** Local API (services/api). The browser always calls same-origin paths; Vite forwards them. */
const API_TARGET = 'http://localhost:3000';

/** Same routes as the production nginx proxy, so dev and container behave alike. */
const apiProxy: Record<string, ProxyOptions> = Object.fromEntries(
  ['/api', '/health', '/ready'].map((path) => [path, { target: API_TARGET }]),
);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // The API CORS allow-list expects exactly this origin: fail loudly instead of drifting.
    strictPort: true,
    proxy: apiProxy,
  },
  preview: {
    port: 4173,
    proxy: apiProxy,
  },
  build: {
    // Maps are emitted for debugging and future error-tracker upload, but bundles do not
    // reference them, so browsers never fetch them.
    sourcemap: 'hidden',
  },
});
