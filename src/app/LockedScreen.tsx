export function LockedScreen({ retry }: { retry: () => void }) {
  return (
    <div className="mx-auto max-w-lg px-4 py-16">
      <h1 className="text-xl font-semibold">Open in another tab</h1>
      <p className="mt-3 text-sm opacity-80">
        LoreScribe keeps one writer on a project at a time, because the storage
        engine holds the database file exclusively. Your work is safe — this tab
        simply isn&rsquo;t the one holding it.
      </p>
      <p className="mt-3 text-sm opacity-80">
        Close the other tab, then try again. If that doesn&rsquo;t work, reload
        this page.
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        {/* Retry works because every open spawns a fresh worker, and the VFS's
            cached install failure is scoped to the JS realm rather than the
            page. Measured, not assumed — docs/16. Reload stays as the fallback
            in case that property is ever lost. */}
        <button onClick={retry}
          className="rounded-lg border border-current/20 bg-current/10 px-4 py-2 text-sm font-medium">
          Try again
        </button>
        <button onClick={() => location.reload()}
          className="rounded-lg px-4 py-2 text-sm underline opacity-70">
          Reload the page
        </button>
      </div>
    </div>
  );
}
