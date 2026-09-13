/**
 * Single-writer lock over the database file.
 *
 * Scoped to the DATABASE, not to a project, and that correction matters. The
 * contended resource is the OPFS file: `opfs-sahpool` pre-opens every handle in
 * its pool, so a second context cannot install the VFS at all — it is refused
 * before it can reach any individual project. A per-project lock would be
 * describing a granularity the storage engine does not have.
 *
 * It also settles what `project_lock` can be used for. The losing tab has no
 * database access by definition, so it cannot read a holder label out of a
 * table — the label has to arrive over BroadcastChannel. What the table is
 * genuinely good for is the opposite direction: a row still present when a new
 * session opens is evidence the previous one died without releasing.
 *
 * Three mechanisms, each doing the one thing it is good at:
 *   - **Web Locks** — liveness. The spec releases a terminated agent's locks, so
 *     a crash needs no timeout and no heartbeat.
 *   - **BroadcastChannel** — the handoff, because Web Locks deliberately offers
 *     no way to tell a holder that someone is waiting.
 *   - **`project_lock`** — evidence of an unclean shutdown, read on open.
 */

export type YieldHandler = () => Promise<void>;

interface Msg {
  type: 'who' | 'holder' | 'yield-request' | 'yielded' | 'refused';
  from: string;
  label?: string;
}

const CHANNEL = (name: string) => `lorescribe.lock.${name}`;

export interface HolderInfo {
  /** What to show the writer: "another tab", or a device name if we ever have one. */
  label: string;
}

export class DatabaseLock {
  #release!: () => void;
  #channel: BroadcastChannel;
  #onYield?: YieldHandler;
  #yielded = false;

  private constructor(readonly name: string, readonly holderId: string, readonly label: string) {
    this.#channel = new BroadcastChannel(CHANNEL(name));
  }

  static lockName(name: string): string { return `lorescribe.db.${name}`; }

  /**
   * Take the lock, or return null immediately if another context holds it.
   * Never blocks: a writer waiting on an invisible queue is worse than being
   * told what is going on.
   */
  static async acquire(
    name: string, holderId: string, label: string, onYield?: YieldHandler,
    opts: { waitMs?: number } = {},
  ): Promise<DatabaseLock | null> {
    const deadline = Date.now() + (opts.waitMs ?? 0);
    for (;;) {
      const lock = await DatabaseLock.#tryAcquire(name, holderId, label, onYield);
      if (lock) return lock;
      // A handoff is not instantaneous: the previous holder's release has to
      // propagate. Poll briefly rather than declaring the database busy the
      // moment it was handed over to us.
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  static async #tryAcquire(
    name: string, holderId: string, label: string, onYield?: YieldHandler,
  ): Promise<DatabaseLock | null> {
    const lock = new DatabaseLock(name, holderId, label);
    lock.#onYield = onYield;

    const held = await new Promise<boolean>((resolveHeld) => {
      void navigator.locks.request(
        DatabaseLock.lockName(name),
        { mode: 'exclusive', ifAvailable: true },
        (granted) => {
          if (!granted) { resolveHeld(false); return; }
          return new Promise<void>((releaseLock) => {
            lock.#release = releaseLock;
            resolveHeld(true);
          });
        },
      );
    });

    if (!held) { lock.#channel.close(); return null; }
    lock.#listen();
    return lock;
  }

  #listen(): void {
    this.#channel.onmessage = async (ev: MessageEvent<Msg>) => {
      const msg = ev.data;
      if (msg.from === this.holderId) return;

      if (msg.type === 'who') {
        this.#channel.postMessage({ type: 'holder', from: this.holderId, label: this.label } satisfies Msg);
        return;
      }

      if (msg.type === 'yield-request') {
        if (!this.#onYield) {
          this.#channel.postMessage({ type: 'refused', from: this.holderId } satisfies Msg);
          return;
        }
        // Close database handles and pause the VFS BEFORE releasing, or the
        // waiting tab wins the lock and is then refused by the VFS anyway —
        // which looks exactly like the bug the takeover exists to remove.
        try {
          await this.#onYield();
        } catch {
          this.#channel.postMessage({ type: 'refused', from: this.holderId } satisfies Msg);
          return;
        }
        this.#yielded = true;
        // Release the Web Lock BEFORE announcing it. Announcing first loses the
        // race: the waiting tab hears "yielded", asks for the lock with
        // ifAvailable, finds it still held, and falls straight back to the
        // locked screen it just tried to leave.
        this.#releaseLock();
        this.#channel.postMessage({ type: 'yielded', from: this.holderId } satisfies Msg);
        this.#channel.close();
      }
    };
  }

  get yielded(): boolean { return this.#yielded; }

  /** Ask whoever holds it to identify themselves. Resolves null if nobody answers. */
  static async whoHolds(name: string, asker: string, timeoutMs = 1500): Promise<HolderInfo | null> {
    const ch = new BroadcastChannel(CHANNEL(name));
    try {
      return await new Promise<HolderInfo | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        ch.onmessage = (ev: MessageEvent<Msg>) => {
          if (ev.data.type === 'holder' && ev.data.from !== asker) {
            clearTimeout(timer);
            resolve({ label: ev.data.label ?? 'another tab' });
          }
        };
        ch.postMessage({ type: 'who', from: asker } satisfies Msg);
      });
    } finally { ch.close(); }
  }

  /**
   * Ask the holder to let go. Resolves false if it refuses or does not answer —
   * a holder that has stopped responding is not one to wait on, and the caller
   * still has reload as a fallback.
   */
  static async requestTakeover(name: string, asker: string, timeoutMs = 5000): Promise<boolean> {
    const ch = new BroadcastChannel(CHANNEL(name));
    try {
      return await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        ch.onmessage = (ev: MessageEvent<Msg>) => {
          if (ev.data.from === asker) return;
          if (ev.data.type === 'yielded') { clearTimeout(timer); resolve(true); }
          if (ev.data.type === 'refused') { clearTimeout(timer); resolve(false); }
        };
        ch.postMessage({ type: 'yield-request', from: asker } satisfies Msg);
      });
    } finally { ch.close(); }
  }

  #releaseLock(): void {
    try { this.#release?.(); } catch { /* already released */ }
  }

  release(): void {
    this.#releaseLock();
    this.#channel.close();
  }
}

/**
 * `steal: true` is deliberately never used anywhere in this file. The spec is
 * explicit that a stolen holder's callback keeps running with no exclusivity
 * guarantee, which is precisely the state that corrupts a database — two
 * contexts believing they own the same file. The escape hatch for a
 * non-responding holder is reload, which kills the holder outright.
 */
