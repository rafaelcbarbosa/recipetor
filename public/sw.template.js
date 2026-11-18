const CACHE_NAME = "recipetor-shell-__COMMIT_HASH__";
const APP_SHELL = ["/", "/manifest.webmanifest", "/recipetor.svg", "/commit-info.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("recipetor-shell-") && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    // API responses are always live: caching them would hide outages behind
    // stale data and prevent the app from noticing a dropped connection.
    url.pathname.startsWith("/api/") ||
    // Private class photos use short-lived signed URLs. Never write them to
    // the shared cache where another person on the device could find them.
    url.pathname.startsWith("/media/class/") ||
    (request.mode !== "navigate" && !url.pathname.startsWith("/assets/"))
  ) {
    return;
  }

  // Network-first for navigation (HTML) - always check for updates
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          if (cached) return cached;
          const appShell = await caches.match("/");
          if (appShell) return appShell;
          throw new Error("The requested resource is unavailable offline.");
        }),
    );
    return;
  }

  // Cache-first for assets (JS, CSS, images) - they have hashes in filenames
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        });
      }),
    );
    return;
  }

  // Default: network-first for everything else
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        throw new Error("The requested resource is unavailable offline.");
      }),
  );
});