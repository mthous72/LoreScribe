import { test, expect, type Page } from '@playwright/test';
import { gotoApp } from './support';

/**
 * Kept drafts, end to end.
 *
 * The repository's tests prove the drafts are stored and that restoring never
 * loses the page. What only the browser can show is the two joins this screen
 * depends on and neither side can check alone: that keeping a draft captures
 * the sentence still sitting behind the editor's debounce, and that restoring
 * one reaches the editor rather than the database alone — where the next
 * autosave would quietly put the old prose back over it.
 */

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[][] }>;
async function query(page: Page, sql: string, params: unknown[] = []): Promise<unknown[][]> {
  return page.evaluate(async ([s, p]) => {
    const run = (window as unknown as { __lsQuery: Query }).__lsQuery;
    return (await run(s as string, p as unknown[])).rows;
  }, [sql, params] as const);
}

/**
 * Push the autosave debounce out of reach.
 *
 * Without this, the ordinary timer saves the prose a moment later and every
 * assertion below passes with `flushAll` deleted — which is exactly the flaw
 * that made the first version of the hidden-tab test meaningless.
 */
const suspendAutosave = (page: Page) =>
  page.evaluate(() => { (window as unknown as { __lsSaveDelayMs: number }).__lsSaveDelayMs = 600_000; });

const surface = (page: Page) => page.locator('.prose-editor');
const drafts = (page: Page) => page.locator('[data-version-id]');

async function sceneOpen(page: Page): Promise<void> {
  await gotoApp(page);
  await page.getByLabel('Project title').fill(`Ashfall ${Date.now()}`);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: /^Ashfall/ }).first().click();
  await page.getByRole('button', { name: 'Create the first book' }).click();
  await page.getByRole('button', { name: 'Add a chapter' }).click();
  await page.getByRole('button', { name: 'Add a scene' }).click();
  await page.getByRole('button', { name: /^Scene 1, / }).click();
  await expect(surface(page)).toBeVisible();
}

/** Replace everything in the editor with this text. */
async function type(page: Page, text: string): Promise<void> {
  await surface(page).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(text);
}

async function keep(page: Page, label?: string): Promise<void> {
  const before = await drafts(page).count();
  if (label) await page.getByLabel('Name this draft').fill(label);
  await page.getByRole('button', { name: 'Keep this version' }).click();
  await expect(drafts(page)).toHaveCount(before + 1);
}

test('keeping a draft captures the sentence still behind the debounce', async ({ page }) => {
  await sceneOpen(page);
  await suspendAutosave(page);
  await type(page, 'The harbour was empty when she arrived.');
  // Proof the timer is not what saved it: the editor still says so.
  await expect(page.locator('[data-save-state]')).toHaveAttribute('data-save-state', 'unsaved');

  await keep(page, 'draft 1');
  await expect.poll(
    () => query(page, 'SELECT content_text FROM scene_version'), { timeout: 10_000 },
  ).toEqual([['The harbour was empty when she arrived.']]);
});

test('a second press keeps nothing new when nothing has changed', async ({ page }) => {
  await sceneOpen(page);
  await type(page, 'Unchanged.');
  await keep(page, 'draft 1');

  await page.getByRole('button', { name: 'Keep this version' }).click();
  await expect(page.getByText(/nothing new to keep/)).toBeVisible();
  await expect(drafts(page)).toHaveCount(1);
});

test('restoring a draft puts its prose back in the editor', async ({ page }) => {
  await sceneOpen(page);
  await suspendAutosave(page);
  await type(page, 'The first version.');
  await keep(page, 'draft 1');

  await type(page, 'A later version that went nowhere.');
  await expect(surface(page)).toContainText('went nowhere');

  await drafts(page).first().getByRole('button', { name: 'restore' }).click();
  // The editor, not the database: writing underneath it would leave the old
  // prose on screen and the next autosave would put it straight back.
  await expect(surface(page)).toContainText('The first version.');
  await expect(surface(page)).not.toContainText('went nowhere');
});

test('what was on the page survives a restore, and can be put back', async ({ page }) => {
  await sceneOpen(page);
  await suspendAutosave(page);
  await type(page, 'The first version.');
  await keep(page, 'draft 1');
  await type(page, 'The work in progress.');

  await drafts(page).filter({ hasText: 'draft 1' })
    .getByRole('button', { name: 'restore' }).click();
  await expect(surface(page)).toContainText('The first version.');

  await page.getByRole('button', { name: 'Put it back' }).click();
  await expect(surface(page)).toContainText('The work in progress.');
});

test('shows which words changed since the draft was kept', async ({ page }) => {
  await sceneOpen(page);
  await suspendAutosave(page);
  await type(page, 'She crossed the yard in the rain.');
  await keep(page, 'draft 1');
  await type(page, 'She crossed the yard in the snow.');

  // Comparing reads the current prose, which is still behind the debounce, so
  // this also proves the comparison flushes rather than reading a stale row.
  await drafts(page).first().getByRole('button', { name: 'compare' }).click();
  const diff = page.getByTestId('diff');
  await expect(diff.locator('[data-run="delete"]')).toHaveText('rain.');
  await expect(diff.locator('[data-run="insert"]')).toHaveText('snow.');
  await expect(page.getByTestId('diff-stats')).toHaveText('+1 −1');
});

test('says so when two drafts are the same', async ({ page }) => {
  await sceneOpen(page);
  await type(page, 'Word for word.');
  await keep(page, 'draft 1');
  await expect(page.getByText('These two are word for word the same.')).toBeVisible();
});

test('deleting a draft takes two presses, because it does not come back', async ({ page }) => {
  await sceneOpen(page);
  await type(page, 'Disposable.');
  await keep(page, 'draft 1');

  await drafts(page).first().getByRole('button', { name: 'delete', exact: true }).click();
  await expect(drafts(page)).toHaveCount(1);
  await drafts(page).first().getByRole('button', { name: 'delete for good?' }).click();
  await expect(drafts(page)).toHaveCount(0);
});

test('the drafts of a scene belong to that scene', async ({ page }) => {
  await sceneOpen(page);
  await type(page, 'Scene one prose.');
  await keep(page, 'draft 1');

  await page.getByRole('button', { name: 'Add a scene' }).click();
  await page.getByRole('button', { name: /^Scene 2, / }).click();
  await expect(page.getByText(/No kept drafts yet/)).toBeVisible();

  // And the comparison does not follow either. The panel is keyed on the scene
  // precisely so a picker cannot end up naming a draft this scene has never had.
  await type(page, 'Scene two prose.');
  await keep(page, 'scene two draft');
  await expect(drafts(page)).toHaveCount(1);

  // Back to the first scene, which is where the comparison can go wrong: its
  // picker must name its own draft, not the one chosen while scene two was
  // open. A select holding an id that is not among its options renders as the
  // first one and looks fine, so the value is what has to be asserted.
  await page.getByRole('button', { name: /^Scene 1, / }).click();
  await expect(drafts(page)).toHaveCount(1);
  const own = await drafts(page).first().getAttribute('data-version-id');
  await expect(page.getByLabel('Compare')).toHaveValue(own!);
});
