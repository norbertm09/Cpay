// Portail porteur — configuration Vite (vague 7, migration depuis CRA 5).
// Conventions partagees avec les autres portails (docker/Dockerfile.portal,
// .github/workflows/ci.yml) : sortie dans build/, pas de source maps, prefixe
// REACT_APP_ conserve pour l'argument de build REACT_APP_API_BASE_URL.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Cible du proxy /api en developpement (remplace le champ CRA « proxy »).
// API locale par defaut ; API factice : API_PROXY_TARGET=http://127.0.0.1:4011
// (meme origine => le cookie HttpOnly de refresh circule sans CORS).
const PROXY_TARGET = process.env.API_PROXY_TARGET || 'http://localhost:3000';

export default defineConfig({
  base: '/',
  plugins: [react()],
  envPrefix: ['VITE_', 'REACT_APP_'],
  server: {
    port: 3003,
    strictPort: true,
    proxy: { '/api': { target: PROXY_TARGET, changeOrigin: false } },
  },
  preview: { port: 3003 },
  build: {
    outDir: 'build',
    sourcemap: false,
    // Aucun script inline dans index.html : CSP script-src 'self' (nginx / mock).
    modulePreload: { polyfill: false },
  },
  // Tests unitaires (vitest, remplace react-scripts test) : jsdom + globals jest-like.
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.{js,jsx}'],
  },
});
