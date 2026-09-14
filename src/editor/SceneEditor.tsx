import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, Extension, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { mentionDecorationPlugin } from './mentionDecorations';
import { EntityLink } from './entityLink';
import {
  MentionSuggest, setSuggestHandlers, clearSuggestHandlers, suggestKey, type SuggestState,
} from './mentionSuggest';
import { Link } from 'react-router-dom';
import { useDb } from '../app/DbProvider';
import type { Entity } from '../data/codexRepository';
import { loadAliases } from '../index/sceneIndex';
import type { AliasEntry } from '../domain/mentions';
import type { SceneSummary } from '../data/manuscriptRepository';
import { countWords } from '../text/words';

/**
 * The writing surface.
 *
 * Everything here is arranged around one question: what happens to the last
 * sentence typed? A debounce means prose lives in memory for a while before it
 * reaches the database, and every path out of that window has to be closed or
 * the app quietly loses work — which is the one failure that would make
 * everything else here pointless.
 *
 * The windows, and what closes each:
 *
 *  - **The writer keeps typing.** Debounced save, deliberately short.
 *  - **They switch scenes, or navigate away.** Flush on unmount.
 *  - **The phone backgrounds the tab and Android kills it.** `visibilitychange`
 *    to hidden, which is the event that actually fires on mobile — `beforeunload`
 *    is unreliable there, and R2b exists precisely because this platform kills
 *    backgrounded tabs ([doc 16](../../docs/16-phase-0-spike-report.md)).
 *  - **Another tab takes the database over.** `registerFlush`, so the handover
 *    waits for this save rather than racing it.
 *
 * What is NOT saved on a timer is the mention index. Aliases are half-typed for
 * a few keystrokes, so re-detecting on every save would make the highlights
 * flicker; it runs on a longer idle and on the way out.
 */

const SAVE_AFTER_MS = 600;
const REINDEX_AFTER_MS = 4_000;

/**
 * The debounce, overridable by Playwright only.
 *
 * Not a convenience. A test for "the tab being hidden flushes unsaved prose"
 * that leaves the normal debounce running proves nothing: the timer saves the
 * text anyway, well inside the assertion's timeout, and the test passes with
 * the visibilitychange listener deleted — which is exactly what happened to the
 * first version of it. Pushing the debounce out of reach makes the event the
 * only thing that can explain a save.
 *
 * Gated on the build flag, so it is not in the shipped bundle at all.
 */
function saveDelay(): number {
  if (import.meta.env.VITE_TEST_SURFACE) {
    const override = (window as unknown as { __lsSaveDelayMs?: number }).__lsSaveDelayMs;
    if (typeof override === 'number') return override;
  }
  return SAVE_AFTER_MS;
}

type SaveState = 'saved' | 'unsaved' | 'saving' | 'failed';

export function SceneEditor({ projectId, scene }: { projectId: string; scene: SceneSummary }) {
  const db = useDb();
  // Tagged with the scene it belongs to, rather than cleared when the scene
  // changes: for one render after switching scenes the old content is still in
  // state, and mounting the editor with it would show the previous scene's
  // prose under the new scene's id — which the first autosave would then write.
  const [loaded, setLoaded] = useState<
    { sceneId: string; json: string | null; aliases: AliasEntry[] } | null>(null);

  useEffect(() => {
    if (db.state !== 'ready') return;
    let cancelled = false;
    void (async () => {
      const [content, aliases] = await Promise.all([
        db.manuscript.getSceneContent(scene.id),
        loadAliases(db.driver, projectId),
      ]);
      if (!cancelled) {
        setLoaded({ sceneId: scene.id, json: content?.contentJson ?? null, aliases });
      }
    })();
    return () => { cancelled = true; };
  }, [db, projectId, scene.id]);

  if (db.state !== 'ready') return null;
  if (loaded?.sceneId !== scene.id) {
    return <p className="px-2 py-6 text-sm opacity-60">Opening the scene…</p>;
  }

  // Keyed on the scene so a different scene gets a fresh editor rather than a
  // reused one whose undo history belongs to the previous scene's prose.
  return (
    <Surface
      key={scene.id}
      projectId={projectId}
      scene={scene}
      initialJson={loaded.json}
      aliases={loaded.aliases}
    />
  );
}

function Surface({ projectId, scene, initialJson, aliases }: {
  projectId: string;
  scene: SceneSummary;
  initialJson: string | null;
  aliases: AliasEntry[];
}) {
  const db = useDb();
  const [card, setCard] = useState<{ entity: Entity; top: number; left: number } | null>(null);
  const [suggest, setSuggest] = useState<SuggestState | null>(null);
  const [candidates, setCandidates] = useState<Entity[]>([]);
  const [chosen, setChosen] = useState(0);
  // `insertLinkAt` acts on the editor but is defined before it exists, and runs
  // only from a key press or a click — long after effects have settled.
  const editorRef = useRef<Editor | null>(null);

  /**
   * What the editor thinks is being typed, right now.
   *
   * Read from the plugin rather than from `suggest`, which is React's copy and
   * is a render behind. A key handler that trusts the copy decides using text
   * the writer has already moved past.
   */
  const currentSuggest = useCallback((): SuggestState | null => {
    const editor = editorRef.current;
    return editor ? (suggestKey.getState(editor.state) ?? null) : null;
  }, []);

  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [words, setWords] = useState(scene.wordCount);
  const [error, setError] = useState<string | null>(null);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reindexTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The content the editor holds that has not reached the database. Held in a
  // ref so every flush path reads the same value without re-rendering.
  const pending = useRef<{ json: string; text: string } | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);

  const extensions = useMemo(() => [
    StarterKit,
    EntityLink,
    MentionSuggest,
    Extension.create({
      name: 'lorescribeMentions',
      addProseMirrorPlugins: () => [mentionDecorationPlugin({
        aliases,
        detect: { sceneRank: scene.globalRank, povEntityId: scene.povEntityId },
      })],
    }),
  ], [aliases, scene.globalRank, scene.povEntityId]);

  const save = useCallback(async (): Promise<void> => {
    if (db.state !== 'ready') return;
    // Never two writes to one scene at once: the second would race the first
    // and whichever lost would be the newer text.
    if (inFlight.current) await inFlight.current;
    const next = pending.current;
    if (!next) return;
    pending.current = null;
    setSaveState('saving');
    const job = (async () => {
      try {
        const { wordCount } = await db.manuscript.saveSceneContent(scene.id, {
          contentJson: next.json, contentText: next.text,
        });
        setWords(wordCount);
        setSaveState((s) => (pending.current ? s : 'saved'));
        setError(null);
      } catch (e) {
        // Put it back: a failed save must not be a discarded save.
        pending.current = next;
        setSaveState('failed');
        setError((e as Error).message ?? String(e));
      }
    })();
    inFlight.current = job;
    await job;
    inFlight.current = null;
  }, [db, scene.id]);

  const reindex = useCallback(async () => {
    if (db.state !== 'ready') return;
    try { await db.manuscript.reindexScene(projectId, scene.id); }
    catch { /* highlights are derived; a failure here is not the writer's problem */ }
  }, [db, projectId, scene.id]);

  /** Everything outstanding, now. The one function every exit path calls. */
  const flush = useCallback(async () => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    if (reindexTimer.current) { clearTimeout(reindexTimer.current); reindexTimer.current = null; }
    await save();
    await reindex();
  }, [save, reindex]);

  /**
   * Put the link in, replacing the `@query` the writer typed.
   *
   * The name comes from the codex rather than from what they typed, so
   * "@ilv" becomes "Ilva" — the point of a picker is not having to spell it.
   * A trailing space follows, and the mark is non-inclusive, so the next word
   * is ordinary prose rather than more link.
   */
  const insertLinkAt = useCallback((range: { from: number; to: number }, entity: Entity) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.chain().focus().insertContentAt(range, [
      {
        type: 'text',
        text: entity.name,
        marks: [{ type: 'entityLink', attrs: { entityId: entity.id } }],
      },
      { type: 'text', text: ' ' },
    ]).run();
    setSuggest(null);
    setCandidates([]);
  }, []);

  // What the `@` list offers. Matches aliases as well as names, so a character
  // can be reached by any name the book calls them.
  useEffect(() => {
    if (db.state !== 'ready') return;
    let cancelled = false;
    void (async () => {
      const found = suggest
        ? (await db.codex.listEntities(projectId, { search: suggest.query })).slice(0, 8)
        : [];
      if (cancelled) return;
      setCandidates(found);
      setChosen(0);
    })();
    return () => { cancelled = true; };
    // Deliberately NOT depending on insertLinkAt. Adding it made this effect
    // run a second time and land a late setChosen(0), resetting the writer's
    // arrow-key choice a moment after they made it.
  }, [db, projectId, suggest]);

  const editor = useEditor({
    extensions,
    content: initialJson ? (JSON.parse(initialJson) as object) : '',
    editorProps: {
      attributes: {
        class: 'prose-editor min-h-[50vh] outline-none',
        'aria-label': `${scene.title ?? 'Untitled scene'} — scene text`,
      },
    },
    onUpdate({ editor: ed }) {
      const text = ed.getText();
      pending.current = { json: JSON.stringify(ed.getJSON()), text };
      setSaveState('unsaved');
      // Shown from the editor rather than from the last save, so the count is
      // the writer's current text and not a number lagging a debounce behind.
      setWords(countWords(text).words);

      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => { void save(); }, saveDelay());
      if (reindexTimer.current) clearTimeout(reindexTimer.current);
      reindexTimer.current = setTimeout(() => { void reindex(); }, REINDEX_AFTER_MS);
    },
  }, [extensions]);

  // After render, not during it: `insertLink` only ever runs from a key press
  // or a click, both of which happen long after effects have settled.
  useEffect(() => { editorRef.current = editor; }, [editor]);

  // Left for the plugin after each render, read when a key is pressed. They
  // close over the current candidate list, so they are replaced whenever it
  // changes — which is why they cannot be handed over once at construction.
  useEffect(() => {
    const view = editor?.view;
    if (!view) return;
    setSuggestHandlers(view, {
      onState: setSuggest,
      onKeyDown: (event) => {
        if (event.key === 'Escape') {
          setSuggest(null);
          setCandidates([]);
          return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          // The fast path: the list is showing, so the choice is already made.
          const pick = candidates[chosen];
          const showing = currentSuggest();
          if (pick && showing) { insertLinkAt(showing.range, pick); return true; }

          /*
           * The slow path, and the reason it exists.
           *
           * `candidates` is React state fed by a database round trip, so it
           * lags the editor by at least one render — and a writer typing
           * "@ilva" and hitting Enter in one motion outruns it. Deciding from
           * stale state gets it wrong in both directions: an Enter let through
           * breaks the paragraph instead of inserting the link, and an Enter
           * held on a stale "still loading" is simply lost.
           *
           * So the decision is not made from React state at all. The plugin's
           * own state is always current, the lookup is redone for exactly what
           * is on screen, and whichever answer comes back is honoured — insert
           * the match, or perform the paragraph break that was withheld.
           */
          if (!showing) return false;
          const { range, query } = showing;
          void (async () => {
            if (db.state !== 'ready') return;
            const found = await db.codex.listEntities(projectId, { search: query });
            if (found[0]) insertLinkAt(range, found[0]);
            else editorRef.current?.commands.splitBlock();
          })();
          return true;
        }
        if (!candidates.length) return false;
        if (event.key === 'ArrowDown') {
          setChosen((i) => (i + 1) % candidates.length);
          return true;
        }
        if (event.key === 'ArrowUp') {
          setChosen((i) => (i - 1 + candidates.length) % candidates.length);
          return true;
        }
        return false;
      },
    });
    return () => { clearSuggestHandlers(view); };
  }, [editor, candidates, chosen, insertLinkAt, currentSuggest, db, projectId]);

  // Close each window out of the debounce.
  useEffect(() => {
    if (db.state !== 'ready') return;
    const unregister = db.registerFlush(flush);
    const onHidden = () => { if (document.visibilityState === 'hidden') void flush(); };
    document.addEventListener('visibilitychange', onHidden);
    // pagehide fires on the bfcache path, where visibilitychange sometimes
    // does not. Both are cheap and flush() is idempotent once pending is null.
    window.addEventListener('pagehide', onHidden);
    return () => {
      unregister();
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onHidden);
      void flush();
    };
  }, [db, flush]);

  /**
   * Tap a highlighted name to see what the codex knows about it.
   *
   * Tap, not hover. Hover does not exist on a phone, and
   * [D15](../../docs/10-decisions.md) makes the phone a peer rather than a
   * viewer — a card that only appears on mouseover is a feature half the
   * devices cannot reach. It also leaves the caret where the writer put it,
   * because clicking is how they move around their own prose and this must not
   * take that over.
   */
  const onEditorClick = (e: React.MouseEvent) => {
    if (db.state !== 'ready') return;
    const hit = (e.target as HTMLElement).closest<HTMLElement>('[data-entity-id]');
    if (!hit) { setCard(null); return; }
    const id = hit.dataset.entityId!;
    const host = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const box = hit.getBoundingClientRect();
    void db.codex.getEntity(id).then((detail) => {
      if (!detail) { setCard(null); return; }
      setCard({
        entity: detail.entity,
        top: box.bottom - host.top + 6,
        // Kept inside the container: a name at the right edge would otherwise
        // open a card hanging off the page.
        left: Math.max(0, Math.min(box.left - host.left, host.width - 260)),
      });
    });
  };

  return (
    <div className="mt-4">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 text-xs">
        <span className="font-medium">{scene.title ?? 'Untitled scene'}</span>
        <span className="tabular-nums opacity-50">{words.toLocaleString()} words</span>
        <span
          data-save-state={saveState}
          aria-live="polite"
          className={saveState === 'failed' ? 'text-amber-700 dark:text-amber-300' : 'opacity-50'}>
          {saveState === 'saved' && 'Saved'}
          {saveState === 'unsaved' && 'Unsaved…'}
          {saveState === 'saving' && 'Saving…'}
          {/* Named, not swallowed. The writer needs to know their last
              paragraph is only in this tab before they close it. */}
          {saveState === 'failed' && `Not saved — ${error ?? 'unknown error'}`}
        </span>
        {saveState === 'failed' && (
          <button onClick={() => void save()} className="underline">Try again</button>
        )}
      </div>

      <div
        className="relative rounded-xl border border-current/15 p-4"
        onClick={onEditorClick}
        onKeyDown={(e) => { if (e.key === 'Escape') setCard(null); }}>
        <EditorContent editor={editor} />

        {suggest && candidates.length > 0 && editor && (
          <MentionList
            editor={editor}
            from={suggest.range.from}
            candidates={candidates}
            chosen={chosen}
            onPick={(entity) => insertLinkAt(suggest.range, entity)}
          />
        )}

        {card && (
          <div
            role="dialog"
            aria-label={`${card.entity.name} — codex entry`}
            style={{ top: card.top, left: card.left }}
            className="absolute z-10 w-[16rem] rounded-lg border border-current/20
                       bg-white p-3 text-xs shadow-lg dark:bg-neutral-900">
            <p className="font-medium">{card.entity.name}</p>
            <p className="mt-0.5 opacity-50">{card.entity.typeKey} · {card.entity.importance}</p>
            {card.entity.summary && <p className="mt-2 opacity-80">{card.entity.summary}</p>}
            {!card.entity.summary && (
              <p className="mt-2 opacity-60">
                No one-line summary yet. Adding one here is what a brief would
                show instead of the full entry.
              </p>
            )}
            <div className="mt-2 flex gap-3">
              <Link
                to={`/project/${projectId}/codex?entity=${card.entity.id}`}
                className="underline opacity-70">
                Open in codex
              </Link>
              <button onClick={() => setCard(null)} className="underline opacity-50">
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The `@` list, anchored to the caret.
 *
 * Positioned from `coordsAtPos` rather than tracked in state: the caret moves
 * on every keystroke, and a position stored in React would always be one render
 * behind the word it belongs to.
 *
 * Not focusable. The caret stays in the prose the whole time — a menu that took
 * focus to be steered would take the writer's place in the sentence with it.
 * That is why this is a `listbox` the editor points at rather than a row of
 * buttons, and why the plugin borrows the arrow keys instead.
 */
function MentionList({ editor, from, candidates, chosen, onPick }: {
  editor: Editor;
  from: number;
  candidates: Entity[];
  chosen: number;
  onPick: (entity: Entity) => void;
}) {
  const host = editor.view.dom.parentElement;
  if (!host) return null;

  const at = (() => {
    try {
      const caret = editor.view.coordsAtPos(from);
      const box = host.getBoundingClientRect();
      return {
        top: caret.bottom - box.top + 4,
        // Kept inside the editor: a name typed at the right edge would
        // otherwise open a list hanging off the page.
        left: Math.max(0, Math.min(caret.left - box.left, box.width - 240)),
      };
    } catch {
      // A position that no longer resolves means the document moved under us.
      // The next render will have a valid one.
      return null;
    }
  })();
  if (!at) return null;

  return (
    <ul
      role="listbox"
      aria-label="Link to a codex entry"
      style={at}
      className="absolute z-10 w-[15rem] overflow-hidden rounded-lg border border-current/20
                 bg-white text-xs shadow-lg dark:bg-neutral-900">
      {candidates.map((entity, i) => (
        <li
          key={entity.id}
          role="option"
          aria-selected={i === chosen}
          data-chosen={i === chosen ? 'true' : undefined}
          // onMouseDown, not onClick: a click blurs the editor first, which
          // moves the caret out of the range we are about to replace.
          onMouseDown={(e) => { e.preventDefault(); onPick(entity); }}
          className={`flex cursor-pointer items-baseline gap-2 px-2.5 py-1.5
                      ${i === chosen ? 'bg-current/10' : ''}`}>
          <span className="min-w-0 flex-1 truncate">{entity.name}</span>
          <span className="shrink-0 opacity-50">{entity.typeKey}</span>
        </li>
      ))}
    </ul>
  );
}
