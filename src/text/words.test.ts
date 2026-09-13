import { describe, it, expect } from 'vitest';
import { countWords, countSentences, splitSentences } from './words';

/**
 * Reference cases with hand-verified counts — docs/12 §6 insists the counter is
 * tested against known-good numbers rather than against itself.
 *
 * The working is written out beside each expectation, so a future change that
 * shifts a number has to argue with the arithmetic rather than just update it.
 * Kept inline rather than in fixture files because the count and the text being
 * counted belong next to each other where a reviewer can check them.
 */

describe('word counting', () => {
  it('counts plain prose', () => {
    const text = [
      'The rain fell in sheets.',              // The/rain/fell/in/sheets       = 5
      '',
      'Kaelen woke before dawn and did not move.', // Kaelen/woke/before/dawn/and/did/not/move = 8
      'He counted three breaths, then four.',  // He/counted/three/breaths/then/four = 6
    ].join('\n');

    const c = countWords(text);
    expect(c.words).toBe(19);       // 5 + 8 + 6
    expect(c.paragraphs).toBe(2);   // the second is two lines, one paragraph
    expect(c.sentences).toBe(3);
  });

  it('treats en and em dashes as separators but keeps hyphenated words whole', () => {
    // The specific trap §6 names: naive splitting counts `word—word` as one.
    // word / word / and / word / word / and / well-lit = 7
    const c = countWords('word—word and word–word and well-lit');
    expect(c.words).toBe(7);
  });

  it('does not count markup as words or characters', () => {
    // The/heavy/sheet/of/corrugated/plastic/rattled/hard/against/the/frame = 11
    const c = countWords('The **heavy** sheet of *corrugated* plastic rattled—hard—against the frame.');
    expect(c.words).toBe(11);
    expect(c.paragraphs).toBe(1);
    expect(c.sentences).toBe(1);
    // The asterisks are gone from the character count too.
    expect(c.characters).toBe(
      'The heavy sheet of corrugated plastic rattled—hard—against the frame.'.length,
    );
  });

  it('keeps link text and drops the target', () => {
    // See/the/note/for/details = 5
    const c = countWords('See [the note](https://example.invalid/a/b) for details.');
    expect(c.words).toBe(5);
  });

  it('skips comment and keyword lines entirely', () => {
    const text = ['% a private note', '@pov: Kaelen', '', 'She said nothing.'].join('\n');
    const c = countWords(text);
    expect(c.words).toBe(3);        // She/said/nothing
    expect(c.paragraphs).toBe(1);   // the meta lines do not make a paragraph of their own
    expect(c.sentences).toBe(1);
  });

  it('strips block-quote markers', () => {
    const c = countWords('> She said nothing.\n> He did not answer.');
    expect(c.words).toBe(7);        // 3 + 4
    expect(c.paragraphs).toBe(1);
    expect(c.sentences).toBe(2);
  });

  it('counts characters with and without spaces', () => {
    const c = countWords('Two words.');
    expect(c.words).toBe(2);
    expect(c.characters).toBe(10);          // T,w,o,space,w,o,r,d,s,.
    expect(c.charactersNoSpaces).toBe(9);
  });

  it('is empty for empty input rather than counting one blank word', () => {
    const c = countWords('');
    expect(c).toMatchObject({ words: 0, paragraphs: 0, sentences: 0, characters: 0 });
  });

  it('normalises CRLF so a Windows-authored file counts the same', () => {
    expect(countWords('One two.\r\n\r\nThree four.')).toEqual(countWords('One two.\n\nThree four.'));
  });
});

describe('sentence splitting', () => {
  it('treats a terminator run as one sentence, not three', () => {
    expect(countSentences('What?! Really... yes.')).toBe(3);
  });

  it('counts a trailing fragment with no terminator', () => {
    expect(countSentences('She ran. He followed')).toBe(2);
  });

  it('keeps a closing quotation mark with its sentence', () => {
    expect(splitSentences('"Go," she said. He went.')).toEqual(['"Go," she said.', 'He went.']);
  });

  it('agrees with countWords about how many sentences there are', () => {
    const text = 'One. Two! Three?';
    expect(splitSentences(text)).toHaveLength(countWords(text).sentences);
  });
});
