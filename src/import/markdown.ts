import {
  emptyNode, type SourceDoc, type SourceField, type SourceNode, type SourceTable,
} from './source';

/**
 * Markdown into the neutral document tree.
 *
 * Written here rather than taken from a library for two reasons that are not
 * "avoid a dependency". A Markdown library produces an AST of Markdown, and
 * what this needs is a document tree: sections nested by heading level, which
 * every Markdown AST leaves flat because Markdown itself has no nesting.
 * Rebuilding the nesting is most of this file, so the library would be saving
 * the easy half. And the field detection below is a judgement about prose that
 * no Markdown parser makes, because `Want: keep the door` is a paragraph to
 * every one of them.
 *
 * This is deliberately not a complete Markdown implementation. It reads the
 * structure a story bible uses — headings, tables, key/value lines, front
 * matter — and treats everything else as prose, which is what it is. Inline
 * emphasis is left in the text: the writer wrote it, and stripping it would be
 * this file deciding their italics did not matter.
 */

const ATX = /^(#{1,6})\s+(.*?)\s*#*\s*$/u;
const FENCE = /^\s{0,3}(`{3,}|~{3,})/u;
const THEMATIC = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/u;
const SETEXT = /^\s{0,3}(=+|-+)\s*$/u;
const TABLE_ROW = /^\s*\|.*\|\s*$/u;
const TABLE_RULE = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/u;

/**
 * A key/value line.
 *
 * Tight on purpose. The loose version — anything before a colon — turns
 * `She turned and said: nothing at all.` into a field called "She turned and
 * said", and a bible full of dialogue becomes a bible full of nonsense fields.
 *
 * Two signals, because neither works alone. **Length**: a real label is three
 * words at most — `Want`, `Beat path`, `The live split` — while a clause that
 * happens to precede a colon is usually longer. And **clause words**: a label
 * almost never contains `and`, `was`, `said`, `that`. Length alone lets
 * `She turned and said` through at exactly four words; the stop list alone lets
 * a long noun phrase through. Together they hold.
 *
 * A **bolded** key skips both tests. Bolding it is the writer saying it is a
 * label, and a heuristic that overrules an explicit signal is a bad heuristic.
 *
 * The error to prefer, where the rule is unsure: false positives are survivable
 * — nothing here is applied, only proposed, and an unmapped field is skipped.
 * A field nobody detected is one the writer has to retype.
 */
const BOLD_FIELD = /^\s*(?:[-*+]\s+)?\*\*\s*([^*\n]{1,40}?)\s*\*\*\s*[:：]\s*(.*)$/u;
const PLAIN_FIELD = /^\s*(?:[-*+]\s+)?([A-Za-z][A-Za-z0-9 '’-]{0,31})\s*[:：]\s+(.+)$/u;
const MAX_KEY_WORDS = 3;
/** Words that mean this is a clause, not a label. */
const CLAUSE_WORDS = new Set([
  'and', 'or', 'but', 'is', 'was', 'are', 'were', 'be', 'been', 'had', 'has', 'have',
  'said', 'says', 'that', 'which', 'who', 'when', 'then', 'than', 'because', 'with',
]);

function readField(line: string): SourceField | null {
  const bold = BOLD_FIELD.exec(line);
  if (bold) return { key: bold[1]!.trim(), value: bold[2]!.trim() };
  const plain = PLAIN_FIELD.exec(line);
  if (!plain) return null;
  const key = plain[1]!.trim();
  const words = key.split(/\s+/u);
  if (words.length > MAX_KEY_WORDS) return null;
  if (words.some((w) => CLAUSE_WORDS.has(w.toLowerCase()))) return null;
  return { key, value: plain[2]!.trim() };
}

const cells = (row: string): string[] =>
  row.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map((c) => c.trim());

/**
 * YAML front matter, read as fields and nothing more.
 *
 * Deliberately not a YAML parser. A bible's front matter is a flat block of
 * `key: value`, and the alternative is either a dependency or a half-YAML that
 * is wrong in ways nobody can predict. Nested structure is left in the value as
 * text, where a writer can see it and decide, rather than silently flattened.
 */
function frontMatter(lines: string[]): { fields: SourceField[]; rest: string[] } {
  if (lines[0]?.trim() !== '---') return { fields: [], rest: lines };
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (close < 0) return { fields: [], rest: lines };
  const fields: SourceField[] = [];
  for (const line of lines.slice(1, close)) {
    const at = line.indexOf(':');
    if (at > 0) {
      fields.push({ key: line.slice(0, at).trim(), value: line.slice(at + 1).trim() });
    }
  }
  return { fields, rest: lines.slice(close + 1) };
}

export function parseMarkdown(path: string, text: string): SourceDoc {
  const { fields: matter, rest } = frontMatter(text.replace(/\r\n?/gu, '\n').split('\n'));

  const root = emptyNode('', 0, null);
  root.fields.push(...matter);
  // The open section at each depth. Index 0 is always the root, so a stray
  // `###` in a file that never had an `#` still has somewhere to attach.
  const open: SourceNode[] = [root];
  let current = root;
  let paragraph: string[] = [];

  const flush = () => {
    const body = paragraph.join('\n').trim();
    if (body) current.text = current.text ? `${current.text}\n\n${body}` : body;
    paragraph = [];
  };

  const openSection = (depth: number, heading: string) => {
    flush();
    // The nearest ancestor shallower than this one. A jump from `#` to `###`
    // nests rather than erroring: real documents skip levels constantly, and
    // refusing the file over it would be this parser having an opinion about
    // the writer's formatting.
    while (open.length > 1 && open[open.length - 1]!.depth >= depth) open.pop();
    const parent = open[open.length - 1]!;
    const node = emptyNode(
      parent.id ? `${parent.id}.${parent.children.length}` : String(parent.children.length),
      depth, heading,
    );
    parent.children.push(node);
    open.push(node);
    current = node;
  };

  let fence: string | null = null;

  for (let i = 0; i < rest.length; i++) {
    const line = rest[i]!;

    // Inside a fence nothing is structure — a table in a code block is a table
    // the writer is showing, not one they are keeping.
    const fenceMark = FENCE.exec(line);
    if (fence) {
      paragraph.push(line);
      if (fenceMark && line.trim().startsWith(fence)) fence = null;
      continue;
    }
    if (fenceMark) { fence = fenceMark[1]![0]!.repeat(3); paragraph.push(line); continue; }

    const atx = ATX.exec(line);
    if (atx) { openSection(atx[1]!.length, atx[2]!.trim()); continue; }

    // A setext underline turns the paragraph above it into a heading; the same
    // characters after a blank line are a horizontal rule. One line of context
    // is the whole difference, and a bible that uses `---` as a divider gets
    // spurious headings without it.
    const setext = SETEXT.exec(line);
    if (setext && paragraph.length > 0 && paragraph[paragraph.length - 1]!.trim()) {
      const heading = paragraph.pop()!.trim();
      openSection(setext[1]!.startsWith('=') ? 1 : 2, heading);
      continue;
    }
    if (THEMATIC.test(line) || setext) { flush(); continue; }

    const next = rest[i + 1];
    if (TABLE_ROW.test(line) && next !== undefined && TABLE_RULE.test(next)
      && next.includes('-')) {
      flush();
      const table: SourceTable = { columns: cells(line), rows: [] };
      i += 2;
      for (; i < rest.length && TABLE_ROW.test(rest[i]!); i++) table.rows.push(cells(rest[i]!));
      i--;
      current.tables.push(table);
      continue;
    }

    const asField = readField(line);
    if (asField) { flush(); current.fields.push(asField); continue; }

    paragraph.push(line);
  }
  flush();

  return { path, format: 'markdown', root };
}

/**
 * Plain text: one document, paragraphs kept, fields still read.
 *
 * Not a separate parser — a `.txt` file is Markdown that happens to use none of
 * it, and treating it as its own format would mean a writer who pasted a note
 * with a `Want:` line in it lost the field for want of a file extension.
 */
export function parseText(path: string, text: string): SourceDoc {
  return { ...parseMarkdown(path, text), format: 'text' };
}
