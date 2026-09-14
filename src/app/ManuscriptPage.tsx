import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { useDb } from './DbProvider';
import { useReorder, type DropTarget } from '../ui/useReorder';
import type { OutlineGroup } from '../data/manuscriptRepository';
import { SceneEditor } from '../editor/SceneEditor';
import { SceneCast } from './SceneCast';
import { SceneVersions } from './SceneVersions';

/**
 * The manuscript tree.
 *
 * The repository's promise is that a reorder writes one row; this is where a
 * writer can actually cause one. Two things about it are deliberate:
 *
 * **Every reorder has a keyboard path.** Alt+↑ / Alt+↓ on a focused row, doing
 * exactly what a drag does, including across a chapter boundary. Drag is the
 * enhancement, not the feature — a tree only reorderable by dragging is a tree
 * some writers cannot reorder at all, and the whole point of a manuscript view
 * is moving things around in it.
 *
 * **Moving down past the end of a chapter moves into the next one.** The rows
 * are one list in reading order, so "one position down" means one position in
 * the manuscript, not one position within some container the writer was not
 * thinking about. That is also why the move takes its target from the
 * neighbouring scene rather than from a chapter picker.
 */

type Busy = null | 'loading' | 'writing';

export function ManuscriptPage() {
  const db = useDb();
  const { projectId = '' } = useParams();
  const [bookId, setBookId] = useState<string | null>(null);
  const [bookTitle, setBookTitle] = useState('');
  const [outline, setOutline] = useState<OutlineGroup[]>([]);
  // The open scene lives in the URL, not in component state: a backlink from
  // the codex has to be able to name one, and a reload should come back to the
  // scene the writer was in rather than to the top of the book.
  const [params, setParams] = useSearchParams();
  const selected = params.get('scene');
  const setSelected = useCallback((id: string | null) => {
    setParams((p) => {
      const next = new URLSearchParams(p);
      if (id) next.set('scene', id); else next.delete('scene');
      return next;
    }, { replace: true });
  }, [setParams]);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>('loading');
  const [announcement, setAnnouncement] = useState('');
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((g) => g + 1), []);
  // Separate from `generation`, which every tree write bumps: this one remounts
  // the editor, and doing that on a rename would throw away the writer's undo
  // history for no reason.
  const [contentToken, setContentToken] = useState(0);

  useEffect(() => {
    if (db.state !== 'ready' || !projectId) return;
    let cancelled = false;
    void (async () => {
      const books = await db.manuscript.listBooks(projectId);
      const first = books[0];
      const groups = first ? await db.manuscript.outline(first.id) : [];
      if (cancelled) return;
      setBookId(first?.id ?? null);
      setBookTitle(first?.title ?? '');
      setOutline(groups);
      setBusy(null);
    })();
    return () => { cancelled = true; };
  }, [db, projectId, generation]);

  /** Every scene in the book, in reading order — what a move is relative to. */
  const scenes = useMemo(
    () => outline.flatMap((g) => g.chapters.flatMap((c) => c.scenes)), [outline]);
  const chapters = useMemo(
    () => outline.flatMap((g) => g.chapters.map((c) => c.chapter)), [outline]);

  const write = useCallback(async (job: () => Promise<void>, say?: string) => {
    setBusy('writing');
    try {
      await job();
      if (say) setAnnouncement(say);
    } finally {
      setBusy(null);
      reload();
    }
  }, [reload]);

  /** A drop, from either a pointer or a key. */
  const place = useCallback(async (kind: string, movedId: string, target: DropTarget) => {
    if (db.state !== 'ready') return;
    if (kind === 'scene') {
      const onto = scenes.find((s) => s.id === target.id);
      if (!onto) return;
      await write(
        () => db.manuscript.moveScene(movedId, {
          chapterId: onto.chapterId,
          ...(target.side === 'before' ? { beforeId: onto.id } : { afterId: onto.id }),
        }).then(() => undefined),
        `${label(scenes.find((s) => s.id === movedId))} moved ${target.side} ${label(onto)}`,
      );
    } else if (kind === 'chapter') {
      const onto = chapters.find((c) => c.id === target.id);
      if (!onto) return;
      await write(
        () => db.manuscript.moveChapter(movedId, {
          partId: onto.partId,
          ...(target.side === 'before' ? { beforeId: onto.id } : { afterId: onto.id }),
        }).then(() => undefined),
        `${label(chapters.find((c) => c.id === movedId))} moved ${target.side} ${label(onto)}`,
      );
    }
  }, [db, scenes, chapters, write]);

  const { handleProps, draggingId, dropTarget } = useReorder(place);

  /**
   * Alt+arrow, resolved against the neighbour rather than against a container.
   *
   * When the neighbour is in a different chapter the sides flip: one position
   * up from the first scene of chapter two is the LAST position of chapter one,
   * which is `after` that scene, not `before` it.
   */
  const nudge = useCallback((kind: 'scene' | 'chapter', id: string, delta: -1 | 1) => {
    if (kind === 'scene') {
      const i = scenes.findIndex((s) => s.id === id);
      const neighbour = scenes[i + delta];
      if (i < 0 || !neighbour) return;
      const sameChapter = neighbour.chapterId === scenes[i]!.chapterId;
      const side: DropTarget['side'] = sameChapter
        ? (delta === -1 ? 'before' : 'after')
        : (delta === -1 ? 'after' : 'before');
      void place('scene', id, { id: neighbour.id, side });
      return;
    }
    const i = chapters.findIndex((c) => c.id === id);
    const neighbour = chapters[i + delta];
    if (i < 0 || !neighbour) return;
    void place('chapter', id, { id: neighbour.id, side: delta === -1 ? 'before' : 'after' });
  }, [scenes, chapters, place]);

  const onRowKeyDown = (kind: 'scene' | 'chapter', id: string) => (e: React.KeyboardEvent) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    nudge(kind, id, e.key === 'ArrowUp' ? -1 : 1);
  };

  if (db.state !== 'ready') return null;

  if (busy === 'loading') {
    return <p className="mx-auto max-w-3xl px-4 py-16 text-sm opacity-60">Loading…</p>;
  }

  if (!bookId) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <Back />
        <h1 className="mt-4 text-xl font-semibold">No book yet</h1>
        <p className="mt-2 text-sm opacity-70">
          A project holds one book, or a series of them. Start with one.
        </p>
        <button
          onClick={() => void write(async () => {
            await db.manuscript.createBook(projectId, 'Book One');
          })}
          className="mt-4 rounded-lg border border-current/20 bg-current/10 px-4 py-2 text-sm font-medium">
          Create the first book
        </button>
      </div>
    );
  }

  const words = scenes.reduce((n, s) => n + s.wordCount, 0);
  const openScene = scenes.find((s) => s.id === selected) ?? null;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <Back />
      <div className="mt-4 flex flex-wrap items-baseline gap-x-3">
        <h1 className="text-xl font-semibold">{bookTitle}</h1>
        <p className="text-xs tabular-nums opacity-60">
          {chapters.length} chapter{chapters.length === 1 ? '' : 's'} ·{' '}
          {scenes.length} scene{scenes.length === 1 ? '' : 's'} · {words.toLocaleString()} words
        </p>
      </div>

      <p className="mt-2 text-xs opacity-60">
        Drag a row by its handle, or focus one and press Alt with the up and down
        arrows. Moving a scene past the end of a chapter moves it into the next.
      </p>
      <div className="mt-2 flex flex-wrap gap-x-4 text-xs">
        <Link to={`/project/${projectId}/codex`} className="underline opacity-70">
          Codex — the people, places and things this book knows about →
        </Link>
        <Link to={`/project/${projectId}/facts`} className="underline opacity-70">
          Facts — what is true, and who knows →
        </Link>
        <Link to={`/project/${projectId}/search`} className="underline opacity-70">
          Search →
        </Link>
      </div>

      {/* Announced rather than only shown: a drag gives sighted feedback the
          keyboard path does not. */}
      <p aria-live="polite" className="sr-only">{announcement}</p>

      <ol className="mt-6 space-y-6">
        {outline.map((group) => (
          <li key={group.part?.id ?? 'loose'}>
            {group.part && (
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide opacity-50">
                {group.part.title ?? 'Untitled part'}
              </h2>
            )}
            <ol className="space-y-3">
              {group.chapters.map(({ chapter, scenes: within }) => (
                <li key={chapter.id}>
                  <Row
                    kind="chapter" id={chapter.id}
                    title={chapter.title ?? 'Untitled chapter'}
                    meta={`${within.length} scene${within.length === 1 ? '' : 's'}`}
                    dragging={draggingId === chapter.id}
                    drop={dropTarget?.id === chapter.id ? dropTarget.side : null}
                    handleProps={handleProps}
                    onKeyDown={onRowKeyDown('chapter', chapter.id)}
                    editing={editing === chapter.id}
                    onEdit={() => setEditing(chapter.id)}
                    onCommit={(title) => {
                      setEditing(null);
                      void write(() => db.manuscript.renameChapter(chapter.id, title));
                    }}
                    onCancel={() => setEditing(null)}
                    onRemove={() => void write(
                      () => db.manuscript.removeChapter(chapter.id),
                      `${chapter.title ?? 'Chapter'} deleted`)}
                    disabled={busy !== null}
                  />

                  <ol className="mt-1 space-y-1 pl-6">
                    {within.map((scene) => (
                      <li key={scene.id}>
                        <Row
                          kind="scene" id={scene.id}
                          title={scene.title ?? 'Untitled scene'}
                          meta={scene.wordCount ? `${scene.wordCount.toLocaleString()} words` : 'empty'}
                          selected={selected === scene.id}
                          onSelect={() => setSelected(scene.id)}
                          dragging={draggingId === scene.id}
                          drop={dropTarget?.id === scene.id ? dropTarget.side : null}
                          handleProps={handleProps}
                          onKeyDown={onRowKeyDown('scene', scene.id)}
                          editing={editing === scene.id}
                          onEdit={() => setEditing(scene.id)}
                          onCommit={(title) => {
                            setEditing(null);
                            void write(() => db.manuscript.renameScene(scene.id, title));
                          }}
                          onCancel={() => setEditing(null)}
                          onRemove={() => void write(
                            () => db.manuscript.removeScene(scene.id),
                            `${scene.title ?? 'Scene'} deleted`)}
                          disabled={busy !== null}
                        />
                      </li>
                    ))}
                    <li>
                      <button
                        disabled={busy !== null}
                        onClick={() => void write(async () => {
                          await db.manuscript.createScene(
                            chapter.id, `Scene ${within.length + 1}`);
                        })}
                        className="px-1 py-1 text-xs underline opacity-50 disabled:opacity-30">
                        Add a scene
                      </button>
                    </li>
                  </ol>
                </li>
              ))}
            </ol>
          </li>
        ))}
      </ol>

      <button
        disabled={busy !== null}
        onClick={() => void write(async () => {
          await db.manuscript.createChapter(bookId, `Chapter ${chapters.length + 1}`);
        })}
        className="mt-6 rounded-lg border border-current/20 bg-current/10 px-4 py-2 text-sm
                   font-medium disabled:opacity-50">
        Add a chapter
      </button>

      {openScene
        ? (
          <>
            <SceneEditor
              projectId={projectId} scene={openScene} reloadToken={contentToken} />
            <SceneCast projectId={projectId} sceneId={openScene.id} />
            <SceneVersions
              // Keyed on the scene: the chosen comparison, the last message and
              // a half-typed draft name all belong to the scene they were made
              // in, and carrying them across would point the pickers at drafts
              // the new scene does not have.
              key={openScene.id}
              projectId={projectId}
              scene={openScene}
              onRestored={() => { setContentToken((n) => n + 1); reload(); }}
            />
          </>
        )
        : (
          <p className="mt-8 text-sm opacity-60">
            Choose a scene above to write in it.
          </p>
        )}
    </div>
  );
}

function Back() {
  return <Link to="/" className="text-xs underline opacity-60">← Projects</Link>;
}

function label(item: { title: string | null } | undefined): string {
  return item?.title ?? 'Untitled';
}

interface RowProps {
  kind: 'chapter' | 'scene';
  id: string;
  title: string;
  meta: string;
  selected?: boolean;
  onSelect?: () => void;
  dragging: boolean;
  drop: 'before' | 'after' | null;
  handleProps: ReturnType<typeof useReorder>['handleProps'];
  onKeyDown: (e: React.KeyboardEvent) => void;
  editing: boolean;
  onEdit: () => void;
  onCommit: (title: string) => void;
  onCancel: () => void;
  onRemove: () => void;
  disabled: boolean;
}

function Row(props: RowProps) {
  const { kind, id, title, meta, dragging, drop, editing } = props;
  return (
    <div
      data-row-id={id}
      data-row-kind={kind}
      // The row is focusable so the keyboard path has somewhere to land, and
      // carries the move affordance in its accessible name rather than leaving
      // it to the hint paragraph above, which a screen reader may be past.
      tabIndex={0}
      role="button"
      aria-label={`${title}, ${meta}. Alt with up or down arrow to move.`}
      onKeyDown={props.onKeyDown}
      onClick={props.onSelect}
      className={[
        'flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-offset-2',
        kind === 'chapter' ? 'font-medium' : '',
        props.selected ? 'bg-current/10' : 'hover:bg-current/5',
        dragging ? 'opacity-40' : '',
        drop === 'before' ? 'shadow-[inset_0_2px_0_0_currentColor]' : '',
        drop === 'after' ? 'shadow-[inset_0_-2px_0_0_currentColor]' : '',
      ].filter(Boolean).join(' ')}
    >
      <span
        {...props.handleProps(id, kind)}
        aria-hidden="true"
        className="select-none px-1 text-xs opacity-40">
        ⠿
      </span>

      {editing ? (
        <input
          autoFocus
          defaultValue={title}
          aria-label={`Rename ${title}`}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => props.onCommit(e.currentTarget.value.trim() || title)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') props.onCommit(e.currentTarget.value.trim() || title);
            if (e.key === 'Escape') props.onCancel();
          }}
          className="min-w-0 flex-1 rounded border border-current/20 bg-transparent px-1 py-0.5 text-sm"
        />
      ) : (
        <span className="min-w-0 flex-1 truncate">{title}</span>
      )}

      <span className="shrink-0 text-xs tabular-nums opacity-50">{meta}</span>
      <button
        disabled={props.disabled}
        onClick={(e) => { e.stopPropagation(); props.onEdit(); }}
        className="shrink-0 text-xs underline opacity-50 disabled:opacity-30">
        rename
      </button>
      <button
        disabled={props.disabled}
        onClick={(e) => { e.stopPropagation(); props.onRemove(); }}
        className="shrink-0 text-xs underline opacity-50 disabled:opacity-30">
        delete
      </button>
    </div>
  );
}
