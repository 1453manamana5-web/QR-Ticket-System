const CACHE_PREFIX = "qr-ticket-reception-shell-v8";
const BASE_PATH = new URL("./", self.location.href).pathname;
const SHELL_CACHE = CACHE_PREFIX;

// Publish the entry point only after every dependency is available offline.
async function cacheShell(cache, response) {
  if (!response.ok) throw new Error("受付アプリを取得できませんでした");
  const indexUrl = new URL("index.html", self.location.href).href;
  const html = await response.clone().text();
  const paths = [...[...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map(match => match[1]),
    "sounds/qr_scan_detected.wav", "sounds/qr_result_chime.wav", "sounds/qr_gate_error_chime_v1.wav", "sounds/entry_osusumi_voice_d_v1.mp3", "sounds/entry_success_voice_d_v1.mp3", "sounds/exit_thank_you_voice_d_v1.mp3", "sounds/exit_success_voice_d_v1.mp3"];
  await Promise.all(paths.filter(path => path && !path.startsWith("data:")).map(async path => {
    const url = new URL(path, indexUrl);
    if (url.origin !== self.location.origin || !url.pathname.startsWith(BASE_PATH)) return;
    const asset = await fetch(url.href, {cache: "reload"});
    if (!asset.ok) throw new Error(`受付ファイルを取得できませんでした: ${url.pathname}`);
    await cache.put(url.href, asset);
  }));
  await cache.put(indexUrl, response.clone());
}

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const indexUrl = new URL("index.html", self.location.href).href;
    await cacheShell(cache, await fetch(indexUrl, {cache: "reload"}));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith("qr-ticket-reception-shell-") && name !== SHELL_CACHE)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(BASE_PATH)) return;
  // The reception worker also controls the sibling management app. Its HTML
  // must never replace reception's offline entry point.
  if (url.pathname.startsWith(BASE_PATH + "management-app/")) return;

  if (request.mode === "navigate") {
    if (url.pathname !== BASE_PATH && url.pathname !== BASE_PATH + "index.html") return;
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        const cache = await caches.open(SHELL_CACHE);
        await cacheShell(cache, response);
        return response;
      } catch {
        const cache = await caches.open(SHELL_CACHE);
        return await cache.match(request)
          || await cache.match(new URL("index.html", self.location.href).href)
          || new Response("受付アプリはまだオフライン用に保存されていません。オンラインで一度開いてから再試行してください。", {
            status: 503,
            headers: { "Content-Type": "text/plain; charset=utf-8" }
          });
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    } catch {
      return new Response("", { status: 503, statusText: "Offline" });
    }
  })());
});
