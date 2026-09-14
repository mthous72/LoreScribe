-- 003 — repair databases built before migration 001 was edited.
--
-- THE BUG THIS FIXES, because it must not happen again.
--
-- Migration 001 is `db/schema.sql`, imported directly so that the canonical
-- schema and the first migration cannot drift apart. [Doc 15](../../docs/15-phase-0-plan.md)
-- R8 then declared 001 "explicitly mutable until Phase 1 ends", on the reasoning
-- that there was "no installed base to protect". Two later commits edited it in
-- place under that rule: `project_lock` became `session_lock`, and the fact
-- views were renamed and corrected.
--
-- The premise had already expired. The app was deployed to Pages and used on a
-- real device during Phase 0 — R2b — so a database existed in the wild before
-- Phase 1 began. `migrate()` skips every migration at or below `user_version`,
-- and that database was already at 2, so BOTH migrations were skipped and the
-- edits never reached it. It opened, migrated successfully, and then failed on
-- `no such table: session_lock`.
--
-- Nothing caught it because every test creates a FRESH database. The suite had
-- no way to see this class of failure: not a missing test, a missing path.
-- `src/db/migrate.test.ts` now runs an old database forward and compares it
-- against a fresh one, which fails if 001 is ever edited without a migration
-- again.
--
-- Written to be idempotent and to converge from ANY earlier shape: it is a
-- no-op on a fresh database, where every object below already matches.

-- The single-writer lock row. Scoped to the FILE, not to a project: a
-- per-project lock described a granularity opfs-sahpool does not have, and
-- project_lock's foreign key made the row unwritable before a project existed.
CREATE TABLE IF NOT EXISTS session_lock (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  holder_id    TEXT NOT NULL,
  holder_label TEXT,
  acquired_at  INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL
);

-- Its predecessor. Never written by any shipped build, so there is nothing to
-- carry across.
DROP TABLE IF EXISTS project_lock;

-- Renamed: the old name promised a filter a SQLite view cannot apply, since a
-- view takes no parameters and "visible at scene rank :r" is not expressible.
DROP VIEW IF EXISTS v_fact_reader_visible;
DROP VIEW IF EXISTS v_fact_ranks;
CREATE VIEW v_fact_ranks AS
SELECT f.*, es.global_rank AS established_rank, rs.global_rank AS revealed_rank
FROM fact f
LEFT JOIN scene es ON es.id = f.established_at_scene_id
LEFT JOIN scene rs ON rs.id = f.revealed_at_scene_id
WHERE f.deleted_at IS NULL;

-- Corrected: AND where it needed OR. A fact's object is EITHER literal text OR
-- an entity, never both, so requiring a difference on both columns excluded
-- every shape the model supports and the view returned the empty set for
-- everything — indistinguishable from "no contradictions", which is the worst
-- way for a check to fail.
DROP VIEW IF EXISTS v_fact_conflicts;
CREATE VIEW v_fact_conflicts AS
SELECT a.id AS fact_a, b.id AS fact_b, a.subject_entity_id, a.predicate
FROM fact a JOIN fact b
  ON a.subject_entity_id = b.subject_entity_id
 AND a.predicate = b.predicate
 AND a.id < b.id
WHERE a.deleted_at IS NULL AND b.deleted_at IS NULL
  AND a.invalidated_at_scene_id IS NULL AND b.invalidated_at_scene_id IS NULL
  AND a.supersedes_fact_id IS NOT b.id AND b.supersedes_fact_id IS NOT a.id
  AND (IFNULL(a.object_text,'') <> IFNULL(b.object_text,'')
       OR IFNULL(a.object_entity_id,'') <> IFNULL(b.object_entity_id,''));
