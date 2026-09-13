import { test, expect } from '@playwright/test';
import { gotoApp } from './support';
import { writeFileSync, mkdirSync } from 'node:fs';

// Gate A. The exit condition is measured numbers, not a working demo — a
// three-row database on the main thread with no lock would pass a demo and
// would leave every risk this phase exists to find alive. docs/15 §1.

test('A1-A4, A6, A9 — the measurement run', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await gotoApp(page);

  const result = await page.evaluate(async () => {
    const r = await window.runSpike(undefined as never, { clearOnInit: true });
    return r;
  });

  expect(errors, `page errors: ${errors.join('\n')}`).toHaveLength(0);
  expect(result.failure, JSON.stringify(result.failure)).toBeUndefined();

  mkdirSync('spike-results', { recursive: true });
  writeFileSync('spike-results/local-chromium.json', JSON.stringify(result, null, 2));

  console.log('\n' + result.measurements.map((m) =>
    `${m.pass === null ? ' · ' : m.pass ? ' ✓ ' : ' ✗ '}${m.label}\n     ${m.value} ${m.unit}   (target ${m.target})${m.detail ? '\n     ' + m.detail : ''}`,
  ).join('\n'));

  // The VFS we actually got, not the one we asked for.
  expect(result.diagnostics?.vfsName).toBe('lorescribe-spike');
  expect(result.diagnostics?.foreignKeys).toBe(1);

  const failed = result.measurements.filter((m) => m.pass === false);
  expect(failed.map((m) => `${m.label}: ${m.value}${m.unit} (target ${m.target})`)).toEqual([]);
});

test('A5 — a second tab is refused, and what the cached failure actually scopes to', async ({ context }) => {
  const tabA = await context.newPage();
  await gotoApp(tabA);
  expect(await tabA.evaluate(() => window.holdOpen('lorescribe-multitab'))).toMatchObject({ ok: true });

  const tabB = await context.newPage();
  await gotoApp(tabB);
  const blocked = await tabB.evaluate(() => window.openOnly('lorescribe-multitab'));
  expect(blocked).toMatchObject({ ok: false, reason: 'held-by-another-tab' });

  console.log('   second tab refused with:', JSON.stringify(blocked));

  // Release the holder WITHOUT closing the page, so we are testing the VFS and
  // not the page lifecycle.
  expect(await tabA.evaluate(() => window.releaseHeld(false))).toMatchObject({ ok: true });

  // sqlite.org documents that a failed install is cached "so that future calls
  // can return consistent results". It is cached per JS realm, though — and we
  // spawn a fresh worker per open attempt, so the retry gets a clean realm and
  // succeeds. That is a materially better UX than the docs imply, and it is why
  // this test exists rather than a note in a design document.
  const retry = await tabB.evaluate(() => window.openOnly('lorescribe-multitab'));
  expect(retry).toMatchObject({ ok: true });

  console.log('   retry in a fresh worker, same page:', JSON.stringify({ ok: (retry as { ok: boolean }).ok }));
});

test('A5b — pauseVfs/unpauseVfs gives a real cooperative handoff', async ({ context }) => {
  const tabA = await context.newPage();
  await gotoApp(tabA);
  expect(await tabA.evaluate(() => window.holdOpen('lorescribe-handoff'))).toMatchObject({ ok: true });

  const tabB = await context.newPage();
  await gotoApp(tabB);
  expect(await tabB.evaluate(() => window.openOnly('lorescribe-handoff')))
    .toMatchObject({ ok: false, reason: 'held-by-another-tab' });

  // Tab A yields: close handles, then pause the VFS.
  expect(await tabA.evaluate(() => window.releaseHeld(true))).toMatchObject({ ok: true });

  // Tab B takes over, and the data written by tab A is intact.
  const taken = await tabB.evaluate(() => window.reopenAndCount('lorescribe-handoff', 'project'));
  expect(taken).toMatchObject({ ok: true, integrity: 'ok' });
  expect((taken as { count: number }).count).toBe(1);
});

test('A5c — after a pause/unpause handoff the database is usable again', async ({ page }) => {
  // pause() closes the handle so another context can take the VFS. Until this
  // test existed, unpause() reopened nothing and the next query dereferenced a
  // null database — the handoff D18 calls mandatory did not come back.
  await gotoApp(page, './');
  const result = await page.evaluate(() => window.pauseAndResume('lorescribe-resume'));
  expect(result).toMatchObject({ ok: true, beforePause: 1, afterUnpause: 1, integrity: 'ok' });
});

test('A7 — data survives an abrupt kill mid-write', async ({ browser }) => {
  const ctx = await browser.newContext();
  const p1 = await ctx.newPage();
  await gotoApp(p1);

  await p1.evaluate(async () => {
    const held = await window.holdOpen('lorescribe-durability');
    void held;
    const d = window.__held!;
    for (let i = 0; i < 200; i++) {
      await d.query('INSERT INTO book (id,project_id,title,sort_key,created_at,updated_at) VALUES (?,?,?,?,?,?)',
        [`bk_${i}`, 'pr_hold', `Book ${i}`, String(i), Date.now(), Date.now()], 'run');
    }
  });

  // No close(), no flush: kill the page out from under the worker.
  await p1.evaluate(() => {
    const d = window.__held!;
    void d.query('INSERT INTO book (id,project_id,title,sort_key,created_at,updated_at) VALUES (?,?,?,?,?,?)',
      ['bk_inflight', 'pr_hold', 'In flight', 'z', Date.now(), Date.now()], 'run');
  });
  await p1.close();

  const p2 = await ctx.newPage();
  await gotoApp(p2);
  const survived = await p2.evaluate(() => window.reopenAndCount('lorescribe-durability', 'book'));
  // The 200 committed writes must all be there, and the file must not be corrupt.
  expect(survived).toMatchObject({ ok: true, integrity: 'ok' });
  expect((survived as { count: number }).count).toBeGreaterThanOrEqual(200);

  console.log('   after abrupt kill:', JSON.stringify(survived));

  await ctx.close();
});
