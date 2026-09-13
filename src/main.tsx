import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Hash routing, not history routing: GitHub Pages has no documented SPA
// fallback and the index.html-as-404.html trick is convention with no official
// endorsement. Hash routing sidesteps the question entirely. docs/15 §7.
import { HashRouter } from 'react-router-dom';
import { App } from './app/App';
import './index.css';
import './spike/testSurface';

createRoot(document.getElementById('root')!).render(
  <StrictMode><HashRouter><App /></HashRouter></StrictMode>,
);
