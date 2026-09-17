import { test, expect, type Page } from '@playwright/test';
import { gotoApp } from './support';

/**
 * Bringing a bible in, end to end.
 *
 * The parsers and the rules are proved exhaustively as pure functions, and the
 * staging repository against the real schema. What only the browser can show is
 * the promise the screen makes: that a writer sees every change before any of
 * it happens, that changing one dropdown changes what happens, and that an
 * applied import comes back out.
 *
 * Every fixture is invented — D14. The bible this was built against never
 * enters this repository.
 */

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[][] }>;
async function query(page: Page, sql: string, params: unknown[] = []): Promise<unknown[][]> {
  return page.evaluate(async ([s, p]) => {
    const run = (window as unknown as { __lsQuery: Query }).__lsQuery;
    return (await run(s as string, p as unknown[])).rows;
  }, [sql, params] as const);
}

const ILVA = `# Ilva
She keeps the seal, and the gate behind it.

## Arc
Want: the throne.
Lie: I am owed it.
`;

const KNOWLEDGE = `# Who knows what

| Fact | Ilva | Renn |
|---|---|---|
| She is the heir | yes | no |
| The seal is a fake | suspects | through the clerk |
`;

const file = (name: string, body: string) =>
  ({ name, mimeType: 'text/markdown', buffer: Buffer.from(body, 'utf8') });

async function importPage(page: Page): Promise<void> {
  await gotoApp(page);
  await page.getByLabel('Project title').fill(`Ashfall ${Date.now()}`);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: /^Ashfall/ }).first().click();
  await page.getByRole('link', { name: /bible/i }).first().click();
  await expect(page.getByRole('heading', { name: 'Bring in a bible' })).toBeVisible();
}

test('reads files, shows what it proposes and why, and writes nothing yet', async ({ page }) => {
  await importPage(page);
  await page.getByLabel('Choose files').setInputFiles([file('characters-ilva.md', ILVA)]);

  await expect(page.getByText('1 file read')).toBeVisible();
  // The rule, in the writer's terms, beside the thing it decided.
  await expect(page.getByText(/names a character/)).toBeVisible();
  await expect(page.getByLabel('Where Ilva goes')).toHaveValue('entity:character');

  // Nothing has happened to the codex, and nothing will until it is applied.
  expect(await query(page, 'SELECT COUNT(*) FROM entity')).toEqual([[0]]);
});

test('stages, applies, and the entry arrives with its fields', async ({ page }) => {
  await importPage(page);
  await page.getByLabel('Choose files').setInputFiles([file('characters-ilva.md', ILVA)]);
  await page.getByRole('button', { name: 'Stage these changes' }).click();

  await expect(page.getByText(/1 change ready/)).toBeVisible();
  expect(await query(page, 'SELECT COUNT(*) FROM entity')).toEqual([[0]]);

  await page.getByRole('button', { name: /^Apply/ }).click();
  await expect.poll(
    () => query(page, 'SELECT name, attributes FROM entity'), { timeout: 15_000 },
  ).toEqual([['Ilva', '{"want":"the throne.","lie":"I am owed it."}']]);
});

test('a table of who knows what becomes facts and knowledge', async ({ page }) => {
  await importPage(page);
  await page.getByLabel('Choose files').setInputFiles([
    file('characters-ilva.md', ILVA),
    file('characters-renn.md', '# Renn\nHe counts the crates.\n'),
    file('reference-knowledge.md', KNOWLEDGE),
  ]);
  await expect(page.getByText('3 files read')).toBeVisible();
  await expect(page.getByText(/facts down the rows/)).toBeVisible();

  await page.getByRole('button', { name: 'Stage these changes' }).click();
  await page.getByRole('button', { name: /^Apply/ }).click();

  await expect.poll(
    () => query(page, 'SELECT COUNT(*) FROM fact WHERE deleted_at IS NULL'), { timeout: 15_000 },
  ).toEqual([[2]]);
  // Renn's cell said "through the clerk" — kept as how he learned it rather
  // than flattened to a boolean.
  await expect.poll(() => query(page,
    `SELECT e.name, k.belief, k.learned_how FROM fact_knowledge k
     JOIN entity e ON e.id = k.entity_id ORDER BY e.name, k.belief`))
    .toEqual([
      ['Ilva', 'knows', null],
      ['Ilva', 'suspects', 'suspects'],
      ['Renn', 'knows', 'through the clerk'],
    ]);
});

test('changing one dropdown changes what happens', async ({ page }) => {
  await importPage(page);
  await page.getByLabel('Choose files').setInputFiles([file('characters-ilva.md', ILVA)]);
  await page.getByLabel('Where Ilva goes').selectOption('note');
  await page.getByRole('button', { name: 'Stage these changes' }).click();
  await page.getByRole('button', { name: /^Apply/ }).click();

  await expect.poll(() => query(page, 'SELECT COUNT(*) FROM note'), { timeout: 15_000 })
    .toEqual([[1]]);
  expect(await query(page, 'SELECT COUNT(*) FROM entity')).toEqual([[0]]);
});

test('discarding a staged run writes nothing', async ({ page }) => {
  await importPage(page);
  await page.getByLabel('Choose files').setInputFiles([file('characters-ilva.md', ILVA)]);
  await page.getByRole('button', { name: 'Stage these changes' }).click();
  await page.getByRole('button', { name: 'Discard' }).click();

  await expect(page.getByText(/Nothing was written/)).toBeVisible();
  expect(await query(page, 'SELECT COUNT(*) FROM entity')).toEqual([[0]]);
});

test('an applied import can be taken back out', async ({ page }) => {
  await importPage(page);
  await page.getByLabel('Choose files').setInputFiles([file('characters-ilva.md', ILVA)]);
  await page.getByRole('button', { name: 'Stage these changes' }).click();
  await page.getByRole('button', { name: /^Apply/ }).click();
  await expect.poll(() => query(page, 'SELECT COUNT(*) FROM entity WHERE deleted_at IS NULL'),
    { timeout: 15_000 }).toEqual([[1]]);

  // A bad mapping writes hundreds of rows, and "delete them by hand" is not an
  // answer.
  await page.getByRole('button', { name: 'take it back out' }).click();
  await expect.poll(() => query(page, 'SELECT COUNT(*) FROM entity WHERE deleted_at IS NULL'),
    { timeout: 15_000 }).toEqual([[0]]);
});

test('one unreadable file does not cost you the rest', async ({ page }) => {
  await importPage(page);
  await page.getByLabel('Choose files').setInputFiles([
    file('characters-ilva.md', ILVA),
    { name: 'scan.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4', 'utf8') },
  ]);

  await expect(page.getByText('1 file read')).toBeVisible();
  await expect(page.getByText(/Could not read scan\.pdf/)).toBeVisible();
  await expect(page.getByLabel('Where Ilva goes')).toBeVisible();
});

test('an entry that already exists is offered as an update, not a second one', async ({ page }) => {
  // Not the usual helper: this one needs a codex entry first, and the Codex
  // link lives on the manuscript once a book exists.
  await gotoApp(page);
  await page.getByLabel('Project title').fill(`Ashfall ${Date.now()}`);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: /^Ashfall/ }).first().click();
  await page.getByRole('button', { name: 'Create the first book' }).click();
  await page.getByRole('link', { name: /^Codex/ }).click();
  await page.getByLabel('New entity name').fill('Ilva');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect.poll(() => query(page, 'SELECT COUNT(*) FROM entity'), { timeout: 20_000 })
    .toEqual([[1]]);

  await page.getByRole('link', { name: '← Manuscript' }).click();
  await page.getByRole('link', { name: /bible/i }).first().click();
  await page.getByLabel('Choose files').setInputFiles([file('characters-ilva.md', ILVA)]);
  await expect(page.getByText('already in your codex')).toBeVisible();

  await page.getByRole('button', { name: 'Stage these changes' }).click();
  await page.getByRole('button', { name: /^Apply/ }).click();
  await expect.poll(() => query(page, 'SELECT COUNT(*) FROM entity WHERE deleted_at IS NULL'),
    { timeout: 15_000 }).toEqual([[1]]);
});

test('the model lane says what it needs when no extract model is set, and sends nothing', async ({ page }) => {
  await importPage(page);
  await page.getByLabel('Choose files').setInputFiles([file('characters-ilva.md', ILVA)]);
  const lane = page.getByTestId('ask-model');
  await expect(lane).toContainText('1 file in 1 call');
  await lane.getByRole('button', { name: 'Let the model read them' }).click();
  await expect(page.getByRole('status')).toContainText('No extract model is set');
  await expect(page.getByRole('status').getByRole('link', { name: 'Settings →' })).toBeVisible();
  expect(await query(page, 'SELECT COUNT(*) FROM ai_run')).toEqual([[0]]);
  expect(await query(page, 'SELECT COUNT(*) FROM proposal')).toEqual([[0]]);
});

test('a proposal can be edited before it is applied, and the edit is what lands', async ({ page }) => {
  await importPage(page);
  await page.getByLabel('Choose files').setInputFiles([file('characters-ilva.md', ILVA)]);
  await page.getByRole('button', { name: 'Stage these changes' }).click();
  const row = page.locator('[data-proposal="entity"]');
  await row.getByRole('button', { name: 'edit' }).click();
  const editor = page.getByTestId('proposal-editor');
  await editor.getByLabel('name').fill('Ilva Vell');
  await editor.getByLabel('summary').fill('Keeper of the seal.');
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(row).toContainText('Ilva Vell');
  await page.getByRole('button', { name: /^Apply/ }).click();
  await expect.poll(() => query(page, 'SELECT name, summary FROM entity'), { timeout: 15_000 })
    .toEqual([['Ilva Vell', 'Keeper of the seal.']]);
});

test('a model claim that cannot be traced to the file waits for the writer, and can be taken anyway', async ({ page }) => {
  await importPage(page);
  // A staged run as the extraction lane leaves one: two verified rows accepted, one unverified pending.
  const [[projectId]] = (await query(page, 'SELECT id FROM project ORDER BY created_at DESC LIMIT 1')) as [[string]];
  await query(page, `INSERT INTO proposal_run (id, project_id, seed_kind, status, created_at)
                     VALUES ('run-m', ?, 'import', 'staged', ?)`, [projectId, Date.now()]);
  const insert = (id: string, name: string, verified: number, status: string) => query(page,
    `INSERT INTO proposal (id, run_id, target_table, op, payload, rationale, confidence, evidence_quote,
                           evidence_verified, status, created_at)
     VALUES (?, 'run-m', 'entity', 'new', ?, 'from cast.md — the model read it as a character', 0.8, ?, ?, ?, ?)`,
    [id, JSON.stringify({ name, typeKey: 'character', summary: null, description: null, attributes: {} }),
      `${name} keeps the seal`, verified, status, Date.now()]);
  await insert('p-ilva', 'Ilva', 1, 'accepted');
  await insert('p-maren', 'Maren', 0, 'pending');

  // Reopen the screen on that run through the page's own review path: reload and pick it up.
  await page.reload();
  await page.waitForFunction(() => 'runSpike' in window, null, { timeout: 30_000 });
  await expect(page.locator('[data-run-status="staged"]')).toBeVisible();
  await page.getByRole('button', { name: 'review' }).click();

  const maren = page.locator('[data-proposal="entity"]').filter({ hasText: 'Maren' });
  await expect(maren).toHaveAttribute('data-verified', 'false');
  await expect(maren).toHaveAttribute('data-status', 'pending');
  await expect(maren.getByTestId('unverified')).toHaveText('could not be traced to the file');
  await expect(page.getByText(/1 more could not be traced to the files and waits for you/)).toBeVisible();
  await expect(maren).toContainText('80%');

  // Apply without touching it: only Ilva lands.
  await page.getByRole('button', { name: /^Apply 1$/ }).click();
  await expect.poll(() => query(page, 'SELECT name FROM entity WHERE deleted_at IS NULL'), { timeout: 15_000 })
    .toEqual([['Ilva']]);
  expect(await query(page, "SELECT status FROM proposal WHERE id = 'p-maren'")).toEqual([['pending']]);
});
