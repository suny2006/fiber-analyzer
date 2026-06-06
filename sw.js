const CACHE_NAME = 'fiber-analyzer-v3';
const ASSETS = ['./index.html', './app.js', './manifest.json', './icon.svg'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE_NAME).then(c=>c.addAll(ASSETS))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e => { e.respondWith(caches.match(e.request).then(c=>c||fetch(e.request))); });
