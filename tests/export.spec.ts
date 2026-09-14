import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { gotoApp } from './support';
import { readZipEntry } from '../src/import/docx';

/**
 * The readable export, end to end.
 *
 * The formatters and the round trip are proved as pure functions and against
 * the real schema. What only the browser can show is that a file actually
 * reaches the writer's disk — which is the entire point of an export, and the
 * one part no unit test touches.
 *
 * Fixtures invented — D14.
 */

async function project(page: Page): Promise<void> {
  await gotoApp(page);
  await page.getByLabel('Project title').fill(`Ashfall ${Date.now()}`);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: /^Ashfall/ }).first().click();
  await page.getByRole('button', { name: 'Create the first book' }).click();
  await page.getByRole('button', { name: 'Add a chapter' }).click();
  await page.getByRole('button', { name: 'Add a scene' }).click();
  await page.getByRole('button', { name: /^Scene 1, / }).click();
  await page.locator('.prose-editor').click();
  await page.keyboard.type('The harbour was empty when she arrived.');
  await expect(page.locator('[data-save-state]')).toHaveAttribute('data-save-state', 'saved');
}

/** Back to the project list, where the backup panel lives. */
const backToList = (page: Page) => page.getByRole('link', { name: '← Projects' }).click();

test('saves the manuscript as one Markdown file', async ({ page }) => {
  await project(page);
  await backToList(page);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Just the manuscript, as one file' }).click(),
  ]);

  // The date is in the name and in ISO order, so a folder of backups sorts.
  expect(download.suggestedFilename()).toMatch(/^ashfall-\d+-\d{4}-\d{2}-\d{2}\.md$/u);
  const text = await readFile((await download.path())!, 'utf8');
  // The BOOK's title, which is not the project's: "Create the first book" makes
  // one called Book One inside a project called something else.
  expect(text).toContain('# Book One');
  expect(text).toContain('### Chapter 1');
  expect(text).toContain('The harbour was empty when she arrived.');
});

test('saves everything as a folder of Markdown, and the app can read it back', async ({ page }) => {
  await project(page);
  await page.getByRole('link', { name: /^Codex/ }).click();
  await page.getByLabel('New entity name').fill('Ilva');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Ilva/ })).toBeVisible();
  await page.getByRole('link', { name: '← Manuscript' }).click();
  await backToList(page);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Save everything as Markdown' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.zip$/u);

  const bytes = new Uint8Array(await readFile((await download.path())!));
  const decoder = new TextDecoder();
  /** Fail by name when an entry is missing, rather than throwing inside decode. */
  const entry = async (path: string) => {
    const found = await readZipEntry(bytes, path);
    expect(found, `expected ${path} in the bundle`).not.toBeNull();
    return decoder.decode(found!);
  };

  // A real zip, laid out as a bible: a folder per kind, a file per thing.
  expect(await entry('README.md')).toContain('.lorescribe');
  expect(await entry('characters/ilva.md')).toContain('# Ilva');
  expect(await entry('manuscript/book-one.md'))
    .toContain('The harbour was empty when she arrived.');
  // The parity bar asks for plain text beside Markdown, and it is a different
  // file rather than the same one with the hashes taken out.
  expect(await entry('manuscript/book-one.txt')).not.toMatch(/^#/mu);
});
