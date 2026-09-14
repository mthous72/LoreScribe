import { test, expect, type Page } from '@playwright/test';
import { gotoApp } from './support';

/**
 * Backlinks and the entity card — the lore graph made navigable.
 *
 * `mention` rows have existed for several commits with nowhere to be seen.
 * These check the two directions a writer actually travels: from a scene to
 * who is in it, and from an entity to where it appears.
 */

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[][] }>;
async function query(page: Page, sql: string, params: unknown[] = []): Promise<unknown[][]> {
  return page.evaluate(async ([s, p]) => {
    const run = (window as unknown as { __lsQuery: Query }).__lsQuery;
    return (await run(s as string, p as unknown[])).rows;
  }, [sql, params] as const);
}

/** A book of two chapters, one scene each, both naming Ilva. */
async function bookWithIlva(page: Page): Promise<void> {
  await gotoApp(page);
  await page.getByLabel('Project title').fill(`Ashfall ${Date.now()}`);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: /^Ashfall/ }).first().click();
  await page.getByRole('button', { name: 'Create the first book' }).click();

  for (const [chapter, prose] of [[0, 'Ilva waited in the hall. Ilva slept.'],
    [1, 'Ilva left before dawn.']] as const) {
    await page.getByRole('button', { name: 'Add a chapter' }).click();
    await page.getByRole('button', { name: 'Add a scene' }).nth(chapter).click();
    await page.getByRole('button', { name: /^Scene 1, / }).nth(chapter).click();
    await page.locator('.prose-editor').click();
    await page.keyboard.type(prose);
    await expect(page.locator('[data-save-state]')).toHaveAttribute('data-save-state', 'saved');
  }

  await page.getByRole('link', { name: /^Codex/ }).click();
  await page.getByLabel('New entity name').fill('Ilva');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect.poll(() => query(page, 'SELECT COUNT(*) FROM mention'), { timeout: 20_000 })
    .toEqual([[2]]);
}

test('an entity lists the scenes it appears in, in reading order', async ({ page }) => {
  await bookWithIlva(page);
  const appearances = page.getByRole('link', { name: /Chapter \d · Scene 1/ });
  await expect(appearances).toHaveCount(2);
  await expect(appearances.nth(0)).toContainText('Chapter 1');
  await expect(appearances.nth(1)).toContainText('Chapter 2');
});

test('a backlink opens that scene, and the URL says which', async ({ page }) => {
  await bookWithIlva(page);
  await page.getByRole('link', { name: /Chapter 2 · Scene 1/ }).click();

  // The open scene lives in the URL, so a link can name one and a reload
  // returns to it rather than to the top of the book.
  await expect(page).toHaveURL(/scene=/);
  await expect(page.locator('.prose-editor')).toContainText('Ilva left before dawn.');
  await page.reload();
  await page.waitForFunction(() => 'runSpike' in window);
  await expect(page.locator('.prose-editor')).toContainText('Ilva left before dawn.');
});

test('a scene shows its cast, and each links back to the codex', async ({ page }) => {
  await bookWithIlva(page);
  await page.getByRole('link', { name: /Chapter 1 · Scene 1/ }).click();

  const chip = page.getByRole('link', { name: /^Ilva present$/ });
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page).toHaveURL(/codex\?entity=/);
  // And the entry it lands on is open, not just the list.
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Ilva');
});

test('tapping a highlighted name opens its codex card', async ({ page }) => {
  await bookWithIlva(page);
  // A one-line summary, so the card has something to show.
  await page.getByLabel('Summary').fill('A courier who reads.');
  await page.getByLabel('Description').click();
  await page.getByRole('link', { name: /Chapter 1 · Scene 1/ }).click();

  // Tap, not hover: hover does not exist on a phone, and D15 makes the phone
  // a peer rather than a viewer.
  await page.locator('.ls-mention').first().click();
  const card = page.getByRole('dialog', { name: /Ilva — codex entry/ });
  await expect(card).toBeVisible();
  await expect(card).toContainText('A courier who reads.');

  await card.getByRole('button', { name: 'Close' }).click();
  await expect(card).toBeHidden();
});

test('the cast follows the prose as it is written', async ({ page }) => {
  await bookWithIlva(page);
  await page.getByRole('link', { name: /Chapter 2 · Scene 1/ }).click();
  await expect(page.getByRole('link', { name: /^Ilva/ })).toBeVisible();

  // Remove every mention of her from this scene; the cast should empty out on
  // the editor's own re-index, with nobody pressing anything.
  await page.locator('.prose-editor').click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('The hall stood empty.');
  await expect.poll(
    () => page.getByRole('link', { name: /^Ilva present$/ }).count(),
    { timeout: 25_000 },
  ).toBe(0);
});
