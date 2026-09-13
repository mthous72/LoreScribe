import { useCallback, useRef, useState } from 'react';

/**
 * Reordering a tree by pointer, with a keyboard path that is not an afterthought.
 *
 * **Why not the HTML5 drag-and-drop API.** It does not fire on touch. Not
 * "works badly" — `dragstart` is never dispatched by a touch, so the whole
 * feature would be missing on a phone. [D15](../../docs/10-decisions.md) says
 * the phone is a peer rather than a viewer, so a mouse-only reorder is not a
 * reorder. Pointer Events cover mouse, touch and pen with one code path.
 *
 * **Why not a drag-and-drop library.** dnd-kit would be the reasonable pick and
 * genuinely does this better. It is not here because the drop model this tree
 * needs is small — a list of rows, a line between two of them — and because the
 * hard part of an accessible reorder is the keyboard path, which has to be
 * written either way. What a library would buy is auto-scroll and collision
 * strategies; see the limitation below.
 *
 * **How a drop target is found.** `document.elementFromPoint` under the
 * pointer, then the nearest ancestor carrying `data-row-id`, rather than
 * measuring every row up front. Measurements go stale the moment the list
 * scrolls or a row wraps to two lines, and a stale rectangle drops a scene in
 * the wrong place — which is a data change, not a visual glitch.
 *
 * **Known limitation.** No auto-scroll: dragging to the edge of a long
 * manuscript does not scroll it, so a scene cannot yet be dragged past the
 * visible list. The keyboard path has no such limit, and moving a scene a long
 * way is what the chapter field in the row menu is for. Worth a library the day
 * that stops being true.
 */

export interface DropTarget {
  id: string;
  /** Which side of that row the dragged item lands on. */
  side: 'before' | 'after';
}

export interface ReorderHandlers {
  /** Spread onto the drag handle. */
  handleProps: (id: string, kind: string) => {
    onPointerDown: (e: React.PointerEvent) => void;
    style: React.CSSProperties;
  };
  draggingId: string | null;
  dropTarget: DropTarget | null;
}

/** Movement in pixels before a press becomes a drag rather than a tap. */
const THRESHOLD = 6;

export function useReorder(
  onDrop: (kind: string, movedId: string, target: DropTarget) => void | Promise<void>,
): ReorderHandlers {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  // Refs, not state: these are read inside pointer handlers that must see the
  // current value rather than the one captured when the drag started.
  const active = useRef<{ id: string; kind: string; x: number; y: number; started: boolean } | null>(null);
  const target = useRef<DropTarget | null>(null);

  const findTarget = useCallback((x: number, y: number, kind: string): DropTarget | null => {
    const el = document.elementFromPoint(x, y);
    const row = el?.closest<HTMLElement>('[data-row-id]');
    // Only same-kind drops: a chapter dropped between two scenes has no
    // meaning, and guessing one is worse than refusing.
    if (!row || row.dataset.rowKind !== kind) return null;
    const id = row.dataset.rowId!;
    if (id === active.current?.id) return null;
    const box = row.getBoundingClientRect();
    return { id, side: y < box.top + box.height / 2 ? 'before' : 'after' };
  }, []);

  const handleProps = useCallback((id: string, kind: string) => ({
    style: {
      // Without this the browser claims the gesture for scrolling on touch and
      // the drag never starts.
      touchAction: 'none' as const,
      cursor: 'grab' as const,
    },
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      const element = e.currentTarget as HTMLElement;
      element.setPointerCapture(e.pointerId);
      active.current = { id, kind, x: e.clientX, y: e.clientY, started: false };

      const move = (ev: PointerEvent) => {
        const a = active.current;
        if (!a) return;
        if (!a.started) {
          if (Math.hypot(ev.clientX - a.x, ev.clientY - a.y) < THRESHOLD) return;
          a.started = true;
          setDraggingId(a.id);
        }
        ev.preventDefault();
        const found = findTarget(ev.clientX, ev.clientY, a.kind);
        target.current = found;
        setDropTarget(found);
      };

      const finish = () => {
        element.removeEventListener('pointermove', move);
        element.removeEventListener('pointerup', finish);
        element.removeEventListener('pointercancel', cancel);
        const a = active.current;
        const t = target.current;
        active.current = null;
        target.current = null;
        setDraggingId(null);
        setDropTarget(null);
        // A press that never passed the threshold is a click, not a drag, and
        // must not reorder anything.
        if (a?.started && t) void onDrop(a.kind, a.id, t);
      };

      const cancel = () => {
        target.current = null;
        finish();
      };

      element.addEventListener('pointermove', move);
      element.addEventListener('pointerup', finish);
      element.addEventListener('pointercancel', cancel);
    },
  }), [findTarget, onDrop]);

  return { handleProps, draggingId, dropTarget };
}
