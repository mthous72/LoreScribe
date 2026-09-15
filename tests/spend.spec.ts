import { test, expect, type Page } from '@playwright/test';
import { gotoApp } from './support';

/**
 * The spend cap, in the browser ([D17](../docs/10-decisions.md)).
 *
 * The drafter's refusal is proved against a fake provider in `draft.test.ts`.
 * What only the page can show is the join: a day's spend already in `ai_run`
 * reads on the meter, the stop refuses before "no draft model" gets a word in,
 * the raise is one tap and lands on the project row, and the Providers page
 * shows the same numbers and lets them be set in full.
 *
 * Fixtures invented — D14. The spend is a row we insert, not a call we make.
 */

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[][] }>;
async function query(page: Page, sql: string, params: unknown[] = []): Promise<unknown[][]> {
  return page.evaluate(async ([s, p]) => {
    const run = (window as unknown as { __lsQuery: Query }).__lsQuery;
    return (await run(s as string, p as unknown[])).rows;
  }, [sql, params] as const);
}

async function sceneWithPanel(page: Page): Promise<void> {
  await gotoApp(page);
  await page.getByLabel('Project title').fill(`Ashfall ${Date.now()}`);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: /^Ashfall/ }).first().click();
  await page.getByRole('button', { name: 'Create the first book' }).click();
  await page.getByRole('button', { name: 'Add a chapter' }).click();
  await page.getByRole('button', { name: 'Add a scene' }).click();
  await page.getByRole('button', { name: /^Scene 1, / }).click();
  await expect(page.getByTestId('scene-draft')).toBeVisible();
}

test('the meter reads today, the stop refuses first, and the raise is one tap', async ({ page }) => {
  await sceneWithPanel(page);
  const meter = page.getByTestId('spend-meter');
  await expect(meter).toContainText('$0.00 spent today');
  await expect(meter).toContainText('warns at $5.00, stops at $20.00');
  await expect(meter).toHaveAttribute('data-level', 'ok');

  // A priced run earlier today, as the drafter would have left it.
  const [[projectId]] = (await query(page, 'SELECT id FROM project ORDER BY created_at DESC LIMIT 1')) as [[string]];
  await query(page,
    `INSERT INTO ai_run (id, project_id, purpose, provider, model, tokens_in, tokens_out, cost_usd, status, created_at)
     VALUES ('run-today', ?, 'draft_beat', 'openrouter', 'm', 1000, 500, 25, 'ok', ?)`,
    [projectId, Date.now() - 60_000]);

  // No draft model is set, so a refusal on the cap proves the cap came first.
  const panel = page.getByTestId('scene-draft');
  await panel.getByRole('button', { name: 'Draft this beat' }).click();
  const status = panel.getByRole('status');
  await expect(status).toContainText('$25.00 spent today on this project has reached the $20.00 daily stop');
  await expect(status).not.toContainText('No draft model');
  await expect(meter).toHaveAttribute('data-level', 'stop');
  await expect(meter).toContainText('$25.00 spent today on this project — at the $20.00 stop');

  const blocked = await query(page, "SELECT status, block_reason, cost_usd FROM ai_run WHERE status = 'blocked'");
  expect(blocked).toHaveLength(1);
  expect(String(blocked[0]![1])).toContain('daily stop');
  expect(blocked[0]![2]).toBeNull();

  await status.getByRole('button', { name: 'Raise the stop to $40.00 a day' }).click();
  await expect(status).toContainText('now $40.00 a day');
  await expect(meter).toHaveAttribute('data-level', 'warn');
  await expect(meter).toContainText('past the $5.00 warning, stops at $40.00');
  const [[settings]] = (await query(page, 'SELECT settings_json FROM project WHERE id = ?', [projectId])) as [[string]];
  expect(JSON.parse(settings)).toEqual({ spend: { warnUsd: 5, stopUsd: 40 } });

  // The Providers page shows the same day and lets the caps be set in full.
  await meter.getByRole('link', { name: 'change the caps' }).click();
  const today = page.getByTestId('spend-today');
  await expect(today).toContainText('$25.00 spent on this project today');
  await expect(today).toContainText('past the warning');
  await expect(page.getByLabel('Warn at $')).toHaveValue('5');
  await expect(page.getByLabel('Stop at $')).toHaveValue('40');
  await page.getByLabel('Warn at $').fill('60');
  await page.getByRole('button', { name: 'Save the caps' }).click();
  await expect(page.getByRole('status')).toContainText('cannot be higher than the stop');
  await page.getByLabel('Warn at $').fill('30');
  await page.getByLabel('Stop at $').fill('100');
  await page.getByRole('button', { name: 'Save the caps' }).click();
  await expect(page.getByRole('status')).toContainText('warns at $30.00 and stops at $100.00');
  await expect(today).toHaveAttribute('data-level', 'ok');
});
