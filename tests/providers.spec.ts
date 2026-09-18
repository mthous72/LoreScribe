import { test, expect, type Page } from '@playwright/test';
import { gotoApp } from './support';

/**
 * The providers screen, and D30 in the browser.
 *
 * The unit tests prove the store seals what it is given. What only the browser
 * can show is the join: a key pasted into the page reaches IndexedDB sealed,
 * the database row gets a handle and nothing else, the page never shows the
 * key back, and "Test this key" produces one honest sentence — whichever one
 * this network allows.
 *
 * Fixtures invented — D14. The key is a made-up string in the right shape.
 */

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[][] }>;
async function query(page: Page, sql: string, params: unknown[] = []): Promise<unknown[][]> {
  return page.evaluate(async ([s, p]) => {
    const run = (window as unknown as { __lsQuery: Query }).__lsQuery;
    return (await run(s as string, p as unknown[])).rows;
  }, [sql, params] as const);
}

const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef-not-a-real-key';

async function providers(page: Page): Promise<void> {
  await gotoApp(page);
  await page.getByLabel('Project title').fill(`Ashfall ${Date.now()}`);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: /^Ashfall/ }).first().click();
  // The project's navigation appears once there is a book to navigate from.
  await page.getByRole('button', { name: 'Create the first book' }).click();
  await page.getByRole('link', { name: /^Settings —/ }).click();
  await expect(page.getByTestId('key-protection')).toBeVisible();
}

test('a key is saved sealed, referenced by handle, and never shown back', async ({ page }) => {
  await providers(page);
  await page.getByLabel('Account label').fill('Mine');
  await page.getByLabel('OpenRouter API key').fill(KEY);
  await page.getByRole('button', { name: 'Add an OpenRouter account' }).click();
  await expect(page.getByRole('status')).toContainText('key saved on this device');
  await expect(page.getByTestId('key-state')).toHaveText('key saved on this device');

  // The row holds a handle and nothing that looks like a key.
  const rows = await query(page, 'SELECT id, credential_ref FROM provider_account');
  expect(rows).toHaveLength(1);
  expect(rows[0]![1]).toBe(rows[0]![0]);
  const everything = JSON.stringify(await query(page, 'SELECT * FROM provider_account'));
  expect(everything).not.toContain('sk-or');

  // Sealed in IndexedDB: present, and not the plaintext.
  const sealed = await page.evaluate(async (ref) => new Promise<string>((resolve, reject) => {
    const open = indexedDB.open('lorescribe-credentials');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const get = open.result.transaction('vault').objectStore('vault').get(`cred:${ref}`);
      get.onsuccess = () => {
        const v = get.result as { ciphertext: Uint8Array } | undefined;
        resolve(v ? new TextDecoder().decode(v.ciphertext) : 'MISSING');
      };
      get.onerror = () => reject(get.error);
    };
  }), rows[0]![0] as string);
  expect(sealed).not.toBe('MISSING');
  expect(sealed).not.toContain('sk-or');

  // And the page never echoes it.
  await expect(page.locator('body')).not.toContainText(KEY);
  await expect(page.getByLabel('Replace the key for Mine')).toHaveValue('');
});

test('testing the key gives one honest sentence, and removing it forgets the key', async ({ page }) => {
  await providers(page);
  await page.getByLabel('OpenRouter API key').fill(KEY);
  await page.getByRole('button', { name: 'Add an OpenRouter account' }).click();
  await expect(page.getByTestId('key-state')).toHaveText('key saved on this device');

  await page.getByRole('button', { name: 'Test this key' }).click();
  // A made-up key is rejected where the network reaches OpenRouter, and gets
  // no answer where it does not. Either is said in one sentence; neither is
  // the upstream's raw error text — and neither is "the key works", which the
  // public model list would have said about any string at all.
  await expect(page.getByRole('status')).toHaveText(
    /^(OpenRouter rejected this key\.|No answer from OpenRouter — .*|OpenRouter (is rate-limiting|had a problem).*)$/,
    { timeout: 60_000 });
  await expect(page.getByRole('status')).not.toContainText('The key works');

  await page.getByRole('button', { name: 'remove' }).click();
  await expect(page.getByRole('status')).toContainText('forgotten');
  expect(await query(page, 'SELECT COUNT(*) FROM provider_account')).toEqual([[0]]);
});
