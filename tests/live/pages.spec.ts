import { test, expect } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';

// Environment 2 of the spike report: the deployed Pages origin.
// Excluded from the default run because it depends on a live deployment — a
// test that fails when GitHub is having a bad morning is not a useful gate.

test('the spike, against the deployed origin', async ({ page }) => {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e}`));
  page.on('requestfailed', (r) => problems.push(`${r.url()} :: ${r.failure()?.errorText}`));

  await page.goto('./', { waitUntil: 'networkidle' });

  // If Pages ever serves the repository instead of the build, the app never
  // mounts and this is where it shows up rather than on someone's phone.
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();

  await page.goto('./#/diagnostics');
  const result = await page.evaluate(async () => window.runSpike(undefined as never, { clearOnInit: true }));

  expect(problems, problems.join('\n')).toHaveLength(0);
  expect(result.failure, JSON.stringify(result.failure)).toBeUndefined();

  mkdirSync('spike-results', { recursive: true });
  writeFileSync('spike-results/pages-desktop.json', JSON.stringify(result, null, 2));
  console.log('\n' + result.measurements.map((m) =>
    `${m.pass === null ? ' · ' : m.pass ? ' ✓ ' : ' ✗ '}${m.label}\n     ${m.value} ${m.unit}   (target ${m.target})`
    + `${m.detail ? '\n     ' + m.detail : ''}`).join('\n'));

  expect(result.measurements.filter((m) => m.pass === false)
    .map((m) => `${m.label}: ${m.value}${m.unit}`)).toEqual([]);
});
