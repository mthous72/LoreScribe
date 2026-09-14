import type { SourceDoc, SourceFormat } from './source';
import { parseMarkdown, parseText } from './markdown';
import { parseCsv, parseJson } from './structured';
import { parseDocx } from './docx';

/**
 * One file in, one document tree out — whichever of the four it is.
 *
 * Format comes from the extension rather than from sniffing the contents. A
 * writer who names a file `.md` has told us what it is, and guessing against
 * them produces the one failure that is genuinely hard to debug: a file that
 * imports, and imports wrongly. The exception is the one case where the
 * extension carries no information at all — no extension — which is read as
 * text, because that is what it almost always is.
 */

const BY_EXTENSION: Record<string, SourceFormat> = {
  md: 'markdown', markdown: 'markdown', mdown: 'markdown', mkd: 'markdown',
  txt: 'text', text: 'text', '': 'text',
  docx: 'docx',
  json: 'json',
  csv: 'csv', tsv: 'csv',
};

export function formatFor(path: string): SourceFormat | null {
  const name = path.split('/').pop() ?? path;
  const at = name.lastIndexOf('.');
  const extension = at > 0 ? name.slice(at + 1).toLowerCase() : '';
  return BY_EXTENSION[extension] ?? null;
}

/** Extensions worth putting in a file picker's `accept`. */
export const ACCEPTED = '.md,.markdown,.txt,.docx,.json,.csv,.tsv';

export class UnreadableFile extends Error {
  constructor(readonly path: string, message: string) {
    super(message);
    this.name = 'UnreadableFile';
  }
}

/**
 * Read one file.
 *
 * A failure names the file and stays a failure for that file alone: a folder
 * of two hundred documents with one stray PDF in it should import a hundred and
 * ninety-nine, not refuse the lot.
 */
export async function parseFile(file: File): Promise<SourceDoc> {
  const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
  const format = formatFor(path);
  if (!format) throw new UnreadableFile(path, `nothing here reads ${path.split('.').pop()} files`);
  try {
    if (format === 'docx') return await parseDocx(path, new Uint8Array(await file.arrayBuffer()));
    const text = await file.text();
    if (format === 'json') return parseJson(path, text);
    if (format === 'csv') return parseCsv(path, text);
    if (format === 'text') return parseText(path, text);
    return parseMarkdown(path, text);
  } catch (e) {
    throw new UnreadableFile(path, (e as Error).message ?? String(e));
  }
}

export interface ReadResult {
  docs: SourceDoc[];
  skipped: { path: string; reason: string }[];
}

export async function parseFiles(files: readonly File[]): Promise<ReadResult> {
  const docs: SourceDoc[] = [];
  const skipped: ReadResult['skipped'] = [];
  for (const file of files) {
    try { docs.push(await parseFile(file)); }
    catch (e) {
      const failure = e as UnreadableFile;
      skipped.push({ path: failure.path ?? file.name, reason: failure.message });
    }
  }
  docs.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return { docs, skipped };
}
