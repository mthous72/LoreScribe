import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { WorkerSqlDriver } from '../db/client';
import { SqlOpenError } from '../db/driver';
import { migrate } from '../db/migrate';
import { makeDb, type Db } from '../db/drizzle';
import { ProjectRepository } from '../data/projectRepository';
import { requestPersistence, type StorageStatus } from '../data/storage';
import type { Diagnostics } from '../db/protocol';

interface Ready {
  state: 'ready';
  driver: WorkerSqlDriver;
  db: Db;
  projects: ProjectRepository;
  diagnostics: Diagnostics;
  storage: StorageStatus;
}
type DbState =
  | { state: 'opening' }
  | Ready
  | { state: 'locked'; retry: () => void }
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

    const open = async () => {
      setState({ state: 'opening' });
      try {
        const opened = await WorkerSqlDriver.open({
          path: '/lorescribe.db',        // absolute: sahpool mishandles relative
          vfsName: 'lorescribe',
          minimumCapacity: 8,            // a FILE count; default 6 is too few
        });
        if (cancelled) { await opened.driver.close(); opened.driver.terminate(); return; }
        driver = opened.driver;

        // WAL for steady-state editing: measured 3x faster than `delete` on the
        // autosave write, which is the one on the critical path of writing.
        // docs/16. locking_mode=exclusive is applied first, in the driver.
        await driver.setJournalMode('wal', 'NORMAL');
        await migrate(driver);

        const storage = await requestPersistence();
        const diagnostics = await driver.diagnostics();
        setState({
          state: 'ready', driver, db: makeDb(driver),
          projects: new ProjectRepository(driver), diagnostics, storage,
        });
      } catch (e) {
        if (cancelled) return;
        if (e instanceof SqlOpenError && e.reason === 'held-by-another-tab') {
          setState({ state: 'locked', retry: () => void open() });
        } else {
          setState({ state: 'error', message: (e as Error).message ?? String(e), retry: () => void open() });
        }
      }
    };

    void open();
    return () => { cancelled = true; void driver?.close().then(() => driver?.terminate()); };
  }, []);

  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}
