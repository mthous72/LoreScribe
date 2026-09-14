import { test, expect, type Page } from '@playwright/test';
import { gotoApp } from './support';

/**
 * The codex, end to end.
 *
 * The point of this screen is not CRUD. It is that an entity created here is
 * afterwards recognised in prose — the loop that makes the lore-linking claim
 * true, and which until now could only be exercised by inserting rows by hand.
 */

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[][] }>;

async function query(page: Page, sql: string, params: unknown[] = []): Promise<unknown[][]> {
  return page.evaluate(async ([s, p]) => {
    const run = (window as unknown as { __lsQuery: Query }).__lsQuery;
    return (await run(s as string, p as unknown[])).rows;
  }, [sql, params] as const);
}

/** A project with one scene of prose, sitting on the manuscript page. */
async function project(page: Page, prose: string): Promise<string> {
  await gotoApp(page);
  await page.getByLabel('Project title').fill(`Ashfall ${Date.now()}`);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: /^Ashfall/ }).first().click();
  await page.getByRole('button', { name: 'Create the first book' }).click();
  await page.getByRole('button', { name: 'Add a chapter' }).click();
  await page.getByRole('button', { name: 'Add a scene' }).click();
  await page.getByRole('button', { name: /^Scene 1, / }).click();
  await page.locator('.prose-editor').click();
  await page.keyboard.type(prose);
  await expect(page.locator('[data-save-state]')).toHaveAttribute('data-save-state', 'saved');
  return String((await query(page, 'SELECT id FROM project ORDER BY created_at DESC'))[0]![0]);
}

const toCodex = (page: Page) => page.getByRole('link', { name: /^Codex/ }).click();

test('an entity created here is afterwards found in the prose', async ({ page }) => {
  await project(page, 'Ilva waited in the hall. Ilva left before dawn.');
  await toCodex(page);

  await page.getByLabel('New entity name').fill('Ilva');
  await page.getByRole('button', { name: 'Add', exact: true }).click();

  // Creating it re-scans the manuscript, so the mention exists without the
  // writer being sent to a settings panel to ask for it.
  await expect.poll(
    () => query(page, 'SELECT role, alias_used FROM mention'),
    { timeout: 20_000 },
  ).toEqual([['present', 'Ilva']]);

  // And the prose now highlights it.
  await page.getByRole('link', { name: '← Manuscript' }).click();
  await page.getByRole('button', { name: /^Scene 1, / }).click();
  await expect(page.locator('.ls-mention').first()).toHaveText('Ilva');
});

test('a primary alias is minted from the name, because the matcher reads aliases', async ({ page }) => {
  await project(page, 'Ilva waited.');
  await toCodex(page);
  await page.getByLabel('New entity name').fill('Ilva');
  await page.getByRole('button', { name: 'Add', exact: true }).click();

  await expect(page.getByText('primary')).toBeVisible();
  expect(await query(page, 'SELECT alias, is_primary FROM entity_alias'))
    .toEqual([['Ilva', 1]]);
});

test('adding an alias re-reads the manuscript for it', async ({ page }) => {
  await project(page, 'The Warden turned away from the fire.');
  await toCodex(page);
  await page.getByLabel('New entity name').fill('Ilva');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect.poll(() => query(page, 'SELECT COUNT(*) FROM mention'), { timeout: 20_000 })
    .toEqual([[0]]);                                   // her name is not in the prose

  await page.getByLabel('New alias').fill('The Warden');
  await page.getByRole('button', { name: 'Add name' }).click();

  // Adding it changes what the scene means, retroactively.
  await expect.poll(() => query(page, 'SELECT alias_used FROM mention'), { timeout: 20_000 })
    .toEqual([['The Warden']]);
});

test('an alias switched off stops linking without being deleted', async ({ page }) => {
  await project(page, 'The Warden turned away.');
  await toCodex(page);
  await page.getByLabel('New entity name').fill('Ilva');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByLabel('New alias').fill('The Warden');
  await page.getByRole('button', { name: 'Add name' }).click();
  await expect.poll(() => query(page, 'SELECT COUNT(*) FROM mention'), { timeout: 20_000 })
    .toEqual([[1]]);

  await page.getByLabel('Link The Warden in prose').uncheck();
  await expect.poll(() => query(page, 'SELECT COUNT(*) FROM mention'), { timeout: 20_000 })
    .toEqual([[0]]);
  expect(await query(page, 'SELECT COUNT(*) FROM entity_alias')).toEqual([[2]]);
});

test('the attribute fields come from the type’s schema, not from this code', async ({ page }) => {
  await project(page, 'Nothing yet.');
  await toCodex(page);
  await page.getByLabel('New entity name').fill('Ilva');
  await page.getByRole('button', { name: 'Add', exact: true }).click();

  // Straight out of db/migrations/002. A character has a want and a wound; a
  // location does not — which is the whole point of a per-type schema.
  await expect(page.getByLabel('Want')).toBeVisible();
  await expect(page.getByLabel('Voice profile')).toBeVisible();

  await page.getByLabel('Want').fill('To be believed');
  await page.getByLabel('Voice profile').click();
  await expect.poll(() => query(page, 'SELECT attributes FROM entity'), { timeout: 10_000 })
    .toEqual([[JSON.stringify({ want: 'To be believed' })]]);
});

test('a rename carries the primary alias, so detection does not silently stop', async ({ page }) => {
  await project(page, 'Ilva Renn waited.');
  await toCodex(page);
  await page.getByLabel('New entity name').fill('Ilva');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect.poll(() => query(page, 'SELECT COUNT(*) FROM mention'), { timeout: 20_000 })
    .toEqual([[1]]);

  await page.getByLabel('Name', { exact: true }).fill('Ilva Renn');
  await page.getByLabel('Type', { exact: true }).click();   // blur commits

  await expect.poll(() => query(page, 'SELECT alias FROM entity_alias'), { timeout: 20_000 })
    .toEqual([['Ilva Renn']]);
  await expect.poll(() => query(page, 'SELECT alias_used FROM mention'), { timeout: 20_000 })
    .toEqual([['Ilva Renn']]);
});

test('the codex finds an entity by an alias, not only its name', async ({ page }) => {
  await project(page, 'Nothing yet.');
  await toCodex(page);
  await page.getByLabel('New entity name').fill('Ilva');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByLabel('New alias').fill('The Grey Warden');
  await page.getByRole('button', { name: 'Add name' }).click();

  await page.getByLabel('Search the codex').fill('Grey');
  await expect(page.getByRole('button', { name: /^Ilva/ })).toBeVisible();
  await page.getByLabel('Search the codex').fill('nothing like this');
  await expect(page.getByText('Nothing matches.')).toBeVisible();
});

test('the compliance fields default to unknown and persist', async ({ page }) => {
  await project(page, 'Nothing yet.');
  await toCodex(page);
  await page.getByLabel('New entity name').fill('Ilva');
  await page.getByRole('button', { name: 'Add', exact: true }).click();

  // docs/13: the hard floor reads these before any model call, so the default
  // has to be the truth rather than the convenient answer.
  expect(await query(page, 'SELECT maturity, is_real_person FROM entity'))
    .toEqual([['unknown', 0]]);
  await page.getByLabel('Maturity').selectOption('adult');
  await expect.poll(() => query(page, 'SELECT maturity FROM entity'), { timeout: 10_000 })
    .toEqual([['adult']]);
});

test('deleting an entity takes its links out of the manuscript', async ({ page }) => {
  await project(page, 'Ilva waited. Ilva left.');
  await toCodex(page);
  await page.getByLabel('New entity name').fill('Ilva');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect.poll(() => query(page, 'SELECT COUNT(*) FROM mention'), { timeout: 20_000 })
    .toEqual([[1]]);

  await page.getByRole('button', { name: 'Delete this entry' }).click();
  await expect.poll(() => query(page, 'SELECT COUNT(*) FROM mention'), { timeout: 20_000 })
    .toEqual([[0]]);
  await expect(page.getByText('Nothing here yet.')).toBeVisible();
});
