// sw.js — zero-maintenance
// 不缓存本地文件；只白名单缓存 ECharts CDN（可删）
// 这样每次部署都会直接读新版本，无需改 CACHE_NAME

self.addEventListener('install', (e) => {
  // 立即接管，不等旧 SW
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  // 清理旧缓存（如果之前有）
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
  );
  self.clients.claim();
});

const CDN_OK = [
  'https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js'
];

// 只缓存白名单 CDN，其他请求一律放过（走网络）
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // 忽略非 http(s) 协议
  if (!/^https?:$/.test(url.protocol)) return;

  // 同源资源：不缓存，直接走网络（保证每次都是最新）
  if (url.origin === self.location.origin) return;

  // 仅对白名单 CDN 做 cache-first
  if (CDN_OK.some(prefix => e.request.url.startsWith(prefix))) {
    e.respondWith(
      caches.match(e.request).then(hit => {
        if (hit) return hit;
        return fetch(e.request).then(res => {
          if (res.ok) {
            const copy = res.clone();
            caches.open('cdn-cache-v1').then(c => c.put(e.request, copy));
          }
          return res;
        });
      })
    );
  }
});