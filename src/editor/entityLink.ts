import { Mark, mergeAttributes } from '@tiptap/react';

/**
 * An explicit link from a word in the prose to a codex entry.
 *
 * The alias matcher handles the ordinary case and this is not a replacement for
 * it — a writer should not have to mark up every occurrence of a name. What
 * this closes is the case the matcher deliberately refuses: an alias shared by
 * two entities is ambiguous, and `detectSpans` skips it rather than guessing,
 * because a link the writer never asked for is a claim without evidence. Two
 * characters called Rhys are therefore invisible to the graph until one of them
 * is pointed at, and `@` is how you point.
 *
 * A **mark**, not a node. A mark is formatting over text that is still text, so
 * `editor.getText()` returns "Ilva" and nothing downstream changes: word counts
 * stay right, `content_text` stays plain, and FTS indexes prose rather than
 * markup. A node would have put a foreign object in the middle of a sentence
 * and every one of those would have had to learn about it.
 */

export interface EntityLinkAttributes {
  entityId: string | null;
}

export const EntityLink = Mark.create({
  name: 'entityLink',

  // Two links can never overlap, and nothing nests inside one.
  excludes: '_',
  inclusive: false,

  addAttributes() {
    return {
      entityId: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-entity-id'),
        renderHTML: (attributes: EntityLinkAttributes) =>
          (attributes.entityId ? { 'data-entity-id': attributes.entityId } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-entity-id]' }];
  },

  renderHTML({ HTMLAttributes }) {
    // Shares `ls-mention` with the matcher's decorations so a linked name looks
    // the same however it was linked; the writer should not have to care which
    // mechanism found it. The extra class is there for a future affordance that
    // distinguishes "you said so" from "we think so".
    return ['span', mergeAttributes(HTMLAttributes, {
      class: 'ls-mention ls-mention-explicit',
    }), 0];
  },
});

/** One explicit link found in a stored document. */
export interface EntityLinkSpan {
  entityId: string;
  /** The text the writer actually sees, which may not be the entity's name. */
  text: string;
  /** Character offset into the plain text, matching `content_text`. */
  start: number;
  end: number;
}

interface JsonNode {
  type?: string;
  text?: string;
  content?: JsonNode[];
  marks?: { type?: string; attrs?: { entityId?: string | null } }[];
}

/**
 * Pull the explicit links out of a stored Tiptap document.
 *
 * Reads `content_json` rather than taking spans from the editor, so the write
 * path and a wholesale rebuild derive them from the same source. A rebuild that
 * could not see explicit links would delete them as stale on its first run,
 * which is how a feature quietly loses the writer's work rather than loudly.
 *
 * Offsets are counted the way Tiptap's `getText()` builds a string — text nodes
 * concatenated, a newline between top-level blocks — because that is what ends
 * up in `content_text`, and a mention's offsets are only useful if they point
 * into the same string everything else reads.
 */
export function entityLinksFrom(contentJson: string | null | undefined): EntityLinkSpan[] {
  if (!contentJson) return [];
  let doc: JsonNode;
  try { doc = JSON.parse(contentJson) as JsonNode; } catch { return []; }

  const spans: EntityLinkSpan[] = [];
  let offset = 0;

  const walkInline = (node: JsonNode) => {
    if (typeof node.text === 'string') {
      const link = node.marks?.find((m) => m.type === 'entityLink');
      const entityId = link?.attrs?.entityId;
      if (entityId) {
        spans.push({ entityId, text: node.text, start: offset, end: offset + node.text.length });
      }
      offset += node.text.length;
      return;
    }
    for (const child of node.content ?? []) walkInline(child);
  };

  (doc.content ?? []).forEach((block, i) => {
    if (i > 0) offset += 1;            // the newline getText() puts between blocks
    walkInline(block);
  });

  // Adjacent text nodes can carry the same mark — a link the writer typed
  // through, or one split by an inline style. Merge them so a single linked
  // name is one mention rather than two rows pointing at halves of it.
  const merged: EntityLinkSpan[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && last.entityId === span.entityId && last.end === span.start) {
      last.end = span.end;
      last.text += span.text;
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}
