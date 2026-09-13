-- LoreScribe — SQLite schema (v0 draft)
-- Target: SQLite 3.45+ (WASM/OPFS on web, @capacitor-community/sqlite on Android)
-- Conventions:
--   * ids are UUIDv7 TEXT (time-sortable)
--   * every mutable row: created_at, updated_at, deleted_at (soft), rev
--   * timestamps are INTEGER epoch milliseconds (UTC)
--   * narrative position is always a scene reference, never a number
--   * story time is INTEGER in-world minutes since project epoch

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- ============================================================ 1. STRUCTURE

CREATE TABLE project (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  subtitle      TEXT,
  premise       TEXT,
  genre         TEXT,
  audience      TEXT,                -- e.g. adult / YA
  content_rating TEXT,               -- author's declared ceiling; see laws
  prose_register INTEGER,            -- 1..5 register dial; NULL = off (docs/04)
  calendar_id   TEXT REFERENCES calendar(id),
  story_epoch   INTEGER DEFAULT 0,   -- in-world minute 0
  settings_json TEXT,                -- model roles, budgets, ui prefs
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  deleted_at INTEGER, rev INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE book (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  sort_key   TEXT NOT NULL,
  synopsis   TEXT,
  target_word_count INTEGER,
  status     TEXT DEFAULT 'drafting', -- planning|drafting|revising|done
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  deleted_at INTEGER, rev INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE part (                  -- act / section / volume
  id       TEXT PRIMARY KEY,
  book_id  TEXT NOT NULL REFERENCES book(id) ON DELETE CASCADE,
  title    TEXT, sort_key TEXT NOT NULL, summary TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  deleted_at INTEGER, rev INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE chapter (
  id       TEXT PRIMARY KEY,
  book_id  TEXT NOT NULL REFERENCES book(id) ON DELETE CASCADE,
  part_id  TEXT REFERENCES part(id) ON DELETE SET NULL,
  number   INTEGER,                  -- display number, may differ from order
  title    TEXT, sort_key TEXT NOT NULL,
  summary  TEXT,                     -- rolling compression level 2
  pov_entity_id TEXT REFERENCES entity(id),
  status   TEXT DEFAULT 'planned',   -- planned|drafted|revised|final
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  deleted_at INTEGER, rev INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE scene (
  id          TEXT PRIMARY KEY,
  chapter_id  TEXT NOT NULL REFERENCES chapter(id) ON DELETE CASCADE,
  title       TEXT,
  sort_key    TEXT NOT NULL,
  global_rank TEXT NOT NULL,         -- materialised part|chapter|scene sort keys
  summary     TEXT,                  -- rolling compression level 1
  purpose     TEXT,                  -- what this scene must accomplish
  pov_entity_id  TEXT REFERENCES entity(id),
  pov_mode    TEXT,                  -- first|close_third|third|omniscient
  tense       TEXT,                  -- past|present
  location_entity_id TEXT REFERENCES entity(id),
  story_time_start INTEGER, story_time_end INTEGER,
  tension     INTEGER,               -- 0-10, for the pacing curve
  word_count  INTEGER DEFAULT 0,
  status      TEXT DEFAULT 'planned',
  content_json TEXT,                 -- Tiptap doc
  content_text TEXT,                 -- denormalised plain text
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  deleted_at INTEGER, rev INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX scene_rank_idx ON scene(global_rank);
CREATE INDEX scene_chapter_idx ON scene(chapter_id, sort_key);

CREATE TABLE scene_version (
  id         TEXT PRIMARY KEY,
  scene_id   TEXT NOT NULL REFERENCES scene(id) ON DELETE CASCADE,
  label      TEXT,                   -- 'draft 2', 'what if: she stays'
  parent_version_id TEXT REFERENCES scene_version(id),
  origin     TEXT NOT NULL,          -- manual|ai_draft|ai_revision|import
  ai_run_id  TEXT REFERENCES ai_run(id),
  content_json TEXT, content_text TEXT, word_count INTEGER,
  is_active  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX scene_version_scene_idx ON scene_version(scene_id, created_at DESC);

CREATE TABLE calendar (              -- optional custom world calendar
  id TEXT PRIMARY KEY, project_id TEXT REFERENCES project(id) ON DELETE CASCADE,
  name TEXT NOT NULL, definition_json TEXT NOT NULL, -- months, days, epochs
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

-- ============================================================ 2. CODEX

CREATE TABLE entity_type (
  key TEXT PRIMARY KEY,              -- character|location|faction|item|...
  project_id TEXT REFERENCES project(id) ON DELETE CASCADE, -- NULL = built-in
  label TEXT NOT NULL, icon TEXT,
  attribute_schema_json TEXT         -- JSON Schema for entity.attributes
);

CREATE TABLE entity (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  type_key    TEXT NOT NULL REFERENCES entity_type(key),
  name        TEXT NOT NULL,
  summary     TEXT,                  -- ONE line; used in compact briefs
  description TEXT,                  -- full prose dossier
  attributes  TEXT,                  -- JSON, validated against type schema
  importance  TEXT DEFAULT 'minor',  -- protagonist|major|minor|background
  status      TEXT,                  -- alive|dead|destroyed|unknown ...
  first_scene_id TEXT REFERENCES scene(id),
  portrait_uri TEXT, colour TEXT,
  book_scope_id TEXT REFERENCES book(id),  -- NULL = whole series
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  deleted_at INTEGER, rev INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX entity_project_type_idx ON entity(project_id, type_key);

CREATE TABLE entity_alias (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  kind TEXT,                         -- name|title|nickname|epithet|disguise
  is_primary INTEGER DEFAULT 0,
  -- an alias may itself be a spoiler ("the Grey Warden" == Kaelen, ch.20)
  linkable_from_scene_id TEXT REFERENCES scene(id),
  auto_link INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX entity_alias_lookup ON entity_alias(alias);

CREATE TABLE entity_relationship (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  from_entity_id TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  to_entity_id   TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                -- parent_of|serves|loves|located_in|...
  label TEXT, strength INTEGER,      -- -5..5 for affinity arcs
  since_scene_id TEXT REFERENCES scene(id),
  until_scene_id TEXT REFERENCES scene(id),
  is_secret INTEGER DEFAULT 0,
  notes TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  deleted_at INTEGER, rev INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX rel_from_idx ON entity_relationship(from_entity_id);
CREATE INDEX rel_to_idx   ON entity_relationship(to_entity_id);

-- ============================================================ 3. FACTS

CREATE TABLE fact (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  subject_entity_id TEXT REFERENCES entity(id) ON DELETE CASCADE,
  predicate  TEXT NOT NULL,
  object_text TEXT,
  object_entity_id TEXT REFERENCES entity(id),
  statement  TEXT NOT NULL,          -- rendered for prompts & UI
  established_at_scene_id TEXT REFERENCES scene(id),  -- NULL = backstory
  revealed_at_scene_id    TEXT REFERENCES scene(id),  -- NULL = never on page
  invalidated_at_scene_id TEXT REFERENCES scene(id),
  supersedes_fact_id TEXT REFERENCES fact(id),
  certainty     TEXT DEFAULT 'canon',-- canon|planned|speculative
  spoiler_weight INTEGER DEFAULT 0,  -- 0..3
  is_dramatic_irony INTEGER DEFAULT 0, -- reader knows before characters do
  source        TEXT DEFAULT 'manual', -- manual|extracted|ai_suggested
  confirmed     INTEGER NOT NULL DEFAULT 1,
  -- Evidence discipline (libriscribe milestone_verifier): an extracted fact must cite a
  -- span that is verifiably present in the prose. Unverified evidence downgrades, it
  -- does not silently pass. See docs/09.
  evidence_quote TEXT,
  evidence_scene_id TEXT REFERENCES scene(id),
  evidence_verified INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  deleted_at INTEGER, rev INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX fact_subject_idx ON fact(subject_entity_id, predicate);
CREATE INDEX fact_reveal_idx  ON fact(revealed_at_scene_id);

CREATE TABLE fact_knowledge (        -- who knows what, and when they learned it
  id TEXT PRIMARY KEY,
  fact_id   TEXT NOT NULL REFERENCES fact(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  belief    TEXT NOT NULL DEFAULT 'knows', -- knows|suspects|believes_false|denies
  known_from_scene_id TEXT REFERENCES scene(id),
  learned_how TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX fact_knowledge_uniq ON fact_knowledge(fact_id, entity_id);

-- ============================================================ 4. MENTIONS

CREATE TABLE mention (
  id TEXT PRIMARY KEY,
  scene_id  TEXT NOT NULL REFERENCES scene(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  -- Role in THIS scene, not importance in the book (novelWriter @pov/@focus/
  -- @char/@mention). The brief compiler seeds from pov/focus/present and admits
  -- 'mentioned' entities at summary level only. See docs/11.
  role TEXT NOT NULL DEFAULT 'present',  -- pov|focus|present|mentioned
  start_offset INTEGER, end_offset INTEGER,
  alias_used TEXT,
  method     TEXT,                   -- explicit|alias_match|inferred
  confidence REAL DEFAULT 1.0,
  confirmed  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX mention_scene_idx  ON mention(scene_id, role);
CREATE INDEX mention_entity_idx ON mention(entity_id);

-- ============================================================ 5. PLANNING

CREATE TABLE arc (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES book(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                -- main_plot|subplot|character|relationship|mystery|theme
  name TEXT NOT NULL, sort_key TEXT NOT NULL, colour TEXT,
  owner_entity_id TEXT REFERENCES entity(id),
  second_entity_id TEXT REFERENCES entity(id),  -- for relationship arcs
  premise TEXT,
  want TEXT, need TEXT, lie TEXT, ghost TEXT,   -- character-arc scaffolding
  change_from TEXT, change_to TEXT,
  template_key TEXT,                 -- save_the_cat|story_circle|seven_point|...
  status TEXT DEFAULT 'planned',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  deleted_at INTEGER, rev INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE beat (
  id TEXT PRIMARY KEY,
  arc_id TEXT NOT NULL REFERENCES arc(id) ON DELETE CASCADE,
  sort_key TEXT NOT NULL,
  title TEXT NOT NULL, summary TEXT,
  function TEXT,                     -- setup|inciting|turn|midpoint|crisis|climax|resolution
  template_beat_key TEXT,            -- slot in the chosen structure template
  tension INTEGER,                   -- 0-10 target
  target_chapter_id TEXT REFERENCES chapter(id),
  status TEXT DEFAULT 'planned',     -- planned|drafted|realised|cut
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  deleted_at INTEGER, rev INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE beat_scene (
  beat_id  TEXT NOT NULL REFERENCES beat(id) ON DELETE CASCADE,
  scene_id TEXT NOT NULL REFERENCES scene(id) ON DELETE CASCADE,
  role TEXT DEFAULT 'develop',       -- setup|develop|payoff|echo
  PRIMARY KEY (beat_id, scene_id)
);

CREATE TABLE timeline_event (        -- world history, incl. pre-story backstory
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  title TEXT NOT NULL, description TEXT,
  story_time INTEGER, story_time_end INTEGER,
  on_page_scene_id TEXT REFERENCES scene(id),  -- NULL = offscreen/backstory
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  deleted_at INTEGER, rev INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE timeline_event_entity (
  event_id TEXT NOT NULL REFERENCES timeline_event(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  role TEXT,
  PRIMARY KEY (event_id, entity_id)
);

-- ============================================================ 6. LAWS

CREATE TABLE law (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL DEFAULT 'project', -- project|book|arc|chapter|scene|entity|pov
  scope_id   TEXT,
  category   TEXT NOT NULL,          -- canon|style|voice|structure|content|ip
  severity   TEXT NOT NULL DEFAULT 'must',   -- must|should|prefer
  title      TEXT NOT NULL,
  rule_text  TEXT NOT NULL,          -- the instruction the model receives
  rationale  TEXT,
  check_mode TEXT DEFAULT 'prompt',  -- prompt|regex|heuristic|rubric|prompt+rubric
  check_config TEXT,                 -- JSON: pattern, threshold, rubric prompt
  examples_good TEXT, examples_bad TEXT,
  is_system  INTEGER NOT NULL DEFAULT 0,     -- hard floor, not user-editable
  active     INTEGER NOT NULL DEFAULT 1,
  sort_key   TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  deleted_at INTEGER, rev INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX law_scope_idx ON law(project_id, scope_type, scope_id, active);

CREATE TABLE law_violation (
  id TEXT PRIMARY KEY,
  ai_run_id TEXT REFERENCES ai_run(id) ON DELETE CASCADE,
  scene_id  TEXT REFERENCES scene(id) ON DELETE CASCADE,
  law_id    TEXT NOT NULL REFERENCES law(id) ON DELETE CASCADE,
  severity  TEXT, quote TEXT, start_offset INTEGER, end_offset INTEGER,
  -- A rubric-model violation citing a quote that is not actually in the prose is
  -- downgraded to 'uncertain', never reported as a finding.
  evidence_verified INTEGER NOT NULL DEFAULT 0,
  explanation TEXT, suggested_fix TEXT,
  resolution TEXT,                   -- pending|fixed|dismissed|law_amended
  created_at INTEGER NOT NULL
);

-- ============================================================ 7. AI

CREATE TABLE provider_account (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                -- openrouter|ollama|llamacpp|lmstudio|openai_compat
  label TEXT NOT NULL,
  base_url TEXT,
  credential_ref TEXT,               -- keystore handle; NEVER the key itself
  capabilities_json TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE model_profile (         -- a named role the app calls
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES project(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                -- draft|revise|critique|summarise|extract|embed|name
  provider_account_id TEXT NOT NULL REFERENCES provider_account(id),
  model_id TEXT NOT NULL,
  params_json TEXT,                  -- temperature, top_p, max_tokens...
  context_window INTEGER,
  cost_in_per_mtok REAL, cost_out_per_mtok REAL,
  -- Reasoning models spend tokens in a private think channel BEFORE answering
  -- (~2.5k observed for a two-sentence ask). Learned worst case, added preemptively
  -- to every request; streaming cannot retry, so it is applied up front there.
  reasoning_allowance INTEGER NOT NULL DEFAULT 0,
  supports_json_schema INTEGER,      -- grammar-constrained decoding available
  supports_strict_schema INTEGER,    -- requires all-closed objects
  fallback_profile_id TEXT REFERENCES model_profile(id),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE prompt_template (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES project(id) ON DELETE CASCADE, -- NULL = built-in
  purpose TEXT NOT NULL,             -- draft_scene|expand|rewrite|critique|extract...
  name TEXT NOT NULL, body TEXT NOT NULL,  -- handlebars-style over the brief
  version INTEGER DEFAULT 1, is_default INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE ai_run (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  scene_id   TEXT REFERENCES scene(id) ON DELETE SET NULL,
  purpose    TEXT NOT NULL,
  provider   TEXT, model TEXT, params_json TEXT,
  brief_json TEXT,                   -- the compiled Scene Brief, verbatim
  prompt_rendered TEXT,              -- exactly what was sent
  output_text TEXT,
  tokens_in INTEGER, tokens_out INTEGER, cost_usd REAL, latency_ms INTEGER,
  tokens_reasoning INTEGER,          -- private think channel, billed but unseen
  budget_escalations INTEGER DEFAULT 0,
  sanitizer_actions TEXT,            -- JSON list of deterministic repairs applied
  retry_of_run_id TEXT REFERENCES ai_run(id),  -- regenerate-with-violations-named
  status TEXT,                       -- ok|error|cancelled|refused|truncated
  error_text TEXT,
  accepted INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX ai_run_project_idx ON ai_run(project_id, created_at DESC);

CREATE TABLE embedding (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  owner_table TEXT NOT NULL, owner_id TEXT NOT NULL,
  source_band TEXT NOT NULL DEFAULT 'canon',  -- canon|reference; never mixed in retrieval
  chunk_index INTEGER DEFAULT 0, chunk_text TEXT,
  model TEXT NOT NULL, dims INTEGER NOT NULL, vector BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX embedding_owner_idx ON embedding(owner_table, owner_id);

-- ============================================================ 8. MISC

CREATE TABLE note (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  owner_table TEXT, owner_id TEXT,   -- attach to anything, or free-floating
  title TEXT, body TEXT, kind TEXT,  -- idea|research|todo|comment
  resolved INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  deleted_at INTEGER, rev INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE tag (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name TEXT NOT NULL, colour TEXT
);
CREATE TABLE tag_link (
  tag_id TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
  owner_table TEXT NOT NULL, owner_id TEXT NOT NULL,
  PRIMARY KEY (tag_id, owner_table, owner_id)
);

-- Derived data is a CACHE, never the source of truth: mention, scene_fts,
-- embedding and scene.global_rank are all recomputable from scenes + aliases.
-- Each kind records the algorithm revision that built it; a bump makes the data
-- stale and triggers a rebuild. "Rebuild index" is a button, not an incident.
CREATE TABLE index_state (
  kind TEXT PRIMARY KEY,             -- mention|fts|embedding|rank
  algo_revision INTEGER NOT NULL,
  built_at INTEGER, built_rows INTEGER,
  stale INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

-- Single-writer lock. The opfs-sahpool VFS takes exclusive sync access handles,
-- so a second tab on the same project fails at the storage layer with an opaque
-- error. Claim the lock with a heartbeat and show a real "open elsewhere" screen.
CREATE TABLE project_lock (
  project_id TEXT PRIMARY KEY REFERENCES project(id) ON DELETE CASCADE,
  holder_id TEXT NOT NULL,           -- tab/device identifier
  holder_label TEXT,                 -- human-readable, for the takeover prompt
  acquired_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL
);

CREATE TABLE op_log (                -- append-only; enables future sync
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  table_name TEXT NOT NULL, row_id TEXT NOT NULL,
  op TEXT NOT NULL,                  -- insert|update|delete
  payload TEXT, ts INTEGER NOT NULL
);

-- ================================================ 8b. THREADS (reader promises)

-- Distinct from `fact`: a fact is a truth about the world, a thread is a PROMISE
-- made to the reader. "Someone is watching the house" is a thread, not a fact.
-- Auto-detected from prose after each scene/chapter; see docs/09 item 8.
CREATE TABLE narrative_thread (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES book(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  thread_type TEXT NOT NULL,         -- promise|setup|question|item
  description TEXT,
  opened_scene_id   TEXT REFERENCES scene(id),
  target_resolution_chapter_id TEXT REFERENCES chapter(id),
  resolved_scene_id TEXT REFERENCES scene(id),
  status TEXT NOT NULL DEFAULT 'open',  -- open|resolved|abandoned
  source TEXT DEFAULT 'extracted',   -- manual|extracted
  confirmed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  deleted_at INTEGER, rev INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE narrative_thread_entity (
  thread_id TEXT NOT NULL REFERENCES narrative_thread(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  PRIMARY KEY (thread_id, entity_id)
);

-- ================================================ 8c. REFERENCE MATERIAL

-- Imported source material (PDF/TXT/MD/OCR). Grounds generation, NEVER becomes
-- canon, never enters an export, retrieved into its own reserved brief slice and
-- excluded from canon retrieval. See docs/09 item 6.
CREATE TABLE reference_source (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  title TEXT NOT NULL, kind TEXT,    -- pdf|txt|markdown|image_ocr|web
  file_uri TEXT, page_count INTEGER,
  licence_note TEXT,                 -- author's own record of usage rights
  ocr_applied INTEGER DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  deleted_at INTEGER, rev INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE reference_chunk (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES reference_source(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL, page INTEGER,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX reference_chunk_source_idx ON reference_chunk(source_id, chunk_index);

-- ================================================ 8d. PROPOSAL STAGING

-- Nothing an AI extracts touches live data until the author accepts it. Grouped
-- per run so a bad run is abandoned in one action. See docs/09 items 11-12.
CREATE TABLE proposal_run (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  ai_run_id TEXT REFERENCES ai_run(id),
  seed_kind TEXT,                    -- scene_extraction|import|brainstorm|gap_fill
  seed_ref TEXT,
  status TEXT NOT NULL DEFAULT 'staged',  -- staged|applied|abandoned
  created_at INTEGER NOT NULL, applied_at INTEGER
);
CREATE TABLE proposal (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES proposal_run(id) ON DELETE CASCADE,
  target_table TEXT NOT NULL,        -- entity|fact|fact_knowledge|mention|narrative_thread|beat
  target_id TEXT,                    -- set for op='update'
  op TEXT NOT NULL,                  -- new|update
  payload TEXT NOT NULL,             -- JSON; merge is field-by-field, never destructive
  rationale TEXT, confidence REAL,
  evidence_quote TEXT,
  evidence_verified INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|accepted|rejected
  created_at INTEGER NOT NULL
);
CREATE INDEX proposal_run_idx ON proposal(run_id, status);

-- ============================================================ 9. SEARCH

CREATE VIRTUAL TABLE scene_fts USING fts5(
  scene_id UNINDEXED, title, content_text, tokenize='porter unicode61'
);
CREATE VIRTUAL TABLE codex_fts USING fts5(
  owner_table UNINDEXED, owner_id UNINDEXED, name, body,
  tokenize='porter unicode61'
);

-- ============================================================ 10. VIEWS

-- Facts visible to the reader at a given scene rank (bind :rank).
CREATE VIEW v_fact_reader_visible AS
SELECT f.*, es.global_rank AS established_rank, rs.global_rank AS revealed_rank
FROM fact f
LEFT JOIN scene es ON es.id = f.established_at_scene_id
LEFT JOIN scene rs ON rs.id = f.revealed_at_scene_id
WHERE f.deleted_at IS NULL;

-- Beats with no scene realising them: the plan/prose drift detector.
CREATE VIEW v_unrealised_beats AS
SELECT b.* FROM beat b
LEFT JOIN beat_scene bs ON bs.beat_id = b.id
WHERE bs.beat_id IS NULL AND b.status <> 'cut' AND b.deleted_at IS NULL;

-- Scenes advancing no arc: candidates for cutting.
CREATE VIEW v_orphan_scenes AS
SELECT s.* FROM scene s
LEFT JOIN beat_scene bs ON bs.scene_id = s.id
WHERE bs.scene_id IS NULL AND s.deleted_at IS NULL;

-- Two active facts asserting different values for the same subject+predicate.
CREATE VIEW v_fact_conflicts AS
SELECT a.id AS fact_a, b.id AS fact_b, a.subject_entity_id, a.predicate
FROM fact a JOIN fact b
  ON a.subject_entity_id = b.subject_entity_id
 AND a.predicate = b.predicate
 AND a.id < b.id
WHERE a.deleted_at IS NULL AND b.deleted_at IS NULL
  AND a.invalidated_at_scene_id IS NULL AND b.invalidated_at_scene_id IS NULL
  AND a.supersedes_fact_id IS NOT b.id AND b.supersedes_fact_id IS NOT a.id
  AND IFNULL(a.object_text,'') <> IFNULL(b.object_text,'')
  AND IFNULL(a.object_entity_id,'') <> IFNULL(b.object_entity_id,'');

-- Reader promises still outstanding, with how long they have been open.
CREATE VIEW v_open_threads AS
SELECT t.*, os.global_rank AS opened_rank
FROM narrative_thread t
LEFT JOIN scene os ON os.id = t.opened_scene_id
WHERE t.status = 'open' AND t.deleted_at IS NULL;
