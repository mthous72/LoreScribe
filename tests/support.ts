import type { Page } from '@playwright/test';

/**
 * Navigate, then wait for the Playwright test surface to finish loading.
 *
 * The surface is a dynamic import gated on a build flag, so that the entry
 * points which open a caller-named VFS with clearOnInit cannot ship to a
 * writer's browser. A dynamic import resolves after `load` fires, so a bare
 * goto() can win the race and the first page.evaluate finds nothing there.
 */
export async function gotoApp(page: Page, path = './'): Promise<void> {
  await page.goto(path);
  await page.waitForFunction(() => 'runSpike' in window, null, { timeout: 30_000 });
}
