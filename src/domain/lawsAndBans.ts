/**
 * Step 8 of the scene brief — laws, canon, and the ban list; and 8b, the
 * reference band.
 *
 * [Doc 03](../../docs/03-story-graph-and-context.md): *gather laws whose scope
 * covers this scene, ordered `must` → `should` → `prefer`. Canon laws derived
 * from step 4's facts are appended. Then compute the repetition ban list
 * deterministically from the prose written so far.*
 *
 * **Scope is what keeps the prompt short**, and [doc 04](../../docs/04-laws-engine.md)
 * says why: *the alternative — every rule in every prompt — is exactly the
 * "instruction buried at position 4000 gets dropped" failure.* So a law is in
 * only if its scope names something this scene is: its project, its book, an
 * arc one of its beats belongs to, its chapter, itself, somebody in its working
 * set, or its point of view.
 *
 * **Voice laws scoped to an entity or the POV are not gathered here.** Step 5
 * rendered them inside the dossier of the character they describe, where the
 * model reads them next to that character's facts — and the header there
 * promised this step would not list them again. A voice law at any wider scope
 * is not about one character and is gathered like any other.
 *
 * **Canon laws are the admitted facts restated as constraints, and only the
 * `canon` ones.** Doc 04 defines the category — *derived automatically from
 * the story graph, not typed by hand. "Maren is dead as of chapter 18."
 * Refreshed per brief* — and a dossier fact and a canon law are different
 * things even when the words are the same: one is information the model may
 * draw on, the other is a constraint it may not contradict, and the
 * verification phase checks laws. Certainty finally does its work here: step 3
 * carried `planned` and `speculative` through unfiltered so step 5 could label
 * them, and this is the step that must not turn them into rules. Every canon
 * law's text is already in a dossier; rendering them without paying twice is
 * step 9's decision, which knows the budget.
 *
 * **The ban list reads everything written so far, this scene included.** Doc 12
 * says *all prose written so far*, and the beat-at-a-time rule
 * ([D29](../../docs/10-decisions.md)) makes the current scene's earlier beats
 * exactly that: prose already on the page whose imagery the next beat must not
 * repeat. The scene's own opening is not a *recent opening*, though — the new
 * text continues it rather than beginning after it.
 */

import { buildBanList, type BanList } from '../text/repetition';
import { splitSentences } from '../text/words';
import type { Briefed } from './sceneBrief';
import type { LadderScene } from './continuityLadder';
import type { Candidate, SupplementHit } from './semanticSupplement';

export type LawScope = 'project' | 'book' | 'arc' | 'chapter' | 'scene' | 'entity' | 'pov';
export type Severity = 'must' | 'should' | 'prefer';

/** A `law` row. The repository filters `deleted_at`; `active` is honoured here. */
export interface LawRow {
  id: string;
  scopeType: LawScope;
  scopeId: string | null;
  /** canon | style | voice | structure | content | ip. */
  category: string;
  severity: string;
  title: string;
  ruleText: string;
  examplesGood: string | null;
  examplesBad: string | null;
  /** The hard floor. Not user-editable, and first among equals. */
  isSystem: boolean;
  active: boolean;
  sortKey: string | null;
  /** How the verification phase checks it. Absent reads as `prompt`. */
  checkMode?: string | null;
  checkConfig?: string | null;
}

export interface BriefLaw {
  id: string;
  scopeType: LawScope;
  category: string;
  severity: Severity;
  title: string;
  ruleText: string;
  examplesGood: string | null;
  examplesBad: string | null;
  isSystem: boolean;
  checkMode: string;
  checkConfig: string | null;
}

/** A fact the model may use, restated as a thing it may not contradict. */
export interface CanonLaw {
  factId: string;
  subjectEntityId: string;
  ruleText: string;
  severity: 'must';
}

export interface Laws {
  /** `must` first, then `should`, then `prefer`; the hard floor first within each. */
  laws: BriefLaw[];
  canon: CanonLaw[];
  bans: BanList;
}

export interface LawsInput {
  briefed: Briefed;
  bookId: string;
  chapterId: string;
  laws: readonly LawRow[];
  /** Scenes of the book, with prose. Anything at or after the scene is ignored. */
  scenes: readonly LadderScene[];
  /** What this scene already says, when the writer is part-way through it. */
  currentText?: string | null;
}

const SEVERITY_RANK: Record<Severity, number> = { must: 0, should: 1, prefer: 2 };

/** Forward-compatible in the safe direction: an unknown severity binds least. */
const asSeverity = (raw: string): Severity =>
  (raw in SEVERITY_RANK ? raw : 'prefer') as Severity;

export function gatherLaws(input: LawsInput): Laws {
  const { briefed } = input;
  const working = new Set([
    ...briefed.cast.map((e) => e.entityId),
    ...briefed.setting.map((e) => e.entityId),
  ]);
  const arcs = new Set(briefed.beats.map((b) => b.arcId));
  const pov = briefed.scene.povEntityId;

  const covers = (law: LawRow): boolean => {
    switch (law.scopeType) {
      case 'project': return true;
      case 'book': return law.scopeId === input.bookId;
      case 'arc': return law.scopeId !== null && arcs.has(law.scopeId);
      case 'chapter': return law.scopeId === input.chapterId;
      case 'scene': return law.scopeId === briefed.scene.id;
      case 'entity': return law.scopeId !== null && working.has(law.scopeId);
      case 'pov': return pov !== null && law.scopeId === pov;
      default: return false;
    }
  };

  const laws = input.laws
    .filter((l) => l.active && covers(l))
    // Step 5's, already in the dossier.
    .filter((l) => !(l.category === 'voice' && (l.scopeType === 'entity' || l.scopeType === 'pov')))
    .map((l) => ({
      key: l.sortKey ?? '',
      law: {
        id: l.id, scopeType: l.scopeType, category: l.category,
        severity: asSeverity(l.severity), title: l.title, ruleText: l.ruleText,
        examplesGood: l.examplesGood, examplesBad: l.examplesBad, isSystem: l.isSystem,
        checkMode: l.checkMode ?? 'prompt', checkConfig: l.checkConfig ?? null,
      } satisfies BriefLaw,
    }))
    .sort((a, b) =>
      SEVERITY_RANK[a.law.severity] - SEVERITY_RANK[b.law.severity]
      || Number(b.law.isSystem) - Number(a.law.isSystem)
      || a.key.localeCompare(b.key)
      || a.law.title.localeCompare(b.law.title, 'en')
      || a.law.id.localeCompare(b.law.id))
    .map(({ law }) => law);

  const canon: CanonLaw[] = briefed.facts
    .filter((f) => f.certainty === 'canon')
    .map((f) => ({
      factId: f.factId, subjectEntityId: f.subjectEntityId,
      ruleText: f.statement, severity: 'must',
    }));

  const written = input.scenes
    .filter((s) => s.globalRank < briefed.scene.globalRank && s.text?.trim())
    .sort((a, b) => (a.globalRank < b.globalRank ? -1 : a.globalRank > b.globalRank ? 1 : 0));
  const prose = [...written.map((s) => s.text as string), input.currentText ?? '']
    .filter((t) => t.trim()).join('\n\n');
  const bans = buildBanList(prose, {
    // Most recent last, as `buildBanList` expects; it applies the cap itself.
    recentOpenings: written
      .map((s) => splitSentences(s.text as string)[0])
      .filter((o): o is string => Boolean(o)),
  });

  return { laws, canon, bans };
}

/* ------------------------------------------------------ 8b: reference band */

/**
 * Doc 03 §8b: *imported source material is retrieved into its own slice, whose
 * budget is reserved before canon sections so it cannot be crowded out, and
 * labelled unmistakably as background rather than canon.*
 *
 * The mirror of step 7's band rule and none of its others. Reference material is
 * not in the book, so there is nothing to be behind the reader and no spoiler
 * filter to have rejected it; the only questions are the band, the best chunk
 * per source, and how many. It grounds the writing; it never becomes part of the
 * world, and it never appears in an export — that last one is the exporter's
 * promise, kept there.
 */
export function referenceBand(candidates: readonly Candidate[], limit = 3): SupplementHit[] {
  const best = new Map<string, Candidate>();
  for (const c of candidates) {
    if (c.band !== 'reference') continue;
    const key = `${c.ownerTable}:${c.ownerId}`;
    const held = best.get(key);
    if (!held || c.score > held.score) best.set(key, c);
  }
  return [...best.values()]
    .sort((a, b) =>
      b.score - a.score
      || a.ownerTable.localeCompare(b.ownerTable)
      || a.ownerId.localeCompare(b.ownerId))
    .slice(0, limit)
    .map((c) => ({
      ownerTable: c.ownerTable, ownerId: c.ownerId,
      title: c.title, text: c.text, score: c.score,
    }));
}
