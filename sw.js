// sw.js
const CACHE_NAME = 'b44-metrics-v2'; // bump version when you change app code

// 仅缓存站点核心文件 + 指定 CDN；避免缓存 chrome-extension 等协议
const CORE = [
  '/', '/index.html', '/styles.css', '/app.js', '/manifest.webmanifest'
];
const ALLOWLIST_CDN = [
  'https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js'
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // 只缓存存在的核心文件
      for (const u of CORE) {
        try { await cache.add(u); } catch (err) { /* 忽略 404 during dev */ }
      }
      for (const u of ALLOWLIST_CDN) {
        try { await cache.add(u); } catch {}
      }
    })
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // 🚫 只处理 http/https，同源优先；排除 chrome-extension / data / blob 等
  if (!/^https?:$/.test(url.protocol)) return;

  // 只缓存同源文件，或白名单 CDN
  const isCore = url.origin === self.location.origin && CORE.includes(url.pathname);
  const isCdn = ALLOWLIST_CDN.some(s => e.request.url.startsWith(s));
  if (!(isCore || isCdn)) return;

  // cache-first
  e.respondWith(
    caches.match(e.request).then(hit => {
      if (hit) return hit;
      return fetch(e.request).then(res => {
        // 只缓存成功响应
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, copy));
        }
        return res;
      });
    })
  );
});