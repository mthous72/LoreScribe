import { describe, it, expect } from 'vitest';
import { entityLinksFrom } from './entityLink';

/**
 * Reading explicit links back out of a stored document.
 *
 * The offsets are the risky part: a mention's start and end are only useful if
 * they point into the same string as `content_text`, which is what the editor's
 * `getText()` produced. Off-by-one here puts a highlight on the wrong word —
 * quietly, and further from the truth the longer the scene gets.
 */

const text = (t: string) => ({ type: 'text', text: t });
const linked = (t: string, entityId: string | null) => ({
  type: 'text', text: t, marks: [{ type: 'entityLink', attrs: { entityId } }],
});
const para = (...content: unknown[]) => ({ type: 'paragraph', content });
const doc = (...content: unknown[]) => JSON.stringify({ type: 'doc', content });

/** The same string getText() builds: text nodes joined, a newline per block. */
function plain(json: string): string {
  const d = JSON.parse(json) as { content?: { content?: { text?: string }[] }[] };
  return (d.content ?? [])
    .map((block) => (block.content ?? []).map((n) => n.text ?? '').join(''))
    .join('\n');
}

describe('finding links', () => {
  it('returns the entity, the words, and where they are', () => {
    const json = doc(para(text('The '), linked('Rhys', 'e1'), text(' left.')));
    const [link] = entityLinksFrom(json);
    expect(link).toEqual({ entityId: 'e1', text: 'Rhys', start: 4, end: 8 });
    // The offsets index the same string content_text holds.
    expect(plain(json).slice(link!.start, link!.end)).toBe('Rhys');
  });

  it('counts the newline between blocks, as getText() does', () => {
    const json = doc(
      para(text('First line.')),
      para(text('Then '), linked('Ilva', 'e1'), text('.')),
    );
    const [link] = entityLinksFrom(json);
    expect(plain(json).slice(link!.start, link!.end)).toBe('Ilva');
    expect(plain(json)).toBe('First line.\nThen Ilva.');
  });

  it('finds several links across several blocks', () => {
    const json = doc(
      para(linked('Ilva', 'e1'), text(' waited.')),
      para(text('The '), linked('Long Hall', 'e2'), text(' emptied.')),
    );
    const links = entityLinksFrom(json);
    expect(links.map((l) => [l.entityId, l.text])).toEqual([['e1', 'Ilva'], ['e2', 'Long Hall']]);
    for (const l of links) expect(plain(json).slice(l.start, l.end)).toBe(l.text);
  });

  it('merges adjacent runs of one link into a single mention', () => {
    // Typing through a link, or an inline style inside it, splits the text node.
    // Two rows pointing at halves of one name would be wrong twice over.
    const json = doc(para(linked('Ilva', 'e1'), linked(' Renn', 'e1'), text('.')));
    expect(entityLinksFrom(json)).toEqual([
      { entityId: 'e1', text: 'Ilva Renn', start: 0, end: 9 },
    ]);
  });

  it('does not merge two different entities that happen to touch', () => {
    const json = doc(para(linked('Ilva', 'e1'), linked('Renn', 'e2')));
    expect(entityLinksFrom(json).map((l) => l.entityId)).toEqual(['e1', 'e2']);
  });

  it('ignores unlinked text and a link with no entity', () => {
    expect(entityLinksFrom(doc(para(text('Nothing linked here.'))))).toEqual([]);
    // A mark left behind by a deleted entity points at nothing and must not
    // produce a mention against a null id.
    expect(entityLinksFrom(doc(para(linked('Ilva', null))))).toEqual([]);
  });

  it('never throws on a document it cannot read', () => {
    for (const junk of [null, undefined, '', '{ not json', '{}', '[]', '{"content":null}']) {
      expect(() => entityLinksFrom(junk), JSON.stringify(junk)).not.toThrow();
      expect(entityLinksFrom(junk)).toEqual([]);
    }
  });

  it('looks inside nested blocks', () => {
    const json = JSON.stringify({
      type: 'doc',
      content: [{
        type: 'blockquote',
        content: [{ type: 'paragraph', content: [text('She said '), linked('Ilva', 'e1')] }],
      }],
    });
    expect(entityLinksFrom(json).map((l) => l.entityId)).toEqual(['e1']);
  });
});
