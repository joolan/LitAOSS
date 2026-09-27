// LitAOSS Service Worker —— 仅缓存应用外壳（静态资源），永不缓存 /api 与 OSS 响应。
// 零知识数据不落 Cache Storage；登录态在页面内存，离线壳只保证 UI 可加载。
// 缓存策略：
//   - 导航（页面打开）：网络优先，失败回退缓存的 index.html（离线可用）
//   - 静态资源（Vite 内容哈希文件名）：缓存优先
//   - /api、跨域（OSS 等）：不拦截
// 更新 sw.js 字节即触发浏览器更新流程；新版本用新 VERSION，旧缓存 activate 时清理。

const VERSION = 'lit-aoss-v1';
const SHELL = VERSION + '-shell';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(['/', '/manifest.webmanifest', '/icon.svg', '/icon-192.png']))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (req.headers.has('range')) return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 跨域（OSS 预签名等）不拦截
  if (url.pathname.startsWith('/api/')) return; // API 永不缓存

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match('/')))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(SHELL).then((cache) => cache.put(req, copy));
        }
        return res;
      });
    })
  );
});
