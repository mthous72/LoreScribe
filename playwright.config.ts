import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

// This container ships a pinned Chromium that predates the @playwright/test
// version here. Point at it when it exists; in CI, let Playwright resolve its
// own download.
const localChromium = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
const executablePath = existsSync(localChromium) ? localChromium : undefined;

// Gate A runs against the PRODUCTION build, not the dev server: the sqlite-wasm
// asset URLs live inside an excluded dependency, which is the classic
// dev-works/build-breaks seam. docs/15 §7.
export default defineConfig({
  testDir: './tests',
  // The live-origin spike is opt-in; it needs a deployment to exist.
  testIgnore: '**/live/**',
  fullyParallel: false,
  workers: 1,
  timeout: 240_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'off',
  },
  projects: [{
    name: 'chromium',
    use: {
      ...devices['Desktop Chrome'],
      launchOptions: { executablePath },
    },
  }],
  webServer: {
    command: 'npx vite build && npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
