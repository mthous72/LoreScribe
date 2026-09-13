/**
 * Rasterise the icon SVGs to the PNG sizes a manifest needs.
 *
 * Run by hand (`node tools/render-icons.mjs`) and the results committed, not run
 * in CI: the PNGs change only when the artwork does, and a build step that
 * needs a browser to produce two images is a build step that breaks for someone.
 * Chromium is already here for Playwright, so this adds no dependency.
 */
import { chromium } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const JOBS = [
  { svg: 'public/icons/icon.svg', out: 'public/icons/icon-192.png', size: 192 },
  { svg: 'public/icons/icon.svg', out: 'public/icons/icon-512.png', size: 512 },
  { svg: 'public/icons/icon-maskable.svg', out: 'public/icons/icon-maskable-512.png', size: 512 },
];

// The pinned Playwright version may not match the browser build present in a
// given environment; point at the one that is actually installed when the
// default lookup misses.
const executablePath = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
const browser = await chromium.launch(
  existsSync(executablePath) ? { executablePath } : {});
for (const job of JOBS) {
  const page = await browser.newPage({
    viewport: { width: job.size, height: job.size },
    deviceScaleFactor: 1,
  });
  const svg = readFileSync(job.svg, 'utf8');
  await page.setContent(
    `<style>html,body{margin:0;padding:0}svg{display:block;width:${job.size}px;height:${job.size}px}</style>${svg}`,
  );
  writeFileSync(job.out, await page.screenshot({ omitBackground: true }));
  await page.close();
  console.log(`${job.out} ${job.size}x${job.size}`);
}
await browser.close();
