import type { SqlDriver } from '../db/driver';
import { deviceId, uuidv7 } from './ids';
import { markStale } from '../index/indexState';
import { codexFtsStatements } from '../index/codexIndex';

/**
 * The codex: entities, their aliases, and the relationships between them.
 *
 * Same discipline as the other repositories — every mutation and its `op_log`
 * row in one batch. Three things here are specific to the codex, and each of
 * them is a trap that would fail silently rather than loudly:
 *
 *  1. **An entity is found in prose by its ALIASES, never by its name.** The
 *     matcher reads `entity_alias`; `entity.name` is a label. So creating an
 *     entity mints a primary alias from its name, and renaming one carries that
 *     alias along. Without this, a writer creates "Ilva", types Ilva into a
 *     scene, and nothing happens — with no error to explain why.
 *  2. **Editing aliases invalidates every scene's mentions.** Adding "the
 *     Warden" changes what the manuscript means, retroactively. The kind is
 *     marked stale here; re-scanning is the caller's to trigger, because it
 *     walks the whole book and should be visible while it does.
 *  3. **`maturity` and `is_real_person` are compliance fields, not decoration.**
 *     The hard floor reads them before any model call ([doc 13](../../docs/13-legal-and-compliance.md)),
 *     so they default to the honest answer — `unknown` — rather than to the
 *     convenient one.
 */

export interface AttributeField {
  name: string;
  label: string;
  /** Render as a textarea rather than a single line. */
  long: boolean;
}

export interface EntityType {
  key: string;
  label: string;
  icon: string | null;
  /** Parsed from the type's JSON Schema, so a field added there needs no code. */
  attributes: AttributeField[];
}

export interface Entity {
  id: string;
  projectId: string;
  typeKey: string;
  name: string;
  summary: string | null;
  description: string | null;
  attributes: Record<string, string>;
  importance: string;
  status: string | null;
  maturity: string;
  isRealPerson: boolean;
  rev: number;
}

export interface Alias {
  id: string;
  entityId: string;
  alias: string;
  kind: string | null;
  isPrimary: boolean;
  autoLink: boolean;
  linkableFromSceneId: string | null;
}

export interface Relationship {
  id: string;
  fromEntityId: string;
  toEntityId: string;
  /** The other end, for rendering without a second query. */
  otherName: string;
  otherId: string;
  outgoing: boolean;
  kind: string;
  label: string | null;
  strength: number | null;
  isSecret: boolean;
  notes: string | null;
}

/** A scene an entity appears in — the backlink. */
export interface SceneMention {
  sceneId: string;
  sceneTitle: string | null;
  chapterTitle: string | null;
  globalRank: string;
  role: string;
  aliasUsed: string | null;
}

/** An entity appearing in a scene — the same rows read the other way. */
export interface EntityMention {
  entityId: string;
  name: string;
  typeKey: string;
  summary: string | null;
  role: string;
  aliasUsed: string | null;
}

export interface EntityDetail {
  entity: Entity;
  aliases: Alias[];
  relationships: Relationship[];
}

export type EntityDraft = Partial<Omit<Entity, 'id' | 'projectId' | 'rev'>> & { name: string };

interface Statement { sql: string; params: unknown[] }

/** Turn a type's JSON Schema into the fields an editor should show. */
export function attributeFields(schemaJson: string | null): AttributeField[] {
  if (!schemaJson) return [];
  try {
    const schema = JSON.parse(schemaJson) as {
      properties?: Record<string, { type?: string; 'x-long'?: boolean }>;
    };
    return Object.entries(schema.properties ?? {}).map(([name, spec]) => ({
      name,
      // "voice_profile" reads as a column name; a writer should see words.
      label: name.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
      long: spec['x-long'] === true,
    }));
  } catch {
    // A malformed schema costs the type's extra fields, not the type.
    return [];
  }
}

export class CodexRepository {
  constructor(private readonly driver: SqlDriver) {}

  /* ------------------------------------------------------------------ reads */

  /** Built-in types plus any this project defined. */
  async listTypes(projectId: string): Promise<EntityType[]> {
    const rows = await this.#all(
      `SELECT key, label, icon, attribute_schema_json FROM entity_type
       WHERE project_id IS NULL OR project_id = ? ORDER BY project_id IS NOT NULL, label`,
      [projectId]);
    return rows.map((r) => ({
      key: r[0] as string,
      label: r[1] as string,
      icon: r[2] as string | null,
      attributes: attributeFields(r[3] as string | null),
    }));
  }

  async listEntities(
    projectId: string, filter: { typeKey?: string; search?: string } = {},
  ): Promise<Entity[]> {
    const where = ['e.project_id = ?', 'e.deleted_at IS NULL'];
    const params: unknown[] = [projectId];
    if (filter.typeKey) { where.push('e.type_key = ?'); params.push(filter.typeKey); }
    if (filter.search?.trim()) {
      // Matches an alias as well as the name: a writer looking for "the Warden"
      // should find Ilva, which is the entire point of keeping aliases.
      where.push(`(e.name LIKE ? OR EXISTS (
        SELECT 1 FROM entity_alias a WHERE a.entity_id = e.id AND a.alias LIKE ?))`);
      params.push(`%${filter.search.trim()}%`, `%${filter.search.trim()}%`);
    }
    const rows = await this.#all(
      `SELECT ${ENTITY_COLUMNS} FROM entity e
       WHERE ${where.join(' AND ')} ORDER BY e.name COLLATE NOCASE`, params);
    return rows.map(toEntity);
  }

  async getEntity(id: string): Promise<EntityDetail | null> {
    const rows = await this.#all(
      `SELECT ${ENTITY_COLUMNS} FROM entity e WHERE e.id = ? AND e.deleted_at IS NULL`, [id]);
    if (!rows[0]) return null;
    return {
      entity: toEntity(rows[0]),
      aliases: await this.listAliases(id),
      relationships: await this.listRelationships(id),
    };
  }

  async listAliases(entityId: string): Promise<Alias[]> {
    const rows = await this.#all(
      `SELECT id, entity_id, alias, kind, is_primary, auto_link, linkable_from_scene_id
       FROM entity_alias WHERE entity_id = ? ORDER BY is_primary DESC, alias COLLATE NOCASE`,
      [entityId]);
    return rows.map((r) => ({
      id: r[0] as string, entityId: r[1] as string, alias: r[2] as string,
      kind: r[3] as string | null, isPrimary: Number(r[4]) !== 0,
      autoLink: Number(r[5]) !== 0, linkableFromSceneId: r[6] as string | null,
    }));
  }

  /** Both directions, because a relationship is a fact about both ends. */
  async listRelationships(entityId: string): Promise<Relationship[]> {
    const rows = await this.#all(
      `SELECT r.id, r.from_entity_id, r.to_entity_id, r.kind, r.label, r.strength,
              r.is_secret, r.notes, f.name, t.name
       FROM entity_relationship r
       JOIN entity f ON f.id = r.from_entity_id
       JOIN entity t ON t.id = r.to_entity_id
       WHERE (r.from_entity_id = ? OR r.to_entity_id = ?) AND r.deleted_at IS NULL
       ORDER BY r.kind`, [entityId, entityId]);
    return rows.map((r) => {
      const outgoing = r[1] === entityId;
      return {
        id: r[0] as string, fromEntityId: r[1] as string, toEntityId: r[2] as string,
        kind: r[3] as string, label: r[4] as string | null,
        strength: r[5] === null ? null : Number(r[5]),
        isSecret: Number(r[6]) !== 0, notes: r[7] as string | null,
        outgoing,
        otherId: (outgoing ? r[2] : r[1]) as string,
        otherName: (outgoing ? r[9] : r[8]) as string,
      };
    });
  }

  /**
   * Where this entity appears, in reading order.
   *
   * The backlink half of the lore graph, and the reason `mention` is a table
   * rather than a highlight computed in the editor: a decoration can tell the
   * writer that "Ilva" is on the screen in front of them, but only a row can
   * answer "which scenes is she in, and which is the last one before chapter
   * twelve".
   *
   * Reads `global_rank` for the order, so a scene moved in the tree moves here
   * too without this query knowing anything about it.
   */
  async scenesMentioning(entityId: string): Promise<SceneMention[]> {
    const rows = await this.#all(
      `SELECT s.id, s.title, c.title, s.global_rank, m.role, m.alias_used
       FROM mention m
       JOIN scene s   ON s.id = m.scene_id
       JOIN chapter c ON c.id = s.chapter_id
       WHERE m.entity_id = ? AND s.deleted_at IS NULL
       ORDER BY s.global_rank`, [entityId]);
    return rows.map((r) => ({
      sceneId: r[0] as string, sceneTitle: r[1] as string | null,
      chapterTitle: r[2] as string | null, globalRank: r[3] as string,
      role: r[4] as string, aliasUsed: r[5] as string | null,
    }));
  }

  /**
   * Who and what is in this scene, most important first.
   *
   * `pov` before `focus` before `present` before `mentioned` — the same order
   * the scene brief compiler will seed from, expressed once in SQL rather than
   * re-sorted by each caller.
   */
  async entitiesInScene(sceneId: string): Promise<EntityMention[]> {
    const rows = await this.#all(
      `SELECT e.id, e.name, e.type_key, e.summary, m.role, m.alias_used
       FROM mention m
       JOIN entity e ON e.id = m.entity_id
       WHERE m.scene_id = ? AND e.deleted_at IS NULL
       ORDER BY CASE m.role
                  WHEN 'pov' THEN 0 WHEN 'focus' THEN 1
                  WHEN 'present' THEN 2 ELSE 3 END,
                e.name COLLATE NOCASE`, [sceneId]);
    return rows.map((r) => ({
      entityId: r[0] as string, name: r[1] as string, typeKey: r[2] as string,
      summary: r[3] as string | null, role: r[4] as string,
      aliasUsed: r[5] as string | null,
    }));
  }

  /* ------------------------------------------------------------------- types */

  /**
   * A type this project defines, from a label. The key is the label's slug;
   * `entity_type.key` is one namespace across projects, so a slug another
   * project already took gets this project's suffix. A key this project or
   * the built-ins already have is returned as it is.
   */
  async createType(projectId: string, label: string): Promise<EntityType> {
    const clean = label.trim();
    if (!clean) throw new Error('a type needs a name');
    const slug = clean.toLowerCase().replace(/[^a-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '').slice(0, 40) || 'type';
    const rows = await this.#all(
      'SELECT key, project_id, label, icon, attribute_schema_json FROM entity_type WHERE key = ?', [slug]);
    const taken = rows[0];
    let key = slug;
    if (taken) {
      if (taken[1] === null || taken[1] === projectId) {
        return {
          key: taken[0] as string, label: taken[2] as string, icon: taken[3] as string | null,
          attributes: attributeFields(taken[4] as string | null),
        };
      }
      key = `${slug}_${projectId.slice(-4)}`;
    }
    const schema = JSON.stringify({ type: 'object', properties: {} });
    await this.driver.batch([
      {
        sql: 'INSERT OR IGNORE INTO entity_type (key, project_id, label, icon, attribute_schema_json) VALUES (?,?,?,NULL,?)',
        params: [key, projectId, clean, schema],
      },
      this.#op('entity_type', key, 'insert', { projectId, label: clean }, Date.now()),
    ], true);
    return { key, label: clean, icon: null, attributes: [] };
  }

  /**
   * Give a type's editor a field for an attribute its entries already carry.
   * Built-in types are shared by every project on this device; with one
   * writer ([D7](../../docs/10-decisions.md)) that is a convenience, not a leak.
   */
  async addAttributeField(typeKey: string, name: string, long = false): Promise<void> {
    const field = name.trim().toLowerCase().replace(/[^a-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '');
    if (!field) throw new Error('a field needs a name');
    const rows = await this.#all('SELECT attribute_schema_json FROM entity_type WHERE key = ?', [typeKey]);
    if (!rows[0]) throw new Error(`no type “${typeKey}”`);
    let schema: { type?: string; properties?: Record<string, unknown> } = { type: 'object', properties: {} };
    try {
      const parsed = JSON.parse((rows[0][0] as string | null) ?? '') as typeof schema;
      if (parsed && typeof parsed === 'object') schema = { type: 'object', ...parsed, properties: { ...(parsed.properties ?? {}) } };
    } catch { /* an unreadable schema is replaced, keeping nothing it hid */ }
    if (schema.properties![field]) return;
    schema.properties![field] = long ? { type: 'string', 'x-long': true } : { type: 'string' };
    await this.driver.batch([
      { sql: 'UPDATE entity_type SET attribute_schema_json = ? WHERE key = ?', params: [JSON.stringify(schema), typeKey] },
      this.#op('entity_type', typeKey, 'update', { addedField: field }, Date.now()),
    ], true);
  }

  /* ---------------------------------------------------------------- entities */

  async createEntity(projectId: string, draft: EntityDraft): Promise<Entity> {
    const now = Date.now();
    const id = uuidv7(now);
    const entity: Entity = {
      id, projectId,
      typeKey: draft.typeKey ?? 'character',
      name: draft.name,
      summary: draft.summary ?? null,
      description: draft.description ?? null,
      attributes: draft.attributes ?? {},
      importance: draft.importance ?? 'minor',
      status: draft.status ?? null,
      maturity: draft.maturity ?? 'unknown',
      isRealPerson: draft.isRealPerson ?? false,
      rev: 1,
    };

    await this.driver.batch([
      {
        sql: `INSERT INTO entity (id,project_id,type_key,name,summary,description,attributes,
                importance,status,maturity,is_real_person,created_at,updated_at,rev)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
        params: [id, projectId, entity.typeKey, entity.name, entity.summary, entity.description,
          JSON.stringify(entity.attributes), entity.importance, entity.status,
          entity.maturity, entity.isRealPerson ? 1 : 0, now, now],
      },
      this.#op('entity', id, 'insert', entity, now),
      // The primary alias, without which this entity is invisible to the prose.
      ...this.#aliasInsert(uuidv7(now), id, entity.name, 'name', true, now),
      // And the search index, without which it is invisible to search until
      // somebody runs a wholesale rebuild.
      ...codexFtsStatements('entity', id),
    ], true);

    await markStale(this.driver, ['mention']);
    return entity;
  }

  /**
   * Update an entity, carrying its primary alias along with a rename.
   *
   * Only when the primary alias still matches the old name: once a writer has
   * edited it by hand it is theirs, and silently overwriting it would undo a
   * deliberate choice — "Kaelen" renamed to "Kaelen Voss" should not clobber a
   * primary alias the writer set to "Kael".
   */
  async updateEntity(id: string, patch: Partial<EntityDraft>): Promise<void> {
    const now = Date.now();
    const before = await this.getEntity(id);
    if (!before) return;

    const columns: Record<string, unknown> = {};
    if (patch.name !== undefined) columns.name = patch.name;
    if (patch.typeKey !== undefined) columns.type_key = patch.typeKey;
    if (patch.summary !== undefined) columns.summary = patch.summary;
    if (patch.description !== undefined) columns.description = patch.description;
    if (patch.attributes !== undefined) columns.attributes = JSON.stringify(patch.attributes);
    if (patch.importance !== undefined) columns.importance = patch.importance;
    if (patch.status !== undefined) columns.status = patch.status;
    if (patch.maturity !== undefined) columns.maturity = patch.maturity;
    if (patch.isRealPerson !== undefined) columns.is_real_person = patch.isRealPerson ? 1 : 0;
    if (!Object.keys(columns).length) return;

    const sets = Object.keys(columns).map((c) => `${c} = ?`).join(', ');
    const writes: Statement[] = [
      {
        sql: `UPDATE entity SET ${sets}, updated_at = ?, rev = rev + 1
              WHERE id = ? AND deleted_at IS NULL`,
        params: [...Object.values(columns), now, id],
      },
      this.#op('entity', id, 'update', patch, now),
    ];

    const renamed = patch.name !== undefined && patch.name !== before.entity.name;
    const primary = before.aliases.find((a) => a.isPrimary);
    if (renamed && primary && primary.alias === before.entity.name) {
      writes.push({
        sql: 'UPDATE entity_alias SET alias = ? WHERE id = ?',
        params: [patch.name, primary.id],
      });
      writes.push(this.#op('entity_alias', primary.id, 'update', { alias: patch.name }, now));
    }

    writes.push(...codexFtsStatements('entity', id));
    await this.driver.batch(writes, true);
    if (renamed) await markStale(this.driver, ['mention']);
  }

  /**
   * Soft delete, taking the derived rows with it.
   *
   * The entity row stays as a tombstone a sync can replicate; its mentions do
   * not, because they are a cache describing a link that no longer exists and
   * every backlink query would still return them.
   */
  async removeEntity(id: string): Promise<void> {
    const now = Date.now();
    await this.driver.batch([
      {
        sql: `UPDATE entity SET deleted_at = ?, updated_at = ?, rev = rev + 1
              WHERE id = ? AND deleted_at IS NULL`,
        params: [now, now, id],
      },
      this.#op('entity', id, 'delete', null, now),
      { sql: 'DELETE FROM mention WHERE entity_id = ?', params: [id] },
      // Aliases are not a tombstone anyone needs and they would keep matching.
      { sql: 'DELETE FROM entity_alias WHERE entity_id = ?', params: [id] },
      // The INSERT half finds no undeleted row, so this removes it from search.
      ...codexFtsStatements('entity', id),
    ], true);
    await markStale(this.driver, ['mention']);
  }

  /* ----------------------------------------------------------------- aliases */

  async addAlias(
    entityId: string, alias: string,
    options: { kind?: string; autoLink?: boolean; linkableFromSceneId?: string | null } = {},
  ): Promise<Alias> {
    const now = Date.now();
    const id = uuidv7(now);
    await this.driver.batch(
      this.#aliasInsert(id, entityId, alias, options.kind ?? null, false, now,
        options.autoLink ?? true, options.linkableFromSceneId ?? null), true);
    await markStale(this.driver, ['mention']);
    return {
      id, entityId, alias, kind: options.kind ?? null, isPrimary: false,
      autoLink: options.autoLink ?? true,
      linkableFromSceneId: options.linkableFromSceneId ?? null,
    };
  }

  async updateAlias(
    id: string,
    patch: { alias?: string; autoLink?: boolean; linkableFromSceneId?: string | null },
  ): Promise<void> {
    const now = Date.now();
    const columns: Record<string, unknown> = {};
    if (patch.alias !== undefined) columns.alias = patch.alias;
    if (patch.autoLink !== undefined) columns.auto_link = patch.autoLink ? 1 : 0;
    if (patch.linkableFromSceneId !== undefined) {
      columns.linkable_from_scene_id = patch.linkableFromSceneId;
    }
    if (!Object.keys(columns).length) return;
    await this.driver.batch([
      {
        sql: `UPDATE entity_alias SET ${Object.keys(columns).map((c) => `${c} = ?`).join(', ')}
              WHERE id = ?`,
        params: [...Object.values(columns), id],
      },
      this.#op('entity_alias', id, 'update', patch, now),
    ], true);
    await markStale(this.driver, ['mention']);
  }

  async removeAlias(id: string): Promise<void> {
    const now = Date.now();
    await this.driver.batch([
      { sql: 'DELETE FROM entity_alias WHERE id = ?', params: [id] },
      this.#op('entity_alias', id, 'delete', null, now),
    ], true);
    await markStale(this.driver, ['mention']);
  }

  /* ----------------------------------------------------------- relationships */

  async addRelationship(
    projectId: string, fromEntityId: string, toEntityId: string, kind: string,
    options: { label?: string; strength?: number; isSecret?: boolean; notes?: string } = {},
  ): Promise<string> {
    const now = Date.now();
    const id = uuidv7(now);
    await this.driver.batch([
      {
        sql: `INSERT INTO entity_relationship (id,project_id,from_entity_id,to_entity_id,kind,
                label,strength,is_secret,notes,created_at,updated_at,rev)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`,
        params: [id, projectId, fromEntityId, toEntityId, kind, options.label ?? null,
          options.strength ?? null, options.isSecret ? 1 : 0, options.notes ?? null, now, now],
      },
      this.#op('entity_relationship', id, 'insert',
        { fromEntityId, toEntityId, kind, ...options }, now),
    ], true);
    return id;
  }

  async removeRelationship(id: string): Promise<void> {
    const now = Date.now();
    await this.driver.batch([
      {
        sql: `UPDATE entity_relationship SET deleted_at = ?, updated_at = ?, rev = rev + 1
              WHERE id = ? AND deleted_at IS NULL`,
        params: [now, now, id],
      },
      this.#op('entity_relationship', id, 'delete', null, now),
    ], true);
  }

  /* ----------------------------------------------------------------- private */

  async #all(sql: string, params: unknown[]): Promise<unknown[][]> {
    const { rows } = await this.driver.query(sql, params, 'all');
    return rows as unknown[][];
  }

  #aliasInsert(
    id: string, entityId: string, alias: string, kind: string | null, isPrimary: boolean,
    now: number, autoLink = true, linkableFromSceneId: string | null = null,
  ): Statement[] {
    return [
      {
        sql: `INSERT INTO entity_alias (id,entity_id,alias,kind,is_primary,auto_link,
                linkable_from_scene_id,created_at)
              VALUES (?,?,?,?,?,?,?,?)`,
        params: [id, entityId, alias, kind, isPrimary ? 1 : 0, autoLink ? 1 : 0,
          linkableFromSceneId, now],
      },
      this.#op('entity_alias', id, 'insert', { entityId, alias, isPrimary }, now),
    ];
  }

  #op(table: string, rowId: string, op: string, payload: unknown, ts: number): Statement {
    return {
      sql: 'INSERT INTO op_log (device_id,table_name,row_id,op,payload,ts) VALUES (?,?,?,?,?,?)',
      params: [deviceId(), table, rowId, op, payload === null ? null : JSON.stringify(payload), ts],
    };
  }
}

const ENTITY_COLUMNS = `e.id, e.project_id, e.type_key, e.name, e.summary, e.description,
  e.attributes, e.importance, e.status, e.maturity, e.is_real_person, e.rev`;

function toEntity(r: unknown[]): Entity {
  let attributes: Record<string, string> = {};
  try { attributes = JSON.parse((r[6] as string | null) ?? '{}') as Record<string, string>; }
  catch { /* a corrupt blob costs the extra fields, not the entity */ }
  return {
    id: r[0] as string, projectId: r[1] as string, typeKey: r[2] as string,
    name: r[3] as string, summary: r[4] as string | null, description: r[5] as string | null,
    attributes,
    importance: (r[7] as string | null) ?? 'minor',
    status: r[8] as string | null,
    maturity: (r[9] as string | null) ?? 'unknown',
    isRealPerson: Number(r[10]) !== 0,
    rev: Number(r[11]),
  };
}
