const version = 'counter-v10';
const assets = 'counter-model-assets-v1';
const shell = ['./', 'index.html', 'style.css?v=10', 'app.js?v=10', 'ledger-ui.mjs?v=10',
  'ledger.mjs', ...['tracker','detection','body-check','vision','records','health','torso','torso-decoder']
    .map(name => name + '.mjs?v=10')];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(version).then(cache => cache.addAll(shell)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys
    .filter(key => /^counter-v\d+$/.test(key) && key !== version).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});
function modelAsset(url) {
  return (url.origin === 'https://cdn.jsdelivr.net' &&
    /^\/npm\/(?:@mediapipe\/tasks-vision@0\.10\.35|@tensorflow\/tfjs(?:-backend-wasm)?@4\.22\.0|@tensorflow-models\/body-pix@2\.2\.1)\//.test(url.pathname)) ||
    (url.origin === 'https://storage.googleapis.com' &&
      /^\/(?:mediapipe-models\/object_detector\/efficientdet_lite0\/float16\/1\/|tfjs-models\/savedmodel\/bodypix\/mobilenet\/(?:quant2\/)?)/.test(url.pathname));
}
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET') return;
  if (modelAsset(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(assets);
      const hit = await cache.match(request);
      if (hit) return hit;
      const response = await fetch(request);
      if (response.ok || response.type === 'opaque') await cache.put(request, response.clone());
      return response;
    })());
    return;
  }
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(async () => (await caches.open(version)).match('./')));
    return;
  }
  if (shell.includes(url.pathname.slice(scope.pathname.length) + url.search)) {
    event.respondWith(caches.open(version).then(cache => cache.match(request)).then(hit => hit || fetch(request)));
  }
});
