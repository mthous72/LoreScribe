import { test, expect } from '@playwright/test';

// Gate C. The floor, not the bar: a project that survives a reload. Doc 15 is
// explicit that this alone would not have gated anything — it is checked here
// because it must be true, not because it is sufficient.

test('C2-C4 — a project survives a reload, and op_log records every write', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();

  await page.getByLabel('Project title').fill('The Grey Warden');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByText('The Grey Warden')).toBeVisible();

  // The actual Phase 0 question.
  await page.reload();
  await expect(page.getByText('The Grey Warden')).toBeVisible();

  // One op_log row per mutation, written in the same transaction as the change.
  await expect(page.getByText('op_log rows').locator('xpath=following-sibling::dd')).toHaveText('1');

  await page.getByLabel('Project title').fill('Second Book');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByText('op_log rows').locator('xpath=following-sibling::dd')).toHaveText('2');

  await page.getByRole('button', { name: 'delete' }).first().click();
  await expect(page.getByText('op_log rows').locator('xpath=following-sibling::dd')).toHaveText('3');

  // A soft delete leaves the row and the tombstone, so a future sync can
  // replicate it — the list just stops showing it.
  await page.reload();
  await expect(page.getByText('op_log rows').locator('xpath=following-sibling::dd')).toHaveText('3');
});

test('C1 — the shell works at phone width (D15: the phone is a peer, not a viewer)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./');
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();

  // No horizontal overflow: the single most common phone-layout defect.
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'page scrolls horizontally at 390px').toBeLessThanOrEqual(0);

  await page.getByRole('link', { name: 'Diagnostics' }).click();
  await expect(page.getByRole('heading', { name: 'Storage diagnostics' })).toBeVisible();
  const overflow2 = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow2, 'diagnostics page scrolls horizontally at 390px').toBeLessThanOrEqual(0);
});

test('R2b harness — holds one connection and probes it, on a phone-sized screen', async ({ page }) => {
  // Cannot reproduce Android's memory-pressure reclamation here; what this
  // proves is that the harness itself works, so the person running it on a real
  // device is testing the storage engine rather than debugging the test.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./#/diagnostics');

  await expect(page.getByRole('heading', { name: 'Backgrounding test (R2b)' })).toBeVisible();
  await page.getByRole('button', { name: 'Start the test' }).click();
  await expect(page.getByText('Connection open — now leave this tab.')).toBeVisible();

  // Probe the HELD connection — the whole point is that this is not a reopen.
  await page.getByRole('button', { name: 'Check now' }).click();
  await expect(page.getByText('survived', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/read ok, write ok/)).toBeVisible();

  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'diagnostics page scrolls horizontally at 390px').toBeLessThanOrEqual(0);
});

test('C5 — a second tab is told who holds the database, and can take it over', async ({ context }) => {
  // The gap this closes: the lock module existed with zero importers, so what
  // actually stopped a second tab was the VFS throwing an opaque storage error.
  const tabA = await context.newPage();
  await tabA.goto('./');
  await expect(tabA.getByRole('heading', { name: 'Projects' })).toBeVisible();
  await tabA.getByLabel('Project title').fill('Held By Tab A');
  await tabA.getByRole('button', { name: 'Create project' }).click();
  await expect(tabA.getByText('Held By Tab A')).toBeVisible();

  // Second tab: refused, and told by whom rather than shown a storage error.
  const tabB = await context.newPage();
  await tabB.goto('./');
  await expect(tabB.getByRole('heading', { name: 'Open somewhere else' })).toBeVisible();
  await expect(tabB.getByText(/another tab/)).toBeVisible();

  // Take over: tab A is asked to yield, closes its handles, releases.
  await tabB.getByRole('button', { name: 'Take over here' }).click();
  await expect(tabB.getByRole('heading', { name: 'Projects' })).toBeVisible({ timeout: 30_000 });
  // The data is intact on the other side of the handover.
  await expect(tabB.getByText('Held By Tab A')).toBeVisible();

  // And tab A says what happened rather than silently breaking.
  await expect(tabA.getByRole('heading', { name: 'Handed over' })).toBeVisible();

  // Handing it back works too, which is what makes this a lock and not a coin toss.
  await tabB.close();
  await tabA.getByRole('button', { name: 'Take it back' }).click();
  await expect(tabA.getByRole('heading', { name: 'Projects' })).toBeVisible({ timeout: 30_000 });
  await expect(tabA.getByText('Held By Tab A')).toBeVisible();
});
