/**
 * Extraction — a model reads a bible file and proposes what is in it.
 *
 * [Doc 08](../../docs/08-roadmap.md) called this Phase 2's extraction lane and
 * said where it lands: *the same two tables and the same review screen* as the
 * rule-based import, so a writer confirms a model's proposal exactly the way
 * they confirm a rule's. This file is the pure half: what the model is asked,
 * how its answer is read, and how each item becomes a proposal the stager
 * already knows how to apply.
 *
 * Three commitments, because they are what make this a review and not a dump:
 *
 * - **Every item cites the file, and is written for the codex.** The model
 *   quotes the words an item rests on — the quote is held against the text
 *   ([doc 12 §3](../../docs/12-algorithms.md)), and an item whose quote is not
 *   there is *unverified*: staged, shown, never accepted by default, because
 *   small models invent characters with confidence. But the entry itself is
 *   the model's writing, not a copy: a summary and a description in clean
 *   present-tense prose that fit a bible entry, the type's own attribute
 *   fields filled from what the file says, facts as one clear sentence each,
 *   rules as instructions. A model call that only copied would be a worse
 *   version of the rule-based lane; the point of paying for one is the
 *   rewrite. The quote is what keeps the rewrite honest.
 * - **What has no home is recommended, not dropped.** The model chooses from
 *   the entity types this project has; when nothing fits, it may name a new
 *   one, and that becomes a *recommendation* — add the type and file these
 *   entries there, or file them under a type that exists — with the entries
 *   held until the writer decides. The same for an attribute the type's editor
 *   has no field for, and for anything the file establishes that fits none of
 *   the shapes offered: a timeline, a language's rules, a theme. A bible is
 *   wider than any schema, and a model that has read the file is the right
 *   thing to say where the schema falls short.
 * - **An existing entry is an update, not a twin.** A name or alias already in
 *   the codex marks the proposal `update`; the apply path already merges by
 *   name, so this is a label for the reviewer rather than a second mechanism.
 *
 * Plans and scenes stay with the rules: an outline's structure is read exactly
 * by the outline reader, and prose is prose. The model is for the parts a rule
 * cannot read — who somebody is, what is true, what the writer's rules are.
 */

import { locateQuote } from './evidence';
import { countWords } from '../text/words';
import { subtreeText, type SourceDoc, type SourceNode } from '../import/source';
import type { ExistingEntity } from '../import/plan';

export interface ExtractTypes {
  /** Type keys this project has, with a label and the attribute fields the model may fill. */
  types: { key: string; label: string; attributes?: string[] }[];
  /** Normalised name or alias to the entity it belongs to. */
  existing: Map<string, ExistingEntity>;
}

/** A row for `proposal`, ready to stage. The same shapes the rule-based stager writes. */
export interface Extracted {
  table: 'entity' | 'entity_alias' | 'relationship' | 'fact' | 'fact_knowledge' | 'law' | 'note';
  op: 'new' | 'update';
  payload: Record<string, unknown>;
  /** Why, in the writer's terms: the file and what the model said. */
  rationale: string;
  /** 0–1. The model's own, clipped. */
  confidence: number;
  /** The words the model pointed to, as the file has them when located. */
  evidenceQuote: string | null;
  evidenceVerified: boolean;
}

/**
 * Where the schema fell short of the file, with what to do about it in reach.
 *
 * - `new_type`: entries the model filed under a type the project lacks, held
 *   with the type's proposed key and label. Add the type and stage them, or
 *   file them under a type that exists.
 * - `new_field`: an attribute the model filled that the type's editor has no
 *   field for. The value is kept on the entry either way; adding the field
 *   makes it visible and editable.
 * - `unplaced`: something the file establishes that belongs in a bible but
 *   fits none of the shapes offered. Keep it as a note, or not.
 */
export type Recommendation =
  | {
    kind: 'new_type';
    /** A key in the codex's form, from the model's word. */
    typeKey: string;
    label: string;
    names: string[];
    /** The entity and alias proposals waiting on the decision, typed with `typeKey`. */
    held: Extracted[];
    why: string;
  }
  | { kind: 'new_field'; typeKey: string; field: string; names: string[] }
  | {
    kind: 'unplaced';
    what: string;
    why: string;
    evidenceQuote: string | null;
    evidenceVerified: boolean;
    confidence: number;
    /** Where it was read. */
    label: string;
  };

export interface ExtractParse {
  proposals: Extracted[];
  recommendations: Recommendation[];
  /** Items with no usable content at all. */
  dropped: { what: string; reason: string }[];
  malformed: boolean;
}

/** A type key in the codex's form, from the model's word for it. */
export function slugType(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '').slice(0, 40);
}

/** A piece of a document small enough for one call. */
export interface Chunk {
  path: string;
  /** The heading path, for the run record and the rationale. */
  label: string;
  text: string;
  words: number;
}

const nameKey = (raw: string): string => raw.trim().toLowerCase();

/**
 * Split a document into section-sized chunks under a word limit.
 *
 * Headings are the chunk boundary because a bible's sections are its units of
 * meaning; a node too big on its own is cut at paragraph breaks. Small sibling
 * sections are packed together so a file of twelve short entries is one call,
 * not twelve.
 */
export function chunkDocument(doc: SourceDoc, maxWords = 2500): Chunk[] {
  const out: Chunk[] = [];
  const label = (node: SourceNode, above: string[]) =>
    [doc.path, ...above, ...(node.heading ? [node.heading] : [])].join(' › ');

  const emit = (text: string, at: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    out.push({ path: doc.path, label: at, text: trimmed, words: countWords(trimmed).words });
  };

  const visit = (node: SourceNode, above: string[]) => {
    const whole = subtreeText(node);
    const words = countWords(whole).words;
    if (words <= maxWords) {
      emit(whole, label(node, above));
      return;
    }
    // Too big: its own prose first, then each child on its own.
    const own = [
      node.text,
      ...node.fields.map((f) => `${f.key}: ${f.value}`),
      ...node.tables.map((t) => [t.columns.join(' | '), ...t.rows.map((r) => r.join(' | '))].join('\n')),
    ].filter((s) => s.trim()).join('\n\n');
    if (countWords(own).words > maxWords) {
      for (const piece of splitParagraphs(own, maxWords)) emit(piece, label(node, above));
    } else {
      emit(own, label(node, above));
    }
    const below = node.heading ? [...above, node.heading] : above;
    for (const child of node.children) visit(child, below);
  };
  visit(doc.root, []);

  // Pack small neighbours together, in order, under the limit.
  const packed: Chunk[] = [];
  for (const c of out) {
    const last = packed.at(-1);
    if (last && last.words + c.words <= maxWords) {
      last.text = `${last.text}\n\n${c.text}`;
      last.words += c.words;
      last.label = commonLabel(last.label, c.label);
    } else {
      packed.push({ ...c });
    }
  }
  return packed;
}

function commonLabel(a: string, b: string): string {
  const pa = a.split(' › ');
  const pb = b.split(' › ');
  const shared: string[] = [];
  for (let i = 0; i < Math.min(pa.length, pb.length) && pa[i] === pb[i]; i++) shared.push(pa[i]!);
  return shared.length ? shared.join(' › ') : pa[0]!;
}

function splitParagraphs(text: string, maxWords: number): string[] {
  const pieces: string[] = [];
  let current = '';
  let words = 0;
  for (const para of text.split(/\n{2,}/u)) {
    const n = countWords(para).words;
    if (current && words + n > maxWords) {
      pieces.push(current);
      current = para;
      words = n;
    } else {
      current = current ? `${current}\n\n${para}` : para;
      words += n;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

/** Which parts of an answer a file can sensibly yield. */
export type ExtractSection = 'entities' | 'facts' | 'relationships' | 'laws' | 'unplaced';
export const ALL_SECTIONS: readonly ExtractSection[] = ['entities', 'facts', 'relationships', 'laws', 'unplaced'];

/**
 * What to ask for, from where the file sits. A rules file yields rules and
 * nothing else; a who-knows-what table yields facts and the people in it; a
 * character or place file yields the lot. Six sections at once is more than a
 * small model can hold, and asking a style guide for relationships invites
 * invention. The same signals the rule-based lane reads.
 */
export function sectionsFor(path: string): ExtractSection[] {
  if (/\blaws?\b|\brules?\b|house.?style|style.?guide|\bstyle\b|\bcanon\b/iu.test(path)) return ['laws', 'unplaced'];
  if (/fact|know|secret|reveal/iu.test(path)) return ['entities', 'facts', 'relationships', 'unplaced'];
  return [...ALL_SECTIONS];
}

export interface ExtractPrompt {
  /** Role, rules and the answer's shape: the same for every call, so a provider's prefix cache hits. */
  system: string;
  /** This project's types and names, and the fenced source. */
  user: string;
}

const SOURCE_FENCE = '=====';

/**
 * One worked example, invented, so the shape is shown rather than drawn in
 * angle brackets — small models copy placeholders literally. Every section
 * appears once; the call says which are wanted.
 */
const EXAMPLE = {
  entities: [{
    name: 'Tamsin Reel', type: 'character', aliases: ['the Reel', 'Tam'],
    summary: 'Tamsin Reel is the harbourmaster of Low Quay and the only person who can read the tide ledgers.',
    description: 'Tamsin Reel keeps the harbour at Low Quay and has done since her father drowned. She reads '
      + 'the tide ledgers nobody else can, and charges for it. She distrusts the guild and says so.\n\n'
      + 'She is short, grey before forty, and never seen without the brass key she will not explain.',
    attributes: { occupation: 'harbourmaster', want: 'to keep the quay out of guild hands', lie: 'that she owes nobody' },
    quote: 'Tamsin has kept the harbour since her father drowned',
  }],
  facts: [{
    subject: 'Tamsin Reel', statement: 'Tamsin Reel forged the last three tide ledgers.',
    knownBy: [{ entity: 'Orrin Vale', belief: 'suspects', how: 'the tallies do not match his own' }],
    quote: 'the last three ledgers are hers, and false',
  }],
  relationships: [{
    from: 'Orrin Vale', to: 'Tamsin Reel', kind: 'rival',
    note: 'Orrin wants the harbour for the guild.', quote: 'Orrin means to have the quay for the guild',
  }],
  laws: [{
    category: 'style', title: 'No weather openings',
    rule: 'Never open a scene on the weather. Begin with a person doing something.',
    quote: 'never open on weather',
  }],
  unplaced: [{
    what: 'The tide calendar', why: 'A table of tide names by month; belongs in a calendar or timeline, '
      + 'not in any entry.', quote: 'Names of the tides, by month',
  }],
};

const SECTION_NOTES: Record<ExtractSection, string> = {
  entities: '"entities": the file\'s own subjects. A person or place merely mentioned is not an entry unless the file says '
    + 'something substantive about them; they belong in "relationships" or as an alias. Use one of the project\'s types '
    + 'when it fits; when none fits — a language, a magic system, a ship, a religion — give a short new type name, and '
    + 'it will be offered to the writer as a new type. Fill the type\'s attribute fields from what the file states, and add '
    + 'a field of your own when the file states a concrete detail with no field for it.',
  facts: '"facts": things the file establishes as true in the story, one clear present-tense sentence each, names not '
    + 'pronouns, with who knows them and how, when the file says.',
  relationships: '"relationships": one entry per pair the file connects, kind in one or two words.',
  laws: '"laws": rules for the writer or the prose, each as an instruction. Categories: style (how the prose is written), '
    + 'canon (what is true in the world), content (what stays off the page), voice (how someone speaks), structure '
    + '(how scenes and chapters are built).',
  unplaced: '"unplaced": anything the file establishes that belongs in a story bible but fits none of the sections asked '
    + 'for — a timeline, a calendar, a language\'s rules, a map, a theme, a scene list — named, with what it is and where '
    + 'it would belong, so the writer can decide.',
};

/**
 * The extraction turn, in two parts.
 *
 * The **system** message is the same for every call: the role, the rules,
 * the worked example, and the answer's shape. A provider's prefix cache
 * keys on it, and models follow a system turn for format more reliably than
 * an instruction buried under a file. The **user** message is what changes:
 * the project's types and names, and the source, fenced, so the model can
 * tell where the file ends and our words resume.
 */
export function renderExtractPrompt(
  chunk: Chunk, types: ExtractTypes, sections: readonly ExtractSection[] = ALL_SECTIONS,
): ExtractPrompt {
  const wanted = ALL_SECTIONS.filter((s) => sections.includes(s));
  const example = Object.fromEntries(wanted.map((s) => [s, EXAMPLE[s]]));
  const system = [
    'You turn one part of a novelist\'s story bible into entries for a codex database. You read the source and WRITE '
    + 'the entries: clean present-tense prose that fits a reference entry, not a copy of the source. Correct its '
    + 'typos, resolve pronouns to names, drop its formatting, headings and asides, keep every concrete detail it '
    + 'gives, and invent nothing it does not say. The source is fiction the writer owns; render it as it is.',
    '',
    'EVERY ITEM CARRIES A "quote": the source\'s own words the item rests on, copied exactly, at least twelve '
    + 'characters. The quote is how the writer checks you. An item whose quote is not in the source is set aside '
    + 'unread, however good it is, so copy rather than paraphrase.',
    '',
    'SECTIONS',
    ...wanted.map((s) => `- ${SECTION_NOTES[s]}`),
    '',
    'A "summary" is one sentence saying who or what this is, as an encyclopedia entry begins. A "description" is one '
    + 'to three paragraphs in your own clean prose covering everything the source establishes: role, history, '
    + 'appearance, relationships, contradictions. Use an empty list for a section the source does not fill and an '
    + 'empty object for attributes it does not give.',
    '',
    'EXAMPLE — an invented source produced this answer:',
    JSON.stringify(example, null, 1),
    '',
    'Answer with one JSON object in that shape and no other text: no explanation, no code fence, nothing before the '
    + 'opening brace or after the closing one. If you reason first, keep it brief; the answer is the JSON.',
  ].join('\n');

  const typeList = types.types.map((t) => {
    const fields = (t.attributes ?? []).filter(Boolean);
    return `${t.key} (${t.label}${fields.length ? `; fields: ${fields.join(', ')}` : ''})`;
  }).join('\n  ');
  const known = [...new Set([...types.existing.values()].map((e) => e.name))]
    .sort((a, b) => a.localeCompare(b, 'en'));
  const user = [
    `SECTIONS WANTED FOR THIS SOURCE: ${wanted.join(', ')}.`,
    '',
    'ENTITY TYPES THIS PROJECT HAS, with the attribute fields each carries:',
    `  ${typeList}`,
    known.length
      ? '\nNAMES ALREADY IN THE CODEX (reuse them exactly when the source means the same person or thing): '
        + known.join(', ')
      : '',
    '',
    `${SOURCE_FENCE} SOURCE: ${chunk.label} ${SOURCE_FENCE}`,
    chunk.text,
    `${SOURCE_FENCE} END OF SOURCE ${SOURCE_FENCE}`,
    '',
    'The JSON object for this source:',
  ].filter((line) => line !== '').join('\n');

  return { system, user };
}

interface RawEntity {
  name?: unknown; type?: unknown; aliases?: unknown; summary?: unknown; description?: unknown;
  attributes?: unknown; quote?: unknown; confidence?: unknown;
}
interface RawKnown { entity?: unknown; belief?: unknown; how?: unknown }
interface RawFact {
  subject?: unknown; statement?: unknown; knownBy?: unknown; quote?: unknown; confidence?: unknown;
}
interface RawLaw {
  category?: unknown; title?: unknown; rule?: unknown; quote?: unknown; confidence?: unknown;
}
interface RawRelationship {
  from?: unknown; to?: unknown; kind?: unknown; note?: unknown; quote?: unknown; confidence?: unknown;
}
interface RawUnplaced { what?: unknown; why?: unknown; quote?: unknown; confidence?: unknown }
interface RawReply {
  entities?: unknown; facts?: unknown; laws?: unknown; relationships?: unknown; unplaced?: unknown;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const list = <T>(v: unknown): T[] => (Array.isArray(v) ? v.filter((x): x is T => !!x && typeof x === 'object') : []);
const BELIEFS = new Set(['knows', 'suspects', 'believes_false', 'denies']);
/** Longer than this and the model is pasting the file back, not writing an entry. */
const MAX_DESCRIPTION = 4000;
const MAX_ATTRIBUTE = 400;

/** The model's attribute object as the codex stores it: snake keys, string values, nothing empty. */
export function readAttributes(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = k.trim().toLowerCase().replace(/[^a-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '');
    const value = typeof v === 'string' ? v.trim()
      : typeof v === 'number' || typeof v === 'boolean' ? String(v)
        : Array.isArray(v) ? v.filter((x) => typeof x === 'string' || typeof x === 'number').join(', ')
          : '';
    if (key && value) out[key] = value.slice(0, MAX_ATTRIBUTE);
  }
  return out;
}
/** Every category the laws engine has (doc 04), not only the three the pull-down offers. */
const LAW_CATEGORIES = new Set(['style', 'canon', 'content', 'voice', 'structure', 'ip']);

/**
 * The model's confidence when it gave one, else read off the evidence: a
 * located quote is the one signal we can check, and it is a better guide than
 * a number a small model sets to 1.0 for everything.
 */
function clip(v: unknown, verified = true): number {
  const n = typeof v === 'number' ? v : Number.NaN;
  if (!Number.isFinite(n)) return verified ? 0.9 : 0.4;
  return Math.min(1, Math.max(0, Math.round(n * 100) / 100));
}

/** Read the model's answer for one chunk into proposals, with every quote checked. */
export function parseExtractReply(reply: string, chunk: Chunk, types: ExtractTypes): ExtractParse {
  // The object, with any prose or fence around it removed — but an array is
  // not an object with extra steps, so the first bracket decides.
  const body = reply.replace(/```[a-z]*/giu, '').trim();
  const open = body.indexOf('{');
  const close = body.lastIndexOf('}');
  const firstBracket = body.search(/[[{]/u);
  const malformed: ExtractParse = { proposals: [], recommendations: [], dropped: [], malformed: true };
  if (open === -1 || close <= open || firstBracket !== open) return malformed;
  let raw: RawReply;
  try {
    raw = JSON.parse(body.slice(open, close + 1)) as RawReply;
  } catch {
    return malformed;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return malformed;

  const allowed = new Map(types.types.map((t) => [t.key, new Set(t.attributes ?? [])]));
  const proposals: Extracted[] = [];
  const recommendations: Recommendation[] = [];
  const dropped: ExtractParse['dropped'] = [];
  const from = `from ${chunk.label}`;
  /** Entries filed under a type the project lacks, by the type's key. */
  const newTypes = new Map<string, Extract<Recommendation, { kind: 'new_type' }>>();
  /** Fields a type's editor has no box for, by `type\u0000field`. */
  const newFields = new Map<string, Extract<Recommendation, { kind: 'new_field' }>>();

  const evidence = (quote: unknown) => {
    const claimed = str(quote);
    const hit = claimed ? locateQuote(chunk.text, claimed) : null;
    return { quote: hit ? hit.quote : claimed, verified: hit !== null };
  };

  /** Names this chunk proposes, so knowledge and aliases can point at them. */
  const proposed = new Set<string>();

  for (const e of list<RawEntity>(raw.entities)) {
    const name = str(e.name);
    if (!name) { dropped.push({ what: 'an entity with no name', reason: 'no name' }); continue; }
    const typeWord = str(e.type) ?? '';
    const existing = types.existing.get(nameKey(name));
    // An existing entry keeps its type; otherwise the model's word, matched to
    // a key the project has, or slugged into a key it might add.
    const known = allowed.has(typeWord.toLowerCase()) ? typeWord.toLowerCase()
      : [...allowed.keys()].find((k) => k === slugType(typeWord)) ?? null;
    const typeKey = existing?.typeKey ?? known ?? slugType(typeWord);
    if (!typeKey) { dropped.push({ what: name, reason: 'the model gave it no type' }); continue; }
    const isNewType = !existing && !known;

    const { quote, verified } = evidence(e.quote);
    const description = str(e.description);
    const attributes = readAttributes(e.attributes);
    const rows: Extracted[] = [{
      table: 'entity', op: existing ? 'update' : 'new',
      payload: {
        name, typeKey, summary: str(e.summary),
        description: description ? description.slice(0, MAX_DESCRIPTION) : null,
        attributes,
      },
      rationale: `${from} — the model read it as a ${isNewType ? typeWord.trim() : typeKey}`
        + (existing ? ', already in your codex' : ''),
      confidence: clip(e.confidence, verified), evidenceQuote: quote, evidenceVerified: verified,
    }];
    for (const alias of Array.isArray(e.aliases) ? e.aliases : []) {
      const a = str(alias);
      if (!a || nameKey(a) === nameKey(name) || types.existing.has(nameKey(a))) continue;
      rows.push({
        table: 'entity_alias', op: 'new', payload: { entityName: name, alias: a },
        rationale: `${from} — another name for ${name}`,
        confidence: clip(e.confidence, verified), evidenceQuote: quote, evidenceVerified: verified,
      });
    }

    if (isNewType) {
      const seen = newTypes.get(typeKey);
      if (seen) { seen.names.push(name); seen.held.push(...rows); } else {
        const rec: Extract<Recommendation, { kind: 'new_type' }> = {
          kind: 'new_type', typeKey, label: typeWord.trim(), names: [name], held: rows,
          why: `${from} — the model read ${name} as a “${typeWord.trim()}”, a type this project does not have`,
        };
        newTypes.set(typeKey, rec);
        recommendations.push(rec);
      }
    } else {
      proposals.push(...rows);
      // Fields the type's editor has no box for. The value is on the entry
      // either way; the recommendation is to give it a box.
      const fields = allowed.get(typeKey);
      if (fields && fields.size > 0) {
        for (const field of Object.keys(attributes)) {
          if (fields.has(field)) continue;
          const key = `${typeKey}\u0000${field}`;
          const seen = newFields.get(key);
          if (seen) { if (!seen.names.includes(name)) seen.names.push(name); } else {
            const rec: Extract<Recommendation, { kind: 'new_field' }> = {
              kind: 'new_field', typeKey, field, names: [name],
            };
            newFields.set(key, rec);
            recommendations.push(rec);
          }
        }
      }
    }
    proposed.add(nameKey(name));
  }

  for (const r of list<RawRelationship>(raw.relationships)) {
    const fromName = str(r.from);
    const toName = str(r.to);
    const kind = str(r.kind);
    if (!fromName || !toName || !kind) {
      dropped.push({ what: 'a relationship missing an end or a kind', reason: 'incomplete' });
      continue;
    }
    if (nameKey(fromName) === nameKey(toName)) continue;
    const { quote, verified } = evidence(r.quote);
    proposals.push({
      table: 'relationship', op: 'new',
      payload: { fromName, toName, kind: kind.toLowerCase(), notes: str(r.note) },
      rationale: `${from} — ${fromName} ${kind.toLowerCase()} ${toName}`,
      confidence: clip(r.confidence, verified), evidenceQuote: quote, evidenceVerified: verified,
    });
  }

  let factIndex = 0;
  for (const f of list<RawFact>(raw.facts)) {
    const statement = str(f.statement);
    if (!statement) { dropped.push({ what: 'a fact with no statement', reason: 'no statement' }); continue; }
    const { quote, verified } = evidence(f.quote);
    const subject = str(f.subject);
    const key = `${chunk.path}#${chunk.label}#${factIndex++}#${statement}`;
    proposals.push({
      table: 'fact', op: 'new',
      payload: { key, predicate: statement, statement, subjectName: subject },
      rationale: `${from}${subject ? ` — about ${subject}` : ''}`,
      confidence: clip(f.confidence, verified), evidenceQuote: quote, evidenceVerified: verified,
    });
    for (const k of list<RawKnown>(f.knownBy)) {
      const entity = str(k.entity);
      const belief = str(k.belief)?.toLowerCase() ?? '';
      if (!entity || !BELIEFS.has(belief)) continue;
      proposals.push({
        table: 'fact_knowledge', op: 'new',
        payload: { factKey: key, entityName: entity, belief, learnedHow: str(k.how) },
        rationale: `${from} — what ${entity} makes of it`,
        confidence: clip(f.confidence, verified), evidenceQuote: quote, evidenceVerified: verified,
      });
    }
  }

  let order = 0;
  for (const l of list<RawLaw>(raw.laws)) {
    const rule = str(l.rule);
    if (!rule) { dropped.push({ what: 'a law with no rule', reason: 'no rule' }); continue; }
    const category = str(l.category)?.toLowerCase() ?? '';
    if (!LAW_CATEGORIES.has(category)) {
      dropped.push({
        what: rule,
        reason: `the model filed it under “${category || 'nothing'}”, not a category the laws engine has`,
      });
      continue;
    }
    const { quote, verified } = evidence(l.quote);
    proposals.push({
      table: 'law', op: 'new',
      payload: { category, severity: 'must', title: str(l.title) ?? firstWords(rule), ruleText: rule, order: order++ },
      rationale: `${from} — a ${category} rule`,
      confidence: clip(l.confidence, verified), evidenceQuote: quote, evidenceVerified: verified,
    });
  }

  for (const u of list<RawUnplaced>(raw.unplaced)) {
    const what = str(u.what);
    const why = str(u.why);
    if (!what || !why) continue;
    const { quote, verified } = evidence(u.quote);
    recommendations.push({
      kind: 'unplaced', what, why, evidenceQuote: quote, evidenceVerified: verified,
      confidence: clip(u.confidence, verified), label: chunk.label,
    });
  }

  return { proposals, recommendations, dropped, malformed: false };
}

/** Recommendations from many chunks: one per new type, one per new field, every unplaced item. */
export function mergeRecommendations(all: readonly Recommendation[]): Recommendation[] {
  const out: Recommendation[] = [];
  const byType = new Map<string, Extract<Recommendation, { kind: 'new_type' }>>();
  const byField = new Map<string, Extract<Recommendation, { kind: 'new_field' }>>();
  for (const r of all) {
    if (r.kind === 'new_type') {
      const seen = byType.get(r.typeKey);
      if (seen) {
        for (const n of r.names) if (!seen.names.includes(n)) seen.names.push(n);
        seen.held.push(...r.held);
      } else {
        const copy = { ...r, names: [...r.names], held: [...r.held] };
        byType.set(r.typeKey, copy);
        out.push(copy);
      }
    } else if (r.kind === 'new_field') {
      const key = `${r.typeKey}\u0000${r.field}`;
      const seen = byField.get(key);
      if (seen) { for (const n of r.names) if (!seen.names.includes(n)) seen.names.push(n); } else {
        const copy = { ...r, names: [...r.names] };
        byField.set(key, copy);
        out.push(copy);
      }
    } else {
      out.push(r);
    }
  }
  // Held entities fold like staged ones: one per name.
  for (const r of out) if (r.kind === 'new_type') r.held = mergeExtracted(r.held);
  return out;
}

function firstWords(text: string, n = 6): string {
  const words = text.split(/\s+/u);
  return words.length <= n ? text : `${words.slice(0, n).join(' ')}…`;
}

/**
 * Merge proposals from many chunks: one entity per name, with the longest
 * summary and description, every attribute, and every alias; knowledge and
 * facts left as they are, since two
 * chunks saying the same thing twice is what a reviewer should see.
 */
export function mergeExtracted(all: readonly Extracted[]): Extracted[] {
  const entities = new Map<string, Extracted>();
  const aliases = new Map<string, Extracted>();
  const rest: Extracted[] = [];
  for (const p of all) {
    if (p.table === 'entity') {
      const key = nameKey(String(p.payload.name));
      const seen = entities.get(key);
      if (!seen) { entities.set(key, { ...p, payload: { ...p.payload } }); continue; }
      const mine = String(p.payload.summary ?? '');
      const theirs = String(seen.payload.summary ?? '');
      if (mine.length > theirs.length) seen.payload.summary = mine;
      const myDesc = String(p.payload.description ?? '');
      const theirDesc = String(seen.payload.description ?? '');
      if (myDesc.length > theirDesc.length) seen.payload.description = myDesc;
      seen.payload.attributes = {
        ...(seen.payload.attributes as Record<string, string>),
        ...(p.payload.attributes as Record<string, string>),
      };
      seen.confidence = Math.max(seen.confidence, p.confidence);
      if (!seen.evidenceVerified && p.evidenceVerified) {
        seen.evidenceVerified = true;
        seen.evidenceQuote = p.evidenceQuote;
      }
    } else if (p.table === 'entity_alias') {
      const key = `${nameKey(String(p.payload.entityName))}→${nameKey(String(p.payload.alias))}`;
      if (!aliases.has(key)) aliases.set(key, p);
    } else {
      rest.push(p);
    }
  }
  return [...entities.values(), ...aliases.values(), ...rest];
}

/** A rough size for the writer before they spend: about four characters a token. */
export function estimateTokens(chunks: readonly Chunk[]): number {
  return chunks.reduce((n, c) => n + Math.ceil(c.text.length / 4) + 350, 0);
}
