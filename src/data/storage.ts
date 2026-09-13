export interface StorageStatus {
  persisted: boolean;
  /** null when the browser refused to say, rather than pretending it said no. */
  granted: boolean | null;
  usageMb: number | null;
  quotaMb: number | null;
}

/**
 * Ask for persistent storage, and report the honest answer.
 *
 * Chrome never prompts — it decides on heuristics (engagement, whether the app
 * is installed or bookmarked, notification permission) whose canonical
 * documentation dates from 2020 and could not be confirmed against a current
 * source. So this is designed to survive `false`: the answer is surfaced to the
 * writer, and D9's scheduled backup is what actually carries the risk.
 *
 * Main thread only. StorageManager exists on WorkerNavigator but `persist` does
 * not; `estimate` does.
 */
export async function requestPersistence(): Promise<StorageStatus> {
  let persisted = false;
  let granted: boolean | null = null;
  try {
    persisted = await navigator.storage.persisted();
    if (!persisted) {
      granted = await navigator.storage.persist();
      persisted = granted;
    } else {
      granted = true;
    }
  } catch {
    granted = null;
  }
  let usageMb: number | null = null;
  let quotaMb: number | null = null;
  try {
    const e = await navigator.storage.estimate();
    // Chrome pads and quantises these for privacy: a signal, not an audit.
    usageMb = Math.round((e.usage ?? 0) / 1048576);
    quotaMb = Math.round((e.quota ?? 0) / 1048576);
  } catch { /* not available */ }
  return { persisted, granted, usageMb, quotaMb };
}
