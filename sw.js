// ════════════════════════════════════════════════════════════════
// بناء سمارت — Service Worker (PWA)
// يدعم: التشغيل أوفلاين، التحديث التلقائي، Cache ذكي
// ════════════════════════════════════════════════════════════════

const CACHE_VERSION = 'binaa-smart-v2.1.0';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const DATA_CACHE = `${CACHE_VERSION}-data`;
const IMAGES_CACHE = `${CACHE_VERSION}-images`;

// الملفات الأساسية التي يجب تخزينها للعمل أوفلاين
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/offline.html',
  // الخطوط
  'https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;800;900&family=IBM+Plex+Sans+Arabic:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap',
  // مكتبات CDN
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdn.jsdelivr.net/npm/chart.js'
];

// ──────────────────────────────────────────────────────────────────
// التثبيت — تخزين الملفات الأساسية
// ──────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  console.log('[SW] Installing version:', CACHE_VERSION);
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => {
        console.log('[SW] Caching static assets');
        return cache.addAll(STATIC_ASSETS.map(url => new Request(url, { credentials: 'same-origin' })))
          .catch(err => console.warn('[SW] Some assets failed to cache:', err));
      })
      .then(() => self.skipWaiting())
  );
});

// ──────────────────────────────────────────────────────────────────
// التفعيل — حذف الـ caches القديمة
// ──────────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating');
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => !key.startsWith(CACHE_VERSION))
            .map((key) => {
              console.log('[SW] Deleting old cache:', key);
              return caches.delete(key);
            })
      );
    }).then(() => self.clients.claim())
  );
});

// ──────────────────────────────────────────────────────────────────
// استراتيجية الـ Fetch
// ──────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // تجاهل الطلبات غير GET
  if (request.method !== 'GET') return;

  // تجاهل طلبات Chrome extensions
  if (url.protocol === 'chrome-extension:') return;
  
  // تجاهل طلبات Supabase API (نريد دائماً البيانات الحية)
  if (url.hostname.includes('supabase.co') && url.pathname.includes('/rest/')) {
    event.respondWith(networkFirst(request, DATA_CACHE));
    return;
  }
  
  // تجاهل طلبات auth (يجب أن تكون مباشرة)
  if (url.pathname.includes('/auth/')) return;
  
  // تجاهل Moyasar (للأمان)
  if (url.hostname.includes('moyasar.com')) return;

  // الصور — Cache First
  if (request.destination === 'image') {
    event.respondWith(cacheFirst(request, IMAGES_CACHE));
    return;
  }

  // الخطوط والـ CSS — Cache First
  if (request.destination === 'font' || request.destination === 'style') {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  // الصفحة الرئيسية و HTML — Network First with offline fallback
  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith(navigationStrategy(request));
    return;
  }

  // الباقي — Network First
  event.respondWith(networkFirst(request, STATIC_CACHE));
});

// ──────────────────────────────────────────────────────────────────
// استراتيجيات الـ Cache
// ──────────────────────────────────────────────────────────────────

// Cache First — استخدم الـ cache، وحدّث في الخلفية
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) {
    // تحديث في الخلفية
    fetch(request).then(response => {
      if (response.ok) {
        caches.open(cacheName).then(cache => cache.put(request, response));
      }
    }).catch(() => {});
    return cached;
  }
  
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch (e) {
    return new Response('', { status: 408 });
  }
}

// Network First — جرّب الشبكة أولاً، ارجع للـ cache
async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch (e) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw e;
  }
}

// استراتيجية التنقل — Network First + offline fallback
async function navigationStrategy(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put('/', response.clone());
    }
    return response;
  } catch (e) {
    const cached = await caches.match(request) || await caches.match('/');
    if (cached) return cached;
    return caches.match('/offline.html');
  }
}

// ──────────────────────────────────────────────────────────────────
// مزامنة الخلفية (Background Sync) — لإرسال البيانات لاحقاً
// ──────────────────────────────────────────────────────────────────
self.addEventListener('sync', (event) => {
  console.log('[SW] Background sync:', event.tag);
  if (event.tag === 'sync-pending-data') {
    event.waitUntil(syncPendingData());
  }
});

async function syncPendingData() {
  // عند العودة للإنترنت، يُرسل البيانات المعلقة المخزنة في IndexedDB
  // (التنفيذ الكامل في الواجهة الأمامية)
  const clients = await self.clients.matchAll();
  clients.forEach(client => {
    client.postMessage({ type: 'SYNC_PENDING' });
  });
}

// ──────────────────────────────────────────────────────────────────
// إشعارات Push
// ──────────────────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  if (!event.data) return;
  
  const data = event.data.json();
  const options = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-72.png',
    vibrate: [200, 100, 200],
    dir: 'rtl',
    lang: 'ar',
    data: data.data || {},
    actions: data.actions || []
  };
  
  event.waitUntil(
    self.registration.showNotification(data.title || 'بناء سمارت', options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(url) && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

// ──────────────────────────────────────────────────────────────────
// تحديث فوري عند طلب من التطبيق
// ──────────────────────────────────────────────────────────────────
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
