import { fieldKey, walk, type SourceDoc, type SourceField, type SourceNode } from './source';
import { isSectionHeading, ruleItems } from './outline';

/**
 * Where each piece of a document should go — proposed, never decided.
 *
 * This file is where "make no assumptions" has to actually mean something, so
 * it is worth being exact about what it means here. Every rule below is a
 * *suggestion carrying its own reason*. Nothing is applied. Anything no rule
 * recognises defaults to `skip`, not to a guess — because the cost of a wrong
 * guess is a codex full of rows the writer has to find and delete, and the cost
 * of a miss is one dropdown.
 *
 * The rules are deliberately cheap and legible — folder names, heading shapes,
 * a name that already exists. No model, in Phase 1 by design (doc 08: "the
 * graph, with no AI at all"). Phase 2's extraction lane plugs in here as a
 * second source of suggestions feeding the same review, so a writer confirms an
 * AI's proposal exactly the way they confirm this one.
 *
 * The reason strings are part of the interface, not decoration. A suggestion a
 * writer cannot audit is a suggestion they either accept blindly or reject
 * wholesale, and both make the review theatre.
 */

export type Destination =
  /** Deliberately nothing. The default for anything unrecognised. */
  | { kind: 'skip' }
  | { kind: 'entity'; typeKey: string }
  | { kind: 'note' }
  | { kind: 'scene' }
  /** The node's table is a fact-by-character grid: rows facts, columns who knows. */
  | { kind: 'knowledge'; factColumn: number }
  /** One law per bullet or paragraph under the node. */
  | { kind: 'law'; category: LawCategory }
  /** Acts, planned scenes with their summaries, and beats — the book's plan. */
  | { kind: 'plan' };

export type LawCategory = 'style' | 'canon' | 'content';

export interface Suggestion {
  docPath: string;
  nodeId: string;
  /** The heading, or the file name for a document root. For the review list. */
  label: string;
  destination: Destination;
  /** Why this was suggested, in the writer's terms. Always shown. */
  reason: string;
  /** An existing entity this matches by name or alias, if any. */
  matchesEntityId?: string;
}

export interface ExistingEntity {
  id: string;
  name: string;
  typeKey: string;
}

export interface SuggestContext {
  /** Normalised name or alias to the entity it belongs to. Drives update over new. */
  existing: Map<string, ExistingEntity>;
  /** Type keys this project actually has. A rule never proposes a type that is not there. */
  types: Set<string>;
}

/** Normalised the same way an alias is matched, so "Ilva" and "ilva" are one name. */
export const nameKey = (raw: string): string => raw.trim().toLowerCase();

/**
 * Folder and file names that name a kind of thing.
 *
 * The single most reliable signal in a real bible, because a writer who put
 * five files in `characters/` has already told us what they are. Checked
 * against the project's own types so a rule can never propose a type that does
 * not exist.
 */
const PATH_TYPES: [RegExp, string][] = [
  [/character|\bcast\b|people|\bfolk\b|\bpersona/iu, 'character'],
  [/location|\bplace|setting|geograph/iu, 'location'],
  [/faction|\bgroup|\borg\b|organis|organiz|guild/iu, 'faction'],
  [/\bitem|object|\bprop\b|artifact|artefact/iu, 'item'],
  [/\bevent|timeline|histor/iu, 'event'],
];

const SCENE_PATHS = /scene|chapter|manuscript|draft|prose/iu;
const KNOWLEDGE_HEADER = /fact|know|secret|reveal/iu;
/** A file, or a heading, that says it holds rules. */
const LAW_PATHS = /\blaws?\b|\brules?\b|house.?style|style.?guide|\bstyle\b|\bcanon\b/iu;
const STYLE_PATHS = /style|house/iu;
/** A file that says it holds the plan. Never a scene file: those hold prose. */
const PLAN_PATHS = /outline|\bplan\b|beat.?sheet|synopsis|structure/iu;

function typeFromPath(path: string, types: Set<string>): string | null {
  for (const [pattern, key] of PATH_TYPES) {
    if (pattern.test(path) && types.has(key)) return key;
  }
  return null;
}

/** A node carries something worth importing, rather than being a bare heading. */
const hasSubstance = (node: SourceNode): boolean =>
  node.text.trim().length > 0 || node.fields.length > 0;

/**
 * The heading level a file repeats, if it repeats one.
 *
 * This is what separates `jeru.md` — one character, one file — from
 * `supporting.md`, which is seven characters as sibling H3s under a plural
 * heading. Both are ordinary ways to keep a bible and neither is more correct,
 * so the shape decides rather than a convention the writer never agreed to:
 * two or more siblings at the same depth, each with content, means the file is
 * a list of things; anything else means the file is one thing.
 */
function repeatedLevel(node: SourceNode): SourceNode[] | null {
  const byDepth = new Map<number, SourceNode[]>();
  for (const child of node.children) {
    if (!hasSubstance(child) && child.children.length === 0) continue;
    const at = byDepth.get(child.depth);
    if (at) at.push(child);
    else byDepth.set(child.depth, [child]);
  }
  let best: SourceNode[] | null = null;
  for (const group of byDepth.values()) {
    if (group.length >= 2 && (!best || group.length > best.length)) best = group;
  }
  return best;
}

/** The node that stands for a whole document — its single top heading, or the root. */
function documentSubject(root: SourceNode): SourceNode {
  const real = root.children.filter((c) => c.heading);
  return real.length === 1 && !hasSubstance(root) ? real[0]! : root;
}

export function suggestForDocument(doc: SourceDoc, context: SuggestContext): Suggestion[] {
  const out: Suggestion[] = [];
  const claimed = new Set<string>();
  const label = (node: SourceNode) => node.heading ?? doc.path;

  const propose = (node: SourceNode, destination: Destination, reason: string) => {
    if (claimed.has(node.id)) return;
    claimed.add(node.id);
    // A destination that carries prose takes its whole subtree with it. Jeru's
    // `Want:` and `Lie:` live in a child section called "Arc"; the section is
    // not a thing of its own, it is part of the character — so it must not be
    // offered separately, and above all must not be listed as skipped, which
    // would tell the writer their template fields were being dropped.
    if (destination.kind === 'entity' || destination.kind === 'note'
      || destination.kind === 'scene' || destination.kind === 'law' || destination.kind === 'plan') {
      for (const { node: inner } of walk(node)) claimed.add(inner.id);
    }
    const match = node.heading ? context.existing.get(nameKey(node.heading)) : undefined;
    out.push({
      docPath: doc.path,
      nodeId: node.id,
      label: label(node),
      destination,
      reason,
      ...(match ? { matchesEntityId: match.id } : {}),
    });
  };

  // A table of facts against characters, wherever it sits. The highest-value
  // shape in a bible and the least ambiguous, so it is recognised first.
  for (const { node } of walk(doc.root)) {
    const table = node.tables[0];
    if (table && table.columns.length >= 2 && KNOWLEDGE_HEADER.test(table.columns[0] ?? '')) {
      propose(node, { kind: 'knowledge', factColumn: 0 },
        `a table headed "${table.columns[0]}" with ${table.columns.length - 1} more columns, `
        + 'read as facts down the rows and who knows them across');
    }
  }

  const typeKey = typeFromPath(doc.path, context.types);
  const subject = documentSubject(doc.root);

  // Rules and the plan, by what the file calls itself. Checked before the
  // entity types so `reference/laws.md` is never mistaken for a list of things
  // — and never when the folder already says the file holds people or prose.
  const saysLaws = !typeKey && !SCENE_PATHS.test(doc.path)
    && (LAW_PATHS.test(doc.path) || LAW_PATHS.test(subject.heading ?? ''));
  const saysPlan = !typeKey && !SCENE_PATHS.test(doc.path) && PLAN_PATHS.test(doc.path);
  const sections = [...walk(subject)]
    .filter(({ node }) => node !== subject && isSectionHeading(node.heading));

  if (saysPlan && sections.length >= 2) {
    propose(subject, { kind: 'plan' },
      `${sections.length} numbered sections under "${doc.path}", read as planned scenes with `
      + 'their beats, and the headings above them as acts');
  } else if (saysLaws) {
    const text = [...walk(subject)].map(({ node }) => node.text).join('\n\n');
    const items = ruleItems(text);
    if (items.length >= 1) {
      const category: LawCategory =
        STYLE_PATHS.test(`${doc.path} ${subject.heading ?? ''}`) ? 'style' : 'canon';
      const per = items.length > 1 && /^\s*[-*•]\s/mu.test(text) ? 'bullet' : 'paragraph';
      propose(subject, { kind: 'law', category },
        `"${doc.path}" says it holds rules: ${items.length} of them, one per ${per}, `
        + `offered as ${category} laws`);
    }
  }

  if (typeKey) {
    const siblings = repeatedLevel(subject);
    if (siblings) {
      for (const node of siblings) {
        propose(node, { kind: 'entity', typeKey },
          `one of ${siblings.length} sections at the same level in a file under `
          + `"${doc.path}", so the file reads as a list of them`);
      }
    } else if (hasSubstance(subject) || subject.children.length > 0) {
      propose(subject, { kind: 'entity', typeKey },
        `"${doc.path}" names a ${typeKey}, and the file reads as one of them`);
    }
  } else if (SCENE_PATHS.test(doc.path)) {
    propose(subject, { kind: 'scene' },
      `"${doc.path}" sits where prose lives, so it is offered as a scene`);
  }

  // A heading that is already a name in the codex is a strong enough signal to
  // override the folder saying nothing at all.
  for (const { node } of walk(doc.root)) {
    if (claimed.has(node.id) || !node.heading) continue;
    const match = context.existing.get(nameKey(node.heading));
    if (match && hasSubstance(node)) {
      propose(node, { kind: 'entity', typeKey: match.typeKey },
        `"${node.heading}" is already in your codex, so this is offered as an update to it`);
    }
  }

  // Everything else is named and skipped rather than quietly omitted: a writer
  // scanning the list has to be able to see what the rules did NOT recognise,
  // or the only way to find a missed section is to notice its absence.
  for (const { node } of walk(doc.root)) {
    if (claimed.has(node.id) || !hasSubstance(node)) continue;
    propose(node, { kind: 'skip' }, 'no rule recognised this, so nothing happens to it');
  }

  out.sort((a, b) => a.nodeId.localeCompare(b.nodeId, 'en'));
  return out;
}

export function suggestAll(
  docs: readonly SourceDoc[], context: SuggestContext,
): Suggestion[] {
  return docs.flatMap((doc) => suggestForDocument(doc, context));
}

/* ------------------------------------------------------- fields onto columns */

/** Where one key/value line ends up on an entity. */
export type FieldTarget =
  | { kind: 'skip' }
  | { kind: 'column'; column: 'summary' | 'description' | 'importance' | 'status' }
  | { kind: 'attribute'; key: string };

const SUMMARY_KEYS = new Set(['summary', 'one line', 'logline', 'in a line', 'shortly']);
const IMPORTANCE_KEYS = new Set(['importance', 'role', 'billing']);
const STATUS_KEYS = new Set(['status', 'state', 'condition']);

/**
 * The default target for a field.
 *
 * Unrecognised keys become attributes rather than being dropped, because
 * `entity.attributes` is exactly the free-form JSON bag a bible's own
 * vocabulary belongs in — a writer's `Lie:` and `Beat path:` are theirs, and
 * flattening them into the description would lose the structure they wrote.
 */
export function defaultFieldTarget(key: string): FieldTarget {
  const k = fieldKey(key);
  if (SUMMARY_KEYS.has(k)) return { kind: 'column', column: 'summary' };
  if (IMPORTANCE_KEYS.has(k)) return { kind: 'column', column: 'importance' };
  if (STATUS_KEYS.has(k)) return { kind: 'column', column: 'status' };
  return { kind: 'attribute', key: k };
}

/**
 * Every field a destination should carry, including its child sections'.
 *
 * A character file keeps its template under a heading — `## Arc`, then `Want:`,
 * `Need:`, `Lie:`. Reading only the node's own fields would import the dossier
 * and silently lose the part the writer was most deliberate about. Nested keys
 * are prefixed with their section so `Arc`'s `Want` and `Voice`'s `Want` stay
 * two fields rather than one overwriting the other.
 */
export function absorbedFields(node: SourceNode): SourceField[] {
  const out: SourceField[] = [...node.fields];
  const seen = new Set(node.fields.map((f) => fieldKey(f.key)));
  for (const { node: inner, ancestors } of walk(node)) {
    if (inner === node) continue;
    for (const f of inner.fields) {
      const bare = fieldKey(f.key);
      if (!seen.has(bare)) {
        seen.add(bare);
        out.push(f);
        continue;
      }
      const section = [...ancestors.slice(1), inner].map((a) => a.heading).filter(Boolean).join(' ');
      const key = section ? `${section} ${f.key}` : f.key;
      if (seen.has(fieldKey(key))) continue;
      seen.add(fieldKey(key));
      out.push({ key, value: f.value });
    }
  }
  return out;
}
