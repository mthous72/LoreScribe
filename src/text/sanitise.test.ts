import { describe, it, expect } from 'vitest';
import {
  sanitise, stripReasoningBlocks, ReasoningStripper, repairMojibake,
  stripScaffolding, normalisePunctuation, normaliseWhitespace,
} from './sanitise';

describe('reasoning blocks', () => {
  it('removes complete blocks, case-insensitively, across newlines', () => {
    expect(stripReasoningBlocks('A<think>\nplanning\nmore\n</think>B')).toBe('AB');
    expect(stripReasoningBlocks('A<REASONING>x</Reasoning>B')).toBe('AB');
  });

  it('removes an unterminated block through to the end', () => {
    // So that the batch path and the streaming path agree on truncated output.
    expect(stripReasoningBlocks('Kept.<think>cut off')).toBe('Kept.');
  });

  it('leaves ordinary angle brackets alone', () => {
    expect(stripReasoningBlocks('She was <i>furious</i>.')).toBe('She was <i>furious</i>.');
  });
});

describe('streaming reasoning stripper', () => {
  const feed = (text: string, size: number) => {
    const s = new ReasoningStripper();
    let out = '';
    for (let i = 0; i < text.length; i += size) out += s.push(text.slice(i, i + size));
    return { text: out + s.flush(), unterminated: s.unterminated };
  };

  it('matches the batch result at every chunk size', () => {
    // The property that matters: a scene must not sanitise differently because
    // it happened to be streamed.
    const samples = [
      'Before<think>hidden</think>after.',
      '<think>all of it</think>Only this.',
      'No tags at all, just prose.',
      'Two<think>a</think>middle<reasoning>b</reasoning>end.',
      'Angle < bracket and <notatag> stay.',
    ];
    for (const sample of samples) {
      for (let size = 1; size <= sample.length + 1; size++) {
        expect(feed(sample, size).text, `chunk size ${size} on ${JSON.stringify(sample)}`)
          .toBe(stripReasoningBlocks(sample));
      }
    }
  });

  it('does not leak a tag split across a chunk boundary', () => {
    // The exact failure a naive per-chunk regex has: `<thi` + `nk>` passes
    // through, and then the whole reasoning block reaches the reader.
    const s = new ReasoningStripper();
    let out = s.push('Kept.<thi');
    out += s.push('nk>secret planning</th');
    out += s.push('ink>Also kept.');
    out += s.flush();
    expect(out).toBe('Kept.Also kept.');
    expect(out).not.toContain('secret');
  });

  it('flushes a held tail that turned out not to be a tag', () => {
    const s = new ReasoningStripper();
    let out = s.push('ends with <');
    out += s.flush();
    expect(out).toBe('ends with <');
  });

  it('emits nothing and says so when the stream dies inside a block', () => {
    const s = new ReasoningStripper();
    const out = s.push('A<think>still thinking') + s.flush();
    expect(out).toBe('A');
    expect(s.unterminated).toBe(true);
  });
});

describe('mojibake repair', () => {
  it('repairs UTF-8-decoded-as-cp1252 text', () => {
    const enc = new TextEncoder();
    const dec = new TextDecoder('windows-1252');
    const original = 'He paused—then ran. “Go,” she said. It’s over…';
    const broken = dec.decode(enc.encode(original));
    expect(broken).not.toBe(original);
    expect(repairMojibake(broken)).toBe(original);
  });

  it('repairs an em dash whose trailing bytes were lost', () => {
    expect(repairMojibake('wordâword')).toBe('word—word');
  });

  it('drops a stray  adjacent to whitespace', () => {
    expect(repairMojibake('cold Â morning')).toBe('cold  morning');
  });

  it('leaves clean text untouched', () => {
    const clean = 'He paused—then ran. “Go,” she said.';
    expect(repairMojibake(clean)).toBe(clean);
  });
});

describe('scaffolding', () => {
  it('strips scene label lines in their variants', () => {
    for (const label of ['Scene 3:', '**Scene 3: The Kiln**', '## Scene 12', 'SCENE 4 — Dawn']) {
      expect(stripScaffolding(`${label}\nThe rain fell.`)).toBe('The rain fell.');
    }
  });

  it('drops a first line that merely restates the summary', () => {
    const summary = 'Kaelen confronts the smith about the missing blade.';
    const text = 'Kaelen confronts the smith about the missing blade.\n\nThe forge was cold.';
    expect(stripScaffolding(text, summary).trim()).toBe('The forge was cold.');
  });

  it('keeps a first line that merely shares a subject with the summary', () => {
    const summary = 'Kaelen confronts the smith about the missing blade.';
    const text = 'The forge was cold when Kaelen arrived.';
    expect(stripScaffolding(text, summary)).toBe(text);
  });

  it('keeps prose when no summary is supplied', () => {
    expect(stripScaffolding('The rain fell in sheets.')).toBe('The rain fell in sheets.');
  });
});

describe('punctuation', () => {
  it('turns hyphen runs into em dashes and closes the gaps', () => {
    expect(normalisePunctuation('He paused -- then ran.')).toBe('He paused—then ran.');
    expect(normalisePunctuation('He paused — then ran.')).toBe('He paused—then ran.');
  });

  it('leaves markdown horizontal rules alone', () => {
    expect(normalisePunctuation('---')).toBe('---');
    expect(normalisePunctuation('***')).toBe('***');
  });

  it('leaves genuine list items alone but removes the jammed-hyphen tic', () => {
    expect(normalisePunctuation('- A real list item')).toBe('- A real list item');
    expect(normalisePunctuation('-The rain fell.')).toBe('The rain fell.');
    expect(normalisePunctuation('-“Go,” she said.')).toBe('“Go,” she said.');
  });

  it('lower-cases a possessive S after an all-caps word, either apostrophe', () => {
    expect(normalisePunctuation("KAELEN'S blade")).toBe("KAELEN's blade");
    expect(normalisePunctuation('KAELEN\u2019S blade')).toBe('KAELEN\u2019s blade');
    // Not a possessive: a single capital, or a genuine all-caps word.
    expect(normalisePunctuation("A'S")).toBe("A'S");
  });
});

describe('whitespace', () => {
  it('trims line ends, collapses blank runs and trims the edges', () => {
    expect(normaliseWhitespace('\n\nA   \n\n\n\nB \n\n')).toBe('A\n\nB');
  });
});

describe('the pipeline', () => {
  const summary = 'Kaelen confronts the smith about the missing blade.';
  const messy = [
    '<think>',
    'I should open with the forge.',
    '</think>',
    '',
    '**Scene 7: The Kiln**',
    'Kaelen confronts the smith about the missing blade.',
    '',
    '-The forge was cold. He paused -- then spoke.   ',
    '',
    '',
    '',
    'It was KAELEN’S blade. “Where is it?”',
  ].join('\n');

  it('produces clean prose', () => {
    expect(sanitise(messy, { summary })).toBe([
      'The forge was cold. He paused—then spoke.',
      '',
      'It was KAELEN’s blade. “Where is it?”',
    ].join('\n'));
  });

  it('is idempotent — the property docs/12 §2 asks to be tested directly', () => {
    const inputs = [
      messy,
      'Plain prose with nothing to fix.',
      '',
      '   \n\n  \n',
      'A -- B --- C',
      '<think>only reasoning</think>',
      'He paused—then ran.',
      '--- \nnot a rule because of the trailing space',
    ];
    for (const input of inputs) {
      const once = sanitise(input, { summary });
      expect(sanitise(once, { summary }), JSON.stringify(input)).toBe(once);
    }
  });

  it('is idempotent without a summary too', () => {
    for (const input of ['Scene 1:\nScene 2:\nThe rain fell.', 'a\n\n\n\nb']) {
      const once = sanitise(input);
      expect(sanitise(once)).toBe(once);
    }
  });
});
