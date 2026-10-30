// Service Worker — ทำให้เปิดหน้าเว็บได้แม้ไม่มีสัญญาณ
// เมื่อแก้ไขไฟล์และ deploy ใหม่ ให้เปลี่ยนเลข VERSION
const VERSION = 'v8';
const CACHE = 'pg-' + VERSION;
const ASSETS = [
  './',
  'index.html',
  'qr.html',
  'css/style.css',
  'js/config.js',
  'js/icons.js',
  'js/db.js',
  'js/api.js',
  'js/app.js',
  'manifest.json',
  'icon.svg',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first (timeout 4 วินาที) แล้วค่อยใช้ cache — ได้ไฟล์ใหม่เมื่อมีเน็ต และยังใช้ได้ตอนออฟไลน์
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await Promise.race([
        fetch(req),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
      ]);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      const cached = await cache.match(req, { ignoreSearch: true });
      if (cached) return cached;
      throw err;
    }
  })());
});

