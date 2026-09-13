import { describe, it, expect } from 'vitest';
import { findGaps, summariseGaps, type GapInput } from './gapFinder';

const empty: GapInput = {
  entities: [], aliases: [], scenes: [], chapters: [],
  beats: [], arcs: [], threads: [], references: [],
};

const input = (over: Partial<GapInput>): GapInput => ({ ...empty, ...over });

describe('gap finder', () => {
  it('finds nothing in an empty project rather than inventing work', () => {
    expect(findGaps(empty)).toEqual([]);
  });

  it('flags a name with no matching entity, and accepts one matched by alias', () => {
    const gaps = findGaps(input({
      entities: [{ id: 'e1', name: 'Kaelen', typeKey: 'character', summary: 'A smith.' }],
      aliases: [{ entityId: 'e1', alias: 'The Grey Warden' }],
      references: [
        { ownerTable: 'fact', ownerId: 'f1', ownerName: 'A fact', field: 'subject', name: 'Kaelen' },
        { ownerTable: 'fact', ownerId: 'f2', ownerName: 'Another', field: 'subject', name: 'the grey warden' },
        { ownerTable: 'fact', ownerId: 'f3', ownerName: 'A third', field: 'subject', name: 'Bren' },
      ],
    }));
    expect(gaps.filter((g) => g.type === 'dangling_reference')).toHaveLength(1);
    expect(gaps[0]!.message).toContain('Bren');
    expect(gaps[0]!.severity).toBe('error');
    // The row has to be click-to-openable, per §8.
    expect(gaps[0]!.target).toEqual({ table: 'fact', id: 'f3' });
  });

  it('flags a beat aimed at a chapter that does not exist', () => {
    const gaps = findGaps(input({
      chapters: [{ id: 'c1', number: 1 }, { id: 'c2', number: 2 }],
      beats: [
        { id: 'b1', title: 'The betrayal', targetChapterNumber: 2, sceneIds: ['s1'] },
        { id: 'b2', title: 'The reveal', targetChapterNumber: 40, sceneIds: ['s1'] },
      ],
    }));
    const out = gaps.filter((g) => g.type === 'out_of_range_reference');
    expect(out).toHaveLength(1);
    expect(out[0]!.entityName).toBe('The reveal');
  });

  it('flags threads and arcs the manuscript has passed without resolving', () => {
    const scenes = [
      { id: 's1', globalRank: '001' },
      { id: 's2', globalRank: '002' },
      { id: 's3', globalRank: '003' },
    ];
    const gaps = findGaps(input({
      scenes,
      currentSceneId: 's2',
      threads: [
        { id: 't1', name: 'The missing blade', kind: 'promise', resolvesBySceneId: 's1' }, // past, open
        { id: 't2', name: 'The locked door', kind: 'question', resolvesBySceneId: 's3' },  // still ahead
        { id: 't3', name: 'The debt', kind: 'promise', resolvesBySceneId: 's1', resolvedAtSceneId: 's1' },
      ],
      arcs: [
        { id: 'a1', name: 'Kaelen redeemed', resolvesAtSceneId: 's1' },                    // past, open
        { id: 'a2', name: 'The siege', resolvesAtSceneId: 's3' },                          // ahead
        { id: 'a3', name: 'The feud', resolvesAtSceneId: 's1', resolved: true },
      ],
    }));
    expect(gaps.filter((g) => g.type === 'unresolved_thread').map((g) => g.entityName))
      .toEqual(['The missing blade']);
    expect(gaps.filter((g) => g.type === 'unresolved_arc').map((g) => g.entityName))
      .toEqual(['Kaelen redeemed']);
  });

  it('says nothing about resolution points when the manuscript position is unknown', () => {
    const gaps = findGaps(input({
      scenes: [{ id: 's1', globalRank: '001' }],
      threads: [{ id: 't1', name: 'Open', kind: 'promise', resolvesBySceneId: 's1' }],
    }));
    expect(gaps).toEqual([]);
  });

  it('flags a thin entity but leaves background characters alone', () => {
    const gaps = findGaps(input({
      entities: [
        { id: 'e1', name: 'Kaelen', typeKey: 'character', summary: 'A smith.', importance: 'protagonist' },
        { id: 'e2', name: 'Bren', typeKey: 'character', summary: '', importance: 'major' },
        { id: 'e3', name: 'Innkeeper', typeKey: 'character', importance: 'background' },
      ],
    }));
    const thin = gaps.filter((g) => g.type === 'thin_entity');
    expect(thin.map((g) => g.entityName)).toEqual(['Bren']);
  });

  it('flags a speaking character with no voice profile', () => {
    const gaps = findGaps(input({
      entities: [
        { id: 'e1', name: 'Kaelen', typeKey: 'character', summary: 'A smith.', speaks: true },
        { id: 'e2', name: 'Bren', typeKey: 'character', summary: 'A guard.', speaks: true, voiceProfile: 'Clipped.' },
        { id: 'e3', name: 'The forge', typeKey: 'location', summary: 'Hot.' },
      ],
    }));
    expect(gaps.filter((g) => g.type === 'missing_voice_profile').map((g) => g.entityName))
      .toEqual(['Kaelen']);
  });

  it('treats an unwritten scene as unwritten, not orphaned', () => {
    const gaps = findGaps(input({
      scenes: [
        { id: 's1', title: 'Written, no beat', globalRank: '001', wordCount: 900 },
        { id: 's2', title: 'Planned only', globalRank: '002', wordCount: 0 },
        { id: 's3', title: 'Serves a beat', globalRank: '003', wordCount: 800 },
      ],
      beats: [{ id: 'b1', title: 'The betrayal', sceneIds: ['s3'] }],
    }));
    expect(gaps.filter((g) => g.type === 'orphan_scene').map((g) => g.entityName))
      .toEqual(['Written, no beat']);
  });

  it('flags a beat no scene realises', () => {
    const gaps = findGaps(input({
      beats: [
        { id: 'b1', title: 'Realised', sceneIds: ['s1'] },
        { id: 'b2', title: 'Unrealised', sceneIds: [] },
      ],
    }));
    expect(gaps.filter((g) => g.type === 'unrealised_beat').map((g) => g.entityName))
      .toEqual(['Unrealised']);
  });

  it('sorts errors first so the list is triageable', () => {
    const gaps = findGaps(input({
      entities: [{ id: 'e1', name: 'Bren', typeKey: 'character', summary: '' }],
      beats: [{ id: 'b1', title: 'Nothing realises me', sceneIds: [] }],
      references: [{ ownerTable: 'fact', ownerId: 'f1', ownerName: 'A fact', field: 'subject', name: 'Nobody' }],
    }));
    expect(gaps.map((g) => g.severity)).toEqual(['error', 'warning', 'info']);
    expect(summariseGaps(gaps)).toEqual({ error: 1, warning: 1, info: 1 });
  });

  it('gives every gap a stable id, so a dismissal can persist', () => {
    const build = () => findGaps(input({
      beats: [{ id: 'b1', title: 'Unrealised', sceneIds: [] }],
    }));
    expect(build()[0]!.id).toBe(build()[0]!.id);
    expect(new Set(build().map((g) => g.id)).size).toBe(build().length);
  });
});
