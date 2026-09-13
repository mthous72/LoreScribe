import { Editor, Extension } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { mentionDecorationPlugin, mentionPluginKey, decoratedEntityIds, decorationCount } from '../editor/mentionDecorations';
import type { AliasEntry } from '../domain/mentions';
import { rng } from './corpus';
import { countWords } from '../text/words';

/**
 * The editor spike — doc 08's "Tiptap with a 5000-word scene plus live mention
 * decorations: measure, don't hope."
 *
 * It measures two things and compares them, because the interesting number is
 * not "is it fast" but "does the incremental design earn its complexity". The
 * naive alternative — rescan the whole document per keystroke — is timed
 * alongside, on the same document, so the answer is a ratio rather than an
 * assertion.
 */

export interface EditorMeasurement {
  label: string;
  value: number;
  unit: string;
  target?: string;
  pass?: boolean | null;
  detail?: string;
}

export interface EditorSpikeResult {
  words: number;
  paragraphs: number;
  aliases: number;
  /** Guards against a spike that measures a no-op. */
  entitiesHighlighted: number;
  spansHighlighted: number;
  /** The A/B, so callers can judge whether the complexity is earned. */
  incrementalP50: number;
  wholeDocP50: number;
  measurements: EditorMeasurement[];
}

const stat = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
  return { p50: at(0.5), p95: at(0.95), max: s[s.length - 1] ?? 0 };
};
const r2 = (n: number) => Math.round(n * 100) / 100;

/** A scene of roughly `words` words, with the cast sprinkled through it. */
function buildScene(
  words: number, aliases: readonly AliasEntry[], seed = 7,
): { html: string; paragraphs: number } {
  const rand = rng(seed);
  const lexicon = ['rain', 'iron', 'forge', 'ash', 'wire', 'glass', 'smoke', 'hinge', 'rope', 'salt',
    'the', 'and', 'of', 'a', 'to', 'in', 'was', 'were', 'had', 'her', 'his', 'their'];
  const paras: string[] = [];
  let written = 0;
  while (written < words) {
    const len = 60 + Math.floor(rand() * 80);
    const out: string[] = [];
    for (let i = 0; i < len; i++) {
      // Roughly one name every forty words, which is about what prose does.
      if (i > 0 && rand() < 0.025) out.push(aliases[Math.floor(rand() * aliases.length)]!.alias);
      else out.push(lexicon[Math.floor(rand() * lexicon.length)]!);
    }
    written += len;
    const sentence = out.join(' ').replace(/(^|\. )([a-z])/g, (_m, p, c: string) => p + c.toUpperCase());
    paras.push(`<p>${sentence}.</p>`);
  }
  return { html: paras.join(''), paragraphs: paras.length };
}

export async function runEditorSpike(
  mount: HTMLElement,
  opts: { words?: number; aliasCount?: number; keystrokes?: number } = {},
): Promise<EditorSpikeResult> {
  const words = opts.words ?? 5000;
  const aliasCount = opts.aliasCount ?? 200;
  const keystrokes = opts.keystrokes ?? 120;

  const aliases: AliasEntry[] = Array.from({ length: aliasCount }, (_, i) => ({
    entityId: `e${i}`,
    alias: `Person${i}`,
  }));
  const { html, paragraphs } = buildScene(words, aliases);
  const measurements: EditorMeasurement[] = [];

  const makeEditor = (strategy: 'incremental' | 'whole-document') => new Editor({
    element: mount,
    extensions: [
      StarterKit,
      Extension.create({
        name: 'lorescribeMentions',
        addProseMirrorPlugins: () => [mentionDecorationPlugin({ aliases, strategy })],
      }),
    ],
    content: html,
  });

  /**
   * Type into the middle of the document and time each keystroke end to end.
   * Both strategies run through this, so the difference between them is the
   * decoration work and nothing else.
   */
  const typeInto = async (ed: Editor) => {
    const insertAt = Math.floor(ed.state.doc.content.size / 2);
    const times: number[] = [];
    let worst = 0;
    let last = performance.now();
    let watching = true;
    const frame = () => {
      if (!watching) return;
      const now = performance.now();
      worst = Math.max(worst, now - last);
      last = now;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);

    const phrase = ' Kaelen turned toward the forge and said nothing at all. ';
    for (let i = 0; i < keystrokes; i++) {
      const at = insertAt + i;
      const t = performance.now();
      ed.view.dispatch(ed.state.tr.insertText(phrase[i % phrase.length]!, at, at));
      times.push(performance.now() - t);
      // Let the browser actually paint, or this times queueing rather than cost.
      if (i % 10 === 9) await new Promise(requestAnimationFrame);
    }
    watching = false;
    return { stat: stat(times), worstFrame: worst };
  };

  // --- cold: build the editor and decorate the whole document once.
  const t0 = performance.now();
  const editor = makeEditor('incremental');
  const coldMs = performance.now() - t0;

  const decoSet = mentionPluginKey.getState(editor.state)!;
  const decorated = decoratedEntityIds(decoSet, editor.state.doc);
  const spans = decorationCount(decoSet, editor.state.doc);
  const actualWords = countWords(editor.state.doc.textContent).words;

  measurements.push({
    label: 'Cold start: parse the scene and decorate every block',
    value: r2(coldMs), unit: 'ms', target: '< 1000', pass: coldMs < 1000,
    detail: `${spans} spans across ${decorated.length} distinct entities`,
  });

  const incremental = await typeInto(editor);
  editor.destroy();
  mount.replaceChildren();

  measurements.push({
    label: 'Per-keystroke: transaction, decoration update and paint',
    value: r2(incremental.stat.p95), unit: 'ms', target: '< 16 (p95)',
    pass: incremental.stat.p95 < 16,
    detail: `p50 ${r2(incremental.stat.p50)} / max ${r2(incremental.stat.max)} over ${keystrokes} keystrokes`,
  });
  measurements.push({
    label: 'Longest main-thread frame gap while typing',
    value: r2(incremental.worstFrame), unit: 'ms', target: '< 50',
    pass: incremental.worstFrame < 50,
  });

  // --- the same typing, with the whole document rescanned each time.
  const naiveEditor = makeEditor('whole-document');
  const naive = await typeInto(naiveEditor);
  naiveEditor.destroy();
  mount.replaceChildren();

  const ratio = naive.stat.p50 / Math.max(incremental.stat.p50, 0.001);
  measurements.push({
    label: 'Same typing, rescanning the whole document each keystroke',
    value: r2(naive.stat.p95), unit: 'ms', target: 'informational', pass: null,
    detail: `p50 ${r2(naive.stat.p50)} / max ${r2(naive.stat.max)} \u2014 `
      + `${r2(ratio)}\u00d7 the incremental path at the median`,
  });

  return {
    words: actualWords, paragraphs, aliases: aliasCount,
    entitiesHighlighted: decorated.length, spansHighlighted: spans,
    incrementalP50: r2(incremental.stat.p50), wholeDocP50: r2(naive.stat.p50),
    measurements,
  };
}
