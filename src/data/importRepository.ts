import type { SqlDriver } from '../db/driver';
import { deviceId, uuidv7 } from './ids';
import type { CodexRepository } from './codexRepository';
import type { FactsRepository, Belief } from './factsRepository';
import type { ManuscriptRepository } from './manuscriptRepository';
import type { PlanRepository } from './planRepository';
import { subtreeText, walk, type SourceDoc, type SourceNode } from '../import/source';
import { absorbedFields, defaultFieldTarget, nameKey, type Destination } from '../import/plan';
import { firstClause, readOutline, ruleItems, splitName, type OutlinePart } from '../import/outline';

/**
 * Staging an import, applying it, and taking it back.
 *
 * Nothing an import produces touches live data until the writer accepts it —
 * which is not a new idea here, it is what `proposal_run` / `proposal` were put
 * in the schema for. That table's `seed_kind` column has listed `import` since
 * it was written; this is the first thing to use it, and the first without an
 * `ai_run_id`, which is why that column is nullable. Phase 2's extraction lane
 * lands in the same two tables and is reviewed by the same screen.
 *
 * Two consequences worth stating, because they are what make an import safe to
 * try rather than something to be careful with:
 *
 * **Proposals refer to things by name, never by id.** A fact about Jeru points
 * at the string "Jeru" and is resolved when it is applied. Minting ids at
 * staging time would mean rejecting the entity left the fact pointing at a row
 * that was never created — so a rejection would corrupt the import rather than
 * shrink it. Resolution happens once, in order, against everything the codex
 * already has plus everything this run just made.
 *
 * **An applied import can be taken back.** A bad mapping writes two hundred
 * rows, and "delete them by hand" is not an answer. Creates are soft-deleted;
 * updates are restored from the previous values, which are captured onto the
 * proposal at the moment it is applied precisely so that undo is possible.
 *
 * The `status` columns carry more values than their schema comments list —
 * `applied`, `failed` and `undone` beyond `pending|accepted|rejected`, and
 * `undone` on the run. They are free text with no constraint, so this needs no
 * migration; it is recorded here because the comment in `db/schema.sql` is now
 * a subset rather than the whole set.
 */

export type ProposalStatus = 'pending' | 'accepted' | 'rejected' | 'applied' | 'failed' | 'undone';
export type RunStatus = 'staged' | 'applied' | 'abandoned' | 'undone';

export interface ImportRun {
  id: string;
  projectId: string;
  status: RunStatus;
  createdAt: number;
  appliedAt: number | null;
  /** How many proposals sit at each status. What the review screen counts. */
  counts: Record<string, number>;
}

export interface ProposalRow {
  id: string;
  runId: string;
  targetTable: string;
  targetId: string | null;
  op: 'new' | 'update';
  payload: Record<string, unknown>;
  rationale: string | null;
  status: ProposalStatus;
  /** The model's, 0–1; null for a rule's proposal, which claims no confidence. */
  confidence: number | null;
  /** The words a model pointed to. Null for a rule's proposal: the payload is the source. */
  evidenceQuote: string | null;
  /**
   * False only for a model claim whose quote is not in the file. Such a row
   * stays `pending` through accept-all and is applied only when the writer
   * accepts it by hand.
   */
  evidenceVerified: boolean;
}

/**
 * A proposal ready to stage, from whichever lane produced it. The rule-based
 * stager builds these; the extraction lane hands them over already built.
 */
export interface PreparedProposal {
  table: string;
  op: 'new' | 'update';
  payload: unknown;
  rationale: string;
  confidence?: number | null;
  evidenceQuote?: string | null;
  /** Defaults to true: a rule's payload is the source text itself. */
  evidenceVerified?: boolean;
}

/** What a writer may change on a proposal before it is applied, by table. */
export const EDITABLE: Record<string, string[]> = {
  entity: ['name', 'typeKey', 'summary', 'description'],
  entity_alias: ['alias'],
  fact: ['statement'],
  fact_knowledge: ['belief', 'learnedHow'],
  note: ['title'],
  scene: ['title'],
  law: ['category', 'title', 'ruleText'],
  plan: ['arcName'],
};

/** What a node was decided to be. Keyed `docPath#nodeId`. */
export type Decisions = Record<string, Destination>;

export interface ApplyResult {
  applied: number;
  failed: { proposalId: string; reason: string }[];
}

interface Statement { sql: string; params: unknown[] }

/* --------------------------------------------------------------- payloads */

interface EntityPayload {
  name: string; typeKey: string;
  summary: string | null; description: string | null;
  attributes: Record<string, string>;
  importance?: string; status?: string;
}
interface AliasPayload { entityName: string; alias: string }
interface FactPayload {
  key: string; predicate: string; statement: string;
  /** The extraction lane names the subject; resolved by name at apply time like everything else. */
  subjectName?: string | null;
}
interface KnowledgePayload {
  factKey: string; entityName: string; belief: Belief; learnedHow: string | null;
}
interface NotePayload { title: string; body: string }
interface ScenePayload { title: string; contentText: string; chapterId?: string | null }
interface LawPayload { category: string; severity: string; title: string; ruleText: string; order: number }
interface PlanPayload {
  arcName: string;
  parts: OutlinePart[];
  /** Written at apply time, so undo knows what to take back. */
  created?: { arcId: string; partIds: string[]; chapterIds: string[]; sceneIds: string[] };
}

/**
 * What a cell in a who-knows-what table means.
 *
 * Anything unrecognised but non-empty is read as knowing, with the cell's own
 * words kept as `learned_how`. A bible's cells say things like "through the
 * guest" or "yes, but private" — nuance the writer wrote down deliberately, and
 * throwing it away to store a boolean would lose the more interesting half.
 */
const NO = /^(?:no|n|-|–|—|x|✗|never|unknown|\?)$/iu;
const BELIEFS: [RegExp, Belief][] = [
  [/^(?:suspect|suspects|maybe|guesses)\b/iu, 'suspects'],
  [/^(?:believes false|lied to|thinks not|wrong|false|misled)\b/iu, 'believes_false'],
  [/^(?:denies|refuses|will not say)\b/iu, 'denies'],
];

export function readKnowledgeCell(
  raw: string,
): { belief: Belief; learnedHow: string | null } | null {
  const cell = raw.trim();
  if (!cell || NO.test(cell)) return null;
  for (const [pattern, belief] of BELIEFS) {
    if (pattern.test(cell)) return { belief, learnedHow: cell };
  }
  const plain = /^(?:yes|y|✓|✔|knows|known|true)$/iu.test(cell);
  return { belief: 'knows', learnedHow: plain ? null : cell };
}

export class ImportRepository {
  constructor(
    private readonly driver: SqlDriver,
    private readonly codex: CodexRepository,
    private readonly facts: FactsRepository,
    private readonly manuscript: ManuscriptRepository,
    private readonly plan: PlanRepository,
  ) {}

  /* ---------------------------------------------------------------- staging */

  /**
   * Turn a set of documents and the writer's decisions into a run of proposals.
   *
   * Writes nothing but proposals. A run that is never applied is a run that
   * changed nothing, which is the property that makes staging worth the table.
   */
  async stage(
    projectId: string, docs: readonly SourceDoc[], decisions: Decisions,
  ): Promise<{ runId: string; proposals: number }> {
    const rows: PreparedProposal[] = [];

    const add = (table: string, payload: unknown, why: string, op: 'new' | 'update' = 'new') => {
      rows.push({ table, op, payload, rationale: why });
    };

    for (const doc of docs) {
      const byId = new Map<string, SourceNode>();
      for (const { node } of walk(doc.root)) byId.set(node.id, node);

      for (const [key, destination] of Object.entries(decisions)) {
        const [path, nodeId] = splitKey(key);
        if (path !== doc.path) continue;
        const node = byId.get(nodeId);
        if (!node || destination.kind === 'skip') continue;

        if (destination.kind === 'entity') {
          // `Wren, dock clerk, male` is a name and a line about it in one
          // heading. The name is the part before the separator; the rest is the
          // summary, unless a template field already supplies one.
          const { name, rest } = splitName(node.heading ?? doc.path);
          const fields = absorbedFields(node);
          const attributes: Record<string, string> = {};
          const payload: EntityPayload = {
            name, typeKey: destination.typeKey,
            summary: rest, description: subtreeText(node) || null, attributes,
          };
          for (const f of fields) {
            const target = defaultFieldTarget(f.key);
            if (target.kind === 'attribute') { attributes[target.key] = f.value; continue; }
            if (target.kind !== 'column') continue;
            if (target.column === 'summary') payload.summary = f.value;
            else if (target.column === 'importance') payload.importance = f.value;
            else if (target.column === 'status') payload.status = f.value;
          }
          add('entity', payload, `from ${doc.path}${node.heading ? ` — ${node.heading}` : ''}`);
        } else if (destination.kind === 'note') {
          add('note', {
            title: node.heading ?? doc.path, body: subtreeText(node),
          } satisfies NotePayload, `from ${doc.path}`);
        } else if (destination.kind === 'scene') {
          add('scene', {
            title: node.heading ?? doc.path, contentText: subtreeText(node),
          } satisfies ScenePayload, `from ${doc.path}`);
        } else if (destination.kind === 'law') {
          const text = [...walk(node)].map(({ node: n }) => n.text).join('\n\n');
          ruleItems(text).forEach((item, order) => {
            add('law', {
              category: destination.category, severity: 'must',
              title: firstClause(item), ruleText: item, order,
            } satisfies LawPayload, `from ${doc.path}`);
          });
        } else if (destination.kind === 'plan') {
          const outline = readOutline(node, node.heading ?? doc.path);
          if (outline.parts.length > 0) {
            add('plan', { arcName: outline.title, parts: outline.parts } satisfies PlanPayload,
              `from ${doc.path}`);
          }
        } else {
          for (const table of node.tables) {
            const names = table.columns.slice(1);
            for (const row of table.rows) {
              const claim = (row[destination.factColumn] ?? '').trim();
              if (!claim) continue;
              const factKey = `${doc.path}#${node.id}#${claim}`;
              add('fact', {
                key: factKey, predicate: claim, statement: claim,
              } satisfies FactPayload, `a row of the table in ${doc.path}`);
              names.forEach((entityName, i) => {
                const cell = readKnowledgeCell(row[i + 1] ?? '');
                if (!cell || !entityName.trim()) return;
                add('fact_knowledge', {
                  factKey, entityName: entityName.trim(), ...cell,
                } satisfies KnowledgePayload,
                `"${entityName.trim()}" column of "${claim}"`);
              });
            }
          }
        }
      }
    }

    return this.stagePrepared(projectId, rows);
  }

  /**
   * Stage proposals already built — the extraction lane's, or the rules'.
   *
   * `aiRunId` names the model call that produced them, when one did; the
   * schema has carried the column since the table was written for this.
   */
  async stagePrepared(
    projectId: string, rows: readonly PreparedProposal[], aiRunId: string | null = null,
  ): Promise<{ runId: string; proposals: number }> {
    const now = Date.now();
    const runId = uuidv7(now);
    await this.driver.batch([
      {
        sql: `INSERT INTO proposal_run (id,project_id,ai_run_id,seed_kind,status,created_at)
              VALUES (?,?,?, 'import', 'staged', ?)`,
        params: [runId, projectId, aiRunId, now],
      },
      ...rows.map((r, i) => ({
        sql: `INSERT INTO proposal (id,run_id,target_table,op,payload,rationale,confidence,evidence_quote,
                                    evidence_verified,status,created_at)
              VALUES (?,?,?,?,?,?,?,?,?, 'pending', ?)`,
        params: [uuidv7(now + i), runId, r.table, r.op, JSON.stringify(r.payload), r.rationale,
          r.confidence ?? null, r.evidenceQuote ?? null, Number(r.evidenceVerified ?? true), now],
      })),
      this.#op(runId, 'insert', { seedKind: 'import', proposals: rows.length, aiRunId }, now),
    ], true);
    return { runId, proposals: rows.length };
  }

  /* ------------------------------------------------------------------ reads */

  async listRuns(projectId: string): Promise<ImportRun[]> {
    const runs = await this.#all(
      `SELECT id, project_id, status, created_at, applied_at FROM proposal_run
       WHERE project_id = ? AND seed_kind = 'import' ORDER BY created_at DESC`, [projectId]);
    const counts = await this.#all(
      `SELECT p.run_id, p.status, COUNT(*) FROM proposal p
       JOIN proposal_run r ON r.id = p.run_id
       WHERE r.project_id = ? GROUP BY p.run_id, p.status`, [projectId]);
    const byRun = new Map<string, Record<string, number>>();
    for (const c of counts) {
      const at = byRun.get(String(c[0])) ?? {};
      at[String(c[1])] = Number(c[2]);
      byRun.set(String(c[0]), at);
    }
    return runs.map((r) => ({
      id: r[0] as string, projectId: r[1] as string, status: r[2] as RunStatus,
      createdAt: Number(r[3]), appliedAt: r[4] === null ? null : Number(r[4]),
      counts: byRun.get(r[0] as string) ?? {},
    }));
  }

  async listProposals(runId: string): Promise<ProposalRow[]> {
    const rows = await this.#all(
      `SELECT id, run_id, target_table, target_id, op, payload, rationale, status,
              confidence, evidence_quote, evidence_verified
       FROM proposal WHERE run_id = ? ORDER BY rowid`, [runId]);
    return rows.map((r) => ({
      id: r[0] as string, runId: r[1] as string, targetTable: r[2] as string,
      targetId: r[3] as string | null, op: r[4] as 'new' | 'update',
      payload: JSON.parse(String(r[5])) as Record<string, unknown>,
      rationale: r[6] as string | null, status: r[7] as ProposalStatus,
      confidence: r[8] === null ? null : Number(r[8]), evidenceQuote: r[9] as string | null,
      evidenceVerified: Number(r[10]) !== 0,
    }));
  }

  /**
   * Change a proposal before it is applied — the fields `EDITABLE` names for
   * its table, nothing else. A model that got the type wrong or a rule that
   * cut a name short is one edit away from right, rather than a rejection and
   * a hand-made row later.
   */
  async edit(id: string, patch: Record<string, unknown>): Promise<void> {
    const rows = await this.#all('SELECT target_table, payload, status FROM proposal WHERE id = ?', [id]);
    const row = rows[0];
    if (!row) throw new Error('no such proposal');
    if (row[2] === 'applied' || row[2] === 'undone') throw new Error('that proposal has already been applied');
    const allowed = new Set(EDITABLE[String(row[0])] ?? []);
    const payload = JSON.parse(String(row[1])) as Record<string, unknown>;
    const changed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (!allowed.has(key)) throw new Error(`${key} is not something an import can change on a ${String(row[0])}`);
      const clean = typeof value === 'string' ? value.trim() : value;
      if (typeof clean === 'string' && !clean && key !== 'learnedHow' && key !== 'summary' && key !== 'description') {
        throw new Error(`${key} cannot be empty`);
      }
      changed[key] = typeof clean === 'string' && !clean ? null : clean;
    }
    if (Object.keys(changed).length === 0) return;
    const now = Date.now();
    await this.driver.batch([
      { sql: 'UPDATE proposal SET payload = ? WHERE id = ?', params: [JSON.stringify({ ...payload, ...changed }), id] },
      this.#op(id, 'update', { edited: changed }, now),
    ], true);
  }

  /* ----------------------------------------------------------- the decisions */

  async setStatus(ids: readonly string[], status: ProposalStatus): Promise<void> {
    if (!ids.length) return;
    const now = Date.now();
    await this.driver.batch(ids.flatMap((id) => [
      { sql: 'UPDATE proposal SET status = ? WHERE id = ?', params: [status, id] },
      this.#op(id, 'update', { status }, now),
    ]), true);
  }

  /**
   * Accept every pending proposal whose evidence holds. An unverified claim —
   * a model quoting words that are not in the file — is left pending, to be
   * accepted one at a time by a writer who has looked at it, or not at all.
   */
  async acceptAll(runId: string): Promise<void> {
    const now = Date.now();
    await this.driver.batch([
      {
        sql: `UPDATE proposal SET status = 'accepted'
              WHERE run_id = ? AND status = 'pending' AND evidence_verified = 1`,
        params: [runId],
      },
      this.#op(runId, 'update', { acceptedAll: true }, now),
    ], true);
  }

  /** Throw the run away. Nothing was ever applied, so nothing has to be undone. */
  async abandon(runId: string): Promise<void> {
    const now = Date.now();
    await this.driver.batch([
      { sql: "UPDATE proposal_run SET status = 'abandoned' WHERE id = ?", params: [runId] },
      this.#op(runId, 'update', { status: 'abandoned' }, now),
    ], true);
  }

  /* ------------------------------------------------------------------ apply */

  /**
   * Apply every accepted proposal, in dependency order.
   *
   * Entities before the facts about them, facts before who knows them. A
   * proposal whose references cannot be resolved is marked `failed` and
   * reported — never applied halfway, and never silently dropped, because a
   * writer who is told "212 applied" and given no list has no way to discover
   * the three that did not.
   */
  async apply(projectId: string, runId: string): Promise<ApplyResult> {
    const proposals = (await this.listProposals(runId))
      .filter((p) => p.status === 'accepted');
    const order = ['entity', 'entity_alias', 'fact', 'fact_knowledge', 'note', 'scene', 'law', 'plan'];
    proposals.sort((a, b) => order.indexOf(a.targetTable) - order.indexOf(b.targetTable));

    const byName = await this.#entityIndex(projectId);
    const factIds = new Map<string, string>();
    const failed: ApplyResult['failed'] = [];
    let applied = 0;
    let chapterId: string | null = null;

    for (const p of proposals) {
      try {
        const createdId = await this.#applyOne(projectId, p, byName, factIds, () => chapterId,
          (id) => { chapterId = id; });
        await this.#finish(p.id, 'applied', createdId);
        applied++;
      } catch (e) {
        failed.push({ proposalId: p.id, reason: (e as Error).message ?? String(e) });
        await this.#finish(p.id, 'failed', null);
      }
    }

    const now = Date.now();
    await this.driver.batch([
      {
        sql: "UPDATE proposal_run SET status = 'applied', applied_at = ? WHERE id = ?",
        params: [now, runId],
      },
      this.#op(runId, 'update', { status: 'applied', applied, failed: failed.length }, now),
    ], true);
    return { applied, failed };
  }

  /**
   * Take an applied import back out.
   *
   * Creates are soft-deleted, which is the same delete the rest of the app
   * does. Updates are restored from the `previous` snapshot written onto the
   * proposal when it was applied — captured then rather than reconstructed now,
   * because by now the row has been overwritten and there is nothing to
   * reconstruct it from.
   */
  async undo(runId: string): Promise<{ reverted: number }> {
    const proposals = (await this.listProposals(runId)).filter((p) => p.status === 'applied');
    // The exact inverse of the apply order. Today this changes nothing —
    // every delete below is a tombstone, and tombstones do not cascade — so it
    // is here to keep undo a true mirror if one of them ever becomes a hard
    // delete, which is when the order would start to matter. Stated rather
    // than dressed up as a dependency it does not currently have.
    proposals.reverse();
    let reverted = 0;

    for (const p of proposals) {
      try {
        await this.#revertOne(p);
        await this.#finish(p.id, 'undone', p.targetId);
        reverted++;
      } catch { /* a row already gone is a row already undone */ }
    }

    const now = Date.now();
    await this.driver.batch([
      { sql: "UPDATE proposal_run SET status = 'undone' WHERE id = ?", params: [runId] },
      this.#op(runId, 'update', { status: 'undone', reverted }, now),
    ], true);
    return { reverted };
  }

  /* ---------------------------------------------------------------- private */

  async #applyOne(
    projectId: string, p: ProposalRow,
    byName: Map<string, string>, factIds: Map<string, string>,
    getChapter: () => string | null, setChapter: (id: string) => void,
  ): Promise<string> {
    if (p.targetTable === 'entity') {
      const payload = p.payload as unknown as EntityPayload;
      const existing = byName.get(nameKey(payload.name));
      if (existing) {
        // The default the writer chose: an exact name or alias match updates
        // rather than minting a second Jeru. The previous values are kept so
        // the undo below has something to put back.
        const before = await this.codex.getEntity(existing);
        // Only the fields an update can put back. Handing `updateEntity` the
        // whole row would feed it `id` and `rev`, which are not its to set.
        await this.#remember(p.id, before && {
          name: before.entity.name, summary: before.entity.summary,
          description: before.entity.description, attributes: before.entity.attributes,
          importance: before.entity.importance, status: before.entity.status,
        });
        await this.codex.updateEntity(existing, {
          summary: payload.summary ?? undefined,
          description: payload.description ?? undefined,
          attributes: { ...(before?.entity.attributes ?? {}), ...payload.attributes },
        });
        return existing;
      }
      const entity = await this.codex.createEntity(projectId, {
        name: payload.name, typeKey: payload.typeKey,
        summary: payload.summary, description: payload.description,
        attributes: payload.attributes,
        ...(payload.importance ? { importance: payload.importance } : {}),
        ...(payload.status ? { status: payload.status } : {}),
      });
      byName.set(nameKey(payload.name), entity.id);
      return entity.id;
    }

    if (p.targetTable === 'entity_alias') {
      const payload = p.payload as unknown as AliasPayload;
      const owner = byName.get(nameKey(payload.entityName));
      if (!owner) throw new Error(`no entity named "${payload.entityName}"`);
      const alias = await this.codex.addAlias(owner, payload.alias);
      return alias.id;
    }

    if (p.targetTable === 'fact') {
      const payload = p.payload as unknown as FactPayload;
      const subject = payload.subjectName ? byName.get(nameKey(payload.subjectName)) ?? null : null;
      const id = await this.facts.createFact(projectId, {
        predicate: payload.predicate, statement: payload.statement, subjectEntityId: subject,
      });
      factIds.set(payload.key, id);
      return id;
    }

    if (p.targetTable === 'fact_knowledge') {
      const payload = p.payload as unknown as KnowledgePayload;
      const factId = factIds.get(payload.factKey);
      if (!factId) throw new Error('the fact this belongs to was not applied');
      const entityId = byName.get(nameKey(payload.entityName));
      if (!entityId) throw new Error(`no entity named "${payload.entityName}"`);
      await this.facts.setKnowledge(factId, entityId, {
        belief: payload.belief, learnedHow: payload.learnedHow ?? undefined,
      });
      return `${factId}:${entityId}`;
    }

    if (p.targetTable === 'note') {
      const payload = p.payload as unknown as NotePayload;
      const now = Date.now();
      const id = uuidv7(now);
      await this.driver.batch([
        {
          sql: `INSERT INTO note (id,project_id,title,body,kind,created_at,updated_at)
                VALUES (?,?,?,?, 'research', ?,?)`,
          params: [id, projectId, payload.title, payload.body, now, now],
        },
        this.#op(id, 'insert', payload, now),
      ], true);
      return id;
    }

    if (p.targetTable === 'scene') {
      const payload = p.payload as unknown as ScenePayload;
      const chapter = payload.chapterId ?? getChapter() ?? await this.#importChapter(projectId);
      setChapter(chapter);
      const scene = await this.manuscript.createScene(chapter, payload.title);
      await this.manuscript.saveSceneContent(scene.id, {
        contentJson: JSON.stringify(docFromText(payload.contentText)),
        contentText: payload.contentText,
      });
      return scene.id;
    }

    if (p.targetTable === 'law') {
      const payload = p.payload as unknown as LawPayload;
      const now = Date.now();
      const id = uuidv7(now);
      await this.driver.batch([
        {
          sql: `INSERT INTO law (id, project_id, scope_type, scope_id, category, severity, title,
                                 rule_text, check_mode, is_system, active, sort_key, created_at, updated_at)
                VALUES (?, ?, 'project', NULL, ?, ?, ?, ?, 'prompt', 0, 1, ?, ?, ?)`,
          params: [id, projectId, payload.category, payload.severity, payload.title, payload.ruleText,
            String(payload.order).padStart(4, '0'), now, now],
        },
        this.#op(id, 'insert', payload, now),
      ], true);
      return id;
    }

    if (p.targetTable === 'plan') {
      const payload = p.payload as unknown as PlanPayload;
      const books = await this.manuscript.listBooks(projectId);
      const book = books[0] ?? await this.manuscript.createBook(projectId, 'Book One');
      const arc = await this.plan.createArc(book.id, payload.arcName);
      const created = {
        arcId: arc.id, partIds: [] as string[], chapterIds: [] as string[], sceneIds: [] as string[],
      };
      for (const part of payload.parts) {
        const partId = part.title === null
          ? null
          : (await this.manuscript.createPart(book.id, part.title)).id;
        if (partId) created.partIds.push(partId);
        for (const section of part.sections) {
          const chapter = await this.manuscript.createChapter(book.id, section.title, { partId });
          created.chapterIds.push(chapter.id);
          if (section.number !== null) {
            await this.driver.query(
              'UPDATE chapter SET number = ? WHERE id = ?', [section.number, chapter.id], 'run');
          }
          const scene = await this.manuscript.createScene(chapter.id, section.title);
          created.sceneIds.push(scene.id);
          await this.manuscript.updateScene(scene.id, { summary: section.summary, status: section.status });
          for (const b of section.beats) {
            const beat = await this.plan.createBeat(arc.id, b.title);
            // A summary that only repeats the title with its full stop is noise.
            if (b.summary.replace(/[.!?]+$/u, '') !== b.title) {
              await this.plan.updateBeat(beat.id, { summary: b.summary });
            }
            await this.plan.linkBeat(beat.id, scene.id, 'develop');
          }
        }
      }
      // Kept on the proposal, not derived later: by undo time the rows may
      // have been renamed or moved, and the ids are the only stable handle.
      await this.#remember(p.id, undefined, { created });
      return arc.id;
    }

    throw new Error(`nothing knows how to apply a ${p.targetTable}`);
  }

  async #revertOne(p: ProposalRow): Promise<void> {
    const id = p.targetId;
    if (!id) return;
    const previous = p.payload.previous as Record<string, unknown> | undefined;

    if (p.targetTable === 'entity') {
      if (p.op === 'update' && previous) {
        await this.codex.updateEntity(id, previous as never);
        return;
      }
      await this.codex.removeEntity(id);
    } else if (p.targetTable === 'entity_alias') {
      await this.codex.removeAlias(id);
    } else if (p.targetTable === 'fact') {
      await this.facts.removeFact(id);
    } else if (p.targetTable === 'fact_knowledge') {
      const [factId, entityId] = id.split(':');
      if (factId && entityId) await this.facts.removeKnowledge(factId, entityId);
    } else if (p.targetTable === 'note') {
      const now = Date.now();
      await this.driver.batch([
        { sql: 'UPDATE note SET deleted_at = ?, updated_at = ? WHERE id = ?', params: [now, now, id] },
        this.#op(id, 'delete', null, now),
      ], true);
    } else if (p.targetTable === 'scene') {
      await this.manuscript.removeScene(id);
    } else if (p.targetTable === 'law') {
      const now = Date.now();
      await this.driver.batch([
        { sql: 'UPDATE law SET deleted_at = ?, updated_at = ? WHERE id = ?', params: [now, now, id] },
        this.#op(id, 'delete', null, now),
      ], true);
    } else if (p.targetTable === 'plan') {
      const created = (p.payload as unknown as PlanPayload).created;
      if (!created) return;
      // The arc takes its beats with it; scenes before chapters before parts,
      // the reverse of how they were made.
      await this.plan.removeArc(created.arcId);
      for (const sceneId of created.sceneIds) await this.manuscript.removeScene(sceneId);
      for (const chapterId of created.chapterIds) await this.manuscript.removeChapter(chapterId);
      for (const partId of created.partIds) await this.manuscript.removePart(partId);
    }
  }

  /**
   * Keep what a row looked like before an update, so undo has something to
   * restore — or, for a proposal that made many rows, which rows it made.
   */
  async #remember(
    proposalId: string, before: unknown, extra: Record<string, unknown> = {},
  ): Promise<void> {
    if (!before && Object.keys(extra).length === 0) return;
    const rows = await this.#all('SELECT payload FROM proposal WHERE id = ?', [proposalId]);
    const payload = JSON.parse(String(rows[0]?.[0] ?? '{}')) as Record<string, unknown>;
    if (before) payload.previous = before;
    Object.assign(payload, extra);
    await this.driver.query(
      before ? "UPDATE proposal SET payload = ?, op = 'update' WHERE id = ?"
        : 'UPDATE proposal SET payload = ? WHERE id = ?',
      [JSON.stringify(payload), proposalId], 'run');
  }

  async #finish(proposalId: string, status: ProposalStatus, targetId: string | null): Promise<void> {
    await this.driver.query(
      'UPDATE proposal SET status = ?, target_id = IFNULL(?, target_id) WHERE id = ?',
      [status, targetId, proposalId], 'run');
  }

  /** Every name and alias already in the project, pointing at its entity. */
  async #entityIndex(projectId: string): Promise<Map<string, string>> {
    const rows = await this.#all(
      `SELECT e.id, e.name, a.alias FROM entity e
       LEFT JOIN entity_alias a ON a.entity_id = e.id
       WHERE e.project_id = ? AND e.deleted_at IS NULL`, [projectId]);
    const index = new Map<string, string>();
    for (const r of rows) {
      index.set(nameKey(String(r[1])), String(r[0]));
      if (r[2]) index.set(nameKey(String(r[2])), String(r[0]));
    }
    return index;
  }

  /**
   * Somewhere for imported prose to land.
   *
   * A stated default rather than a hidden one: the screen says imported scenes
   * go into a chapter called "Imported" unless a chapter is chosen, because a
   * fresh project has no chapter to choose and refusing the import over it
   * would be worse than naming the place it went.
   */
  async #importChapter(projectId: string): Promise<string> {
    const books = await this.manuscript.listBooks(projectId);
    const book = books[0] ?? await this.manuscript.createBook(projectId, 'Book One');
    const chapters = await this.manuscript.listChapters(book.id);
    const existing = chapters.find((c) => c.title === 'Imported');
    return existing?.id ?? (await this.manuscript.createChapter(book.id, 'Imported')).id;
  }

  async #all(sql: string, params: unknown[]): Promise<unknown[][]> {
    const { rows } = await this.driver.query(sql, params, 'all');
    return rows as unknown[][];
  }

  #op(rowId: string, op: string, payload: unknown, ts: number): Statement {
    return {
      sql: 'INSERT INTO op_log (device_id,table_name,row_id,op,payload,ts) VALUES (?,?,?,?,?,?)',
      params: [deviceId(), 'proposal_run', rowId, op,
        payload === null ? null : JSON.stringify(payload), ts],
    };
  }
}

export const decisionKey = (docPath: string, nodeId: string): string => `${docPath}#${nodeId}`;
function splitKey(key: string): [string, string] {
  const at = key.lastIndexOf('#');
  return at < 0 ? [key, ''] : [key.slice(0, at), key.slice(at + 1)];
}

/** Plain text as a Tiptap document, one paragraph per line. */
function docFromText(text: string): object {
  return {
    type: 'doc',
    content: text.split(/\n+/u).map((line) => ({
      type: 'paragraph',
      ...(line.trim() ? { content: [{ type: 'text', text: line.trim() }] } : {}),
    })),
  };
}
