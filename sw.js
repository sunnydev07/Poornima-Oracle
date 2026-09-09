/**
 * Poornima Oracle - Service Worker (v2)
 * Provides offline caching, app-shell reliability, and instant load times.
 */

const CACHE_NAME = 'poornima-oracle-v2';

const PRECACHE_ASSETS = [
    '/',
    '/index.html',
    '/styles.css',
    '/manifest.json',
    '/src/assets/icon.svg',
    '/src/assets/icon-192.png',
    '/src/assets/icon-512.png',
    '/src/vendor/lucide.min.js',
    '/src/vendor/marked.min.js',
    '/src/vendor/purify.min.js',
    '/src/js/app.js',
    '/src/js/config.js',
    '/src/js/state.js',
    '/src/js/api/feedback.js',
    '/src/js/api/sseClient.js',
    '/src/js/audio/speechRecognition.js',
    '/src/js/audio/speechSynthesizer.js',
    '/src/js/components/messageBubble.js',
    '/src/js/components/modal.js',
    '/src/js/components/sidebar.js',
    '/src/js/components/sourceChips.js',
    '/src/js/components/sparkCanvas.js',
    '/src/js/components/toolTray.js',
    '/src/js/components/welcomeScreen.js',
    '/src/js/profile/profileStore.js',
    '/src/js/pwa/installPrompt.js',
    '/src/js/storage/conversationStore.js',
    '/src/js/utils/dom.js',
    '/src/js/utils/markdown.js'
];

// Install: precache app shell and static local dependencies
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(async (cache) => {
            console.log('[ServiceWorker] Precaching app shell assets...');
            for (const asset of PRECACHE_ASSETS) {
                try {
                    await cache.add(asset);
                } catch (err) {
                    console.warn(`[ServiceWorker] Could not precache ${asset}:`, err);
                }
            }
        }).then(() => self.skipWaiting())
    );
});

// Activate: clean up outdated caches and claim clients immediately
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.map((key) => {
                    if (key !== CACHE_NAME) {
                        console.log('[ServiceWorker] Purging legacy cache:', key);
                        return caches.delete(key);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

// Fetch: serve cached shell, stale-while-revalidate for local assets, network-only for /api/* and cross-origin
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);

    // Only process standard GET requests
    if (request.method !== 'GET') {
        return;
    }

    // Never cache API routes (chat streaming, feedback, health check)
    if (url.pathname.startsWith('/api/')) {
        return;
    }

    // Ignore unsupported schemes
    if (!url.protocol.startsWith('http')) {
        return;
    }

    // Never intercept cross-origin requests (e.g. Google Fonts or external CDNs)
    // Let the browser handle cross-origin caching natively
    if (url.origin !== self.location.origin) {
        return;
    }

    // Navigation requests (HTML pages): Network-First, fallback to cached index.html
    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request)
                .then((networkResponse) => {
                    if (networkResponse && networkResponse.status === 200) {
                        const copy = networkResponse.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
                    }
                    return networkResponse;
                })
                .catch(async () => {
                    const cachedResponse = await caches.match(request);
                    if (cachedResponse) return cachedResponse;
                    const cachedIndex = await caches.match('/index.html');
                    if (cachedIndex) return cachedIndex;
                    return new Response('Offline: Poornima Oracle is currently unavailable without an internet connection.', {
                        status: 503,
                        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
                    });
                })
        );
        return;
    }

    // Local static assets (scripts, styles, icons): Stale-While-Revalidate
    event.respondWith(
        caches.match(request).then((cachedResponse) => {
            const fetchPromise = fetch(request)
                .then((networkResponse) => {
                    if (networkResponse && networkResponse.status === 200) {
                        const copy = networkResponse.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
                    }
                    return networkResponse;
                })
                .catch(() => cachedResponse);

            return cachedResponse || fetchPromise;
        })
    );
});
