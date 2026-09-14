/**
 * Handing a file to the browser.
 *
 * Kept beside the formatters rather than in a component so every export path
 * names its file the same way: a writer with a folder of backups should be able
 * to sort them by name and get them in order, which means the date goes in the
 * name and it goes in ISO order.
 */

export function safeName(title: string): string {
  return title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/gu, '').toLowerCase() || 'project';
}

export function downloadFile(
  content: Uint8Array | string, filename: string, type: string,
): void {
  const url = URL.createObjectURL(new Blob([content as unknown as BlobPart], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Long enough for the browser to have started reading it, then reclaimed —
  // an object URL held forever keeps the whole export in memory.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const stamp = (at = new Date()): string => at.toISOString().slice(0, 10);
