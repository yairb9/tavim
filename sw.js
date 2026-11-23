// Service worker: offline use, receiving shared screenshots, and nothing else.
// Every request it serves is for a file of this site; it never talks to another server.
const VERSION = "v6";
const SHELL = "tavim-shell-" + VERSION;      // the app itself: always refreshed from the server when online
const STATIC = "tavim-static-1";              // big libraries: renamed only when a library is replaced
const INBOX = "share-inbox";
const SHELL_FILES = ["./", "index.html", "app.js", "theme.js", "manifest.webmanifest", "icon-192.png", "icon-512.png",
  "font-400.woff2", "font-500.woff2", "font-600.woff2", "lib-jsbarcode.min.js", "lib-qrcode.js", "lib-tesseract.min.js"];
const FRESH = /(\/|index\.html|app\.js|theme\.js|manifest\.webmanifest)$/;

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const keep = [SHELL, STATIC, INBOX];
    for (const k of await caches.keys()) if (!keep.includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", e => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;            // not ours: leave it to the browser (the page's policy blocks it anyway)

  // Screenshots shared from another app. Only images are kept, and only a sane amount of them.
  if (req.method === "POST" && url.pathname.endsWith("/share-target")) {
    e.respondWith((async () => {
      try {
        const form = await req.formData();
        const files = form.getAll("image").filter(f => f instanceof File && /^image\//.test(f.type) && f.size <= 20e6).slice(0, 60);
        const inbox = await caches.open(INBOX);
        let i = 0;
        for (const f of files) {
          const key = new URL("./inbox/" + Date.now() + "-" + (i++), self.registration.scope).href;
          await inbox.put(key, new Response(f, { headers: { "content-type": f.type } }));
        }
      } catch (err) {}
      return Response.redirect(new URL("./?shared=1", self.registration.scope).href, 303);
    })());
    return;
  }

  if (req.method !== "GET") return;

  // The app's own pages and code: ask the server first, so an update arrives at once; the saved copy is for offline.
  if (req.mode === "navigate" || FRESH.test(url.pathname)) {
    e.respondWith((async () => {
      try {
        const res = await fetch(req.url, { cache: "no-cache", credentials: "same-origin" });
        if (res.ok) { const c = await caches.open(SHELL); c.put(req.mode === "navigate" ? "index.html" : req, res.clone()); }
        return res;
      } catch (err) {
        return (await caches.match(req, { ignoreSearch: true })) || (await caches.match("index.html")) || Response.error();
      }
    })());
    return;
  }

  // Libraries, fonts, the text reader and its language data: saved on first use, then served from the phone.
  e.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok && res.type === "basic") { const c = await caches.open(STATIC); c.put(req, res.clone()); }
    return res;
  })());
});
