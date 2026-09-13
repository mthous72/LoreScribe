import { test, expect } from '@playwright/test';

/**
 * The PWA claims, checked.
 *
 * Doc 01 and [D7](../docs/10-decisions.md) have said "ships as an installable
 * PWA" and "works offline" since the first commit, and until this there was no
 * manifest, no icons and no service worker — the statements were simply false.
 * Each test below corresponds to one of those two claims, so they cannot go
 * quietly false again.
 */

test.describe('installability', () => {
  test('serves a manifest with the icons an install needs', async ({ page, request }) => {
    await page.goto('./');
    const href = await page.locator('link[rel=manifest]').getAttribute('href');
    expect(href).toBeTruthy();

    const manifest = await (await request.get(new URL(href!, page.url()).toString())).json();
    expect(manifest.name).toBe('LoreScribe');
    expect(manifest.display).toBe('standalone');
    // Relative, so one build serves Pages under /LoreScribe/ and a Capacitor
    // bundle under ./ — an absolute start_url would put the installed app on
    // the wrong path on exactly one of them.
    expect(manifest.start_url.startsWith('/')).toBe(false);
    expect(manifest.scope.startsWith('/')).toBe(false);

    const sizes = (manifest.icons as { sizes: string; purpose: string }[]);
    expect(sizes.map((i) => i.sizes)).toContain('192x192');
    expect(sizes.map((i) => i.sizes)).toContain('512x512');
    expect(sizes.some((i) => i.purpose === 'maskable')).toBe(true);

    for (const icon of manifest.icons as { src: string }[]) {
      const res = await request.get(new URL(icon.src, new URL(href!, page.url())).toString());
      expect(res.status(), icon.src).toBe(200);
      expect((await res.body()).length, icon.src).toBeGreaterThan(500);
    }
  });
});

test.describe('offline', () => {
  test('loads with the network off, once the worker has cached the build', async ({ page, context }) => {
    await page.goto('./');
    // `ready` resolves when a worker is active, which means install — and so
    // the precache — has finished. Not waitForFunction with an async predicate:
    // that polls for a truthy *return value*, and a Promise is always truthy,
    // so it passes instantly and proves nothing.
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));

    // The point of the precache: everything a cold start needs, including the
    // sqlite wasm, is in the cache before the network goes away.
    const cached = await page.evaluate(async () => {
      const names = await caches.keys();
      const cache = await caches.open(names.find((n) => n.startsWith('lorescribe-'))!);
      return (await cache.keys()).map((r) => new URL(r.url).pathname);
    });
    expect(cached.some((p) => p.endsWith('.wasm'))).toBe(true);
    expect(cached.some((p) => /worker.*\.js$/.test(p))).toBe(true);

    await context.setOffline(true);
    await page.reload();
    // Not just a shell: the database opens, which is the whole local-first claim.
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
    await context.setOffline(false);
  });

  test('does not hand control to a new version behind the writer’s back', async ({ page }) => {
    await page.goto('./');
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));

    // Structural, not behavioural, and worth being honest about why: proving
    // the waiting behaviour needs two deployed versions, which this harness
    // cannot stage. What it can check is that the only route to skipWaiting is
    // the SKIP_WAITING message — i.e. the reload button — and not the install
    // handler. That is the property that stops a deploy swapping the asset
    // bundle under someone mid-sentence.
    const source = (await (await page.request.get('./sw.js')).text())
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    const calls = source.split('\n').filter((l) => l.includes('skipWaiting'));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('SKIP_WAITING');

    // And the first install claims the page, so offline works without asking
    // the writer to reload before it will.
    expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  });
});
