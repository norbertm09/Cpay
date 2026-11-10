// Vite 7 (ex-Vite 5) — remplace Create React App (react-scripts 5, non maintenu).
// Les consommateurs (docker/Dockerfile.portal, nginx, CI, dev/mock-api.js)
// attendent toujours le bundle dans build/.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/',
  // REACT_APP_* : l'argument de build REACT_APP_API_BASE_URL (Dockerfile, CI) reste valable.
  envPrefix: ['VITE_', 'REACT_APP_'],
  server: {
    port: 3008,
    proxy: { '/api': 'http://localhost:3000' },
  },
  build: {
    outDir: 'build',
    // Reliquat 2026-11 : React / Router dans un chunk « vendor » stable (cache navigateur entre deux versions)
    rollupOptions: { output: { manualChunks: { vendor: ['react', 'react-dom', 'react-dom/client', 'react-router-dom'] } } },
    sourcemap: false,
    // Pas de <script> inline dans index.html : CSP script-src 'self' (ex-INLINE_RUNTIME_CHUNK=false).
    modulePreload: { polyfill: false },
  },
});
