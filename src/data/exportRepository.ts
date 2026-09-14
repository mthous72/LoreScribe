import type { SqlDriver } from '../db/driver';
import { writeZip, type ZipEntry } from '../export/zip';
import {
  manuscriptMarkdown, manuscriptText, entityMarkdown, factsMarkdown, fileName, uniquely,
  type BookForExport, type EntityForExport, type FactForExport,
} from '../export/markdown';

/**
 * Gathering a project into files a person can read.
 *
 * Bulk reads in SQL rather than repository calls in a loop, the same way
 * `archive.ts` does it: an export walks every scene and every entity in the
 * project, and a query per row turns a novel into several thousand round trips
 * through the worker.
 *
 * The layout is the shape of a story bible, on purpose — a folder per kind, a
 * file per thing — so the bundle comes back in through the importer's existing
 * rules rather than through a reader written for this app's own format. An
 * export only this app can read is a lock-in with a download button.
 */

const BELIEF_CELLS: Record<string, string> = {
  knows: 'yes',
  suspects: 'suspects',
  believes_false: 'believes false',
  denies: 'denies',
};

export class ExportRepository {
  constructor(private readonly driver: SqlDriver) {}

  /* ------------------------------------------------------------- gathering */

  /** Every book in the project, with its prose, in reading order. */
  async books(projectId: string): Promise<BookForExport[]> {
    const rows = await this.#all(
      `SELECT b.id, b.title, p.title, c.id, c.title, s.title, s.content_text, s.word_count
       FROM book b
       JOIN chapter c ON c.book_id = b.id AND c.deleted_at IS NULL
       LEFT JOIN part p ON p.id = c.part_id AND p.deleted_at IS NULL
       LEFT JOIN scene s ON s.chapter_id = c.id AND s.deleted_at IS NULL
       WHERE b.project_id = ? AND b.deleted_at IS NULL
       ORDER BY b.sort_key, IFNULL(p.sort_key, ''), c.sort_key, s.sort_key`, [projectId]);

    const books = new Map<string, BookForExport>();
    // Parts and chapters are grouped as they arrive, which the ORDER BY makes
    // safe: every row belonging to one chapter is contiguous, so a group is
    // never reopened after it has been closed.
    const parts = new Map<string, BookForExport['parts'][number]>();
    const chapters = new Map<string, BookForExport['parts'][number]['chapters'][number]>();

    for (const r of rows) {
      const [bookId, bookTitle, partTitle, chapterId, chapterTitle, sceneTitle, text, words] = r;
      let book = books.get(String(bookId));
      if (!book) {
        book = { title: (bookTitle as string) || 'Untitled book', parts: [] };
        books.set(String(bookId), book);
      }
      const partKey = JSON.stringify([String(bookId), partTitle]);
      let part = parts.get(partKey);
      if (!part) {
        part = { title: (partTitle as string | null) ?? null, chapters: [] };
        parts.set(partKey, part);
        book.parts.push(part);
      }
      let chapter = chapters.get(String(chapterId));
      if (!chapter) {
        chapter = { title: (chapterTitle as string | null) ?? null, scenes: [] };
        chapters.set(String(chapterId), chapter);
        part.chapters.push(chapter);
      }
      // A chapter with no scenes joins as one row of nulls, which is a real
      // chapter with nothing in it rather than a row to discard.
      if (sceneTitle !== null || text !== null) {
        chapter.scenes.push({
          title: (sceneTitle as string | null) ?? null,
          contentText: (text as string | null) ?? null,
          wordCount: Number(words ?? 0),
        });
      }
    }
    return [...books.values()];
  }

  async entities(projectId: string): Promise<EntityForExport[]> {
    const rows = await this.#all(
      `SELECT id, type_key, name, summary, description, attributes, importance, status
       FROM entity WHERE project_id = ? AND deleted_at IS NULL ORDER BY type_key, name`,
      [projectId]);
    const aliases = await this.#all(
      `SELECT a.entity_id, a.alias FROM entity_alias a
       JOIN entity e ON e.id = a.entity_id
       WHERE e.project_id = ? AND e.deleted_at IS NULL AND a.is_primary = 0
       ORDER BY a.alias`, [projectId]);
    const byEntity = new Map<string, string[]>();
    for (const a of aliases) {
      const at = byEntity.get(String(a[0])) ?? [];
      at.push(String(a[1]));
      byEntity.set(String(a[0]), at);
    }
    return rows.map((r) => ({
      name: r[2] as string,
      typeKey: r[1] as string,
      summary: r[3] as string | null,
      description: r[4] as string | null,
      attributes: safeAttributes(r[5]),
      importance: (r[6] as string | null) ?? '',
      status: r[7] as string | null,
      aliases: byEntity.get(String(r[0])) ?? [],
    }));
  }

  /** The facts, and who knows them, as the table wants them. */
  async facts(projectId: string): Promise<{ facts: FactForExport[]; names: string[] }> {
    const rows = await this.#all(
      `SELECT id, statement FROM fact
       WHERE project_id = ? AND deleted_at IS NULL ORDER BY created_at`, [projectId]);
    const knowledge = await this.#all(
      `SELECT k.fact_id, e.name, k.belief, k.learned_how
       FROM fact_knowledge k
       JOIN entity e ON e.id = k.entity_id AND e.deleted_at IS NULL
       JOIN fact f ON f.id = k.fact_id
       WHERE f.project_id = ? AND f.deleted_at IS NULL
       ORDER BY e.name`, [projectId]);

    const names: string[] = [];
    const byFact = new Map<string, Record<string, string>>();
    for (const k of knowledge) {
      const name = String(k[1]);
      if (!names.includes(name)) names.push(name);
      const at = byFact.get(String(k[0])) ?? {};
      at[name] = knowledgeCell(String(k[2]), k[3] as string | null);
      byFact.set(String(k[0]), at);
    }
    return {
      facts: rows.map((r) => ({
        statement: r[1] as string,
        knownBy: byFact.get(String(r[0])) ?? {},
      })),
      names,
    };
  }

  /* ------------------------------------------------------------- assembling */

  /** The whole manuscript as one Markdown document. */
  async manuscript(projectId: string): Promise<string> {
    const books = await this.books(projectId);
    return books.map((b) => manuscriptMarkdown(b)).join('\n');
  }

  /** Every file of the bundle, ready to be zipped. */
  async bundle(projectId: string, projectTitle: string): Promise<ZipEntry[]> {
    const [books, entities, { facts, names }] = await Promise.all([
      this.books(projectId), this.entities(projectId), this.facts(projectId),
    ]);

    const entries: ZipEntry[] = [{ path: 'README.md', content: readme(projectTitle) }];
    const taken = new Set<string>();
    for (const book of books) {
      const base = uniquely(fileName(book.title, 'book'), taken);
      entries.push({ path: `manuscript/${base}.md`, content: manuscriptMarkdown(book) });
      entries.push({ path: `manuscript/${base}.txt`, content: manuscriptText(book) });
    }

    const perFolder = new Map<string, Set<string>>();
    for (const entity of entities) {
      // A folder per kind, named the way the importer's own rules read it back.
      const folder = `${entity.typeKey}s`;
      const used = perFolder.get(folder) ?? new Set<string>();
      perFolder.set(folder, used);
      const name = uniquely(fileName(entity.name, 'entry'), used);
      entries.push({ path: `${folder}/${name}.md`, content: entityMarkdown(entity) });
    }

    if (facts.length) {
      entries.push({ path: 'reference/knowledge.md', content: factsMarkdown(facts, names) });
    }
    return entries;
  }

  async zip(projectId: string, projectTitle: string): Promise<Uint8Array> {
    return writeZip(await this.bundle(projectId, projectTitle));
  }

  async #all(sql: string, params: unknown[]): Promise<unknown[][]> {
    const { rows } = await this.driver.query(sql, params, 'all');
    return rows as unknown[][];
  }
}

/**
 * One cell of the who-knows-what table.
 *
 * The belief word comes first even when the writer left a note, because the
 * importer reads the front of the cell to decide what the belief is. Writing
 * only the note was the first version, and it round-tripped `suspects` back as
 * plain knowing — the whole distinction the column exists for, lost on the way
 * out and impossible to notice on the way back in.
 *
 * Plain knowing is the exception: `knows` with a note is written as just the
 * note, because "yes — from the clerk" reads worse than "from the clerk" and
 * comes back the same either way.
 */
function knowledgeCell(belief: string, learnedHow: string | null): string {
  const word = BELIEF_CELLS[belief] ?? 'yes';
  if (!learnedHow) return word;
  return belief === 'knows' ? learnedHow : `${word} — ${learnedHow}`;
}

/**
 * Attributes that will not parse are not a reason to refuse the export.
 *
 * The export runs when a writer is worried about losing their work, which is
 * the worst possible moment to throw on one malformed column.
 */
function safeAttributes(raw: unknown): Record<string, string> {
  if (typeof raw !== 'string' || !raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
  } catch { return {}; }
}

/** What whoever opens this folder in five years needs to be told. */
function readme(projectTitle: string): string {
  return `# ${projectTitle}

Exported from LoreScribe on ${new Date().toISOString().slice(0, 10)}.

This is the **readable** copy: plain Markdown, no database, nothing that needs
this or any other program to open. Every file here can be read in a text editor.

    manuscript/   the book, as one Markdown file and one plain text file
    characters/   one file per person
    locations/    one file per place
    reference/    who knows what, as a table

LoreScribe reads this folder back in — the layout is the thing it recognises, so
you can edit these files anywhere and import them again. What comes back is the
names, the prose, the key/value fields under each entry, and the table of who
knows what.

What does **not** come back is the fine structure: internal ids, the ordering
keys, revision history, kept drafts, and the links between a scene's text and
your codex entries. For that, keep a \`.lorescribe\` archive as well — it is the
complete copy, and this is the one you can read.
`;
}
