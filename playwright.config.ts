import { defineConfig, devices } from '@playwright/test';

// Gate A runs against the PRODUCTION build, not the dev server: the sqlite-wasm
// asset URLs live inside an excluded dependency, which is the classic
// dev-works/build-breaks seam. docs/15 §7.
export default defineConfig({
  testDir: './tests',
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
      // This container ships a pinned Chromium that predates the @playwright/test
      // version here, so point at it rather than downloading another one.
      launchOptions: { executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' },
    },
  }],
  webServer: {
    command: 'npx vite build && npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
