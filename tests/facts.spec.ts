import { test, expect, type Page } from '@playwright/test';
import { gotoApp } from './support';

/**
 * Facts, end to end.
 *
 * The spoiler rule is proved exhaustively as a pure function. What only the
 * browser can show is that the ranks reaching it are the manuscript's real
 * ones, and that a writer can see the answer — which is the entire point of the
 * screen.
 */

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[][] }>;
async function query(page: Page, sql: string, params: unknown[] = []): Promise<unknown[][]> {
  return page.evaluate(async ([s, p]) => {
    const run = (window as unknown as { __lsQuery: Query }).__lsQuery;
    return (await run(s as string, p as unknown[])).rows;
  }, [sql, params] as const);
}

/**
 * The judgement the rule reached, by name rather than by its wording.
 *
 * The labels are prose for the writer and free to change; matching them also
 * collides with the explanatory text elsewhere on the page, which is how the
 * first version of this file hit a strict-mode violation against the dramatic
 * irony checkbox.
 */
const status = (page: Page, name: string) => page.locator(`[data-status="${name}"]`);

/** A book of two scenes and two characters, sitting on the facts page. */
async function project(page: Page): Promise<void> {
  await gotoApp(page);
  await page.getByLabel('Project title').fill(`Ashfall ${Date.now()}`);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: /^Ashfall/ }).first().click();
  await page.getByRole('button', { name: 'Create the first book' }).click();
  await page.getByRole('button', { name: 'Add a chapter' }).click();
  await page.getByRole('button', { name: 'Add a scene' }).click();
  await page.getByRole('button', { name: 'Add a scene' }).click();

  await page.getByRole('link', { name: /^Codex/ }).click();
  for (const [i, name] of ['Ilva', 'Renn'].entries()) {
    await page.getByLabel('New entity name').fill(name);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect.poll(() => query(page, 'SELECT COUNT(*) FROM entity'), { timeout: 20_000 })
      .toEqual([[i + 1]]);
  }
  await page.getByRole('link', { name: '← Manuscript' }).click();
  await page.getByRole('link', { name: /^Facts/ }).click();
}

/**
 * Record a fact. The new one's editor opens by itself — a writer records a
 * claim and then says when it becomes true, so the form that asks is already
 * there. These tests therefore never click the row to open it; doing so closes
 * it, which is what the first version of this file did to itself.
 */
async function record(page: Page, subject: string, predicate: string, object: string) {
  await page.getByLabel('Subject').selectOption({ label: subject });
  await page.getByLabel('Predicate').fill(predicate);
  await page.getByLabel('Object').fill(object);
  await page.getByRole('button', { name: 'Record' }).click();
  await expect(page.getByLabel('Reader is told')).toBeVisible();
}

test('records a fact and composes a readable statement', async ({ page }) => {
  await project(page);
  await record(page, 'Ilva', 'is', 'the heir');
  await expect(page.getByRole('button', { name: /Ilva is the heir/ })).toBeVisible();
});

test('a reveal set later means the reader does not know it yet', async ({ page }) => {
  await project(page);
  await record(page, 'Ilva', 'is', 'the heir');

  // Told in scene two; nothing becomes true until then.
  await page.getByLabel('Reader is told').selectOption({ label: 'Scene 2' });
  await expect.poll(
    () => query(page, 'SELECT revealed_at_scene_id IS NOT NULL FROM fact'),
    { timeout: 10_000 },
  ).toEqual([[1]]);

  await page.getByLabel('Reading position').selectOption({ label: 'Scene 1' });
  await expect(status(page, 'withheld')).toBeVisible();

  await page.getByLabel('Reading position').selectOption({ label: 'Scene 2' });
  await expect(status(page, 'reader-knows')).toBeVisible();
});

test('a character can know something the reader does not', async ({ page }) => {
  await project(page);
  await record(page, 'Ilva', 'is', 'the heir');
  await page.getByLabel('Reader is told').selectOption({ label: 'Scene 2' });

  await page.getByLabel('Someone who knows').selectOption({ label: 'Ilva' });
  await page.getByRole('button', { name: 'They know' }).click();
  await expect.poll(() => query(page, 'SELECT COUNT(*) FROM fact_knowledge'), { timeout: 10_000 })
    .toEqual([[1]]);

  await page.getByLabel('Reading position').selectOption({ label: 'Scene 1' });
  await page.getByLabel('Point of view').selectOption({ label: 'Ilva' });
  await expect(status(page, 'pov-knows')).toBeVisible();

  // Renn was not told, so from his eyes it is still withheld.
  await page.getByLabel('Point of view').selectOption({ label: 'Renn' });
  await expect(status(page, 'withheld')).toBeVisible();
});

test('being lied to does not count as knowing', async ({ page }) => {
  await project(page);
  await record(page, 'Ilva', 'is', 'the heir');
  await page.getByLabel('Reader is told').selectOption({ label: 'Scene 2' });
  await page.getByLabel('Someone who knows').selectOption({ label: 'Ilva' });
  await page.getByRole('button', { name: 'They know' }).click();
  await page.getByLabel('What Ilva believes').selectOption('believes_false');
  await expect.poll(
    () => query(page, 'SELECT belief FROM fact_knowledge'), { timeout: 10_000 },
  ).toEqual([['believes_false']]);

  await page.getByLabel('Reading position').selectOption({ label: 'Scene 1' });
  await page.getByLabel('Point of view').selectOption({ label: 'Ilva' });
  await expect(status(page, 'withheld')).toBeVisible();
});

test('names a heavy secret as something to keep back', async ({ page }) => {
  await project(page);
  await record(page, 'Ilva', 'is', 'the heir');
  await page.getByLabel('Reader is told').selectOption({ label: 'Scene 2' });
  await page.getByLabel('Spoiler weight').selectOption('3');
  await expect.poll(() => query(page, 'SELECT spoiler_weight FROM fact'), { timeout: 10_000 })
    .toEqual([[3]]);

  await page.getByLabel('Reading position').selectOption({ label: 'Scene 1' });
  // Silence is not enough: a model confabulates into a gap, so the thing is
  // named as forbidden.
  await expect(page.getByText(/1 thing to keep back here/)).toBeVisible();
});

test('shows two facts that contradict each other', async ({ page }) => {
  await project(page);
  await record(page, 'Ilva', 'eye colour', 'grey');
  await expect(page.getByRole('button', { name: /eye colour grey/ })).toBeVisible();
  await record(page, 'Ilva', 'eye colour', 'green');

  await expect(page.getByText(/Two facts disagree about/)).toBeVisible();
});

test('flags a reveal that lands before the thing is true', async ({ page }) => {
  await project(page);
  await record(page, 'Ilva', 'is', 'the heir');
  await page.getByLabel('Becomes true').selectOption({ label: 'Scene 2' });
  await page.getByLabel('Reader is told').selectOption({ label: 'Scene 1' });

  await expect(page.getByText('The reader is told this before it becomes true.'))
    .toBeVisible({ timeout: 10_000 });
});

test('the reading position survives a reload, because it is in the URL', async ({ page }) => {
  await project(page);
  await record(page, 'Ilva', 'is', 'the heir');
  await page.getByLabel('Reader is told').selectOption({ label: 'Scene 1' });
  await expect.poll(
    () => query(page, 'SELECT revealed_at_scene_id IS NOT NULL FROM fact'), { timeout: 10_000 },
  ).toEqual([[1]]);

  await page.getByLabel('Reading position').selectOption({ label: 'Scene 2' });
  await expect(page).toHaveURL(/at=/);
  await expect(status(page, 'reader-knows')).toBeVisible();

  await page.reload();
  await page.waitForFunction(() => 'runSpike' in window);
  // The judgement comes back with it, not just the dropdown.
  await expect(status(page, 'reader-knows')).toBeVisible();
});

test('a fact is findable in search as soon as it is recorded', async ({ page }) => {
  await project(page);
  await record(page, 'Ilva', 'carries', 'the seal of office');
  await page.getByRole('link', { name: '← Manuscript' }).click();
  await page.getByRole('link', { name: 'Search →' }).click();
  await page.getByLabel('Search this project').fill('seal');
  await expect(page.getByText('Fact')).toBeVisible();
});
