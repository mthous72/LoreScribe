import { test, expect, type Page } from '@playwright/test';
import { gotoApp } from './support';

/**
 * The authored metadata a scene brief is compiled from.
 *
 * Until this panel existed, none of these columns could be set by anybody using
 * the app — they were written only by the corpus generator and by tests. The
 * plumbing was all in place and fed a permanent null, which is the kind of gap
 * that looks covered: the spoiler rule's POV branch is exhaustively unit-tested
 * and the facts page demonstrates it with a dropdown.
 *
 * Fixtures invented — D14.
 */

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[][] }>;
async function query(page: Page, sql: string, params: unknown[] = []): Promise<unknown[][]> {
  return page.evaluate(async ([s, p]) => {
    const run = (window as unknown as { __lsQuery: Query }).__lsQuery;
    return (await run(s as string, p as unknown[])).rows;
  }, [sql, params] as const);
}

const suspendAutosave = (page: Page) =>
  page.evaluate(() => { (window as unknown as { __lsSaveDelayMs: number }).__lsSaveDelayMs = 600_000; });

/** A project with one scene open and a character called Ilva in the codex. */
async function scene(page: Page): Promise<void> {
  await gotoApp(page);
  await page.getByLabel('Project title').fill(`Ashfall ${Date.now()}`);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: /^Ashfall/ }).first().click();
  await page.getByRole('button', { name: 'Create the first book' }).click();
  await page.getByRole('button', { name: 'Add a chapter' }).click();
  await page.getByRole('button', { name: 'Add a scene' }).click();

  await page.getByRole('link', { name: /^Codex/ }).click();
  await page.getByLabel('New entity name').fill('Ilva');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect.poll(() => query(page, 'SELECT COUNT(*) FROM entity'), { timeout: 20_000 })
    .toEqual([[1]]);

  await page.getByRole('link', { name: '← Manuscript' }).click();
  await page.getByRole('button', { name: /^Scene 1, / }).click();
  await expect(page.getByTestId('scene-details')).toBeVisible();
}

test('a scene can be given a point of view, and it reaches the database', async ({ page }) => {
  await scene(page);
  await page.getByLabel('Point of view').selectOption({ label: 'Ilva' });

  await expect.poll(
    () => query(page, 'SELECT pov_entity_id IS NOT NULL FROM scene'), { timeout: 15_000 },
  ).toEqual([[1]]);
});

test('the POV character becomes a pov mention even when the prose never names them', async ({ page }) => {
  // The close-third case, and the reason POV is not a label: detectSpans adds
  // the mention from the authored field whether or not the character is on the
  // page. Without this, a brief compiled for such a scene has no protagonist.
  await scene(page);
  await page.locator('.prose-editor').click();
  await page.keyboard.type('The harbour was empty, and the gate stood open.');
  await expect(page.locator('[data-save-state]')).toHaveAttribute('data-save-state', 'saved');

  await page.getByLabel('Point of view').selectOption({ label: 'Ilva' });

  await expect.poll(
    () => query(page, 'SELECT e.name, m.role FROM mention m JOIN entity e ON e.id = m.entity_id'),
    { timeout: 15_000 },
  ).toEqual([['Ilva', 'pov']]);
});

test('changing the point of view does not cost the sentence being typed', async ({ page }) => {
  // Changing POV rebuilds the editor, and the rebuild reads the scene back from
  // the database. What protects the unsaved sentence is SceneEditor's token
  // gate: the surface unmounts on the next render and its cleanup flush lands
  // before the refetch resolves. This test passes with the explicit flush in
  // SceneDetails deleted — it is pinning the OUTCOME, which is what matters, and
  // it would catch the gate being loosened.
  await scene(page);
  await suspendAutosave(page);
  await page.locator('.prose-editor').click();
  await page.keyboard.type('She reached the gate before the rain did.');
  await expect(page.locator('[data-save-state]')).toHaveAttribute('data-save-state', 'unsaved');

  await page.getByLabel('Point of view').selectOption({ label: 'Ilva' });

  await expect(page.locator('.prose-editor'))
    .toContainText('She reached the gate before the rain did.');
  await expect.poll(
    () => query(page, 'SELECT content_text FROM scene'), { timeout: 15_000 },
  ).toEqual([['She reached the gate before the rain did.']]);
});

test('purpose and summary persist, and survive a reload', async ({ page }) => {
  await scene(page);
  await page.getByLabel('What this scene has to do').fill('Get her through the gate.');
  await page.getByLabel('In a line, for later').fill('Ilva crosses, and is seen.');
  await page.getByLabel('In a line, for later').blur();

  await expect.poll(() => query(page, 'SELECT purpose, summary FROM scene'), { timeout: 15_000 })
    .toEqual([['Get her through the gate.', 'Ilva crosses, and is seen.']]);

  await page.reload();
  await page.waitForFunction(() => 'runSpike' in window);
  await expect(page.getByLabel('What this scene has to do')).toHaveValue('Get her through the gate.');
});

test('setting one field does not blank the others', async ({ page }) => {
  // "Merges never destroy", applied to a form: the panel writes only what it
  // was given, so a later field cannot erase an earlier one.
  await scene(page);
  await page.getByLabel('What this scene has to do').fill('Kept.');
  await page.getByLabel('What this scene has to do').blur();
  await expect.poll(() => query(page, 'SELECT purpose FROM scene'), { timeout: 15_000 })
    .toEqual([['Kept.']]);

  await page.getByLabel('Tense').selectOption('past');
  await page.getByLabel('Told as').selectOption('close_third');

  await expect.poll(() => query(page, 'SELECT purpose, tense, pov_mode FROM scene'),
    { timeout: 15_000 }).toEqual([['Kept.', 'past', 'close_third']]);
});
