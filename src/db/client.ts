import type { Req, ReqBody, Res, SqlMethod, Diagnostics, OpenRequest } from './protocol';
import { type SqlDriver, SqlOpenError, classifyOpenFailure } from './driver';

/** Our own worker RPC. The shipped promiser is deprecated — docs/15 §7. */
export class WorkerSqlDriver implements SqlDriver {
  readonly engine = 'sqlite-wasm-opfs-sahpool';
  #worker: Worker;
  #next = 1;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

  private constructor(worker: Worker) {
    this.#worker = worker;
    this.#worker.onmessage = (ev: MessageEvent<Res>) => {
      const m = ev.data;
      const p = this.#pending.get(m.id);
      if (!p) return;
      this.#pending.delete(m.id);
      if (m.ok) p.resolve(m.value);
      else p.reject(m.error);
    };
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

  #send(body: ReqBody): Promise<unknown> {
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
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
  terminate() { this.#worker.terminate(); }
}
