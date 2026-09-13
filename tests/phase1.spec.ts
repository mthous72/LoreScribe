import { test, expect } from '@playwright/test';

// Phase 1 spikes. Doc 08 lists the Tiptap one among the things to measure
// before the phase ends: a 5,000-word scene with live mention decorations.

test('the editor holds up at 5,000 words with a full cast highlighted', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('./#/diagnostics');

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
