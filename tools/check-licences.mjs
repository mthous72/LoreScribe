#!/usr/bin/env node
// Dependency-licence allowlist.
//
// Irrelevant while the tool is personal and unpublished (D7) — but a check in
// CI costs one file and stops a copyleft dependency from quietly foreclosing
// the option to release later. docs/13 §4.
//
// Only PRODUCTION dependencies are checked: devDependencies don't ship, so
// their licences don't travel with the artefact.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ALLOWED = new Set([
  'MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD',
  'Unlicense', 'CC0-1.0', 'BlueOak-1.0.0', 'MIT-0', 'Python-2.0',
]);

// sqlite-wasm is dedicated to the public domain, which SPDX has no clean id for
// and which the package expresses in prose rather than a licence field.
const EXEMPT = new Map([['@sqlite.org/sqlite-wasm', 'public domain (SQLite)']]);

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const root = read('package.json');

/** Every transitive production dependency, resolved through node_modules. */
function collect(names, seen = new Map()) {
  for (const name of names) {
    if (seen.has(name)) continue;
    const dir = join('node_modules', name);
    const pkgPath = join(dir, 'package.json');
    if (!existsSync(pkgPath)) { seen.set(name, null); continue; }
    const pkg = read(pkgPath);
    seen.set(name, pkg);
    collect(Object.keys(pkg.dependencies ?? {}), seen);
  }
  return seen;
}

const deps = collect(Object.keys(root.dependencies ?? {}));
const problems = [];
const table = [];

for (const [name, pkg] of [...deps].sort()) {
  if (EXEMPT.has(name)) { table.push([name, EXEMPT.get(name), 'exempt']); continue; }
  if (!pkg) { problems.push(`${name}: not installed — cannot verify its licence`); continue; }
  const raw = typeof pkg.license === 'string'
    ? pkg.license
    : pkg.license?.type ?? (Array.isArray(pkg.licenses) ? pkg.licenses.map((l) => l.type).join(' OR ') : null);
  if (!raw) { problems.push(`${name}: no licence field`); continue; }
  // Accept an OR expression if ANY branch is allowed; require ALL for AND.
  const ok = raw.split(/\s+OR\s+/i).some((branch) =>
    branch.replace(/[()]/g, '').split(/\s+AND\s+/i).every((id) => ALLOWED.has(id.trim())));
  table.push([name, raw, ok ? 'ok' : 'DENIED']);
  if (!ok) problems.push(`${name}: ${raw}`);
}

const width = Math.max(...table.map(([n]) => n.length));
for (const [name, lic, status] of table) {
  console.log(`${status === 'DENIED' ? '!' : ' '} ${name.padEnd(width)}  ${lic}`);
}

if (problems.length) {
  console.error(`\n${problems.length} dependency licence problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\nAllowed: ' + [...ALLOWED].join(', '));
  console.error('Anything else needs a look before it ships. docs/13 §4.');
  process.exit(1);
}
console.log(`\n${table.length} production dependencies, all licences allowed.`);
