import { test, expect, type Page } from '@playwright/test';
import { gotoApp } from './support';

/**
 * The writing surface.
 *
 * Only one property really matters and every test here is a version of it:
 * prose the writer typed is in the database, on every path out of the autosave
 * debounce. A word count that lags or a highlight that misses is a defect; text
 * that never arrives is the failure that would make the rest of this app
 * pointless.
 */

const surface = (page: Page) => page.locator('.prose-editor');

/**
 * Push the autosave debounce out of reach.
 *
 * Any test about a flush PATH — hidden tab, scene switch, handover — has to
 * disable the ordinary timer first, or the timer is what saves the text and the
 * test passes with the path deleted.
 */
const suspendAutosave = (page: Page) =>
  page.evaluate(() => { (window as unknown as { __lsSaveDelayMs: number }).__lsSaveDelayMs = 600_000; });
const status = (page: Page) => page.locator('[data-save-state]');

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

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[][] }>;

/**
 * What the database actually holds, through the live connection.
 *
 * A test cannot open its own: opfs-sahpool is single-writer and the app holds
 * it. The hook is build-flag gated in DbProvider for exactly this.
 */
async function query(page: Page, sql: string, params: unknown[] = []): Promise<unknown[][]> {
  return page.evaluate(async ([s, p]) => {
    const run = (window as unknown as { __lsQuery: Query }).__lsQuery;
    return (await run(s as string, p as unknown[])).rows;
  }, [sql, params] as const);
}

const storedText = async (page: Page): Promise<string> =>
  String((await query(page, 'SELECT content_text FROM scene ORDER BY global_rank'))[0]?.[0] ?? '');

test('types, autosaves, and says so', async ({ page }) => {
  await sceneOpen(page);
  await surface(page).click();
  await page.keyboard.type('The council met at dawn.');

  await expect(status(page)).toHaveAttribute('data-save-state', 'unsaved');
  await expect(status(page)).toHaveAttribute('data-save-state', 'saved');
  // Counted by the project's own counter, from the editor's current text.
  await expect(page.getByText('5 words')).toBeVisible();
  // Read back from the database, not from the DOM that just rendered it.
  expect(await storedText(page)).toBe('The council met at dawn.');
  expect(await query(page, 'SELECT word_count FROM scene ORDER BY global_rank'))
    .toEqual([[5]]);
  // Search follows the prose in the same transaction.
  expect(await query(page, "SELECT COUNT(*) FROM scene_fts WHERE scene_fts MATCH 'council'"))
    .toEqual([[1]]);
});

test('the prose is in the database, not the page', async ({ page }) => {
  await sceneOpen(page);
  await surface(page).click();
  await page.keyboard.type('Ilva waited in the Long Hall.');
  await expect(status(page)).toHaveAttribute('data-save-state', 'saved');

  await page.reload();
  await page.waitForFunction(() => 'runSpike' in window);
  await page.getByRole('button', { name: /^Scene 1, / }).click();
  await expect(surface(page)).toContainText('Ilva waited in the Long Hall.');
});

test('a scene that is still unsaved is flushed when the tab is hidden', async ({ page }) => {
  // The R2b case: Android kills a backgrounded tab, and visibilitychange is the
  // event that actually fires there. Without this the last sentence is lost.
  await sceneOpen(page);
  await suspendAutosave(page);
  await surface(page).click();
  await page.keyboard.type('Smoke over the rooftops.');
  await expect(status(page)).toHaveAttribute('data-save-state', 'unsaved');

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(status(page)).toHaveAttribute('data-save-state', 'saved');

  await page.reload();
  await page.waitForFunction(() => 'runSpike' in window);
  await page.getByRole('button', { name: /^Scene 1, / }).click();
  await expect(surface(page)).toContainText('Smoke over the rooftops.');
});

test('switching scenes flushes the one being left', async ({ page }) => {
  await sceneOpen(page);
  await page.getByRole('button', { name: 'Add a scene' }).click();
  await suspendAutosave(page);

  await surface(page).click();
  await page.keyboard.type('First scene text.');
  await expect(status(page)).toHaveAttribute('data-save-state', 'unsaved');

  // Straight to the other scene, inside the debounce window.
  await page.getByRole('button', { name: /^Scene 2, / }).click();
  await expect(surface(page)).toHaveText('');

  await page.getByRole('button', { name: /^Scene 1, / }).click();
  await expect(surface(page)).toContainText('First scene text.');
});

test('an editor opened on another scene never carries the last one’s prose', async ({ page }) => {
  await sceneOpen(page);
  await page.getByRole('button', { name: 'Add a scene' }).click();
  await surface(page).click();
  await page.keyboard.type('Only in scene one.');
  await expect(status(page)).toHaveAttribute('data-save-state', 'saved');

  await page.getByRole('button', { name: /^Scene 2, / }).click();
  await expect(surface(page)).toHaveText('');
  // And scene two staying empty has to survive its own autosave settling.
  await expect(status(page)).toHaveAttribute('data-save-state', 'saved');
  await page.getByRole('button', { name: /^Scene 1, / }).click();
  await expect(surface(page)).toContainText('Only in scene one.');
});

test('the word count tracks the editor, not the last save', async ({ page }) => {
  await sceneOpen(page);
  await surface(page).click();
  await page.keyboard.type('The rain fell hard.');
  await expect(page.getByText('4 words')).toBeVisible();
  await page.keyboard.type(' It kept falling.');
  await expect(page.getByText('7 words')).toBeVisible();
});

test('highlights an entity as it is typed, and records the mention', async ({ page }) => {
  await gotoApp(page);
  await page.getByLabel('Project title').fill(`Ashfall ${Date.now()}`);
  await page.getByRole('button', { name: 'Create project' }).click();
  const projectId = String(
    (await query(page, 'SELECT id FROM project ORDER BY created_at DESC'))[0]![0]);

  // The matcher needs an entity with an alias before the editor loads them.
  // No codex UI yet, so this arrives the way the importer will put it there.
  await query(page, `INSERT INTO entity (id,project_id,type_key,name,created_at,updated_at)
                     VALUES ('e1',?,'character','Ilva',1,1)`, [projectId]);
  await query(page, `INSERT INTO entity_alias (id,entity_id,alias,created_at)
                     VALUES ('a1','e1','Ilva',1)`);

  await page.getByRole('link', { name: /^Ashfall/ }).first().click();
  await page.getByRole('button', { name: 'Create the first book' }).click();
  await page.getByRole('button', { name: 'Add a chapter' }).click();
  await page.getByRole('button', { name: 'Add a scene' }).click();
  await page.getByRole('button', { name: /^Scene 1, / }).click();

  await surface(page).click();
  await page.keyboard.type('Ilva waited. Ilva left.');

  // The decoration is live, before any save: it comes from the ProseMirror
  // plugin reading the document, not from a round trip.
  const marks = page.locator('.ls-mention');
  await expect(marks).toHaveCount(2);
  await expect(marks.first()).toHaveAttribute('data-entity-id', 'e1');
  await expect(marks.first()).toHaveText('Ilva');

  // And the derived row follows on the longer idle, through the same rules a
  // wholesale rebuild would apply.
  await expect.poll(
    () => query(page, 'SELECT entity_id, role FROM mention'),
    { timeout: 15_000 },
  ).toEqual([['e1', 'present']]);
});
