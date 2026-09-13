import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { WorkerSqlDriver } from '../db/client';
import { SqlOpenError } from '../db/driver';
import { migrate } from '../db/migrate';
import { makeDb, type Db } from '../db/drizzle';
import { ProjectRepository } from '../data/projectRepository';
import { requestPersistence, type StorageStatus } from '../data/storage';
import { takeOverLockRecord, beatLockRecord, releaseLockRecord, type StaleLock } from '../data/lockRecord';
import { DatabaseLock } from '../lock/databaseLock';
import { sessionId } from '../data/ids';
import type { Diagnostics } from '../db/protocol';

const DB_NAME = 'lorescribe';
const DB_PATH = '/lorescribe.db';
const HEARTBEAT_MS = 15_000;

interface Ready {
  state: 'ready';
  driver: WorkerSqlDriver;
  db: Db;
  projects: ProjectRepository;
  diagnostics: Diagnostics;
  storage: StorageStatus;
  /** Non-null when the previous session died without releasing. */
  uncleanShutdown: StaleLock | null;
}
type DbState =
  | { state: 'opening' }
  | Ready
  | { state: 'locked'; holderLabel: string; takeOver: () => void; retry: () => void; takingOver: boolean }
  | { state: 'yielded'; retry: () => void }
  | { state: 'error'; message: string; retry: () => void };

const Ctx = createContext<DbState>({ state: 'opening' });
export const useDb = () => useContext(Ctx);
export function useReadyDb(): Ready {
  const s = useDb();
  if (s.state !== 'ready') throw new Error('database not ready');
  return s;
}

export function DbProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DbState>({ state: 'opening' });

  useEffect(() => {
    let cancelled = false;
    let driver: WorkerSqlDriver | null = null;
    let lock: DatabaseLock | null = null;
    let beat: ReturnType<typeof setInterval> | null = null;
    const holderId = sessionId;
    const holderLabel = 'another tab on this device';

    /** Give up the database so a waiting context can have it. */
    const yieldDatabase = async () => {
      if (beat) { clearInterval(beat); beat = null; }
      const d = driver;
      driver = null;
      if (d) {
        try { await releaseLockRecord(d, holderId); } catch { /* going anyway */ }
        // pause() closes handles AND releases the VFS, which is the part that
        // matters: releasing the Web Lock alone would let the other tab win the
        // lock and then be refused by the VFS — the exact confusion a takeover
        // exists to remove.
        try { await d.pause(); } catch { try { await d.close(); } catch { /* gone */ } }
        d.terminate();
      }
      if (!cancelled) setState({ state: 'yielded', retry: () => void open() });
    };

    const open = async (afterTakeover = false) => {
      setState({ state: 'opening' });

      lock = await DatabaseLock.acquire(DB_NAME, holderId, holderLabel, yieldDatabase,
        // After a handoff the previous holder has released, but the VFS handles
        // it was holding take a moment to come free. Wait rather than bouncing
        // the writer back to the screen they just left.
        { waitMs: afterTakeover ? 5_000 : 0 });
      if (cancelled) { lock?.release(); return; }

      if (!lock) {
        const holder = await DatabaseLock.whoHolds(DB_NAME, holderId);
        if (cancelled) return;
        setState({
          state: 'locked',
          holderLabel: holder?.label ?? 'another tab',
          takingOver: false,
          retry: () => void open(),
          takeOver: () => {
            setState((s) => (s.state === 'locked' ? { ...s, takingOver: true } : s));
            void (async () => {
              const ok = await DatabaseLock.requestTakeover(DB_NAME, holderId);
              if (cancelled) return;
              if (ok) void open(true);
              else setState((s) => (s.state === 'locked' ? { ...s, takingOver: false } : s));
            })();
          },
        });
        return;
      }

      try {
        const opened = await WorkerSqlDriver.open({
          path: DB_PATH, vfsName: DB_NAME, minimumCapacity: 8,
        });
        if (cancelled) { await opened.driver.close(); opened.driver.terminate(); lock.release(); return; }
        driver = opened.driver;

        // WAL for steady-state editing — 3x faster on the autosave write, which
        // is the one on the critical path of writing (docs/16, D19).
        await driver.setJournalMode('wal', 'NORMAL');
        await migrate(driver);

        const uncleanShutdown = await takeOverLockRecord(driver, holderId, holderLabel);
        beat = setInterval(() => {
          if (driver) void beatLockRecord(driver, holderId).catch(() => { /* best effort */ });
        }, HEARTBEAT_MS);

        const storage = await requestPersistence();
        const diagnostics = await driver.diagnostics();
        if (cancelled) return;
        setState({
          state: 'ready', driver, db: makeDb(driver),
          projects: new ProjectRepository(driver), diagnostics, storage, uncleanShutdown,
        });
      } catch (e) {
        lock?.release();
        lock = null;
        if (cancelled) return;
        if (e instanceof SqlOpenError && e.reason === 'held-by-another-tab') {
          // The lock was free but the VFS was not — a previous context died
          // without its handles being reclaimed yet. Reload is the honest fix.
          setState({ state: 'locked', holderLabel: 'another tab', takingOver: false,
            takeOver: () => location.reload(), retry: () => void open() });
        } else {
          setState({ state: 'error', message: (e as Error).message ?? String(e), retry: () => void open() });
        }
      }
    };

    void open();
    return () => {
      cancelled = true;
      if (beat) clearInterval(beat);
      const d = driver;
      const l = lock;
      void (async () => {
        if (d) {
          try { await releaseLockRecord(d, holderId); } catch { /* closing anyway */ }
          try { await d.close(); } catch { /* already gone */ }
          d.terminate();
        }
        l?.release();
      })();
    };
  }, []);

  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}
