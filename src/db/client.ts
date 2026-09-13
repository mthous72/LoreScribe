import type { Req, ReqBody, Res, SqlMethod, Diagnostics, OpenRequest } from './protocol';
import { type SqlDriver, SqlOpenError, classifyOpenFailure } from './driver';

/** Our own worker RPC. The shipped promiser is deprecated — docs/15 §7. */
export class WorkerSqlDriver implements SqlDriver {
  /**
   * Long enough that a genuine bulk import is never cut off, short enough that
   * a dead worker surfaces as an error the UI can explain.
   */
  static requestTimeoutMs = 30_000;
  readonly engine = 'sqlite-wasm-opfs-sahpool';
  #worker: Worker;
  #next = 1;
  #pending = new Map<number, {
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  #dead: { name: string; message: string } | null = null;

  private constructor(worker: Worker) {
    this.#worker = worker;
    this.#worker.onmessage = (ev: MessageEvent<Res>) => {
      const m = ev.data;
      const p = this.#pending.get(m.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.#pending.delete(m.id);
      if (m.ok) p.resolve(m.value);
      else p.reject(m.error);
    };
    // A terminated worker never replies, so without this every in-flight call
    // parks forever and presents as a slow query rather than a dead one. The
    // lesson is recorded in docs/16 and was, until now, guarded only inside the
    // R2b harness — not in the driver that actually runs on the phone whose
    // worker might be reclaimed.
    this.#worker.onerror = (e: ErrorEvent) => this.#fail({
      name: 'WorkerError', message: e.message || 'the database worker failed',
    });
    this.#worker.onmessageerror = () => this.#fail({
      name: 'WorkerError', message: 'the database worker sent an unreadable message',
    });
  }

  #fail(error: { name: string; message: string }): void {
    this.#dead = error;
    for (const [, p] of this.#pending) { clearTimeout(p.timer); p.reject(error); }
    this.#pending.clear();
  }

  static async open(req: OpenRequest): Promise<{ driver: WorkerSqlDriver; diagnostics: Diagnostics }> {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    const driver = new WorkerSqlDriver(worker);
    try {
      const diagnostics = (await driver.#send({ kind: 'open', req })) as Diagnostics;
      return { driver, diagnostics };
    } catch (e) {
      worker.terminate();
      const err = e as { name: string; message: string };
      throw new SqlOpenError(classifyOpenFailure(err.name, err.message), err);
    }
  }

  #send(body: ReqBody, timeoutMs = WorkerSqlDriver.requestTimeoutMs): Promise<unknown> {
    if (this.#dead) return Promise.reject(this.#dead);
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject({
          name: 'WorkerTimeout',
          message: `the database did not answer within ${timeoutMs}ms`,
        });
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#worker.postMessage({ id, ...body } as Req);
    });
  }

  exec(sql: string) { return this.#send({ kind: 'exec', sql }) as Promise<void>; }
  query(sql: string, params: unknown[], method: SqlMethod) {
    return this.#send({ kind: 'query', sql, params, method }) as Promise<{ rows: unknown[] }>;
  }
  batch(items: { sql: string; params: unknown[] }[], wrap = true) {
    return this.#send({ kind: 'batch', items, wrap }) as Promise<void>;
  }
  setJournalMode(mode: string, synchronous?: string) {
    return this.#send({ kind: 'journal', mode, synchronous }) as Promise<{ journalMode: string; lockingMode: string }>;
  }
  diagnostics() { return this.#send({ kind: 'diagnostics' }) as Promise<Diagnostics>; }
  async close() { await this.#send({ kind: 'close' }); }

  /** Cooperative multi-tab handoff — SQLite 3.50's pauseVfs/unpauseVfs. */
  async pause() { await this.#send({ kind: 'pause' }); }
  async unpause() { await this.#send({ kind: 'unpause' }); }
  terminate() {
    this.#fail({ name: 'WorkerTerminated', message: 'the database worker was stopped' });
    this.#worker.terminate();
  }
}
