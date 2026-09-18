import { test, expect } from '@playwright/test';
import { gotoApp } from './support';

/**
 * Settings is one tab from the front page, before any project exists: the key
 * is not a project's, and the first thing a new writer needs is somewhere to
 * put it. The roles and the spend then follow whichever project is picked.
 * Fixtures invented — D14.
 */

test('the front page points at Settings when no key is connected, and the tab opens it with no project', async ({ page }) => {
  await gotoApp(page);
  const hint = page.getByTestId('no-key-hint');
  await expect(hint).toContainText('No model is connected yet');
  await hint.getByRole('link', { name: 'Settings' }).click();

  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.getByTestId('key-protection')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add an OpenRouter account' })).toBeVisible();
  // No project yet: the per-project sections wait, and say so.
  await expect(page.getByTestId('project-picker')).toContainText('none yet');
  await expect(page.getByRole('heading', { name: 'Which model does which job' })).toHaveCount(0);
});

test('the Settings tab follows the most recent project, and a project link fixes it', async ({ page }) => {
  await gotoApp(page);
  await page.getByLabel('Project title').fill('Ashfall');
  await page.getByRole('button', { name: 'Create project' }).click();
  // The form clears itself once the first create lands; typing before that loses the second title.
  await expect(page.getByRole('link', { name: 'Ashfall' })).toBeVisible();
  await page.getByLabel('Project title').fill('Kiln');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.getByRole('navigation').getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  const picker = page.getByLabel('For the project');
  await expect(picker.locator('option')).toHaveCount(2);
  await expect(picker.locator('option:checked')).toHaveText('Kiln');
  await expect(page.getByRole('heading', { name: 'Which model does which job' })).toBeVisible();
  await expect(page.getByTestId('spend-today')).toContainText('$0.00 spent on this project today');
  await picker.selectOption({ label: 'Ashfall' });
  await expect(page.getByTestId('spend-today')).toBeVisible();

  // From inside a project the page is that project's, with a way back.
  await page.getByRole('link', { name: 'Projects' }).click();
  await page.getByRole('link', { name: 'Ashfall' }).click();
  await page.getByRole('button', { name: 'Create the first book' }).click();
  await page.getByRole('link', { name: /^Settings —/ }).click();
  await expect(page.getByTestId('project-picker')).toHaveCount(0);
  await page.getByRole('link', { name: '← Manuscript' }).click();
  await expect(page.getByRole('button', { name: 'Add a chapter' })).toBeVisible();
});
