// Browser preview of the desktop UI against a local engine, for visual review and
// screenshots without Tauri. Run the engine on 127.0.0.1:8787, then:
//   STRATON_DEV_TOKEN=$(cat data/token) npx vite --config dev/vite.preview.config.ts
// Development only: the shims below replace Tauri APIs and must never ship.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const engine = process.env.STRATON_ENGINE ?? 'http://127.0.0.1:8787';

export default defineConfig({
  root: here('..'),
  plugins: [react(), tailwindcss()],
  define: { __STRATON_DEV_TOKEN__: JSON.stringify(process.env.STRATON_DEV_TOKEN ?? '') },
  resolve: {
    alias: [
      { find: /^@tauri-apps\/api\/core$/, replacement: here('./browser-shims/core.ts') },
      { find: /^@tauri-apps\/api\/window$/, replacement: here('./browser-shims/window.ts') },
      { find: /^@tauri-apps\/plugin-http$/, replacement: here('./browser-shims/http.ts') },
      {
        find: /^@tauri-apps\/plugin-websocket$/,
        replacement: here('./browser-shims/websocket.ts'),
      },
      { find: /^@tauri-apps\/plugin-dialog$/, replacement: here('./browser-shims/dialog.ts') },
      { find: /^@\//, replacement: here('../src/') },
    ],
  },
  server: {
    host: '127.0.0.1',
    port: 1421,
    strictPort: true,
    proxy: { '/v1': engine, '/health': engine },
  },
});
