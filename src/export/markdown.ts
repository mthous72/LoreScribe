/**
 * The manuscript and the world, as files a person can read.
 *
 * There are two exports and they are not competing. The `.lorescribe` archive is
 * the **complete** one — every column, every id, restorable exactly ([D9](../../docs/10-decisions.md)).
 * This is the **readable** one: Markdown a writer can open in any editor, put in
 * a git repository, send to someone, or read in ten years when this app is
 * gone. Where the two disagree, the archive is the backup and this is the copy.
 *
 * The layout is not arbitrary. It is the shape a story bible already has — a
 * folder per kind, a file per thing — which means the bundle this produces is
 * one the importer reads back, through exactly the rules it already had for
 * material a writer wrote by hand. `characters/ilva.md` comes back as a
 * character because it sits in `characters/`, not because the exporter left a
 * marker in it for itself. An export only this app can read is a lock-in with a
 * download button.
 *
 * What round-trips is stated rather than implied: entity names, their prose,
 * their attribute fields, and the who-knows-what table. Ids, ranks, revisions
 * and the fine structure of a scene do not — that is what the archive is for,
 * and `README.md` in the bundle says so to whoever opens it.
 */

export interface SceneForExport {
  title: string | null;
  contentText: string | null;
  wordCount: number;
}
export interface ChapterForExport {
  title: string | null;
  scenes: SceneForExport[];
}
export interface PartForExport {
  title: string | null;
  chapters: ChapterForExport[];
}
export interface BookForExport {
  title: string;
  parts: PartForExport[];
}

export interface EntityForExport {
  name: string;
  typeKey: string;
  summary: string | null;
  description: string | null;
  attributes: Record<string, string>;
  importance: string;
  status: string | null;
  aliases: string[];
}

export interface FactForExport {
  statement: string;
  /** Entity name to what they believe, for the columns. */
  knownBy: Record<string, string>;
}

/** Blank lines between blocks, and exactly one trailing newline. */
const join = (blocks: readonly (string | null | undefined)[]): string =>
  `${blocks.filter((b) => b && b.trim()).join('\n\n').trim()}\n`;

/* -------------------------------------------------------------- manuscript */

export interface ManuscriptOptions {
  /** Scene titles as headings. Off gives the `***` a finished manuscript uses. */
  sceneTitles?: boolean;
}

export function manuscriptMarkdown(book: BookForExport, options: ManuscriptOptions = {}): string {
  const sceneTitles = options.sceneTitles ?? true;
  const blocks: string[] = [`# ${book.title}`];

  for (const part of book.parts) {
    if (part.title) blocks.push(`## ${part.title}`);
    for (const chapter of part.chapters) {
      // Chapters sit at the same level whether or not the book has parts, so a
      // book that gains one later does not reshuffle every heading in the file.
      blocks.push(`### ${chapter.title ?? 'Untitled chapter'}`);
      chapter.scenes.forEach((scene, i) => {
        if (sceneTitles) blocks.push(`#### ${scene.title ?? 'Untitled scene'}`);
        else if (i > 0) blocks.push('***');
        const prose = (scene.contentText ?? '').trim();
        // An empty scene is said to be empty rather than skipped: a writer
        // checking an export against their outline needs the gaps to show.
        blocks.push(prose || '*(nothing written yet)*');
      });
    }
  }
  return join(blocks);
}

/**
 * The same manuscript with no Markdown in it at all.
 *
 * The parity bar asks for plain text beside Markdown, and it is not the same
 * file with the hashes stripped: a title that reads `# Chapter 1` in a plain
 * text file is a leftover, not a heading. Levels are shown by spacing and by a
 * rule, the way a typescript does it.
 */
export function manuscriptText(book: BookForExport): string {
  const lines: string[] = [book.title.toUpperCase(), ''];
  for (const part of book.parts) {
    if (part.title) lines.push('', part.title.toUpperCase(), '');
    for (const chapter of part.chapters) {
      lines.push('', chapter.title ?? 'Untitled chapter', '');
      chapter.scenes.forEach((scene, i) => {
        if (i > 0) lines.push('', '* * *', '');
        lines.push((scene.contentText ?? '').trim() || '(nothing written yet)');
      });
    }
  }
  return `${lines.join('\n').replace(/\n{3,}/gu, '\n\n').trim()}\n`;
}

/* ------------------------------------------------------------------- codex */

/**
 * One codex entry.
 *
 * Aliases, importance and status are key/value lines because that is what the
 * importer reads back as fields — the same shape a writer's own
 * `Want:` / `Lie:` lines have, and the same shape it reads them in.
 */
export function entityMarkdown(entity: EntityForExport): string {
  const header: string[] = [];
  if (entity.aliases.length) header.push(`Also known as: ${entity.aliases.join(', ')}`);
  if (entity.importance) header.push(`Importance: ${entity.importance}`);
  if (entity.status) header.push(`Status: ${entity.status}`);

  const attributes = Object.entries(entity.attributes)
    .map(([key, value]) => `${titleCase(key)}: ${value}`);

  return join([
    `# ${entity.name}`,
    header.join('\n'),
    entity.summary,
    entity.description,
    attributes.length ? '## Attributes' : null,
    attributes.join('\n'),
  ]);
}

/** `beat path` back to `Beat path` — the writer wrote it that way. */
const titleCase = (key: string): string => key.charAt(0).toUpperCase() + key.slice(1);

/* ------------------------------------------------------------------- facts */

/**
 * A cell of a Markdown table.
 *
 * A pipe inside a cell ends the cell, so it is escaped; a newline ends the row,
 * so it becomes a space. Both are silent corruption otherwise — the table still
 * renders, with the columns shifted by one from the row where it happened.
 */
export const cell = (text: string): string =>
  text.replace(/\|/gu, '\\|').replace(/\s*\n\s*/gu, ' ').trim();

export function factsMarkdown(facts: readonly FactForExport[], names: readonly string[]): string {
  if (!facts.length) return join(['# Who knows what', '*No facts recorded yet.*']);
  const columns = ['Fact', ...names];
  const rows = facts.map((f) =>
    [cell(f.statement), ...names.map((n) => cell(f.knownBy[n] ?? 'no'))]);
  return join([
    '# Who knows what',
    'Facts down the rows, who knows them across. This table reads back in.',
    [
      `| ${columns.map(cell).join(' | ')} |`,
      `|${columns.map(() => '---').join('|')}|`,
      ...rows.map((r) => `| ${r.join(' | ')} |`),
    ].join('\n'),
  ]);
}

/* ------------------------------------------------------------------ naming */

/** A file name from a title: readable, unique-ish, and safe on every platform. */
export function fileName(title: string, fallback = 'untitled'): string {
  const base = title
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .toLowerCase()
    .slice(0, 60);
  return base || fallback;
}

/** Make a name unique within a folder by numbering the repeats. */
export function uniquely(name: string, taken: Set<string>): string {
  if (!taken.has(name)) { taken.add(name); return name; }
  for (let n = 2; ; n++) {
    const candidate = `${name}-${n}`;
    if (!taken.has(candidate)) { taken.add(candidate); return candidate; }
  }
}
