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
 * - **Every item cites the file.** The model quotes the words it read; the
 *   quote is held against the text ([doc 12 §3](../../docs/12-algorithms.md)),
 *   and an item whose quote is not there is *unverified* — staged, shown, never
 *   accepted by default. Small models invent characters with confidence.
 * - **Types come from the project.** The model chooses from the entity types
 *   this project has. An item naming a type that is not there is dropped and
 *   counted rather than filed under a guess.
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
  /** Type keys this project has, with a label for the prompt. */
  types: { key: string; label: string }[];
  /** Normalised name or alias to the entity it belongs to. */
  existing: Map<string, ExistingEntity>;
}

/** A row for `proposal`, ready to stage. The same shapes the rule-based stager writes. */
export interface Extracted {
  table: 'entity' | 'entity_alias' | 'fact' | 'fact_knowledge' | 'law';
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

export interface ExtractParse {
  proposals: Extracted[];
  /** Items with a type the project does not have, or no usable content. */
  dropped: { what: string; reason: string }[];
  malformed: boolean;
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

/**
 * The extraction turn. The file's words, the project's types, the names it
 * already knows, and the shape of the answer. Short and literal on purpose:
 * this goes to the cheap role.
 */
export function renderExtractPrompt(chunk: Chunk, types: ExtractTypes): string {
  const typeList = types.types.map((t) => `${t.key} (${t.label})`).join(', ');
  const known = [...new Set([...types.existing.values()].map((e) => e.name))].sort((a, b) => a.localeCompare(b, 'en'));
  return [
    'You are reading part of a novelist\'s story bible. List what it establishes, as data, and nothing it does not say.',
    '',
    `ENTITY TYPES YOU MAY USE: ${typeList}`,
    known.length ? `NAMES ALREADY IN THE CODEX (reuse them exactly when the text means the same person or thing): ${known.join(', ')}` : '',
    '',
    `SOURCE (${chunk.label})`,
    chunk.text,
    '',
    'Answer with one JSON object and no other text:',
    '{"entities": [{"name": "", "type": "<one of the types above>", "aliases": [""], "summary": "<one sentence>", '
    + '"quote": "<words copied exactly from the source, at least twelve characters>", "confidence": 0.0}],',
    ' "facts": [{"subject": "<entity name or empty>", "statement": "<one sentence, present tense>", '
    + '"knownBy": [{"entity": "", "belief": "knows|suspects|believes_false|denies", "how": ""}], '
    + '"quote": "", "confidence": 0.0}],',
    ' "laws": [{"category": "style|canon|content", "title": "<a few words>", '
    + '"rule": "<the rule as an instruction to a writer>", "quote": "", "confidence": 0.0}]}',
    'Use an empty list for anything the source does not establish. Do not invent names, facts or rules.',
  ].filter((line) => line !== null).join('\n');
}

interface RawEntity {
  name?: unknown; type?: unknown; aliases?: unknown; summary?: unknown; quote?: unknown; confidence?: unknown;
}
interface RawKnown { entity?: unknown; belief?: unknown; how?: unknown }
interface RawFact {
  subject?: unknown; statement?: unknown; knownBy?: unknown; quote?: unknown; confidence?: unknown;
}
interface RawLaw {
  category?: unknown; title?: unknown; rule?: unknown; quote?: unknown; confidence?: unknown;
}
interface RawReply { entities?: unknown; facts?: unknown; laws?: unknown }

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const list = <T>(v: unknown): T[] => (Array.isArray(v) ? v.filter((x): x is T => !!x && typeof x === 'object') : []);
const BELIEFS = new Set(['knows', 'suspects', 'believes_false', 'denies']);
const LAW_CATEGORIES = new Set(['style', 'canon', 'content']);

function clip(v: unknown): number {
  const n = typeof v === 'number' ? v : Number.NaN;
  if (!Number.isFinite(n)) return 0.5;
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
  if (open === -1 || close <= open || firstBracket !== open) {
    return { proposals: [], dropped: [], malformed: true };
  }
  let raw: RawReply;
  try {
    raw = JSON.parse(body.slice(open, close + 1)) as RawReply;
  } catch {
    return { proposals: [], dropped: [], malformed: true };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { proposals: [], dropped: [], malformed: true };

  const allowed = new Set(types.types.map((t) => t.key));
  const proposals: Extracted[] = [];
  const dropped: ExtractParse['dropped'] = [];
  const from = `from ${chunk.label}`;

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
    const type = str(e.type)?.toLowerCase() ?? '';
    if (!allowed.has(type)) {
      dropped.push({ what: name, reason: `the model called it a “${type || 'nothing'}”, a type this project does not have` });
      continue;
    }
    const { quote, verified } = evidence(e.quote);
    const existing = types.existing.get(nameKey(name));
    proposals.push({
      table: 'entity', op: existing ? 'update' : 'new',
      payload: {
        name, typeKey: existing?.typeKey ?? type, summary: str(e.summary), description: null, attributes: {},
      },
      rationale: `${from} — the model read it as a ${type}${existing ? ', already in your codex' : ''}`,
      confidence: clip(e.confidence), evidenceQuote: quote, evidenceVerified: verified,
    });
    proposed.add(nameKey(name));
    for (const alias of Array.isArray(e.aliases) ? e.aliases : []) {
      const a = str(alias);
      if (!a || nameKey(a) === nameKey(name) || types.existing.has(nameKey(a))) continue;
      proposals.push({
        table: 'entity_alias', op: 'new', payload: { entityName: name, alias: a },
        rationale: `${from} — another name for ${name}`,
        confidence: clip(e.confidence), evidenceQuote: quote, evidenceVerified: verified,
      });
    }
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
      confidence: clip(f.confidence), evidenceQuote: quote, evidenceVerified: verified,
    });
    for (const k of list<RawKnown>(f.knownBy)) {
      const entity = str(k.entity);
      const belief = str(k.belief)?.toLowerCase() ?? '';
      if (!entity || !BELIEFS.has(belief)) continue;
      proposals.push({
        table: 'fact_knowledge', op: 'new',
        payload: { factKey: key, entityName: entity, belief, learnedHow: str(k.how) },
        rationale: `${from} — what ${entity} makes of it`,
        confidence: clip(f.confidence), evidenceQuote: quote, evidenceVerified: verified,
      });
    }
  }

  let order = 0;
  for (const l of list<RawLaw>(raw.laws)) {
    const rule = str(l.rule);
    if (!rule) { dropped.push({ what: 'a law with no rule', reason: 'no rule' }); continue; }
    const category = str(l.category)?.toLowerCase() ?? '';
    if (!LAW_CATEGORIES.has(category)) {
      dropped.push({ what: rule, reason: `the model filed it under “${category || 'nothing'}”, not style, canon or content` });
      continue;
    }
    const { quote, verified } = evidence(l.quote);
    proposals.push({
      table: 'law', op: 'new',
      payload: { category, severity: 'must', title: str(l.title) ?? firstWords(rule), ruleText: rule, order: order++ },
      rationale: `${from} — a ${category} rule`,
      confidence: clip(l.confidence), evidenceQuote: quote, evidenceVerified: verified,
    });
  }

  return { proposals, dropped, malformed: false };
}

function firstWords(text: string, n = 6): string {
  const words = text.split(/\s+/u);
  return words.length <= n ? text : `${words.slice(0, n).join(' ')}…`;
}

/**
 * Merge proposals from many chunks: one entity per name, with the longest
 * summary and every alias; knowledge and facts left as they are, since two
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
