import { describe, it, expect } from 'vitest';
import { deterministicChecks, isRubric, parseRubricReply, renderRubricPrompt, type CheckableLaw } from './verify';

/** Fixtures invented — D14. */

const law = (id: string, over: Partial<CheckableLaw> = {}): CheckableLaw => ({
  id, title: id, severity: 'must', ruleText: `rule ${id}`, checkMode: 'prompt', checkConfig: null, ...over,
});

const prose = 'Suddenly the door opened. She turned, suddenly afraid.\n\n“Go,” he said quietly. The rain came down.';

describe('regex laws', () => {
  it('flag every match with the span, case-insensitively by default, and cap the count', () => {
    const r = deterministicChecks([
      law('sud', { title: 'No suddenly', checkMode: 'regex', checkConfig: JSON.stringify({ pattern: '\\bsuddenly\\b', why: 'Banned word.', fix: 'Cut it.' }) }),
    ], prose);
    expect(r.skipped).toEqual([]);
    expect(r.findings.map((f) => [f.quote, f.start, f.end])).toEqual([['Suddenly', 0, 8], ['suddenly', 38, 46]]);
    expect(r.findings[0]).toMatchObject({
      lawId: 'sud', lawTitle: 'No suddenly', source: 'regex', explanation: 'Banned word.', suggestedFix: 'Cut it.',
      evidenceVerified: true,
    });
    const many = deterministicChecks([law('e', { checkMode: 'regex', checkConfig: '{"pattern":"e"}' })], 'e'.repeat(50));
    expect(many.findings).toHaveLength(20);
  });

  it('honour given flags, ignore empty matches, and skip a missing or broken pattern with the reason', () => {
    const r = deterministicChecks([
      law('cs', { checkMode: 'regex', checkConfig: '{"pattern":"suddenly","flags":""}' }),
      law('empty', { checkMode: 'regex', checkConfig: '{"pattern":"x*"}' }),
      law('none', { checkMode: 'regex', checkConfig: null }),
      law('bad', { checkMode: 'regex', checkConfig: '{"pattern":"("}' }),
      law('long', { checkMode: 'regex', checkConfig: JSON.stringify({ pattern: 'a'.repeat(201) }) }),
      law('junk', { checkMode: 'regex', checkConfig: 'not json' }),
      law('prompt-only', { checkMode: 'prompt', checkConfig: '{"pattern":"the"}' }),
    ], prose);
    expect(r.findings.map((f) => f.lawId)).toEqual(['cs']); // lowercase only
    expect(r.skipped.map((s) => s.lawId)).toEqual(['none', 'bad', 'long', 'junk']);
    expect(r.skipped[1]!.reason).toMatch(/does not compile/);
  });
});

describe('heuristic laws', () => {
  it('flag a word band once, as a whole-text finding, and skip an empty or unknown one', () => {
    const r = deterministicChecks([
      law('short', { checkMode: 'heuristic', checkConfig: '{"minWords":400}' }),
      law('long', { checkMode: 'heuristic', checkConfig: '{"kind":"wordBand","maxWords":10}' }),
      law('fine', { checkMode: 'heuristic', checkConfig: '{"minWords":5,"maxWords":100}' }),
      law('nothing', { checkMode: 'heuristic', checkConfig: '{}' }),
      law('odd', { checkMode: 'heuristic', checkConfig: '{"kind":"tense"}' }),
    ], prose);
    expect(r.findings.map((f) => f.lawId)).toEqual(['short', 'long']);
    expect(r.findings[0]).toMatchObject({ quote: null, start: null, source: 'heuristic', evidenceVerified: true });
    expect(r.findings[0]!.explanation).toMatch(/^16 words, under the 400/);
    expect(r.findings[1]!.explanation).toMatch(/over the 10/);
    expect(r.skipped.map((s) => s.reason)).toEqual(['no word band', 'unknown heuristic “tense”']);
  });
});

describe('the rubric turn', () => {
  const laws = [
    law('adv', { title: 'No adverbs on dialogue tags', ruleText: 'Never modify a dialogue tag with an adverb.', checkMode: 'rubric' }),
    law('rain', { title: 'No weather openings', ruleText: 'Do not open on weather.', checkMode: 'prompt+rubric', checkConfig: '{"rubric":"Rain, wind, sun, all of it."}' }),
  ];

  it('numbers the laws, includes the prose, and asks for a bare JSON array', () => {
    const p = renderRubricPrompt(laws, prose);
    expect(p).toContain('1. No adverbs on dialogue tags: Never modify a dialogue tag with an adverb.');
    expect(p).toContain('2. No weather openings: Do not open on weather. (Rain, wind, sun, all of it.)');
    expect(p).toContain('PASSAGE\nSuddenly the door opened.');
    expect(p).toContain('answer [].');
    expect(isRubric(laws[0]!)).toBe(true);
    expect(isRubric(laws[1]!)).toBe(true);
    expect(isRubric(law('p'))).toBe(false);
  });

  it('keeps a verified quote with its offsets, and downgrades an invented one to uncertain', () => {
    const reply = `Here are the breaches:\n\`\`\`json\n[
      {"law": 1, "quote": "\\"Go,\\" he said quietly.", "why": "Quietly modifies said.", "fix": "Cut quietly."},
      {"law": 1, "quote": "he whispered softly", "why": "Softly modifies whispered.", "fix": ""},
      {"law": "rain", "quote": "The rain came down.", "why": "Weather."},
      {"law": 7, "quote": "The rain came down.", "why": "No such law."},
      "garbage",
      {"law": 2, "quote": "rain", "why": "Too short to trust."}
    ]\n\`\`\``;
    const r = parseRubricReply(reply, laws, prose);
    expect(r.malformed).toBe(false);
    expect(r.findings).toHaveLength(4);
    const [a, b, c, d] = r.findings;
    expect(a).toMatchObject({
      lawId: 'adv', source: 'rubric', quote: '“Go,” he said quietly.', evidenceVerified: true,
      explanation: 'Quietly modifies said.', suggestedFix: 'Cut quietly.',
    });
    expect(prose.slice(a!.start!, a!.end!)).toBe('“Go,” he said quietly.');
    expect(b).toMatchObject({ lawId: 'adv', quote: 'he whispered softly', evidenceVerified: false, start: null, suggestedFix: null });
    expect(c).toMatchObject({ lawId: 'rain', evidenceVerified: true, quote: 'The rain came down.' });
    expect(d).toMatchObject({ lawId: 'rain', quote: 'rain', evidenceVerified: false });
  });

  it('reads an empty array as nothing to flag, and anything else as malformed', () => {
    expect(parseRubricReply('[]', laws, prose)).toEqual({ findings: [], malformed: false });
    expect(parseRubricReply('No breaches found.', laws, prose).malformed).toBe(true);
    expect(parseRubricReply('[{"law": 1,', laws, prose).malformed).toBe(true);
    expect(parseRubricReply('{"law": 1}', laws, prose).malformed).toBe(true);
    expect(parseRubricReply('', [], prose)).toEqual({ findings: [], malformed: false });
  });
});
