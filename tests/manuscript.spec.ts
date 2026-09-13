import { test, expect, type Page } from '@playwright/test';
import { gotoApp } from './support';

/**
 * The manuscript tree, end to end.
 *
 * The repository's own tests prove a move writes one row. What they cannot
 * prove is that the tree a writer sees agrees with the manuscript underneath
 * it — that the row order, the reading order and the drag that caused them are
 * the same thing. That is what these check.
 */

const titles = (page: Page, kind: 'scene' | 'chapter') =>
  page.locator(`[data-row-kind=${kind}]`).evaluateAll(
    (rows) => rows.map((r) => r.querySelector('span:nth-of-type(2)')?.textContent?.trim() ?? ''));

async function freshProject(page: Page): Promise<void> {
  await gotoApp(page);
  await page.getByLabel('Project title').fill(`Ashfall ${Date.now()}`);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: /^Ashfall/ }).first().click();
  await page.getByRole('button', { name: 'Create the first book' }).click();
}

/** Two chapters, two scenes each, in reading order. */
async function skeleton(page: Page): Promise<void> {
  await freshProject(page);
  for (let c = 0; c < 2; c++) {
    await page.getByRole('button', { name: 'Add a chapter' }).click();
    const addScene = page.getByRole('button', { name: 'Add a scene' });
    await expect(addScene).toHaveCount(c + 1);
    for (let s = 0; s < 2; s++) await addScene.nth(c).click();
  }
  await expect(page.locator('[data-row-kind=scene]')).toHaveCount(4);
}

test('builds a tree, and the tree is the manuscript', async ({ page }) => {
  await skeleton(page);
  expect(await titles(page, 'chapter')).toEqual(['Chapter 1', 'Chapter 2']);
  // Scene rows render in reading order across chapters, which is global_rank's
  // order — the repository filled it, the page never computed it.
  expect(await titles(page, 'scene')).toEqual(['Scene 1', 'Scene 2', 'Scene 1', 'Scene 2']);
});

test('a scene moves by keyboard, and moving past a chapter end changes chapter', async ({ page }) => {
  await skeleton(page);
  await page.getByRole('button', { name: /^Scene 1, / }).first().click();
  await page.getByRole('button', { name: /^Scene 1, / }).first().focus();

  // Down once: swaps with its sibling inside chapter one.
  await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(() => titles(page, 'scene'))
    .toEqual(['Scene 2', 'Scene 1', 'Scene 1', 'Scene 2']);

  // Down again: it is now last in chapter one, so one more position down is the
  // FIRST position of chapter two, not a no-op and not the second position.
  await page.locator('[data-row-kind=scene]').nth(1).focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(() => page.locator('[data-row-kind=chapter]').first()
    .locator('..').locator('[data-row-kind=scene]').count()).toBe(1);
  await expect.poll(() => page.locator('[data-row-kind=chapter]').nth(1)
    .locator('..').locator('[data-row-kind=scene]').count()).toBe(3);
});

test('the order survives a reload, because it is in the database not the page', async ({ page }) => {
  await skeleton(page);
  await page.locator('[data-row-kind=scene]').first().focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(() => titles(page, 'scene'))
    .toEqual(['Scene 2', 'Scene 1', 'Scene 1', 'Scene 2']);

  await page.reload();
  await page.waitForFunction(() => 'runSpike' in window);
  await expect.poll(() => titles(page, 'scene'))
    .toEqual(['Scene 2', 'Scene 1', 'Scene 1', 'Scene 2']);
});

test('a chapter moves, taking its scenes with it', async ({ page }) => {
  await skeleton(page);
  await page.locator('[data-row-kind=chapter]').nth(1).focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(() => titles(page, 'chapter')).toEqual(['Chapter 2', 'Chapter 1']);
  // The scenes did not move — their own sort keys are untouched — but the
  // manuscript reads in the new order, which is global_rank following the
  // chapter that carried them.
  expect(await titles(page, 'scene')).toEqual(['Scene 1', 'Scene 2', 'Scene 1', 'Scene 2']);
  const first = page.locator('[data-row-kind=chapter]').first();
  await expect(first).toHaveAttribute('aria-label', /^Chapter 2, 2 scenes/);
});

test('a drag reorders, using pointer events so it works on touch too', async ({ page }) => {
  await skeleton(page);
  const rows = page.locator('[data-row-kind=scene]');
  const from = rows.nth(0);
  const to = rows.nth(1);
  const a = (await from.locator('span').first().boundingBox())!;
  const b = (await to.boundingBox())!;

  // HTML5 drag-and-drop never fires on touch, which is why the tree uses
  // pointer events; a mouse gesture exercises the same code path.
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height * 0.9, { steps: 12 });
  await page.mouse.up();

  await expect.poll(() => titles(page, 'scene'))
    .toEqual(['Scene 2', 'Scene 1', 'Scene 1', 'Scene 2']);
});

test('a click on a row is not a drag', async ({ page }) => {
  await skeleton(page);
  const before = await titles(page, 'scene');
  await page.locator('[data-row-kind=scene]').first().locator('span').first().click();
  expect(await titles(page, 'scene')).toEqual(before);
});

test('renaming and deleting reach the database', async ({ page }) => {
  await skeleton(page);
  await page.locator('[data-row-kind=scene]').first()
    .getByRole('button', { name: 'rename' }).click();
  await page.getByLabel('Rename Scene 1').fill('The Long Hall');
  await page.keyboard.press('Enter');
  await expect.poll(() => titles(page, 'scene'))
    .toEqual(['The Long Hall', 'Scene 2', 'Scene 1', 'Scene 2']);

  await page.locator('[data-row-kind=scene]').first()
    .getByRole('button', { name: 'delete' }).click();
  await expect(page.locator('[data-row-kind=scene]')).toHaveCount(3);

  await page.reload();
  await page.waitForFunction(() => 'runSpike' in window);
  await expect(page.locator('[data-row-kind=scene]')).toHaveCount(3);
});
