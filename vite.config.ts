import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Base path is a switch, not a constant: GitHub Pages serves under /LoreScribe/,
// a Capacitor build (Phase 6) needs relative './'. See docs/15 §3d.
const base = process.env.VITE_BASE ?? '/';

export default defineConfig({
  base,
  plugins: [react(), tailwindcss()],
  // Required. Pre-bundling breaks the import.meta.url asset resolution that
  // sqlite-wasm uses to locate its own .wasm — docs/15 §7.
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  // Deliberately NO Cross-Origin-Opener-Policy / Embedder-Policy headers here.
  // The whole D8 bet is that opfs-sahpool needs neither. Setting them in dev
  // would hide a failure that GitHub Pages would then hand us in production.
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true },
});
