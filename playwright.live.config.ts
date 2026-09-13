import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

/**
 * The spike, run against whatever is actually deployed.
 *
 * docs/15 chose a shipped harness over a throwaway precisely so the numbers
 * could be taken again later — from the live origin, on any device, in month
 * six when something feels slow. This is that, pointed at Pages. No web server
 * of its own: it measures the real deployment, not a local build of it.
 *
 *   npm run test:live
 *   LIVE_URL=https://example.invalid/ npm run test:live
 */
const local = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';

// Chromium does not read HTTPS_PROXY, so in a sandbox whose egress is proxied
// it has to be told. Playwright's own option, rather than a --proxy-server flag
// or any loosening of certificate checking. Absent the variable this is
// undefined and the browser connects directly, which is the normal case.
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined;

export default defineConfig({
  testDir: './tests/live',
  timeout: 300_000,
  reporter: [['list']],
  use: {
    baseURL: process.env.LIVE_URL ?? 'https://mthous72.github.io/LoreScribe/',
    trace: 'off',
  },
  projects: [{
    name: 'pages-live',
    use: {
      ...devices['Desktop Chrome'],
      proxy,
      launchOptions: { executablePath: existsSync(local) ? local : undefined },
    },
  }],
});
