/**
 * Single-writer lock.
 *
 * opfs-sahpool pre-opens and holds every access handle in its pool, so it is
 * single-connection by construction and a second tab is refused at VFS install
 * time. That refusal has to become a handled state, not a storage error the
 * writer reads as "my novel is corrupted".
 *
 * Three layers, because no one of them does the job:
 *   - Web Locks is the LIVENESS mechanism. The spec guarantees a terminated
 *     agent's locks are released, so a crash or a killed tab needs no heartbeat.
 *   - BroadcastChannel carries the HANDOFF, because Web Locks deliberately has
 *     no way to tell a holder that someone is waiting.
 *   - the project_lock table is the DIAGNOSTIC layer: the label the takeover
 *     screen shows, and evidence of an unclean shutdown. It does not grant
 *     access.
 *
 * `steal: true` is not used. The spec is explicit that a stolen holder's
 * callback keeps running with no exclusivity guarantee — which is precisely the
 * situation that corrupts a database.
 */

export type YieldHandler = () => Promise<void>;

interface Msg { type: 'yield-request' | 'yielded' | 'holding'; holder: string; label?: string }

export class ProjectLock {
  #release!: () => void;
  #channel: BroadcastChannel;
  #onYield?: YieldHandler;

  private constructor(
    readonly projectId: string,
    readonly holderId: string,
    readonly label: string,
  ) {
    this.#channel = new BroadcastChannel(`lorescribe.lock.${projectId}`);
  }

  static lockName(projectId: string): string { return `lorescribe.project.${projectId}`; }

  /** Returns null if another context holds it — never blocks. */
  static async acquire(
    projectId: string, holderId: string, label: string, onYield?: YieldHandler,
  ): Promise<ProjectLock | null> {
    const lock = new ProjectLock(projectId, holderId, label);
    lock.#onYield = onYield;

    const held = await new Promise<boolean>((resolveHeld) => {
      void navigator.locks.request(
        ProjectLock.lockName(projectId),
        { mode: 'exclusive', ifAvailable: true },
        (granted) => {
          if (!granted) { resolveHeld(false); return; }
          // Hold the lock for as long as this promise is unresolved.
          return new Promise<void>((releaseLock) => {
            lock.#release = releaseLock;
            resolveHeld(true);
          });
        },
      );
    });
    if (!held) { lock.#channel.close(); return null; }

    lock.#channel.onmessage = async (ev: MessageEvent<Msg>) => {
      if (ev.data.type !== 'yield-request' || ev.data.holder === holderId) return;
      // Close database handles first — pauseVfs() throws if any are open, which
      // is the VFS making sure the handoff is real.
      if (lock.#onYield) await lock.#onYield();
      lock.#channel.postMessage({ type: 'yielded', holder: holderId } satisfies Msg);
      lock.#release();
    };
    return lock;
  }

  /**
   * Ask whoever holds the lock to let go. Resolves false if nobody answers in
   * time — a holder that has stopped responding is not a holder to wait on.
   */
  static async requestTakeover(projectId: string, holderId: string, timeoutMs = 3000): Promise<boolean> {
    const ch = new BroadcastChannel(`lorescribe.lock.${projectId}`);
    try {
      return await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        ch.onmessage = (ev: MessageEvent<Msg>) => {
          if (ev.data.type === 'yielded' && ev.data.holder !== holderId) {
            clearTimeout(timer);
            resolve(true);
          }
        };
        ch.postMessage({ type: 'yield-request', holder: holderId } satisfies Msg);
      });
    } finally {
      ch.close();
    }
  }

  release(): void {
    this.#release();
    this.#channel.close();
  }
}
