import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { WorkerSqlDriver } from '../db/client';
import { SqlOpenError } from '../db/driver';
import { migrate } from '../db/migrate';
import { ProjectRepository } from '../data/projectRepository';
import { ManuscriptRepository } from '../data/manuscriptRepository';
import { CodexRepository } from '../data/codexRepository';
import { SearchRepository } from '../data/searchRepository';
import { FactsRepository } from '../data/factsRepository';
import { VersionsRepository } from '../data/versionsRepository';
import { ImportRepository } from '../data/importRepository';
import { ExportRepository } from '../data/exportRepository';
import { PlanRepository } from '../data/planRepository';
import { BriefRepository } from '../data/briefRepository';
import { ProviderRepository } from '../data/providerRepository';
import {
  EncryptedCredentialStore, IndexedDbVault, MemoryVault, type CredentialStore,
} from '../ai/credentials';
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
  projects: ProjectRepository;
  manuscript: ManuscriptRepository;
  codex: CodexRepository;
  search: SearchRepository;
  facts: FactsRepository;
  versions: VersionsRepository;
  imports: ImportRepository;
  exports: ExportRepository;
  plan: PlanRepository;
  brief: BriefRepository;
  providers: ProviderRepository;
  /** Where the API key actually lives — D30. Never the database. */
  credentials: CredentialStore;
  diagnostics: Diagnostics;
  storage: StorageStatus;
  /** Non-null when the previous session died without releasing. */
  uncleanShutdown: StaleLock | null;
  /**
   * Register work that must reach the database before it is handed over or
   * closed. Returns an unregister function.
   *
   * This exists for one failure: an editor holds a few hundred milliseconds of
   * typing in memory behind a debounce, and a takeover in another tab closes
   * the database underneath it. The writer loses the last thing they typed, in
   * an app whose entire promise is that their work is safe. A pending save is
   * not something to race — it is something to wait for.
   */
  registerFlush: (flush: () => Promise<void>) => () => void;
  /**
   * Run every registered flush now, and wait for all of them.
   *
   * The handover path calls this on its way out, but so does anything that
   * reads the database expecting to see what is on the screen — keeping a
   * version of a scene, above all. A snapshot taken while the last sentence is
   * still sitting behind the editor's debounce is a snapshot missing the last
   * sentence, and the writer has no way to tell.
   */
  flushAll: () => Promise<void>;
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
  // A ref, not state: registering a flush must not re-render, and the handover
  // path has to see the set as it is at that moment.
  const flushes = useRef(new Set<() => Promise<void>>());

  const registerFlush = useCallback((flush: () => Promise<void>) => {
    flushes.current.add(flush);
    return () => { flushes.current.delete(flush); };
  }, []);

  /**
   * Everything anyone is holding, written now.
   *
   * Settled rather than raced: one failing flush must not stop the others, and
   * every one of them is somebody's prose.
   */
  const flushAll = useCallback(async () => {
    await Promise.allSettled([...flushes.current].map((f) => f()));
  }, []);

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
      // Before anything is closed. The other tab is waiting a few hundred
      // milliseconds; the alternative is losing a sentence.
      try { await flushAll(); } catch { /* recorded below by the failing writer */ }
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

        // A read/write hook onto the LIVE connection, for Playwright only.
        //
        // Tests cannot open their own connection to check what was stored:
        // opfs-sahpool is single-writer and this tab holds it, so a second one
        // is refused. Without this, an assertion about the database can only be
        // made through the UI, and a test that reads the DOM while claiming to
        // read the database is worse than no test.
        //
        // Gated on the same build flag as src/spike/testSurface.ts, so Vite
        // drops it from the Pages build entirely rather than shipping a console
        // route into a writer's manuscript.
        if (import.meta.env.VITE_TEST_SURFACE) {
          (window as unknown as { __lsQuery?: unknown }).__lsQuery =
            (sql: string, params: unknown[] = []) => driver!.query(sql, params, 'all');
        }

        const manuscript = new ManuscriptRepository(driver);
        const codex = new CodexRepository(driver);
        const facts = new FactsRepository(driver);
        const plan = new PlanRepository(driver);
        const storage = await requestPersistence();
        const diagnostics = await driver.diagnostics();
        if (cancelled) return;
        setState({
          state: 'ready', driver,
          projects: new ProjectRepository(driver),
          manuscript,
          codex,
          search: new SearchRepository(driver),
          facts,
          versions: new VersionsRepository(driver, manuscript),
          imports: new ImportRepository(driver, codex, facts, manuscript, plan),
          exports: new ExportRepository(driver),
          plan,
          brief: new BriefRepository(driver),
          providers: new ProviderRepository(driver),
          // In memory when the browser refuses IndexedDB: the key then lasts
          // the session and the screen says so by asking for it again.
          credentials: new EncryptedCredentialStore(
            typeof indexedDB === 'undefined' ? new MemoryVault() : new IndexedDbVault()),
          diagnostics, storage, uncleanShutdown, registerFlush, flushAll,
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
          try { await flushAll(); } catch { /* nothing more we can do */ }
          try { await releaseLockRecord(d, holderId); } catch { /* closing anyway */ }
          try { await d.close(); } catch { /* already gone */ }
          d.terminate();
        }
        l?.release();
      })();
    };
  }, [registerFlush, flushAll]);

  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}
