import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Extension } from '@tiptap/react';

/**
 * The `@` trigger.
 *
 * Two halves that have to stay apart: this one knows where the caret is and
 * what was typed after the `@`, and the React side knows what the codex
 * contains and how to draw a list. ProseMirror owns the document and the
 * keyboard; React owns the pixels.
 *
 * Keys are intercepted here rather than on a focused list element, because
 * moving focus out of the editor to steer a menu takes the caret with it — the
 * writer would arrow through names and come back to find their place gone. The
 * caret never leaves the prose; the arrows are borrowed while a list is open
 * and handed straight back.
 */

export interface SuggestState {
  /** Where `@query` sits, so an insert can replace exactly that. */
  range: { from: number; to: number };
  /** What has been typed after the `@`. */
  query: string;
}

export const suggestKey = new PluginKey<SuggestState | null>('lorescribe-mention-suggest');

export interface SuggestHandlers {
  onState(state: SuggestState | null): void;
  /** Return true to swallow the key — only while a list is actually showing. */
  onKeyDown(event: KeyboardEvent): boolean;
}

/**
 * Where React leaves its handlers for the plugin to find.
 *
 * Keyed on the editor view and held outside the component, because the two
 * sides change at completely different rates: the extension list is built once
 * and must stay stable, while the handlers close over a candidate list that
 * changes on every keystroke. Passing the handlers in at construction would
 * freeze the first version of them; passing a ref or a getter through render
 * means handing React's internals to a library that will read them whenever it
 * likes. A WeakMap written from an effect says exactly what is happening — the
 * editor is a separate system, and this is the drop box — and releases itself
 * when the view is destroyed.
 */
const HANDLERS = new WeakMap<object, SuggestHandlers>();

export function setSuggestHandlers(view: object, handlers: SuggestHandlers): void {
  HANDLERS.set(view, handlers);
}

export function clearSuggestHandlers(view: object): void {
  HANDLERS.delete(view);
}

/**
 * `@` then anything but another `@`, up to forty characters.
 *
 * Spaces are allowed so "@long hall" finds The Long Hall; the cost is that the
 * trigger stays armed across ordinary prose after a stray `@`. That is handled
 * by the list showing nothing when nothing matches, which is self-correcting —
 * rather than by a rule about where a name may end, which would be wrong for
 * somebody's naming conventions.
 *
 * The `@` must start a word, or an email address would open a character picker.
 */
const TRIGGER = /(?:^|[\s(["'])@([^@\n]{0,40})$/u;

export function mentionSuggestPlugin(): Plugin {
  let last: string | null = null;

  return new Plugin<SuggestState | null>({
    key: suggestKey,

    state: {
      init: () => null,
      apply(tr, value) {
        const selection = tr.selection;
        // A selection with a length is the writer highlighting text, not typing
        // a name.
        if (!selection.empty) return null;
        const { $from } = selection;
        if (!$from.parent.isTextblock) return null;

        // Only the text between the start of this block and the caret: a match
        // can never reach across a paragraph, and scanning the whole document
        // per keystroke would undo the work the decoration plugin does.
        const before = $from.parent.textBetween(
          0, $from.parentOffset, undefined, '￼');
        const match = TRIGGER.exec(before);
        if (!match) return null;

        const query = match[1] ?? '';
        const from = $from.pos - (query.length + 1);   // the @ and what follows
        return value?.range.from === from && value.query === query
          ? value
          : { range: { from, to: $from.pos }, query };
      },
    },

    view(editorView) {
      return {
        update: (view) => {
          const state = suggestKey.getState(view.state) ?? null;
          // Notify only on change: this runs on every transaction, and a React
          // setState per keystroke would re-render the editor's siblings for
          // nothing.
          const signature = state ? `${state.range.from}:${state.query}` : null;
          if (signature === last) return;
          last = signature;
          HANDLERS.get(view)?.onState(state);
        },
        // `view` is only a parameter of update(); destroy() needs the one the
        // plugin was given.
        destroy: () => { HANDLERS.get(editorView)?.onState(null); },
      };
    },

    props: {
      handleKeyDown(view, event) {
        if (!suggestKey.getState(view.state)) return false;
        return HANDLERS.get(view)?.onKeyDown(event) ?? false;
      },
    },
  });
}

/**
 * The Tiptap wrapper — a plain constant, taking nothing.
 *
 * Nothing crosses from React into the editor at construction time, which is
 * what keeps the extension list stable across every render.
 */
export const MentionSuggest = Extension.create({
  name: 'lorescribeMentionSuggest',
  addProseMirrorPlugins: () => [mentionSuggestPlugin()],
});
