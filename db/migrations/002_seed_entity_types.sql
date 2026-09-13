-- 002 — seed the built-in entity type registry.
--
-- entity.type_key REFERENCES entity_type(key), and 001 ships no rows, so a
-- fresh database cannot hold a single entity until this runs. Found by the
-- Phase 0 spike, which had to seed types itself before it could generate a
-- corpus at all (docs/16).
--
-- Data, not structure, which is why it is its own migration rather than an
-- addition to db/schema.sql: that file stays the structural definition the
-- schema-equivalence test compares against.
--
-- project_id IS NULL marks a built-in. A user's own types carry their project's
-- id, so adding one never collides with a later revision of this list.
--
-- The types and their attributes come from docs/02 §3. attribute_schema_json is
-- JSON Schema, used to validate entity.attributes and to render the editor, so
-- a field added here appears in the UI without code.

INSERT INTO entity_type (key, project_id, label, icon, attribute_schema_json) VALUES
  ('character', NULL, 'Character', 'user', json('{
     "type":"object","properties":{
       "age":{"type":"string"},
       "species":{"type":"string"},
       "occupation":{"type":"string"},
       "pronouns":{"type":"string"},
       "voice_profile":{"type":"string","x-long":true},
       "want":{"type":"string"},
       "need":{"type":"string"},
       "lie":{"type":"string"},
       "wound":{"type":"string"}}}')),

  ('location', NULL, 'Location', 'map-pin', json('{
     "type":"object","properties":{
       "parent_location":{"type":"string"},
       "climate":{"type":"string"},
       "population":{"type":"string"},
       "governing_faction":{"type":"string"}}}')),

  ('faction', NULL, 'Faction', 'users', json('{
     "type":"object","properties":{
       "leader":{"type":"string"},
       "allies":{"type":"string"},
       "enemies":{"type":"string"},
       "ideology":{"type":"string","x-long":true},
       "resources":{"type":"string"}}}')),

  ('item', NULL, 'Item', 'package', json('{
     "type":"object","properties":{
       "owner":{"type":"string"},
       "origin":{"type":"string"},
       "powers":{"type":"string","x-long":true},
       "current_location":{"type":"string"}}}')),

  ('species', NULL, 'Species', 'paw-print', json('{
     "type":"object","properties":{
       "lifespan":{"type":"string"},
       "traits":{"type":"string","x-long":true},
       "homeland":{"type":"string"}}}')),

  ('system', NULL, 'System', 'sparkles', json('{
     "type":"object","properties":{
       "rules":{"type":"string","x-long":true},
       "costs":{"type":"string"},
       "limits":{"type":"string","x-long":true},
       "who_can_use":{"type":"string"}}}')),

  ('language', NULL, 'Language', 'languages', json('{
     "type":"object","properties":{
       "phonology":{"type":"string","x-long":true},
       "sample_lexicon":{"type":"string","x-long":true},
       "naming_rules":{"type":"string","x-long":true}}}')),

  ('event', NULL, 'Event', 'calendar', json('{
     "type":"object","properties":{
       "participants":{"type":"string"},
       "consequences":{"type":"string","x-long":true},
       "when":{"type":"string"}}}')),

  ('concept', NULL, 'Concept', 'lightbulb', json('{
     "type":"object","properties":{
       "in_world_term":{"type":"string"},
       "domain":{"type":"string"},
       "notes":{"type":"string","x-long":true}}}')),

  ('theme', NULL, 'Theme', 'quote', json('{
     "type":"object","properties":{
       "statement":{"type":"string","x-long":true},
       "expressions":{"type":"string","x-long":true}}}')),

  ('motif', NULL, 'Motif', 'repeat', json('{
     "type":"object","properties":{
       "statement":{"type":"string"},
       "expressions":{"type":"string","x-long":true}}}'));
