import { test, expect } from '@playwright/test';
import { gotoApp } from './support';

// Phase 1 spikes. Doc 08 lists the Tiptap one among the things to measure
// before the phase ends: a 5,000-word scene with live mention decorations.

test('the editor holds up at 5,000 words with a full cast highlighted', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await gotoApp(page, './#/diagnostics');

  const result = await page.evaluate(() => window.runEditorSpike());
  expect(errors, errors.join('\n')).toHaveLength(0);

   
  console.log(`\n   ${result.words.toLocaleString()} words · ${result.paragraphs} paragraphs · ${result.aliases} aliases`);
  for (const m of result.measurements) {
     
    console.log(`  ${m.pass == null ? ' · ' : m.pass ? ' ✓ ' : ' ✗ '}${m.label}\n     ${m.value} ${m.unit}`
      + `   (target ${m.target ?? '—'})${m.detail ? '\n     ' + m.detail : ''}`);
  }

  // A spike that highlights nothing measures nothing. The first run of this
  // reported "0 distinct entities highlighted" and passed anyway, because the
  // decoration spec and its DOM attributes are separate arguments and I had
  // written the id into only one of them.
  expect(result.spansHighlighted, 'nothing was highlighted, so nothing was measured').toBeGreaterThan(50);
  expect(result.entitiesHighlighted).toBeGreaterThan(10);
  expect(result.words).toBeGreaterThan(4500);
  // The A/B has to mean something: if the incremental path is not actually
  // faster than rescanning everything, its complexity is not earned and it
  // should be deleted rather than kept because it sounds right.
  expect(result.incrementalP50,
    `incremental ${result.incrementalP50}ms vs whole-document ${result.wholeDocP50}ms`)
    .toBeLessThan(result.wholeDocP50);
  expect(result.measurements.filter((m) => m.pass === false).map((m) => `${m.label}: ${m.value}`)).toEqual([]);
});

test('a project exports and restores, and a damaged archive still restores most of it', async ({ page }) => {
  await gotoApp(page);

  // Clean round trip first: everything comes back.
  const clean = await page.evaluate(() => window.backupRoundTrip('backup-clean', 'none')) as Record<string, unknown>;
  expect(clean, JSON.stringify(clean)).toMatchObject({
    ok: true, emptyBefore: 0, skipped: 0, scenesAfter: 12,
    projectTitle: 'The Grey Warden', firstScene: 'Scene 0 prose.',
  });
  expect(clean.problems).toEqual([]);

  // One corrupted line: that row is lost, everything else survives. This is the
  // whole reason the archive is newline-delimited rather than one JSON document.
  const corrupt = await page.evaluate(() => window.backupRoundTrip('backup-corrupt', 'corrupt-line')) as Record<string, unknown>;
  expect(corrupt).toMatchObject({ ok: true, projectTitle: 'The Grey Warden' });
  expect(corrupt.applied as number).toBeGreaterThan(10);
  expect((corrupt.problems as string[]).some((p) => /not valid JSON/.test(p))).toBe(true);

  // Truncated mid-write: the head is still readable and restores.
  const cut = await page.evaluate(() => window.backupRoundTrip('backup-cut', 'truncate')) as Record<string, unknown>;
  expect(cut).toMatchObject({ ok: true, projectTitle: 'The Grey Warden' });
  expect(cut.applied as number).toBeGreaterThan(0);
  expect((cut.problems as string[]).some((p) => /truncated/.test(p))).toBe(true);
});
