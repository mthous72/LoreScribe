import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Hash routing, not history routing: GitHub Pages has no documented SPA
// fallback and the index.html-as-404.html trick is convention with no official
// endorsement. Hash routing sidesteps the question entirely. docs/15 §7.
import { HashRouter } from 'react-router-dom';
import { App } from './app/App';
import './index.css';

// The Playwright test surface is NOT part of the shipped app. It exposes
// entry points that open a caller-named VFS with clearOnInit: true — calling
// window.holdOpen('lorescribe') from a console would wipe the writer's live
// database. Gates A/B/C run against the production build deliberately, so the
// surface is a build-time flag rather than a DEV check: the test builds set
// VITE_TEST_SURFACE, the Pages build does not, and Vite drops the import.
if (import.meta.env.VITE_TEST_SURFACE) await import('./spike/testSurface');

createRoot(document.getElementById('root')!).render(
  <StrictMode><HashRouter><App /></HashRouter></StrictMode>,
);
