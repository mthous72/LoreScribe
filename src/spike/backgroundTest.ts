import { WorkerSqlDriver } from '../db/client';
import { migrate } from '../db/migrate';

/**
 * The backgrounding test — R2b in docs/15 §1.
 *
 * The question is whether `opfs-sahpool`'s exclusive sync access handles
 * survive the tab being backgrounded on Android, where Chrome reclaims
 * resources from background tabs aggressively. If they don't, the web path on
 * the primary platform is unusable and Capacitor moves forward into Phase 0.
 *
 * The test has to hold ONE connection across the interruption. Opening the
 * database, backgrounding, and then opening it again would prove nothing: the
 * second open creates fresh handles, so it succeeds whether or not the first
 * set survived. That distinction is the entire test.
 */

export interface BackgroundProbe {
  at: number;
  /** Milliseconds the tab had been hidden immediately before this probe. */
  hiddenForMs: number;
  outcome: 'survived' | 'failed' | 'unresponsive';
  readOk: boolean;
  writeOk: boolean;
  error?: string;
  /** Trigger, so an automatic probe is distinguishable from a tapped one. */
  source: 'auto' | 'manual';
}

export interface BackgroundState {
  status: 'idle' | 'holding' | 'finished';
  startedAt?: number;
  /** Longest single stretch the tab spent hidden. */
  longestHiddenMs: number;
  totalHiddenMs: number;
  probes: BackgroundProbe[];
  verdict?: 'survived' | 'lost';
}

/**
 * A terminated worker never replies, so a bare await would hang forever and
 * look like a slow query rather than a dead one. Anything past this is treated
 * as the worker being gone, which is itself a failure mode worth naming.
 */
const PROBE_TIMEOUT_MS = 10_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return Promise.race([p, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))]);
}

export class BackgroundTest {
  #driver: WorkerSqlDriver | null = null;
  #hiddenSince: number | null = null;
  #onChange: (s: BackgroundState) => void;

  state: BackgroundState = { status: 'idle', longestHiddenMs: 0, totalHiddenMs: 0, probes: [] };

  constructor(onChange: (s: BackgroundState) => void) {
    this.#onChange = onChange;
  }

  #emit() { this.#onChange({ ...this.state, probes: [...this.state.probes] }); }

  #visibility = () => {
    if (document.visibilityState === 'hidden') {
      this.#hiddenSince = Date.now();
      return;
    }
    if (this.#hiddenSince === null) return;
    const hiddenFor = Date.now() - this.#hiddenSince;
    this.#hiddenSince = null;
    this.state.totalHiddenMs += hiddenFor;
    this.state.longestHiddenMs = Math.max(this.state.longestHiddenMs, hiddenFor);
    // Probe immediately on return, so the answer is recorded even if the tester
    // forgets to tap anything.
    void this.probe('auto', hiddenFor);
  };

  async start(): Promise<void> {
    await this.stop();
    const { driver } = await WorkerSqlDriver.open({
      path: '/lorescribe-background.db',
      vfsName: 'lorescribe-background',
      minimumCapacity: 8,
      clearOnInit: true,
    });
    this.#driver = driver;
    await migrate(driver);
    await driver.query(
      'INSERT INTO project (id,title,created_at,updated_at) VALUES (?,?,?,?)',
      ['pr_bg', 'Backgrounding probe', Date.now(), Date.now()], 'run');

    this.state = {
      status: 'holding', startedAt: Date.now(),
      longestHiddenMs: 0, totalHiddenMs: 0, probes: [],
    };
    document.addEventListener('visibilitychange', this.#visibility);
    this.#emit();
  }

  /** Exercise the HELD connection — a read and a write, since either may fail alone. */
  async probe(source: 'auto' | 'manual', hiddenForMs = this.state.longestHiddenMs): Promise<void> {
    const driver = this.#driver;
    if (!driver || this.state.status !== 'holding') return;

    const probe: BackgroundProbe = {
      at: Date.now(), hiddenForMs, source,
      outcome: 'failed', readOk: false, writeOk: false,
    };

    try {
      const read = await withTimeout(driver.query('SELECT title FROM project WHERE id = ?', ['pr_bg'], 'get'), PROBE_TIMEOUT_MS);
      if (read === 'timeout') {
        probe.outcome = 'unresponsive';
        probe.error = 'the worker did not answer within 10s — it was probably terminated';
      } else {
        probe.readOk = (read.rows as unknown[])[0] === 'Backgrounding probe';
      }

      if (probe.outcome !== 'unresponsive') {
        const write = await withTimeout(driver.query(
          'UPDATE project SET updated_at = ?, rev = rev + 1 WHERE id = ?',
          [Date.now(), 'pr_bg'], 'run'), PROBE_TIMEOUT_MS);
        if (write === 'timeout') {
          probe.outcome = 'unresponsive';
          probe.error = 'the write did not answer within 10s';
        } else {
          probe.writeOk = true;
          probe.outcome = probe.readOk ? 'survived' : 'failed';
        }
      }
    } catch (e) {
      const err = e as { name?: string; message?: string };
      probe.outcome = 'failed';
      probe.error = `${err?.name ?? 'Error'}: ${err?.message ?? String(e)}`;
    }

    this.state.probes.push(probe);
    // One failure after a real backgrounding settles it; later successes do not
    // undo it, because the handle was already lost once.
    if (probe.outcome !== 'survived') this.state.verdict = 'lost';
    else if (!this.state.verdict && probe.hiddenForMs > 0) this.state.verdict = 'survived';
    this.#emit();
  }

  async stop(): Promise<void> {
    document.removeEventListener('visibilitychange', this.#visibility);
    const driver = this.#driver;
    this.#driver = null;
    this.state.status = this.state.probes.length ? 'finished' : 'idle';
    this.#emit();
    if (driver) {
      try { await driver.close(); } catch { /* already gone, which is the finding */ }
      driver.terminate();
    }
  }

  /** A pasteable summary, since the tester is on a phone and typing is painful. */
  report(): string {
    const mins = (ms: number) => `${Math.round(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
    const lines = [
      `R2b backgrounding test — ${navigator.userAgent}`,
      `verdict: ${this.state.verdict ?? 'not yet determined'}`,
      `longest single background: ${mins(this.state.longestHiddenMs)}`,
      `total backgrounded: ${mins(this.state.totalHiddenMs)}`,
      '',
      ...this.state.probes.map((p) =>
        `- ${p.source} probe after ${mins(p.hiddenForMs)}: ${p.outcome}`
        + ` (read ${p.readOk ? 'ok' : 'FAIL'}, write ${p.writeOk ? 'ok' : 'FAIL'})`
        + (p.error ? ` — ${p.error}` : '')),
    ];
    return lines.join('\n');
  }
}
