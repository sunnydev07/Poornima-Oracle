/**
 * Poornima Oracle - Service Worker
 * Provides offline caching, app-shell reliability, and instant repeat load times.
 */

const CACHE_NAME = 'poornima-oracle-v1';

const PRECACHE_ASSETS = [
    '/',
    '/index.html',
    '/styles.css',
    '/manifest.json',
    '/src/assets/icon.svg',
    '/src/assets/icon-192.png',
    '/src/assets/icon-512.png',
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
    '/src/js/pwa/installPrompt.js',
    '/src/js/profile/profileStore.js',
    '/src/js/storage/conversationStore.js',
    '/src/js/utils/dom.js',
    '/src/js/utils/markdown.js'
];

// Third-party CDN URLs to cache for offline usage
const CDN_PRECACHE = [
    'https://unpkg.com/lucide@0.469.0/dist/umd/lucide.min.js',
    'https://unpkg.com/marked@16.2.1/lib/marked.umd.js',
    'https://unpkg.com/dompurify@3.2.3/dist/purify.min.js',
    'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap'
];

// Install: precache app shell and static dependencies
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(async (cache) => {
            console.log('[ServiceWorker] Precaching app shell assets...');
            // Precache local assets individually to avoid complete failure if one 404s
            for (const asset of PRECACHE_ASSETS) {
                try {
                    await cache.add(asset);
                } catch (err) {
                    console.warn(`[ServiceWorker] Could not precache ${asset}:`, err);
                }
            }
            // Precache CDN scripts
            for (const cdnUrl of CDN_PRECACHE) {
                try {
                    await cache.add(cdnUrl);
                } catch (err) {
                    console.warn(`[ServiceWorker] Could not precache CDN asset ${cdnUrl}:`, err);
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
                        console.log('[ServiceWorker] Removing legacy cache:', key);
                        return caches.delete(key);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

// Fetch: serve cached shell, stale-while-revalidate for assets, strictly network-only for /api/*
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

    // Ignore unsupported browser schemes (e.g. chrome-extension://)
    if (!url.protocol.startsWith('http')) {
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

    // Static assets (scripts, styles, icons, fonts): Stale-While-Revalidate
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
                .catch((err) => {
                    // Network failed - return cached version or log
                    return cachedResponse;
                });

            return cachedResponse || fetchPromise;
        })
    );
});
