import { Suspense, lazy, useEffect, useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { registerServiceWorker, type UpdateHandle } from '../pwa/register';
import { DbProvider, useDb } from './DbProvider';
import { LockedScreen, YieldedScreen } from './LockedScreen';
import { ProjectsPage } from './ProjectsPage';
import { ManuscriptPage } from './ManuscriptPage';
import { CodexPage } from './CodexPage';
import { SearchPage } from './SearchPage';
import { ImportPage } from './ImportPage';
import { FactsPage } from './FactsPage';
import { PlanPage } from './PlanPage';
import { ProvidersPage } from './ProvidersPage';

/**
 * Diagnostics is developer-only, and it drags the whole measurement rig behind
 * it — the spike runner and a generator that builds a 150,000-word corpus. In
 * the main chunk, every writer downloads all of it on every cold load to reach a
 * page they will never open, and [D13](../../docs/10-decisions.md) makes a phone
 * on mobile data the primary platform. Split out, so the cost lands on whoever
 * asks for it.
 */
const DiagnosticsPage = lazy(() =>
  import('./DiagnosticsPage').then((m) => ({ default: m.DiagnosticsPage })));

/**
 * The update offer, not an update interruption.
 *
 * The service worker deliberately never takes over a live page
 * (tools/swPlugin.ts). The consequence is that somebody has to ask, and the
 * asking has to be easy to ignore: a writer mid-scene should be able to leave
 * this sitting there for a week.
 */
function UpdateBanner() {
  const [update, setUpdate] = useState<UpdateHandle | null>(null);
  useEffect(() => registerServiceWorker(setUpdate), []);
  if (!update) return null;
  return (
    <p className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-current/10 px-4 py-2
                  text-center text-xs">
      A new version of LoreScribe is ready.
      <button onClick={update.apply} className="underline">
        Reload when you&rsquo;re at a stopping point
      </button>
    </p>
  );
}

function Shell() {
  const db = useDb();
  return (
    <div className="min-h-dvh bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <UpdateBanner />
      <header className="border-b border-current/10">
        <nav className="mx-auto flex max-w-3xl flex-wrap items-center gap-x-5 gap-y-1 px-4 py-3 text-sm">
          <span className="font-semibold">LoreScribe</span>
          <NavLink to="/" className={({ isActive }) => isActive ? 'font-medium' : 'opacity-60'}>
            Projects
          </NavLink>
          <NavLink to="/diagnostics" className={({ isActive }) => isActive ? 'font-medium' : 'opacity-60'}>
            Diagnostics
          </NavLink>
        </nav>
      </header>

      {db.state === 'opening' && <p className="mx-auto max-w-3xl px-4 py-16 text-sm opacity-60">Opening…</p>}
      {db.state === 'locked' && (
        <LockedScreen holderLabel={db.holderLabel} takeOver={db.takeOver} takingOver={db.takingOver} />
      )}
      {db.state === 'yielded' && <YieldedScreen retry={db.retry} />}
      {db.state === 'error' && (
        <div className="mx-auto max-w-lg px-4 py-16">
          <h1 className="text-xl font-semibold">Couldn&rsquo;t open the database</h1>
          <p className="mt-3 text-sm opacity-80">{db.message}</p>
          <button onClick={db.retry}
            className="mt-6 rounded-lg border border-current/20 bg-current/10 px-4 py-2 text-sm font-medium">
            Try again
          </button>
        </div>
      )}
      {db.state === 'ready' && (
        <Routes>
          <Route path="/" element={<ProjectsPage />} />
          <Route path="/project/:projectId" element={<ManuscriptPage />} />
          <Route path="/project/:projectId/codex" element={<CodexPage />} />
          <Route path="/project/:projectId/search" element={<SearchPage />} />
          <Route path="/project/:projectId/facts" element={<FactsPage />} />
          <Route path="/project/:projectId/plan" element={<PlanPage />} />
          <Route path="/project/:projectId/import" element={<ImportPage />} />
          <Route path="/project/:projectId/providers" element={<ProvidersPage />} />
          <Route
            path="/diagnostics"
            element={(
              <Suspense fallback={
                <p className="mx-auto max-w-3xl px-4 py-16 text-sm opacity-60">Loading…</p>
              }>
                <DiagnosticsPage />
              </Suspense>
            )}
          />
        </Routes>
      )}
    </div>
  );
}

export function App() {
  return <DbProvider><Shell /></DbProvider>;
}
