import { describe, it, expect } from 'vitest';
import { parseMarkdown } from './markdown';
import { firstClause, readOutline, ruleItems, splitName } from './outline';

/** Fixtures invented — D14. Shaped like a real outline, about nobody. */

const OUTLINE = [
  '# Outline', '',
  'Ten scenes, three movements.', '',
  '## Movement 1.  The door', '',
  '#### 1. Night 0 — written', '',
  'She lets him in. The book opens on the threshold.', '',
  '1. He knocks twice.  She knows the knock.',
  '2. The price is named.  She does not argue.', '',
  '#### 2. Wren — not written.  Next on the page.', '',
  '1. Wren counts the crates.', '',
  '## Movement 2.  The week', '',
  '#### 3. Old partner — not written', '',
  'A paragraph about it.', '',
  '1. They find her.',
  '2. They ask her back.',
  '3. She cannot take it.', '',
  '#### 9b. Early jack — not written', '',
  '1. The table.', '',
].join('\n');

describe('readOutline', () => {
  const doc = parseMarkdown('reference/outline.md', OUTLINE);
  const root = doc.root.children[0]!;
  const outline = readOutline(root, 'Outline');

  it('reads acts, sections and beats one for one', () => {
    expect(outline.parts.map((p) => p.title)).toEqual(['The door', 'The week']);
    expect(outline.parts[0]!.sections.map((s) => `${s.number}:${s.title}:${s.status}`))
      .toEqual(['1:Night 0:drafted', '2:Wren:planned']);
    expect(outline.parts[1]!.sections.map((s) => `${s.number}:${s.title}`))
      .toEqual(['3:Old partner', '9:Early jack']);
  });

  it('keeps what the section says beyond its beats as the summary', () => {
    const [night, wren] = outline.parts[0]!.sections;
    expect(night!.summary).toBe('She lets him in. The book opens on the threshold.');
    // The tail said more than a status, and that goes first.
    expect(wren!.summary).toBe('Next on the page');
    expect(outline.parts[1]!.sections[0]!.summary).toBe('A paragraph about it.');
  });

  it('reads each numbered line as a beat, titled by its first sentence', () => {
    const night = outline.parts[0]!.sections[0]!;
    expect(night.beats.map((b) => b.title)).toEqual(['He knocks twice', 'The price is named']);
    expect(night.beats[0]!.summary).toBe('He knocks twice.  She knows the knock.');
    expect(outline.parts[1]!.sections[0]!.beats).toHaveLength(3);
  });

  it('puts sections with no act heading above them in an unnamed act', () => {
    const flat = parseMarkdown('plan.md', '# Plan\n\n#### 1. One — not written\n\n1. A beat.\n\n#### 2. Two\n');
    const out = readOutline(flat.root.children[0]!, 'Plan');
    expect(out.parts).toHaveLength(1);
    expect(out.parts[0]!.title).toBeNull();
    expect(out.parts[0]!.sections.map((s) => s.title)).toEqual(['One', 'Two']);
  });

  it('reads nothing from a file with no numbered headings', () => {
    const none = parseMarkdown('x.md', '# Notes\n\n## Time\n\nWeeks.\n\n## Money\n\nNinety.\n');
    expect(readOutline(none.root.children[0]!, 'Notes').parts).toEqual([]);
  });
});

describe('ruleItems', () => {
  it('takes bullets when there are bullets', () => {
    expect(ruleItems('- No em dashes.\n- Two spaces after a period.\n\nA stray paragraph.'))
      .toEqual(['No em dashes.', 'Two spaces after a period.']);
  });

  it('takes paragraphs otherwise', () => {
    expect(ruleItems('Power core in the chest.  Memory too.\n\nOnce out she cannot go home.\n'))
      .toEqual(['Power core in the chest. Memory too.', 'Once out she cannot go home.']);
  });

  it('does not read a single bullet as a list', () => {
    expect(ruleItems('- only one\n\nand prose')).toEqual(['- only one', 'and prose']);
  });
});

describe('splitName', () => {
  it('separates a name from a description sharing its heading', () => {
    expect(splitName('Wren, dock clerk, male')).toEqual({ name: 'Wren', rest: 'dock clerk, male' });
    expect(splitName('Veck — the man with the button')).toEqual({ name: 'Veck', rest: 'the man with the button' });
    expect(splitName('Juno: two women')).toEqual({ name: 'Juno', rest: 'two women' });
  });

  it('leaves alone what it cannot be sure of', () => {
    expect(splitName('Dex and Holm')).toEqual({ name: 'Dex and Holm', rest: null });
    expect(splitName('Masheru')).toEqual({ name: 'Masheru', rest: null });
    expect(splitName('The man who came in from the harbour every night, Stu'))
      .toEqual({ name: 'The man who came in from the harbour every night, Stu', rest: null });
  });
});

describe('firstClause', () => {
  it('takes the first sentence and drops its stop', () => {
    expect(firstClause('No em dashes.  No ellipses.')).toBe('No em dashes');
  });
  it('cuts a long one with an ellipsis', () => {
    expect(firstClause('a'.repeat(100), 20)).toBe(`${'a'.repeat(19)}…`);
  });
});
