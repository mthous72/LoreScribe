/**
 * Service-worker registration, and the update handshake.
 *
 * The worker never takes over a running page by itself ([tools/swPlugin.ts]
 * explains why), so something has to offer the reload. That is this: register,
 * watch for a worker sitting in `waiting`, and hand the caller a function that
 * activates it and reloads once — at a moment the writer picked.
 *
 * Everything here is best-effort. No service worker means no offline cache and
 * no install prompt; it does not mean a broken app, and it must not look like
 * one. The database is in OPFS either way.
 */

export interface UpdateHandle {
  /** Activate the waiting version and reload. */
  apply(): void;
}

export function registerServiceWorker(onUpdateReady: (handle: UpdateHandle) => void): void {
  if (!('serviceWorker' in navigator)) return;
  // Dev is served from source with no precache manifest, and a stale worker in
  // development is a debugging session nobody enjoys.
  if (!import.meta.env.PROD) return;

  // Registration waits for load so it never competes with the first paint or
  // with the database worker starting — but `load` may already have fired by
  // the time React mounts, and a listener added after it never runs.
  const start = () => {
    void (async () => {
      try {
        const registration = await navigator.serviceWorker.register(
          `${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL });

        const offer = (worker: ServiceWorker) => onUpdateReady({
          apply: () => {
            // Reload when the new worker takes control, not when the message is
            // sent — sending it only starts the handover.
            navigator.serviceWorker.addEventListener('controllerchange', () => {
              window.location.reload();
            }, { once: true });
            worker.postMessage({ type: 'SKIP_WAITING' });
          },
        });

        // Already waiting when this page loaded: the update arrived in a
        // previous session and nobody has taken it yet.
        if (registration.waiting && navigator.serviceWorker.controller) offer(registration.waiting);

        registration.addEventListener('updatefound', () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            // `controller` is null on the very first install, when there is no
            // previous version to replace and nothing to offer.
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              offer(installing);
            }
          });
        });
      } catch {
        /* No offline cache this time. The app still works; the database is local. */
      }
    })();
  };
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
}
