import { test, expect } from '@playwright/test';
import { gotoApp } from './support';

/**
 * The draft panel without a model — the only state a browser test can reach
 * without a key. The call itself is proved against a fake adapter in
 * `draft.test.ts`; what the page has to get right here is saying plainly what
 * is missing and where to fix it. Fixtures invented — D14.
 */

test('asks for a draft model, and points at where to set one', async ({ page }) => {
  await gotoApp(page);
  await page.getByLabel('Project title').fill(`Ashfall ${Date.now()}`);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: /^Ashfall/ }).first().click();
  await page.getByRole('button', { name: 'Create the first book' }).click();
  await page.getByRole('button', { name: 'Add a chapter' }).click();
  await page.getByRole('button', { name: 'Add a scene' }).click();
  await page.getByRole('button', { name: /^Scene 1, / }).click();

  const panel = page.getByTestId('scene-draft');
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel('Beat to draft')).toContainText('no beat on this scene');
  await panel.getByRole('button', { name: 'Draft this beat' }).click();
  await expect(panel.getByRole('status')).toContainText('No draft model is set');
  await panel.getByRole('link', { name: 'Settings →' }).click();
  await expect(page.getByTestId('key-protection')).toBeVisible();
});
