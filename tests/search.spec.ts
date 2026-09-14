import { test, expect, type Page } from '@playwright/test';
import { gotoApp } from './support';

/**
 * Search, end to end.
 *
 * The repository tests prove the queries. What only a browser can show is that
 * the indexes the running app maintains are the ones being searched — nothing
 * here rebuilds anything or inserts a row by hand.
 */

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[][] }>;
async function query(page: Page, sql: string, params: unknown[] = []): Promise<unknown[][]> {
  return page.evaluate(async ([s, p]) => {
    const run = (window as unknown as { __lsQuery: Query }).__lsQuery;
    return (await run(s as string, p as unknown[])).rows;
  }, [sql, params] as const);
}

/** A project with one scene of prose and one codex entry. */
async function project(page: Page): Promise<void> {
  await gotoApp(page);
  await page.getByLabel('Project title').fill(`Ashfall ${Date.now()}`);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: /^Ashfall/ }).first().click();
  await page.getByRole('button', { name: 'Create the first book' }).click();
  await page.getByRole('button', { name: 'Add a chapter' }).click();
  await page.getByRole('button', { name: 'Add a scene' }).click();
  await page.getByRole('button', { name: /^Scene 1, / }).click();
  await page.locator('.prose-editor').click();
  await page.keyboard.type("The council met at dawn and the warden didn't answer them.");
  await expect(page.locator('[data-save-state]')).toHaveAttribute('data-save-state', 'saved');

  await page.getByRole('link', { name: /^Codex/ }).click();
  await page.getByLabel('New entity name').fill('Ilva');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByLabel('Description').fill('A courier who reads.');
  await page.getByLabel('Summary').click();
  await expect.poll(() => query(page, 'SELECT description FROM entity'), { timeout: 10_000 })
    .toEqual([['A courier who reads.']]);
}

/**
 * Get to the search page from wherever we are.
 *
 * "Search →" lives on the manuscript page; the codex and search pages both
 * offer "← Manuscript" to get back there. Assuming a starting page instead is
 * what made the first run of this file spend four minutes per test waiting for
 * a link that was on a different screen.
 */
const search = async (page: Page, q: string) => {
  const back = page.getByRole('link', { name: '← Manuscript' });
  if (await back.isVisible().catch(() => false)) await back.click();
  await page.getByRole('link', { name: 'Search →' }).click();
  await page.getByLabel('Search this project').fill(q);
};

test('finds prose the writer typed, with the word marked', async ({ page }) => {
  await project(page);
  await search(page, 'council');

  const hit = page.getByRole('link', { name: /Scene 1/ });
  await expect(hit).toBeVisible();
  await expect(page.locator('mark')).toHaveText('council');
});

test('a result opens the scene it found', async ({ page }) => {
  await project(page);
  await search(page, 'council');
  await page.getByRole('link', { name: /Scene 1/ }).click();
  await expect(page).toHaveURL(/scene=/);
  await expect(page.locator('.prose-editor')).toContainText('The council met at dawn');
});

test('finds a codex entry and opens it', async ({ page }) => {
  await project(page);
  await search(page, 'courier');
  await page.getByRole('link', { name: /Ilva/ }).click();
  await expect(page).toHaveURL(/codex\?entity=/);
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Ilva');
});

test('the query lives in the URL, so a search can be linked and reloaded', async ({ page }) => {
  await project(page);
  await search(page, 'council');
  await expect(page).toHaveURL(/q=council/);
  await page.reload();
  await page.waitForFunction(() => 'runSpike' in window);
  await expect(page.getByLabel('Search this project')).toHaveValue('council');
  await expect(page.getByRole('link', { name: /Scene 1/ })).toBeVisible();
});

test('an empty box and a fruitless search say different things', async ({ page }) => {
  await project(page);
  await search(page, '');
  await expect(page.getByText('Type something to search')).toBeVisible();

  await page.getByLabel('Search this project').fill('dragon');
  await expect(page.getByText('Nothing matches that.')).toBeVisible();
});

test('survives what a writer actually types', async ({ page }) => {
  await project(page);
  // Every one of these is a syntax error if it reaches FTS5 unquoted; a search
  // box that dies on an apostrophe is not a search box.
  for (const hostile of ["don't", '-warden', 'a AND', '"unclosed', '*', '((', 'a:b']) {
    await search(page, hostile);
    // Three outcomes are all correct here, and which one appears depends on
    // the input: a hit, no hit, or — for input that is only punctuation —
    // no query at all, which the page says plainly rather than calling it
    // "nothing matches".
    await expect(
      page.getByText(/Nothing matches that\.|result|Type something to search/),
    ).toBeVisible();
  }

  // And the apostrophe case still finds the word either side of it.
  await search(page, "didn't");
  await expect(page.getByRole('link', { name: /Scene 1/ })).toBeVisible();
});

test('search follows the prose when it is rewritten', async ({ page }) => {
  await project(page);
  await search(page, 'council');
  await expect(page.getByRole('link', { name: /Scene 1/ })).toBeVisible();

  await page.getByRole('link', { name: '← Manuscript' }).click();
  await page.getByRole('button', { name: /^Scene 1, / }).click();
  await page.locator('.prose-editor').click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('The hall stood empty.');
  await expect(page.locator('[data-save-state]')).toHaveAttribute('data-save-state', 'saved');

  // A stale hit is worse than none: it sends a writer to prose that is gone.
  await search(page, 'council');
  await expect(page.getByText('Nothing matches that.')).toBeVisible();
  await page.getByLabel('Search this project').fill('empty');
  await expect(page.getByRole('link', { name: /Scene 1/ })).toBeVisible();
});
