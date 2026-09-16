import { test, expect, type Page } from '@playwright/test';
import { gotoApp } from './support';

/**
 * The laws page, and the loop it closes: a rule typed here is in the next
 * brief's LAWS block, switched off it is not, and the hard floor cannot be
 * touched. Fixtures invented — D14.
 */

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[][] }>;
async function query(page: Page, sql: string, params: unknown[] = []): Promise<unknown[][]> {
  return page.evaluate(async ([s, p]) => {
    const run = (window as unknown as { __lsQuery: Query }).__lsQuery;
    return (await run(s as string, p as unknown[])).rows;
  }, [sql, params] as const);
}

async function project(page: Page): Promise<void> {
  await gotoApp(page);
  await page.getByLabel('Project title').fill(`Ashfall ${Date.now()}`);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: /^Ashfall/ }).first().click();
  await page.getByRole('button', { name: 'Create the first book' }).click();
  await page.getByRole('button', { name: 'Add a chapter' }).click();
  await page.getByRole('button', { name: 'Add a scene' }).click();
}

const toLaws = (page: Page) => page.getByRole('link', { name: /^Laws —/ }).click();

async function addLaw(page: Page, title: string, rule: string): Promise<void> {
  await page.getByLabel('Law title').fill(title);
  await page.getByLabel('The rule, as an instruction').fill(rule);
  await page.getByRole('button', { name: 'Add the law' }).click();
  await expect(page.locator('[data-law]').filter({ hasText: title })).toBeVisible();
}

test('a law typed here is in the next brief, and not once it is switched off', async ({ page }) => {
  await project(page);
  await toLaws(page);
  await expect(page.getByTestId('laws')).toBeVisible();
  await addLaw(page, 'No em dashes', 'Do not use em dashes anywhere.');
  expect(await query(page, "SELECT category, severity, scope_type, active FROM law WHERE title = 'No em dashes'"))
    .toEqual([['style', 'must', 'project', 1]]);

  await page.getByRole('link', { name: '← Manuscript' }).click();
  await page.getByRole('button', { name: /^Scene 1, / }).click();
  await page.getByRole('button', { name: 'Recompile the brief' }).click();
  await page.getByRole('button', { name: 'Show the brief' }).click();
  await expect(page.getByTestId('brief-text')).toContainText('=== LAWS ===');
  await expect(page.getByTestId('brief-text')).toContainText('- [No em dashes] Do not use em dashes anywhere.');

  await page.getByRole('link', { name: /^Laws —/ }).click();
  await page.getByRole('button', { name: 'switch off' }).click();
  await expect(page.locator('[data-law]').first()).toHaveAttribute('data-active', 'false');
  await page.getByRole('link', { name: '← Manuscript' }).click();
  await page.getByRole('button', { name: /^Scene 1, / }).click();
  await page.getByRole('button', { name: 'Recompile the brief' }).click();
  await page.getByRole('button', { name: 'Show the brief' }).click();
  await expect(page.getByTestId('brief-text')).not.toContainText('=== LAWS ===');
});

test('a law can be edited in place and deleted in one step', async ({ page }) => {
  await project(page);
  await toLaws(page);
  await addLaw(page, 'Two spaces', 'Two spaces after every period.');
  await page.getByRole('button', { name: 'edit' }).click();
  await page.getByLabel('Severity').last().selectOption('should');
  await page.getByLabel('A good example').fill('Like this.  And this.');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('[data-law]').first()).toContainText('should');
  await expect(page.locator('[data-law]').first()).toContainText('Good: Like this.  And this.');
  expect(await query(page, "SELECT severity, examples_good, rev FROM law WHERE title = 'Two spaces'"))
    .toEqual([['should', 'Like this.  And this.', 2]]);

  await page.getByRole('button', { name: 'delete' }).click();
  await expect(page.locator('[data-law]')).toHaveCount(0);
  expect(await query(page, 'SELECT COUNT(*) FROM law WHERE deleted_at IS NULL')).toEqual([[0]]);
  expect(await query(page, 'SELECT COUNT(*) FROM law')).toEqual([[1]]);
});

test('the hard floor is listed and cannot be changed', async ({ page }) => {
  await project(page);
  const projectId = (await query(page, 'SELECT id FROM project') as string[][])[0]![0]!;
  await query(page,
    `INSERT INTO law (id, project_id, scope_type, category, severity, title, rule_text, is_system, active,
                      created_at, updated_at)
     VALUES ('floor', ?, 'project', 'content', 'must', 'The floor', 'Not this.', 1, 1, 1, 1)`, [projectId]);
  await toLaws(page);
  const floor = page.locator('[data-law="floor"]');
  await expect(floor).toContainText('hard floor');
  await expect(floor.getByRole('button')).toHaveCount(0);
});

test('a law can carry a pattern check, which is kept and shown', async ({ page }) => {
  await project(page);
  await toLaws(page);
  await page.getByLabel('Law title').fill('No suddenly');
  await page.getByLabel('The rule, as an instruction').fill('Never write "suddenly".');
  await page.getByLabel('How it is checked').selectOption('regex');
  await page.getByLabel('Pattern').fill('\\bsuddenly\\b');
  await page.getByRole('button', { name: 'Add the law' }).click();
  const row = page.locator('[data-law]').filter({ hasText: 'No suddenly' });
  await expect(row).toBeVisible();
  await expect(row.getByTestId('law-check')).toHaveText('checked by pattern /\\bsuddenly\\b/');
  expect(await query(page, "SELECT check_mode, check_config FROM law WHERE title = 'No suddenly'"))
    .toEqual([['regex', JSON.stringify({ pattern: '\\bsuddenly\\b' })]]);

  // A pattern that does not compile is refused with the reason, and the law is unchanged.
  await row.getByRole('button', { name: 'edit' }).click();
  const editor = page.getByTestId('law-editor');
  await editor.getByLabel('Pattern').fill('(');
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status')).toContainText('does not compile');
  expect(await query(page, "SELECT check_config FROM law WHERE title = 'No suddenly'"))
    .toEqual([[JSON.stringify({ pattern: '\\bsuddenly\\b' })]]);

  // Switching to a word band keeps only the band.
  await editor.getByLabel('How it is checked').selectOption('heuristic');
  await editor.getByLabel('at most').fill('900');
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(row.getByTestId('law-check')).toHaveText('checked as a word band to 900');
  expect(await query(page, "SELECT check_mode, check_config FROM law WHERE title = 'No suddenly'"))
    .toEqual([['heuristic', '{"maxWords":900}']]);
});
