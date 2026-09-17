import { describe, it, expect } from 'vitest';
import { filterModels, isFree } from './modelFilter';
import type { ModelInfo } from './provider';

const model = (id: string, over: Partial<ModelInfo>): ModelInfo => ({
  id, name: id, contextWindow: 8000, costInPerMtok: 1, costOutPerMtok: 2, moderated: false,
  supportsTools: false, supportsJsonSchema: false, ...over,
});
const models = [
  model('paid', {}),
  model('free', { costInPerMtok: 0, costOutPerMtok: 0 }),
  model('free-moderated', { costInPerMtok: 0, costOutPerMtok: 0, moderated: true }),
  model('unpriced', { costInPerMtok: null, costOutPerMtok: null }),
  model('half', { costInPerMtok: 0, costOutPerMtok: 3 }),
  model('moderated', { moderated: true }),
];

describe('model filters', () => {
  it('free means nothing in and nothing out; unpriced is not free', () => {
    expect(models.filter(isFree).map((m) => m.id)).toEqual(['free', 'free-moderated']);
  });
  it('compose, and with nothing on return everything', () => {
    const ids = (f: { free: boolean; uncensored: boolean }) => filterModels(models, f).map((m) => m.id);
    expect(ids({ free: false, uncensored: false })).toHaveLength(6);
    expect(ids({ free: true, uncensored: false })).toEqual(['free', 'free-moderated']);
    expect(ids({ free: false, uncensored: true })).toEqual(['paid', 'free', 'unpriced', 'half']);
    expect(ids({ free: true, uncensored: true })).toEqual(['free']);
  });
});
