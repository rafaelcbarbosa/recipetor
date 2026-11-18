const CACHE_NAME = "recipetor-shell-a8b49d7";
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

  // Cook mode offline support: a single recipe response is cached network-first
  // so an open recipe keeps working when the connection drops mid-cook. The
  // network response is always preferred; the cache is only a fallback.
  const singleRecipe = url.pathname.match(/^\/api\/recipes\/[^/]+$/);
  if (singleRecipe) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE_NAME).then(async (cache) => {
              await cache.put(request, copy);
              const keys = await cache.keys();
              // Keep a small rolling set of recently opened recipes.
              if (keys.length > 12) {
                for (const stale of keys.slice(0, keys.length - 12)) {
                  await cache.delete(stale);
                }
              }
            });
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          if (cached) return cached;
          throw new Error("The requested resource is unavailable offline.");
        }),
    );
    return;
  }

  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    // Other API responses are always live: caching them would hide outages
    // behind stale data and prevent the app from noticing a dropped connection.
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