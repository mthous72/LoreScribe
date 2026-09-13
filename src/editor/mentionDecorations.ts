import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PmNode } from '@tiptap/pm/model';
import { detectSpans, type AliasEntry, type DetectOptions } from '../domain/mentions';

/**
 * Live mention highlighting inside the editor.
 *
 * The naive version rescans the whole document on every keystroke, which at
 * 5,000 words and a full cast is tens of milliseconds of regex per character —
 * exactly the jank doc 08 says to measure rather than hope about.
 *
 * So decorations are computed per text block and only for blocks a transaction
 * actually touched. Everything else is carried forward through the mapping.
 * Typing in paragraph 40 costs one paragraph's worth of work regardless of how
 * long the scene is.
 */

export const mentionPluginKey = new PluginKey<DecorationSet>('lorescribe-mentions');

export interface MentionDecorationOptions {
  aliases: readonly AliasEntry[];
  detect?: DetectOptions;
  /** Class applied to each highlighted span. */
  className?: string;
  /**
   * `whole-document` rescans everything on every change. It exists so the
   * editor spike can time the two strategies against each other under
   * identical conditions — same transactions, same DOM work — rather than
   * comparing a regex call to a full render and calling it a result.
   */
  strategy?: 'incremental' | 'whole-document';
}

/**
 * Map a text block's `textContent` offsets back to document positions.
 *
 * Not `pos + 1 + offset`: that is only correct while a block holds nothing but
 * plain text. An inline node that contributes zero characters — an image, a
 * future comment marker — shifts every position after it, and the highlight
 * would drift further from the word the longer the paragraph got.
 */
function blockText(node: PmNode, pos: number): { text: string; positions: number[] } {
  let text = '';
  const positions: number[] = [];
  node.forEach((child, childOffset) => {
    if (child.isText && child.text) {
      for (let i = 0; i < child.text.length; i++) positions.push(pos + 1 + childOffset + i);
      text += child.text;
    }
  });
  return { text, positions };
}

function decorateBlocks(
  doc: PmNode, from: number, to: number, options: MentionDecorationOptions,
): Decoration[] {
  const out: Decoration[] = [];
  const cls = options.className ?? 'ls-mention';
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    const { text, positions } = blockText(node, pos);
    if (!text) return false;
    for (const span of detectSpans(text, options.aliases, options.detect)) {
      const start = positions[span.start];
      const end = positions[span.end - 1];
      if (start === undefined || end === undefined) continue;
      out.push(Decoration.inline(
        start, end + 1,
        // DOM attributes — what the reader sees.
        { class: cls, 'data-entity-id': span.entityId },
        // Spec — what code reads back. These are separate arguments, and
        // conflating them silently yields decorations that render correctly
        // and are invisible to every query, which is how the first run of the
        // editor spike reported zero highlighted entities while highlighting.
        { entityId: span.entityId, alias: span.alias },
      ));
    }
    return false;
  });
  return out;
}

/** Widen a range to the top-level blocks containing it. */
function blockRange(doc: PmNode, from: number, to: number): { from: number; to: number } {
  const size = doc.content.size;
  const $from = doc.resolve(Math.max(0, Math.min(from, size)));
  const $to = doc.resolve(Math.max(0, Math.min(to, size)));
  return {
    from: $from.depth > 0 ? $from.before(1) : 0,
    to: $to.depth > 0 ? $to.after(1) : size,
  };
}

export function mentionDecorationPlugin(options: MentionDecorationOptions): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: mentionPluginKey,
    state: {
      init: (_config, state) =>
        DecorationSet.create(state.doc, decorateBlocks(state.doc, 0, state.doc.content.size, options)),

      apply(tr, value) {
        // Positions first: everything not in a touched block simply moves.
        let set = value.map(tr.mapping, tr.doc);
        if (!tr.docChanged) return set;

        if (options.strategy === 'whole-document') {
          return DecorationSet.create(tr.doc, decorateBlocks(tr.doc, 0, tr.doc.content.size, options));
        }

        // Collect the ranges this transaction rewrote, in final coordinates.
        const dirty: { from: number; to: number }[] = [];
        tr.mapping.maps.forEach((stepMap, i) => {
          stepMap.forEach((_oldFrom, _oldTo, newFrom, newTo) => {
            const rest = tr.mapping.slice(i + 1);
            dirty.push(blockRange(tr.doc, rest.map(newFrom, -1), rest.map(newTo, 1)));
          });
        });
        if (!dirty.length) return set;

        // Merge overlaps so a multi-step transaction rescans a block once.
        dirty.sort((a, b) => a.from - b.from);
        const merged: { from: number; to: number }[] = [];
        for (const r of dirty) {
          const last = merged[merged.length - 1];
          if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
          else merged.push({ ...r });
        }

        for (const range of merged) {
          set = set.remove(set.find(range.from, range.to));
          set = set.add(tr.doc, decorateBlocks(tr.doc, range.from, range.to, options));
        }
        return set;
      },
    },
    props: {
      decorations: (state) => mentionPluginKey.getState(state),
    },
  });
}

/** Everything currently highlighted, for tests and for the backlinks panel. */
export function decoratedEntityIds(set: DecorationSet, doc: PmNode): string[] {
  return [...new Set(
    set.find(0, doc.content.size)
      .map((d) => (d.spec as { entityId?: string } | undefined)?.entityId)
      .filter((id): id is string => !!id),
  )].sort();
}

/** How many spans are highlighted, for tests that care about the count. */
export function decorationCount(set: DecorationSet, doc: PmNode): number {
  return set.find(0, doc.content.size).length;
}
