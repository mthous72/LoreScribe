/**
 * What a fact is, at a given point in the book — [doc 03 §§3–4](../../docs/03-story-graph-and-context.md).
 *
 * This is the rule the whole temporal model exists to support, and the one the
 * scene brief compiler will run on every fact of every entity in Phase 2. It is
 * pure and lives here rather than in a query so it can be tested exhaustively
 * and so there is exactly one statement of it: a spoiler rule implemented twice
 * is a spoiler rule that disagrees with itself, and the failure mode is telling
 * a reader something the book has not told them yet.
 *
 * Ranks are `scene.global_rank` strings, compared lexicographically — which is
 * what that encoding is for. A `null` established rank means "true from the
 * beginning", the same convention the column uses for backstory.
 */

export interface FactForVisibility {
  id: string;
  /** When it becomes true in the world. Null = always was. */
  establishedRank: string | null;
  /** When the reader learns it. Null = never stated on the page. */
  revealedRank: string | null;
  /** When it stops being true. Null = still true. */
  invalidatedRank: string | null;
  /** The fact this one replaces, if any. */
  supersedesFactId: string | null;
  /** The reader knows; the characters do not. An override, never an accident. */
  isDramaticIrony: boolean;
  /** 0–3. How damaging early exposure would be. */
  spoilerWeight: number;
  /**
   * Rank at which each entity learned it, keyed by entity id.
   *
   * A present key with a null value means they know it without a scene to
   * point at — backstory knowledge, the same reading `establishedRank` gives a
   * null. An absent key means they do not know.
   */
  knownFrom?: Record<string, string | null>;
}

export type FactStatus =
  /** The reader has been told. Safe to use freely. */
  | 'reader-knows'
  /** Reader knows, characters do not — the explicit irony flag. */
  | 'dramatic-irony'
  /** The POV character knows it; the reader does not. Usable, but labelled. */
  | 'pov-knows'
  /** True and not yet told. The thing a spoiler rule exists to withhold. */
  | 'withheld'
  /** Not true yet at this point in the book. */
  | 'not-yet-established'
  /** Was true, no longer is. */
  | 'invalidated'
  /** Replaced by a later fact that is active here. */
  | 'superseded';

export interface FactVisibility {
  status: FactStatus;
  /** May this fact be used when writing at this point? */
  include: boolean;
}

/**
 * Which `fact_knowledge.belief` values mean the character has the fact in mind.
 *
 * The one statement of it. `believes_false` and `denies` are not knowledge —
 * counting them would let the spoiler rule reveal a fact to a character who
 * has been lied to about it. `suspects` counts: a character can act on a
 * suspicion, and the brief labels it as one so the model does not write it as
 * settled. The facts page, the fixture and the compiler all read this list,
 * because two lists would eventually disagree about who knows what.
 */
export const KNOWING_BELIEFS: readonly string[] = ['knows', 'suspects'];
export const isKnowing = (belief: string): boolean => KNOWING_BELIEFS.includes(belief);

const atOrBefore = (rank: string | null, at: string): boolean => rank === null || rank <= at;

/**
 * Judge every fact at one point in the manuscript.
 *
 * Takes the whole list rather than one fact because supersession is a relation:
 * whether A is dead depends on whether some B that replaces it is alive here.
 */
export function factVisibilityAt(
  facts: readonly FactForVisibility[],
  atRank: string,
  options: { povEntityId?: string | null } = {},
): Map<string, FactVisibility> {
  /** True while the world holds it — before the spoiler question is asked. */
  const activeInWorld = (f: FactForVisibility) =>
    atOrBefore(f.establishedRank, atRank)
    && (f.invalidatedRank === null || f.invalidatedRank > atRank);

  // A fact is superseded only by a replacement that is itself active here.
  // Otherwise a revision written for chapter 30 would silently delete the
  // original from every scene before it.
  const supersededIds = new Set(
    facts.filter((f) => f.supersedesFactId && activeInWorld(f))
      .map((f) => f.supersedesFactId as string),
  );

  const out = new Map<string, FactVisibility>();
  for (const fact of facts) {
    const say = (status: FactStatus, include: boolean) => {
      out.set(fact.id, { status, include });
    };

    // Step 3, the temporal filter. None of these are spoilers; they are simply
    // not the case here.
    if (!atOrBefore(fact.establishedRank, atRank)) { say('not-yet-established', false); continue; }
    if (fact.invalidatedRank !== null && fact.invalidatedRank <= atRank) {
      say('invalidated', false);
      continue;
    }
    if (supersededIds.has(fact.id)) { say('superseded', false); continue; }

    // Step 4, the spoiler filter, in the order doc 03 gives.
    if (fact.revealedRank !== null && fact.revealedRank <= atRank) {
      say('reader-knows', true);
      continue;
    }
    if (fact.isDramaticIrony) { say('dramatic-irony', true); continue; }

    const pov = options.povEntityId;
    if (pov && fact.knownFrom && pov in fact.knownFrom
      && atOrBefore(fact.knownFrom[pov] ?? null, atRank)) {
      // Usable, but the caller must label it: the POV character may act on
      // this, and the narration may not state it.
      say('pov-knows', true);
      continue;
    }

    say('withheld', false);
  }
  return out;
}

/**
 * The facts to name as forbidden — doc 03 §4's negative constraints block.
 *
 * "Silence is not enough; models confabulate into gaps." So the dangerous
 * exclusions are listed explicitly as things not to reveal, hint at or
 * foreshadow.
 *
 * **This is deliberately broader than doc 03 §4 says, and the difference is
 * worth a decision.** The document derives negative constraints from the
 * spoiler filter alone, so a fact excluded one step earlier — because it is not
 * true *yet* — never becomes a constraint. That leaves the most dangerous case
 * uncovered: a revelation that becomes true in chapter thirty, weight 3, is
 * exactly the thing not to foreshadow in chapter five, and under the narrow
 * reading nothing would stop a model doing so. Any excluded fact heavy enough
 * to matter is named here instead.
 */
export function negativeConstraints(
  facts: readonly FactForVisibility[],
  visibility: Map<string, FactVisibility>,
  minimumWeight = 2,
): FactForVisibility[] {
  return facts.filter((f) => {
    const seen = visibility.get(f.id);
    if (!seen || seen.include) return false;
    // A fact that stopped being true, or was replaced, is not a secret — it is
    // merely wrong. Naming it as forbidden would waste the budget doc 03 is
    // careful about and tell a model about a thing it had no reason to mention.
    if (seen.status === 'invalidated' || seen.status === 'superseded') return false;
    return f.spoilerWeight >= minimumWeight;
  });
}

/**
 * Continuity problems a mechanical check can find — doc 02 §"setup / payoff".
 *
 * Not opinions about the story. Each of these is a statement the record makes
 * about itself that cannot be true.
 */
export interface ContinuityProblem {
  factId: string;
  kind: 'revealed-before-established' | 'invalidated-before-established' | 'never-revealed';
  detail: string;
}

export function continuityProblems(facts: readonly FactForVisibility[]): ContinuityProblem[] {
  const problems: ContinuityProblem[] = [];
  for (const f of facts) {
    if (f.establishedRank && f.revealedRank && f.revealedRank < f.establishedRank) {
      problems.push({
        factId: f.id,
        kind: 'revealed-before-established',
        detail: 'The reader is told this before it becomes true.',
      });
    }
    if (f.establishedRank && f.invalidatedRank && f.invalidatedRank < f.establishedRank) {
      problems.push({
        factId: f.id,
        kind: 'invalidated-before-established',
        detail: 'This stops being true before it starts.',
      });
    }
    // An unfired Chekhov's gun: worth surfacing, never worth blocking on, since
    // a fact the reader never learns is a perfectly ordinary thing to have.
    if (f.revealedRank === null && f.spoilerWeight >= 2) {
      problems.push({
        factId: f.id,
        kind: 'never-revealed',
        detail: 'Set up as a significant secret, but never revealed to the reader.',
      });
    }
  }
  return problems;
}
