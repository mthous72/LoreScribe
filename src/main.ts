import { runSpike, type SpikeResult } from './spike/measure';
import { DEFAULT_SPEC } from './spike/corpus';
import { WorkerSqlDriver } from './db/client';
import { migrate } from './db/migrate';
import { SqlOpenError } from './db/driver';

// Gate A's harness is a route in the real app, not a throwaway: on a phone it
// is the only honest way to get numbers off the actual device, and in month six
// it is the baseline a regression is measured against. docs/15 §2, Path C.

declare global {
  interface Window {
    runSpike: typeof runSpike;
    spikeResult?: SpikeResult;
    /** Test surface: open the VFS without generating a corpus. */
    openOnly: (vfsName: string, clearOnInit?: boolean) => Promise<unknown>;
    /** Test surface: hold the VFS open, returning a handle to release it. */
    holdOpen: (vfsName: string) => Promise<unknown>;
    /** Test surface: reopen after a kill and count what survived. */
    reopenAndCount: (vfsName: string, table: string) => Promise<unknown>;
    /** Test surface: release the held driver, with or without the VFS handoff. */
    releaseHeld: (usePause: boolean) => Promise<unknown>;
    __held?: WorkerSqlDriver;
  }
}
window.runSpike = runSpike;

window.openOnly = async (vfsName, clearOnInit = false) => {
  try {
    const { driver, diagnostics } = await WorkerSqlDriver.open({
      path: '/lorescribe-spike.db', vfsName, minimumCapacity: 8, clearOnInit,
    });
    await driver.close();
    driver.terminate();
    return { ok: true, diagnostics };
  } catch (e) {
    const err = e as SqlOpenError;
    return { ok: false, reason: err.reason, name: err.detail?.name, message: err.message };
  }
};

window.releaseHeld = async (usePause) => {
  const d = window.__held;
  if (!d) return { ok: false, message: 'nothing held' };
  // The cooperative handoff: close handles, pause the VFS (which THROWS if any
  // handle is still open, so the close has to be real), then the next context
  // can install. SQLite 3.50's pauseVfs/unpauseVfs. docs/15 §3c.
  if (usePause) await d.pause(); else await d.close();
  d.terminate();
  window.__held = undefined;
  return { ok: true };
};

window.reopenAndCount = async (vfsName, table) => {
  try {
    const { driver, diagnostics } = await WorkerSqlDriver.open({
      path: '/lorescribe-spike.db', vfsName, minimumCapacity: 8, clearOnInit: false,
    });
    const { rows } = await driver.query(`SELECT COUNT(*) FROM ${table}`, [], 'get');
    const integrity = await driver.query('PRAGMA integrity_check', [], 'get');
    await driver.close();
    driver.terminate();
    return {
      ok: true,
      count: Number((rows as unknown[])[0]),
      integrity: String((integrity.rows as unknown[])[0]),
      journalMode: diagnostics.journalMode,
    };
  } catch (e) {
    const err = e as SqlOpenError;
    return { ok: false, reason: err.reason, message: err.message };
  }
};

window.holdOpen = async (vfsName) => {
  const { driver, diagnostics } = await WorkerSqlDriver.open({
    path: '/lorescribe-spike.db', vfsName, minimumCapacity: 8, clearOnInit: true,
  });
  await migrate(driver);
  await driver.query(
    'INSERT INTO project (id,title,created_at,updated_at) VALUES (?,?,?,?)',
    ['pr_hold', 'Held Project', Date.now(), Date.now()], 'run');
  window.__held = driver;
  return { ok: true, diagnostics };
};

const app = document.getElementById('app')!;
const esc = (s: unknown) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!));

app.innerHTML = `
  <style>
    :root { color-scheme: light dark; }
    body { font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 0; }
    main { max-width: 900px; margin: 0 auto; padding: 24px 16px; }
    h1 { font-size: 1.25rem; margin: 0 0 4px; }
    p.sub { margin: 0 0 20px; opacity: .7; }
    button { font: inherit; padding: 10px 16px; border-radius: 8px; cursor: pointer; }
    table { border-collapse: collapse; width: 100%; margin-top: 16px; }
    th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid color-mix(in srgb, currentColor 15%, transparent); vertical-align: top; }
    td.v { font-variant-numeric: tabular-nums; white-space: nowrap; }
    .pass { color: #16794a; font-weight: 600; }
    .fail { color: #b3261e; font-weight: 600; }
    .info { opacity: .6; }
    .detail { display: block; font-size: .85em; opacity: .65; }
    pre#log { background: color-mix(in srgb, currentColor 6%, transparent); padding: 10px; border-radius: 8px;
              max-height: 180px; overflow: auto; font-size: 12px; }
  </style>
  <h1>LoreScribe — storage spike (Gate A)</h1>
  <p class="sub">opfs-sahpool over OPFS, ${DEFAULT_SPEC.scenes} scenes &middot;
    ${(DEFAULT_SPEC.scenes * DEFAULT_SPEC.wordsPerScene).toLocaleString()} words &middot;
    seed ${DEFAULT_SPEC.seed}</p>
  <button id="run">Run the spike</button>
  <pre id="log" hidden></pre>
  <div id="out"></div>`;

const logEl = app.querySelector<HTMLPreElement>('#log')!;
const outEl = app.querySelector<HTMLDivElement>('#out')!;

function render(r: SpikeResult): void {
  if (r.failure) {
    outEl.innerHTML = `<p class="fail">Open failed: ${esc(r.failure.reason)}</p>
      <p>${esc(r.failure.name)}: ${esc(r.failure.message)}</p>
      ${r.failure.reason === 'held-by-another-tab'
        ? `<p><strong>This project is open in another tab.</strong> Close it there, then
           <button onclick="location.reload()">reload this page</button>.
           A retry button could never work here: the failed VFS install is cached
           for the life of the page.</p>` : ''}`;
    return;
  }
  const rows = r.measurements.map((m) => `
    <tr>
      <td>${esc(m.label)}${m.detail ? `<span class="detail">${esc(m.detail)}</span>` : ''}</td>
      <td class="v">${esc(m.value ?? '—')} ${esc(m.unit)}</td>
      <td class="v info">${esc(m.target)}</td>
      <td class="${m.pass === null ? 'info' : m.pass ? 'pass' : 'fail'}">
        ${m.pass === null ? '—' : m.pass ? 'pass' : 'FAIL'}</td>
    </tr>`).join('');
  outEl.innerHTML = `<table>
    <thead><tr><th>Measure</th><th>Result</th><th>Target</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table>
    <p class="info">${esc(r.userAgent)}</p>`;
}

app.querySelector<HTMLButtonElement>('#run')!.onclick = async (ev) => {
  const btn = ev.currentTarget as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = 'Running…';
  logEl.hidden = false;
  logEl.textContent = '';
  const log = (s: string) => { logEl.textContent += s + '\n'; logEl.scrollTop = logEl.scrollHeight; };
  try {
    const r = await runSpike(DEFAULT_SPEC, { clearOnInit: true, log });
    window.spikeResult = r;
    render(r);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run again';
  }
};
