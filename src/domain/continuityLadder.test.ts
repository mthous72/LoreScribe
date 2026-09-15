import { describe, it, expect } from 'vitest';
import { continuityLadder, proseTail, type LadderInput } from './continuityLadder';
import { globalRank, sceneGlobalRank } from './sortKey';

/**
 * The ladder is four rungs and every one of them is a filter on rank. Most of
 * what is tested here is that nothing climbs a rung it has not earned: a scene
 * that has not happened, a chapter from the act after this one, the summary of
 * a part still to come.
 */

const say = (n: number, from = 1) =>
  Array.from({ length: n }, (_, i) => `w${from + i}`).join(' ');

const ladder = (over: Partial<LadderInput> = {}) => continuityLadder({
  atRank: 'c2s2',
  chapterId: 'c2',
  scenes: [],
  chapters: [
    { id: 'c1', partId: 'p1', rank: 'c1', number: 1, title: null, summary: 'Chapter one happened.' },
    { id: 'c2', partId: 'p1', rank: 'c2', number: 2, title: null, summary: 'Chapter two happens.' },
  ],
  parts: [],
  ...over,
});

const scene = (id: string, rank: string, over: Partial<LadderInput['scenes'][number]> = {}) => ({
  id, globalRank: rank, chapterId: rank.slice(0, 2),
  title: id, summary: `${id} in short.`, text: `${id} at length.`, ...over,
});

describe('the seam', () => {
  it('takes whole paragraphs from the end of the previous scene', () => {
    const text = `${say(200)}\n\n${say(100, 201)}\n\n${say(100, 301)}`;
    const out = ladder({ scenes: [scene('s1', 'c2s1', { text })] });
    expect(out.tail?.words).toBe(200);
    expect(out.tail?.text).toBe(`${say(100, 201)}\n\n${say(100, 301)}`);
    expect(out.tail?.truncated).toBe(true);
  });

  it('ends exactly where the scene ends', () => {
    // This is the text the next scene continues from. The cut is always at the
    // start, never at the end.
    const text = `${say(400)} and then she left.`;
    const out = ladder({ scenes: [scene('s1', 'c2s1', { text })] });
    expect(out.tail?.text.endsWith('and then she left.')).toBe(true);
  });

  it('cuts a single over-long paragraph on a space, and only at the start', () => {
    // The one case whole paragraphs cannot honour. Mid-sentence is survivable;
    // mid-word is not.
    const text = say(400);
    const out = ladder({ scenes: [scene('s1', 'c2s1', { text })] });
    expect(out.tail?.words).toBe(300);
    expect(out.tail?.text).toBe(say(300, 101));
    expect(text.endsWith(out.tail?.text ?? '')).toBe(true);
    expect(out.tail?.truncated).toBe(true);
  });

  it('takes the whole of a short scene without calling it truncated', () => {
    const out = ladder({ scenes: [scene('s1', 'c2s1', { text: say(20) })] });
    expect(out.tail?.text).toBe(say(20));
    expect(out.tail?.truncated).toBe(false);
  });

  it('spends the budget it is given', () => {
    const text = Array.from({ length: 10 }, (_, i) => say(50, i * 50 + 1)).join('\n\n');
    const out = ladder({
      scenes: [scene('s1', 'c2s1', { text })],
      options: { tailWords: 100 },
    });
    expect(out.tail?.words).toBe(100);
  });
});

describe('a scene that was planned and never written', () => {
  const planned = [
    scene('s1', 'c2s1', { text: null }),
    scene('s0', 'c1s9'),
  ];

  it('leaves the seam empty rather than filling it with nothing', () => {
    const out = ladder({ scenes: planned });
    expect(out.tail).toBeNull();
    expect(out.missing).toContainEqual({ rung: 'tail', id: 's1', title: 's1' });
  });

  it('counts a scene holding nothing but whitespace as unwritten', () => {
    // An editor left open and closed again leaves a paragraph of nothing, and
    // a tail of nothing reads to the model as a scene that ended in silence.
    const out = ladder({
      scenes: [scene('s1', 'c2s1', { text: '  \n\n  ' }), scene('s0', 'c1s9')],
    });
    expect(out.tail).toBeNull();
    expect(out.missing).toContainEqual({ rung: 'tail', id: 's1', title: 's1' });
  });

  it('drops it to the rung below, where it still has something to say', () => {
    const out = ladder({ scenes: planned });
    expect(out.scenes.map((r) => r.id)).toEqual(['s0', 's1']);
  });
});

describe('the scenes below the seam', () => {
  const run = Array.from({ length: 8 }, (_, i) => scene(`s${i}`, `c2s${i}`));

  it('takes the ones doc 03 asks for, oldest first, below the tail', () => {
    const out = ladder({ atRank: 'c2s9', scenes: run });
    expect(out.tail?.sceneId).toBe('s7');
    expect(out.scenes.map((r) => r.id)).toEqual(['s3', 's4', 's5', 's6']);
  });

  it('takes as many as it is asked for', () => {
    const out = ladder({ atRank: 'c2s9', scenes: run, options: { sceneSummaries: 2 } });
    expect(out.scenes.map((r) => r.id)).toEqual(['s5', 's6']);
  });

  it('names a scene with no summary instead of skipping it', () => {
    const out = ladder({
      atRank: 'c2s9',
      scenes: [...run.slice(0, 6), scene('s6', 'c2s6', { summary: '   ' }), run[7]!],
    });
    expect(out.scenes.map((r) => r.id)).toEqual(['s3', 's4', 's5']);
    expect(out.missing).toContainEqual({ rung: 'scene', id: 's6', title: 's6' });
  });

  it('ignores anything that has not happened yet', () => {
    const out = ladder({
      atRank: 'c2s2',
      scenes: [scene('past', 'c2s1'), scene('now', 'c2s2'), scene('later', 'c2s3')],
    });
    expect(out.tail?.sceneId).toBe('past');
    expect(out.scenes).toEqual([]);
    expect(JSON.stringify(out)).not.toContain('later');
  });
});

describe('the current act', () => {
  const chapters = [
    // c0 is earlier than everything and belongs to the act before this one, so
    // only the act filter can keep it out — the rank filter never sees it.
    { id: 'c0', partId: 'p0', rank: 'c0', number: 0, title: null, summary: 'Zero.' },
    { id: 'c1', partId: 'p1', rank: 'c1', number: 1, title: null, summary: 'One.' },
    { id: 'c2', partId: 'p1', rank: 'c2', number: 2, title: null, summary: 'Two.' },
    { id: 'c3', partId: 'p1', rank: 'c3', number: 3, title: null, summary: 'Three.' },
    { id: 'c4', partId: 'p2', rank: 'c4', number: 4, title: null, summary: 'Four.' },
  ];

  it('takes the chapters of this act that are already behind us', () => {
    const out = ladder({ chapterId: 'c3', chapters });
    expect(out.chapters.map((r) => r.id)).toEqual(['c1', 'c2']);
    expect(out.chapters.map((r) => r.summary)).toEqual(['One.', 'Two.']);
  });

  it('leaves out the chapter we are standing in', () => {
    // Its earlier scenes are on the rung above, in more detail than a summary.
    const out = ladder({ chapterId: 'c3', chapters });
    expect(out.chapters.map((r) => r.id)).not.toContain('c3');
  });

  it('leaves out the other acts entirely', () => {
    // The act before it belongs on the rung above, compressed to one paragraph;
    // repeating its chapters here is the flat window the ladder replaces.
    const out = ladder({ chapterId: 'c3', chapters });
    expect(out.chapters.map((r) => r.id)).toEqual(['c1', 'c2']);
  });

  it('names an unsummarised chapter, by its number when it has no title', () => {
    const out = ladder({
      chapterId: 'c3',
      chapters: [{ ...chapters[1]!, summary: null }, chapters[2]!, chapters[3]!],
    });
    expect(out.missing).toContainEqual({ rung: 'chapter', id: 'c1', title: 'Chapter 1' });
  });

  it('treats a book written without acts as one act', () => {
    const flat = chapters.map((c) => ({ ...c, partId: null }));
    const out = ladder({ chapterId: 'c3', chapters: flat, parts: [] });
    expect(out.chapters.map((r) => r.id)).toEqual(['c0', 'c1', 'c2']);
    expect(out.parts).toEqual([]);
  });
});

describe('the book so far', () => {
  const parts = [
    { id: 'p1', rank: 'p1', title: 'Before', summary: 'The first act.' },
    { id: 'p2', rank: 'p2', title: 'During', summary: 'The second act.' },
    { id: 'p3', rank: 'p3', title: 'After', summary: 'The third act.' },
  ];
  const chapters = [
    { id: 'c9', partId: 'p2', rank: 'c9', number: 9, title: null, summary: 'Nine.' },
  ];

  it('is the acts that are finished, and only those', () => {
    // `book.synopsis` would be the obvious column and is never read: it is the
    // pitch for the finished book, so it knows the ending. The top rung is
    // built from acts genuinely behind us instead.
    const out = ladder({ chapterId: 'c9', chapters, parts });
    expect(out.parts.map((r) => r.id)).toEqual(['p1']);
  });

  it('is empty in the first act', () => {
    const out = ladder({
      chapterId: 'c1',
      chapters: [{ id: 'c1', partId: 'p1', rank: 'c1', number: 1, title: null, summary: 'One.' }],
      parts,
    });
    expect(out.parts).toEqual([]);
  });

  it('names an act nobody has summarised', () => {
    const out = ladder({
      chapterId: 'c9', chapters,
      parts: [{ ...parts[0]!, summary: null }, parts[1]!, parts[2]!],
    });
    expect(out.missing).toContainEqual({ rung: 'part', id: 'p1', title: 'Before' });
  });
});

describe('the ranks the real composer produces', () => {
  it('sorts a chapter below its own scenes and above the chapter before it', () => {
    // The claim the whole filter rests on: chapter and part ranks are the same
    // composition with the lower segments left off, so they are literal
    // prefixes and one comparison works at every level.
    const keys = { bookKey: 'a1', partKey: 'a1', chapterKey: 'a2', sceneKey: 'a1' };
    const chapterTwo = globalRank(['a1', 'a1', 'a2']);
    const chapterOneScene = sceneGlobalRank({ ...keys, chapterKey: 'a1' });
    const chapterTwoScene = sceneGlobalRank(keys);

    expect(chapterOneScene < chapterTwo).toBe(true);
    expect(chapterTwo < chapterTwoScene).toBe(true);
  });

  it('builds a ladder against them', () => {
    const at = sceneGlobalRank({ bookKey: 'a1', partKey: 'a2', chapterKey: 'a1', sceneKey: 'a2' });
    const out = continuityLadder({
      atRank: at,
      chapterId: 'here',
      scenes: [{
        id: 'earlier',
        globalRank: sceneGlobalRank({ bookKey: 'a1', partKey: 'a1', chapterKey: 'a9', sceneKey: 'a9' }),
        chapterId: 'gone', title: 'Earlier', summary: 'It happened.', text: 'She left.',
      }],
      chapters: [{
        id: 'here', partId: 'p2', rank: globalRank(['a1', 'a2', 'a1']),
        number: 4, title: null, summary: null,
      }],
      parts: [
        { id: 'p1', rank: globalRank(['a1', 'a1']), title: 'One', summary: 'Act one.' },
        { id: 'p2', rank: globalRank(['a1', 'a2']), title: 'Two', summary: 'Act two.' },
      ],
    });
    expect(out.tail?.text).toBe('She left.');
    expect(out.parts.map((r) => r.id)).toEqual(['p1']);
  });
});

describe('an empty book', () => {
  it('says nothing and complains about nothing', () => {
    const out = ladder({ atRank: 'c1s1', chapterId: 'c1' });
    expect(out).toEqual({ tail: null, scenes: [], chapters: [], parts: [], missing: [] });
  });
});

describe('proseTail on its own', () => {
  it('returns nothing for nothing', () => {
    expect(proseTail('   \n\n  ', 300)).toEqual({ text: '', truncated: false });
  });

  it('keeps the paragraph break between the paragraphs it takes', () => {
    expect(proseTail('one.\n\ntwo.', 300).text).toBe('one.\n\ntwo.');
  });
});
