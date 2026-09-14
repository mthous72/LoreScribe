import { test, expect, type Page } from '@playwright/test';
import { gotoApp } from './support';

/**
 * `@` insert, end to end.
 *
 * The point is not convenience. `detectSpans` refuses an alias two entities
 * share, because a link the writer never asked for is a claim without evidence
 * — so an ambiguous name is invisible to the graph until somebody points at it.
 * `@` is how you point, and the test that matters is the one where the matcher
 * cannot help.
 */

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[][] }>;
async function query(page: Page, sql: string, params: unknown[] = []): Promise<unknown[][]> {
  return page.evaluate(async ([s, p]) => {
    const run = (window as unknown as { __lsQuery: Query }).__lsQuery;
    return (await run(s as string, p as unknown[])).rows;
  }, [sql, params] as const);
}

const surface = (page: Page) => page.locator('.prose-editor');
const options = (page: Page) => page.getByRole('option');

/** A project with one empty scene and the named codex entries. */
async function project(page: Page, names: string[]): Promise<void> {
  await gotoApp(page);
  await page.getByLabel('Project title').fill(`Ashfall ${Date.now()}`);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: /^Ashfall/ }).first().click();
  await page.getByRole('button', { name: 'Create the first book' }).click();
  await page.getByRole('button', { name: 'Add a chapter' }).click();
  await page.getByRole('button', { name: 'Add a scene' }).click();

  await page.getByRole('link', { name: /^Codex/ }).click();
  // The loop index, not indexOf: two entities can share a name — which is the
  // whole point of the ambiguity test below — and indexOf would report the
  // first one twice.
  for (const [i, name] of names.entries()) {
    await page.getByLabel('New entity name').fill(name);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect.poll(() => query(page, 'SELECT COUNT(*) FROM entity'), { timeout: 20_000 })
      .toEqual([[i + 1]]);
  }
  await page.getByRole('link', { name: '← Manuscript' }).click();
  await page.getByRole('button', { name: /^Scene 1, / }).click();
  await expect(surface(page)).toBeVisible();
}

test('typing @ offers codex entries and narrows as you type', async ({ page }) => {
  await project(page, ['Ilva', 'The Long Hall']);
  await surface(page).click();

  await page.keyboard.type('She met @');
  await expect(options(page)).toHaveCount(2);

  await page.keyboard.type('ilv');
  await expect(options(page)).toHaveCount(1);
  await expect(options(page).first()).toContainText('Ilva');
});

test('inserts the codex name, not what was typed', async ({ page }) => {
  await project(page, ['Ilva']);
  await surface(page).click();
  // The point of a picker is not having to spell it.
  await page.keyboard.type('She met @ilv');
  await page.keyboard.press('Enter');

  await expect(surface(page)).toContainText('She met Ilva');
  await expect(page.locator('.ls-mention-explicit')).toHaveText('Ilva');
});

test('links an entity the matcher refuses, because two share the name', async ({ page }) => {
  // Both Rhyses have "Rhys" as their primary alias, so detectSpans finds the
  // word ambiguous and links neither. This is the gap @ exists to close.
  await project(page, ['Rhys', 'Rhys']);
  await surface(page).click();
  await page.keyboard.type('Rhys waited.');
  await expect.poll(() => query(page, 'SELECT COUNT(*) FROM mention'), { timeout: 20_000 })
    .toEqual([[0]]);

  await page.keyboard.type(' Then @Rhys');
  await page.keyboard.press('Enter');

  // One mention now, against exactly the entity that was chosen.
  await expect.poll(
    () => query(page, "SELECT COUNT(*) FROM mention WHERE method = 'explicit'"),
    { timeout: 25_000 },
  ).toEqual([[1]]);
});

test('the link survives a reload, and shows in the scene cast', async ({ page }) => {
  await project(page, ['Ilva']);
  await surface(page).click();
  await page.keyboard.type('She met @Ilva');
  await page.keyboard.press('Enter');

  // Wait for the link to reach the DATABASE, not for a status that was already
  // "saved" before the typing registered — an assertion that is true on
  // arrival proves nothing, and the reload would race the save.
  await expect.poll(
    async () => String((await query(page, 'SELECT content_json FROM scene'))[0]?.[0] ?? ''),
    { timeout: 25_000 },
  ).toContain('entityLink');

  // It reached the graph, not just the document.
  await expect(page.getByRole('link', { name: /^Ilva/ })).toBeVisible({ timeout: 25_000 });

  await page.reload();
  await page.waitForFunction(() => 'runSpike' in window);
  await page.getByRole('button', { name: /^Scene 1, / }).click();
  await expect(page.locator('.ls-mention-explicit')).toHaveText('Ilva');
});

test('deleting the linked word removes the mention', async ({ page }) => {
  await project(page, ['Ilva']);
  await surface(page).click();
  await page.keyboard.type('@Ilva');
  await page.keyboard.press('Enter');
  await expect.poll(
    () => query(page, "SELECT COUNT(*) FROM mention WHERE method = 'explicit'"),
    { timeout: 25_000 },
  ).toEqual([[1]]);

  // A link must not outlive the word it was attached to.
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Nothing here now.');
  await expect.poll(() => query(page, 'SELECT COUNT(*) FROM mention'), { timeout: 25_000 })
    .toEqual([[0]]);
});

test('an @ that means nothing stays ordinary punctuation', async ({ page }) => {
  await project(page, ['Ilva']);
  await surface(page).click();

  // No codex entry matches, so there is no list — and Enter must still make a
  // paragraph rather than being swallowed by a menu that is not there.
  await page.keyboard.type('Write to me @ home');
  await expect(options(page)).toHaveCount(0);
  await page.keyboard.press('Enter');
  await page.keyboard.type('A second line.');

  await expect(surface(page)).toContainText('Write to me @ home');
  await expect(surface(page)).toContainText('A second line.');
  await expect(surface(page).locator('p')).toHaveCount(2);
});

test('Escape closes the list and leaves the typing alone', async ({ page }) => {
  await project(page, ['Ilva']);
  await surface(page).click();
  await page.keyboard.type('She met @Ilv');
  await expect(options(page)).toHaveCount(1);

  await page.keyboard.press('Escape');
  await expect(options(page)).toHaveCount(0);
  await expect(surface(page)).toContainText('She met @Ilv');
  await expect(page.locator('.ls-mention-explicit')).toHaveCount(0);
});

test('the arrows choose without taking the caret out of the prose', async ({ page }) => {
  await project(page, ['Ilva', 'Ilva Renn']);
  await surface(page).click();
  await page.keyboard.type('@Ilva');
  await expect(options(page)).toHaveCount(2);

  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-chosen=true]')).toContainText('Ilva Renn');
  await page.keyboard.press('Enter');

  await expect(page.locator('.ls-mention-explicit')).toHaveText('Ilva Renn');
  // The caret never left: typing continues in the sentence, unlinked.
  await page.keyboard.type('waited.');
  await expect(surface(page)).toContainText('Ilva Renn waited.');
  await expect(page.locator('.ls-mention-explicit')).toHaveText('Ilva Renn');
});
