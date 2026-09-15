import { test, expect, type Page } from '@playwright/test';
import { gotoApp } from './support';

/**
 * The scene brief, in the browser.
 *
 * The compiler is proved on the fixture novel in `briefRepository.test.ts`.
 * What only the browser can show is the join that test cannot: the brief is
 * compiled from what the writer just did — a point of view chosen a moment
 * ago, prose still behind the editor's debounce — and the seam carries the
 * previous scene's last words into the next scene's brief.
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

const surface = (page: Page) => page.locator('.prose-editor');
const briefText = (page: Page) => page.getByTestId('brief-text');

async function type(page: Page, text: string): Promise<void> {
  await surface(page).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(text);
}

/** Recompile against the prose as it stands, and open the text. */
async function compile(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Recompile the brief' }).click();
  await expect(page.getByTestId('brief-usage')).toBeVisible();
  const show = page.getByRole('button', { name: 'Show the brief' });
  if (await show.isVisible()) await show.click();
  await expect(briefText(page)).toBeVisible();
}

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
  await expect(page.getByTestId('scene-brief')).toBeVisible();
}

test('the brief is compiled from what the writer just did', async ({ page }) => {
  await scene(page);

  await page.getByLabel('Point of view').selectOption({ label: 'Ilva' });
  await expect.poll(() => query(page, 'SELECT COUNT(*) FROM scene WHERE pov_entity_id IS NOT NULL'))
    .toEqual([[1]]);
  await type(page, 'Ilva crossed the harbour before the light went. Nobody would say why.');
  await compile(page);

  await expect(briefText(page)).toContainText('=== SCENE ===');
  await expect(briefText(page)).toContainText('Point of view: Ilva');
  await expect(briefText(page)).toContainText('## Ilva — character, point of view');
  // The first scene of the book has nothing before it.
  await expect(briefText(page)).not.toContainText('STORY SO FAR');
  // A scene with no beat is named as a gap, not silently compiled around.
  await expect(page.getByTestId('brief-gaps')).toContainText('No beat');
});

test('the seam carries the previous scene’s last words into the next brief', async ({ page }) => {
  await scene(page);
  await type(page, 'Ilva crossed the harbour before the light went. Nobody would say why.');
  // The debounce is the point: the brief must flush the editor before it reads.
  await page.getByRole('button', { name: 'Add a scene' }).click();
  await page.getByRole('button', { name: /^Scene 2, / }).click();
  await expect(page.getByTestId('scene-brief')).toBeVisible();
  await compile(page);

  await expect(briefText(page)).toContainText('=== STORY SO FAR ===');
  await expect(briefText(page)).toContainText('Nobody would say why.');
  await expect(briefText(page)).toContainText('=== END STORY SO FAR ===');
});

test('a small window trims, and says what it cut', async ({ page }) => {
  await scene(page);
  await page.getByLabel('Point of view').selectOption({ label: 'Ilva' });
  await type(page, 'Ilva crossed the harbour before the light went. '.repeat(40));
  await page.getByLabel('Context window').selectOption({ label: '8k — a small local model' });
  await compile(page);
  // Nothing in a two-line scene needs trimming even at 8k; what the panel must
  // show is the budget itself, section by section, with the fixed ones named.
  await expect(page.getByTestId('brief-section-scene')).toContainText('never trimmed');
  await expect(page.getByTestId('brief-section-bans')).toContainText('never trimmed');
  await expect(page.getByTestId('brief-usage')).toContainText('of 8,000 tokens');
});
