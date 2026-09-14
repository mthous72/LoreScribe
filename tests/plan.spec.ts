import { test, expect, type Page } from '@playwright/test';
import { gotoApp } from './support';

/**
 * Arcs, beats, and the grid where they meet scenes.
 *
 * A beat is what a scene has to accomplish, and it is the one thing the brief
 * compiler cannot infer — facts say what is true and the cast says who is here,
 * and neither says what the scene is for. So what these tests pin is not that
 * rows appear, but that a beat can be planned, carried by a scene, and seen from
 * inside the prose it is supposed to shape.
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

/** A book with two scenes, the first of them written. */
async function project(page: Page): Promise<void> {
  await gotoApp(page);
  await page.getByLabel('Project title').fill(`Ashfall ${Date.now()}`);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: /^Ashfall/ }).first().click();
  await page.getByRole('button', { name: 'Create the first book' }).click();
  await page.getByRole('button', { name: 'Add a chapter' }).click();
  await page.getByRole('button', { name: 'Add a scene' }).click();
  await page.getByRole('button', { name: 'Add a scene' }).click();

  await page.getByRole('button', { name: /^Scene 1, / }).click();
  await page.locator('.prose-editor').click();
  await page.keyboard.type('The harbour was empty when she arrived.');
  await expect(page.locator('[data-save-state]')).toHaveAttribute('data-save-state', 'saved');
}

const toPlan = (page: Page) => page.getByRole('link', { name: /^Plan —/ }).click();

async function arcWithBeat(page: Page, arc: string, beat: string): Promise<void> {
  await page.getByLabel('New arc name').fill(arc);
  await page.getByRole('button', { name: 'Add an arc' }).click();
  await expect(page.getByRole('heading', { name: arc })).toBeVisible();
  await page.getByLabel('New beat').fill(beat);
  await page.getByRole('button', { name: 'Add a beat' }).click();
  await expect(page.locator('[data-beat]')).toHaveCount(1);
}

test('an arc and its beats can be planned', async ({ page }) => {
  await project(page);
  await toPlan(page);
  await arcWithBeat(page, 'Ilva takes the seal', 'She is refused');

  await expect.poll(() => query(page, 'SELECT name FROM arc'), { timeout: 15_000 })
    .toEqual([['Ilva takes the seal']]);
  expect(await query(page, 'SELECT title FROM beat')).toEqual([['She is refused']]);
});

test('a beat nothing realises says so, and stops saying it once a scene carries it', async ({ page }) => {
  await project(page);
  await toPlan(page);
  await arcWithBeat(page, 'Ilva takes the seal', 'She is refused');

  // The marker comes from findGaps, which has had no caller since Phase 0b.
  await expect(page.locator('[data-unrealised="true"]')).toBeVisible();

  await page.getByRole('button', { name: /^She is refused in Scene 1/ }).click();
  await expect(page.locator('[data-unrealised="true"]')).toHaveCount(0);
  await expect.poll(() => query(page, 'SELECT COUNT(*) FROM beat_scene'), { timeout: 15_000 })
    .toEqual([[1]]);
});

test('a written scene serving no beat is marked an orphan, an unwritten one is not', async ({ page }) => {
  // Unwritten is not orphaned: a scene nobody has started is not evidence of a
  // planning mistake.
  await project(page);
  await toPlan(page);
  await arcWithBeat(page, 'Ilva takes the seal', 'She is refused');

  const orphans = page.locator('[data-orphan="true"]');
  await expect(orphans).toHaveCount(1);
  await expect(orphans.first()).toContainText('Scene 1');

  await page.getByRole('button', { name: /^She is refused in Scene 1/ }).click();
  await expect(page.locator('[data-orphan="true"]')).toHaveCount(0);
});

test('the beat shows beside the prose it is meant to shape', async ({ page }) => {
  await project(page);
  await toPlan(page);
  await arcWithBeat(page, 'Ilva takes the seal', 'She is refused');
  await page.getByRole('button', { name: /^She is refused in Scene 1/ }).click();

  await page.getByRole('link', { name: '← Manuscript' }).click();
  await page.getByRole('button', { name: /^Scene 1, / }).click();

  const panel = page.getByTestId('scene-beats');
  await expect(panel).toContainText('She is refused');
  await expect(panel).toContainText('Ilva takes the seal');
});

test('a scene with no beat says what that costs', async ({ page }) => {
  await project(page);
  await expect(page.getByTestId('scene-beats')).toContainText('nothing to aim at');
});

test('a beat can be given a role in the scene, and taken off it', async ({ page }) => {
  await project(page);
  await toPlan(page);
  await arcWithBeat(page, 'Ilva takes the seal', 'She is refused');
  await page.getByRole('button', { name: /^She is refused in Scene 1/ }).click();
  await page.getByRole('link', { name: '← Manuscript' }).click();
  await page.getByRole('button', { name: /^Scene 1, / }).click();

  await page.getByLabel('Role of She is refused in this scene').selectOption('payoff');
  await expect.poll(() => query(page, 'SELECT role FROM beat_scene'), { timeout: 15_000 })
    .toEqual([['payoff']]);

  await page.getByTestId('scene-beats').getByRole('button', { name: 'remove' }).click();
  await expect.poll(() => query(page, 'SELECT COUNT(*) FROM beat_scene'), { timeout: 15_000 })
    .toEqual([[0]]);
});

test('deleting an arc takes its beats and their links with it', async ({ page }) => {
  await project(page);
  await toPlan(page);
  await arcWithBeat(page, 'Ilva takes the seal', 'She is refused');
  await page.getByRole('button', { name: /^She is refused in Scene 1/ }).click();
  await expect.poll(() => query(page, 'SELECT COUNT(*) FROM beat_scene'), { timeout: 15_000 })
    .toEqual([[1]]);

  await page.getByRole('button', { name: 'delete arc' }).click();
  await expect(page.locator('[data-beat]')).toHaveCount(0);
  await expect.poll(
    () => query(page, 'SELECT COUNT(*) FROM beat WHERE deleted_at IS NULL'), { timeout: 15_000 },
  ).toEqual([[0]]);
});
