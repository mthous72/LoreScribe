export function LockedScreen({ holderLabel, takeOver, takingOver }: {
  holderLabel: string;
  takeOver: () => void;
  takingOver: boolean;
}) {
  return (
    <div className="mx-auto max-w-lg px-4 py-16">
      <h1 className="text-xl font-semibold">Open somewhere else</h1>
      <p className="mt-3 text-sm opacity-80">
        LoreScribe keeps one writer on a project at a time, because the storage
        engine holds the database file exclusively. Your work is safe — this tab
        simply isn&rsquo;t the one holding it right now.
      </p>
      <p className="mt-3 text-sm opacity-80">
        It&rsquo;s currently open in <strong>{holderLabel}</strong>.
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        {/* A real handoff, not a refresh: the holder is asked to close its
            handles and release, and only then does this tab open. */}
        <button onClick={takeOver} disabled={takingOver}
          className="rounded-lg border border-current/20 bg-current/10 px-4 py-2 text-sm font-medium disabled:opacity-50">
          {takingOver ? 'Asking the other tab…' : 'Take over here'}
        </button>
        <button onClick={() => location.reload()}
          className="rounded-lg px-4 py-2 text-sm underline opacity-70">
          Reload instead
        </button>
      </div>
      <p className="mt-4 text-xs opacity-60">
        If the other tab doesn&rsquo;t answer — it may have crashed — reloading
        this page will take the database once its handles are released.
      </p>
    </div>
  );
}

/** The other side of a takeover: this tab handed the database over. */
export function YieldedScreen({ retry }: { retry: () => void }) {
  return (
    <div className="mx-auto max-w-lg px-4 py-16">
      <h1 className="text-xl font-semibold">Handed over</h1>
      <p className="mt-3 text-sm opacity-80">
        Another tab asked for the database and this one let go. Everything was
        saved before the handover — nothing was in flight.
      </p>
      <button onClick={retry}
        className="mt-6 rounded-lg border border-current/20 bg-current/10 px-4 py-2 text-sm font-medium">
        Take it back
      </button>
    </div>
  );
}
