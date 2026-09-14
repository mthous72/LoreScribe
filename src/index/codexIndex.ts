/**
 * `codex_fts` for one codex row.
 *
 * Exists because the codex had no equivalent of `sceneFtsStatements`: prose
 * reached the search index on every save, and an entity reached it only when
 * somebody ran a wholesale rebuild. Creating a character and immediately
 * failing to find it is the index lying about what the book contains — the
 * exact failure `index_state` was built to make impossible, arriving through
 * the one door that had no lock on it.
 *
 * The body expression is defined ONCE, here, and used both by these per-row
 * statements and by the wholesale rebuild in `rebuild.ts`. Two spellings of
 * "what text represents an entity" would mean a rebuild silently changed the
 * data rather than restoring it, which is the same trap that produced two
 * encodings of `global_rank`.
 */

export type CodexOwner = 'entity' | 'fact' | 'note';

/**
 * How each kind of row becomes a searchable name and body.
 *
 * `name` is what the result list shows; `body` is everything else worth
 * matching on. Both are SQL so that the rebuild can insert a whole project in
 * one statement without marshalling rows into JavaScript and back.
 */
export const CODEX_SOURCE: Record<CodexOwner, { table: string; name: string; body: string }> = {
  entity: {
    table: 'entity',
    name: 'name',
    body: "COALESCE(summary,'') || ' ' || COALESCE(description,'')",
  },
  fact: { table: 'fact', name: 'predicate', body: 'statement' },
  note: { table: 'note', name: "COALESCE(title,'')", body: "COALESCE(body,'')" },
};

/** Every row of one kind in a project — what a rebuild inserts. */
export function codexFtsRebuild(owner: CodexOwner): string {
  const s = CODEX_SOURCE[owner];
  return `INSERT INTO codex_fts (owner_table, owner_id, name, body)
          SELECT '${owner}', id, ${s.name}, ${s.body}
          FROM ${s.table} WHERE project_id = ? AND deleted_at IS NULL`;
}

/**
 * Delete-then-insert for one row, for the write path.
 *
 * The INSERT re-reads the row rather than taking values from the caller, so it
 * cannot disagree with what was just written — and it inserts nothing at all
 * for a soft-deleted row, which makes this the delete path too.
 */
export function codexFtsStatements(
  owner: CodexOwner, id: string,
): { sql: string; params: unknown[] }[] {
  const s = CODEX_SOURCE[owner];
  return [
    {
      sql: 'DELETE FROM codex_fts WHERE owner_table = ? AND owner_id = ?',
      params: [owner, id],
    },
    {
      sql: `INSERT INTO codex_fts (owner_table, owner_id, name, body)
            SELECT '${owner}', id, ${s.name}, ${s.body}
            FROM ${s.table} WHERE id = ? AND deleted_at IS NULL`,
      params: [id],
    },
  ];
}
