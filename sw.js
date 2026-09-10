/*
 * Minimal offline cache for the vag 827 code display. One road, one object,
 * one small JSON file - nothing dynamic, nothing fetched at drive time.
 */
var CACHE_NAME = "vag827-v2";
var ASSETS = [
  "./",
  "index.html",
  "style.css",
  "manifest.webmanifest",
  "js/core.js",
  "js/symbols.js",
  "js/app.js",
  "vendor/proj4.js",
  "data/road827.json",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(ASSETS);
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k !== CACHE_NAME; })
          .map(function (k) { return caches.delete(k); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (event) {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then(function (cached) {
      if (cached) return cached;
      return fetch(event.request).then(function (response) {
        var copy = response.clone();
        caches.open(CACHE_NAME).then(function (cache) { cache.put(event.request, copy); });
        return response;
      }).catch(function () {
        return cached;
      });
    })
  );
});
