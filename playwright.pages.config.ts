import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

// The same gates, against a build served under GitHub Pages' /LoreScribe/
// prefix. This is not ceremony: sqlite-wasm resolves its own .wasm and its OPFS
// async proxy through `import.meta.url` from inside a dependency Vite is told
// to leave alone, so a base path is exactly where that arrangement would break
// — and it would break only in production. docs/15 §7.
const localChromium = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
const executablePath = existsSync(localChromium) ? localChromium : undefined;

export default defineConfig({
  testDir: './tests',
  // Every gate, not a subset. Doc 16 claimed the whole suite re-ran under the
  // Pages prefix; only B and C actually did, so gate A's multi-tab and kill
  // tests were never exercised at the base path they exist to protect.
  // (The live-origin spike stays out: it needs a real deployment.)
  testIgnore: '**/live/**',
  fullyParallel: false,
  workers: 1,
  timeout: 240_000,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:4174/LoreScribe/', trace: 'off' },
  projects: [{ name: 'pages-base', use: { ...devices['Desktop Chrome'], launchOptions: { executablePath } } }],
  webServer: {
    command:
      'npx vite build --outDir dist-pages && npx vite preview --outDir dist-pages --base /LoreScribe/ --port 4174 --strictPort',
    url: 'http://localhost:4174/LoreScribe/',
    reuseExistingServer: false,
    timeout: 180_000,
    env: { VITE_BASE: '/LoreScribe/', VITE_TEST_SURFACE: '1' },
  },
});
