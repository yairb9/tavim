const SHELL = "vouchers-shell-v3";
const RUNTIME = "vouchers-runtime-v1";
const INBOX = "share-inbox";
const SHELL_FILES = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const keep = [SHELL, RUNTIME, INBOX];
    for (const k of await caches.keys()) if (!keep.includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", e => {
  const req = e.request;
  const url = new URL(req.url);

  // Screenshot shared from another app (Android share sheet)
  if (req.method === "POST" && url.pathname.endsWith("/share-target")) {
    e.respondWith((async () => {
      try {
        const form = await req.formData();
        const files = form.getAll("image");
        const inbox = await caches.open(INBOX);
        let i = 0;
        for (const f of files) {
          if (!(f instanceof File)) continue;
          const key = new URL("./inbox/" + Date.now() + "-" + (i++), self.registration.scope).href;
          await inbox.put(key, new Response(f, { headers: { "content-type": f.type || "image/png" } }));
        }
      } catch (err) {}
      return Response.redirect(new URL("./?shared=1", self.registration.scope).href, 303);
    })());
    return;
  }

  if (req.method !== "GET") return;

  // App pages: network first, so updates arrive; cache when offline
  if (url.origin === location.origin && (req.mode === "navigate" || SHELL_FILES.some(f => url.pathname.endsWith(f.replace("./", "/"))))) {
    e.respondWith((async () => {
      try {
        // always ask the server, so a new upload shows up right away
        const res = await fetch(req.url, { cache: "no-cache", credentials: "same-origin" });
        if(res.ok){ const c = await caches.open(SHELL); c.put(req, res.clone()); }
        return res;
      } catch (err) {
        return (await caches.match(req)) || (await caches.match("./index.html")) || Response.error();
      }
    })());
    return;
  }

  // Libraries and OCR language data from the CDN: cache first
  if (url.hostname === "cdn.jsdelivr.net" || url.hostname === "cdnjs.cloudflare.com") {
    e.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) { const c = await caches.open(RUNTIME); c.put(req, res.clone()); }
      return res;
    })());
  }
});
