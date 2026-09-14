import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { useDb } from './DbProvider';
import type { SearchHit, SearchResults } from '../data/searchRepository';
import type { SnippetRun } from '../data/searchQuery';

/**
 * Search across the manuscript and the codex.
 *
 * Both indexes have been built and kept current on every save since the rebuild
 * path landed, and nothing read them until now. This is only a box and a list;
 * the work was already done.
 *
 * Two decisions worth naming. The query lives in the URL, like the open scene
 * and the open codex entry, so a search can be linked to and survives a reload.
 * And an empty box and a fruitless search are different states with different
 * words — "type something" versus "nothing matches" — because showing the
 * second when the first is true is a small lie that makes a working search feel
 * broken.
 */

const DEBOUNCE_MS = 200;

export function SearchPage() {
  const db = useDb();
  const { projectId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const [draft, setDraft] = useState(q);
  const [results, setResults] = useState<SearchResults | null>(null);
  const [searching, setSearching] = useState(false);

  const commit = useCallback((value: string) => {
    setParams((p) => {
      const next = new URLSearchParams(p);
      if (value) next.set('q', value); else next.delete('q');
      return next;
    }, { replace: true });
  }, [setParams]);

  // Typing updates the URL on a delay; the URL is what actually runs a search.
  useEffect(() => {
    const timer = setTimeout(() => commit(draft), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, commit]);

  useEffect(() => {
    if (db.state !== 'ready') return;
    let cancelled = false;
    void (async () => {
      setSearching(true);
      try {
        // Prefix on the last word: results appear while the word is still
        // being typed, which is what makes a debounced box feel live.
        const found = await db.search.search(projectId, q, { prefix: true });
        if (!cancelled) setResults(found);
      } finally {
        if (!cancelled) setSearching(false);
      }
    })();
    return () => { cancelled = true; };
  }, [db, projectId, q]);

  if (db.state !== 'ready') return null;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <Link to={`/project/${projectId}`} className="text-xs underline opacity-60">
        ← Manuscript
      </Link>
      <h1 className="mt-4 text-xl font-semibold">Search</h1>

      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="A word, a name, or &ldquo;a phrase in quotes&rdquo;"
        aria-label="Search this project"
        className="mt-4 w-full rounded-lg border border-current/20 bg-transparent px-3 py-2 text-sm"
      />
      <p className="mt-2 text-xs opacity-60">
        Every word has to appear. Put quotes around words to find them together,
        in that order.
      </p>

      <Outcome results={results} searching={searching} projectId={projectId} />
    </div>
  );
}

function Outcome(
  { results, searching, projectId }:
  { results: SearchResults | null; searching: boolean; projectId: string },
) {
  if (!results) return null;

  // No query at all is not the same as a query that found nothing.
  if (results.expression === null) {
    return (
      <p className="mt-6 text-sm opacity-60">
        Type something to search your scenes, codex and notes.
      </p>
    );
  }

  if (!results.hits.length) {
    return (
      <p aria-live="polite" className="mt-6 text-sm opacity-60">
        {searching ? 'Searching…' : 'Nothing matches that.'}
      </p>
    );
  }

  return (
    <>
      <p aria-live="polite" className="mt-6 text-xs opacity-50">
        {results.hits.length}
        {results.truncated ? '+' : ''} result{results.hits.length === 1 ? '' : 's'}
      </p>
      <ul className="mt-2 divide-y divide-current/10">
        {results.hits.map((hit) => (
          <li key={`${hit.kind}:${hit.id}`} className="py-3">
            <Hit hit={hit} projectId={projectId} />
          </li>
        ))}
      </ul>
    </>
  );
}

function Hit({ hit, projectId }: { hit: SearchHit; projectId: string }) {
  const heading = (
    <span className="flex items-baseline gap-2">
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{hit.title}</span>
      {hit.context && <span className="shrink-0 text-xs opacity-50">{hit.context}</span>}
    </span>
  );

  const href = hit.kind === 'scene' ? `/project/${projectId}?scene=${hit.id}`
    : hit.kind === 'entity' ? `/project/${projectId}/codex?entity=${hit.id}`
      : null;

  return (
    <>
      {href
        ? <Link to={href} className="block hover:underline">{heading}</Link>
        // Facts and notes are indexed and findable, but have no screen to open
        // yet. Showing them unlinked is honest; hiding them would make search
        // quietly incomplete.
        : heading}
      <p className="mt-1 text-xs leading-relaxed opacity-70">
        <Snippet runs={hit.snippet} />
      </p>
    </>
  );
}

function Snippet({ runs }: { runs: SnippetRun[] }) {
  return (
    <>
      {runs.map((run, i) => (
        run.hit
          ? <mark key={i} className="bg-current/15 text-inherit">{run.text}</mark>
          : <span key={i}>{run.text}</span>
      ))}
    </>
  );
}
