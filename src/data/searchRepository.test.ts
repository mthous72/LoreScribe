import { describe, it, expect, beforeEach } from 'vitest';
import { NodeSqlDriver } from '../db/nodeDriver';
import { SearchRepository } from './searchRepository';
import { ManuscriptRepository } from './manuscriptRepository';
import { CodexRepository } from './codexRepository';
import { rebuildKind } from '../index/rebuild';

/**
 * Search, against the real db/schema.sql and the real indexes.
 *
 * Nothing here builds an index. The prose goes in through `saveSceneContent`
 * and the codex through `CodexRepository`, exactly as the app writes them, so a
 * passing test means the indexes the app actually maintains are the ones being
 * searched.
 */

const PROJECT = 'p1';
const OTHER = 'p2';
let driver: NodeSqlDriver;
let search: SearchRepository;
let manuscript: ManuscriptRepository;
let codex: CodexRepository;

const text = (hit: { snippet: { text: string }[] }) => hit.snippet.map((r) => r.text).join('');

beforeEach(async () => {
  driver = await NodeSqlDriver.open();
  search = new SearchRepository(driver);
  manuscript = new ManuscriptRepository(driver);
  codex = new CodexRepository(driver);
  for (const id of [PROJECT, OTHER]) {
    await driver.query('INSERT INTO project (id,title,created_at,updated_at) VALUES (?,?,?,?)',
      [id, `Project ${id}`, 1, 1], 'run');
  }
});

async function scene(projectId: string, chapterTitle: string, title: string, prose: string) {
  const book = await manuscript.createBook(projectId, 'One');
  const chapter = await manuscript.createChapter(book.id, chapterTitle);
  const s = await manuscript.createScene(chapter.id, title);
  await manuscript.saveSceneContent(s.id, { contentText: prose });
  return s;
}

describe('searching the manuscript', () => {
  it('finds a scene by its prose, with the hit marked in a snippet', async () => {
    const s = await scene(PROJECT, 'First', 'Arrival',
      'The council met at dawn and the warden did not answer them.');

    const { hits } = await search.search(PROJECT, 'warden');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: 'scene', id: s.id, title: 'Arrival', context: 'First' });
    expect(hits[0]!.snippet.some((r) => r.hit && /warden/i.test(r.text))).toBe(true);
    expect(text(hits[0]!)).toContain('did not answer');
  });

  it('finds a scene by its title', async () => {
    await scene(PROJECT, 'First', 'The Long Hall', 'Nothing relevant here.');
    expect((await search.search(PROJECT, 'hall')).hits.map((h) => h.title))
      .toEqual(['The Long Hall']);
  });

  it('requires every word, not any of them', async () => {
    await scene(PROJECT, 'First', 'A', 'the warden waited');
    await scene(PROJECT, 'First', 'B', 'the dragon waited');
    expect((await search.search(PROJECT, 'warden dragon')).hits).toEqual([]);
    expect((await search.search(PROJECT, 'warden waited')).hits.map((h) => h.title))
      .toEqual(['A']);
  });

  it('matches the last word as a prefix while it is still being typed', async () => {
    await scene(PROJECT, 'First', 'A', 'the warden waited');
    expect((await search.search(PROJECT, 'ward', { prefix: true })).hits).toHaveLength(1);
    expect((await search.search(PROJECT, 'ward', { prefix: false })).hits).toEqual([]);
  });

  it('follows the prose when it is rewritten', async () => {
    const s = await scene(PROJECT, 'First', 'Arrival', 'The council met at dawn.');
    expect((await search.search(PROJECT, 'council')).hits).toHaveLength(1);

    await manuscript.saveSceneContent(s.id, { contentText: 'The hall stood empty.' });
    // Stale hits are worse than none: they send a writer to prose that is gone.
    expect((await search.search(PROJECT, 'council')).hits).toEqual([]);
    expect((await search.search(PROJECT, 'empty')).hits).toHaveLength(1);
  });

  it('drops a deleted scene', async () => {
    const s = await scene(PROJECT, 'First', 'Arrival', 'The council met at dawn.');
    await manuscript.removeScene(s.id);
    expect((await search.search(PROJECT, 'council')).hits).toEqual([]);
  });
});

describe('searching the codex', () => {
  it('finds an entity the moment it is created, with no rebuild', async () => {
    // This failed when it was first written. Prose reached the search index on
    // every save and an entity reached it only when somebody ran a wholesale
    // rebuild — so creating a character and immediately failing to find it was
    // the index lying about what the book contains.
    await codex.createEntity(PROJECT, { name: 'Ilva', description: 'A courier who reads.' });
    expect((await search.search(PROJECT, 'courier')).hits.map((h) => h.title)).toEqual(['Ilva']);
  });

  it('follows a rename and a description edit', async () => {
    const ilva = await codex.createEntity(PROJECT, { name: 'Ilva', description: 'A courier.' });
    await codex.updateEntity(ilva.id, { name: 'Ilva Renn', description: 'A courier who reads.' });

    expect((await search.search(PROJECT, 'Ilva')).hits.map((h) => h.title)).toEqual(['Ilva Renn']);
    expect((await search.search(PROJECT, 'reads')).hits).toHaveLength(1);
    // The old text is gone, not merely joined by the new.
    expect((await search.search(PROJECT, 'courier')).hits).toHaveLength(1);
  });

  it('drops a deleted entity from search', async () => {
    const ilva = await codex.createEntity(PROJECT, { name: 'Ilva', description: 'A courier.' });
    await codex.removeEntity(ilva.id);
    expect((await search.search(PROJECT, 'courier')).hits).toEqual([]);
  });

  it('is restored, not changed, by a wholesale rebuild', async () => {
    // The write path and the rebuild share one definition of what text
    // represents an entity. If they ever disagree, a rebuild would silently
    // alter what search can find.
    await codex.createEntity(PROJECT, { name: 'Ilva', description: 'A courier who reads.' });
    const before = (await search.search(PROJECT, 'courier')).hits;
    await rebuildKind(driver, PROJECT, 'fts');
    expect((await search.search(PROJECT, 'courier')).hits).toEqual(before);
  });

  it('finds an entity by name and by description', async () => {
    await codex.createEntity(PROJECT, { name: 'Ilva', description: 'A courier who reads.' });
    await rebuildKind(driver, PROJECT, 'fts');

    expect((await search.search(PROJECT, 'Ilva')).hits[0])
      .toMatchObject({ kind: 'entity', title: 'Ilva', context: 'Codex entry' });
    expect((await search.search(PROJECT, 'courier')).hits.map((h) => h.title)).toEqual(['Ilva']);
  });

  it('returns scenes and codex entries in one ranked list', async () => {
    await scene(PROJECT, 'First', 'Arrival', 'The warden crossed the yard.');
    await codex.createEntity(PROJECT, { name: 'The Warden', description: 'Ilva, after chapter ten.' });
    await rebuildKind(driver, PROJECT, 'fts');

    const { hits } = await search.search(PROJECT, 'warden');
    expect(hits).toHaveLength(2);
    // A name outranks a body mention: someone searching "warden" who has a
    // character called The Warden means the character.
    expect(hits[0]).toMatchObject({ kind: 'entity', title: 'The Warden' });
    expect(hits[1]).toMatchObject({ kind: 'scene' });
  });
});

describe('scoping', () => {
  it('never returns another project’s work', async () => {
    await scene(OTHER, 'First', 'Not yours', 'The warden waited here too.');
    await codex.createEntity(OTHER, { name: 'The Warden' });
    await rebuildKind(driver, OTHER, 'fts');
    await scene(PROJECT, 'First', 'Yours', 'The warden waited.');

    const { hits } = await search.search(PROJECT, 'warden');
    expect(hits.map((h) => h.title)).toEqual(['Yours']);
  });
});

describe('what a writer actually types', () => {
  it('does not throw on punctuation, operators or an empty box', async () => {
    await scene(PROJECT, 'First', 'Arrival', "The warden didn't answer.");
    for (const input of ['', '   ', "don't", '-warden', 'a AND', '"unclosed', '*', '((', 'a:b']) {
      await expect(search.search(PROJECT, input), JSON.stringify(input)).resolves.toBeDefined();
    }
  });

  it('reports an empty query as no query rather than no results', async () => {
    // The distinction matters to the UI: one says "type something", the other
    // says "nothing matches", and showing the wrong one is a small lie.
    const empty = await search.search(PROJECT, '   ');
    expect(empty.expression).toBeNull();
    expect(empty.hits).toEqual([]);

    await scene(PROJECT, 'First', 'Arrival', 'Nothing here.');
    const missed = await search.search(PROJECT, 'dragon');
    expect(missed.expression).not.toBeNull();
    expect(missed.hits).toEqual([]);
  });

  it('finds a phrase in order when it is quoted', async () => {
    await scene(PROJECT, 'First', 'A', 'the long hall was empty');
    await scene(PROJECT, 'First', 'B', 'the hall was long');
    expect((await search.search(PROJECT, '"long hall"')).hits.map((h) => h.title)).toEqual(['A']);
  });
});
