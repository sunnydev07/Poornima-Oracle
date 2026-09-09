/**
 * Poornima Oracle - PWA Installation & Service Worker Lifecycle
 * Handles beforeinstallprompt, standalone mode detection, and offline SW registration
 */
import { refreshIcons } from '../utils/dom.js';

let deferredPrompt = null;

/**
 * Check if the application is running in standalone mode (installed PWA)
 */
export function isStandalone() {
    return (
        window.matchMedia('(display-mode: standalone)').matches ||
        window.navigator.standalone === true ||
        document.referrer.includes('android-app://')
    );
}

/**
 * Check if current device is iOS Safari
 */
export function isIosDevice() {
    const userAgent = window.navigator.userAgent.toLowerCase();
    return /iphone|ipad|ipod/.test(userAgent) && !window.MSStream;
}

/**
 * Update UI elements indicating installation state
 */
export function updateInstallUI() {
    const headerInstallBtn = document.getElementById('installAppButton');
    const modalInstallBtn = document.getElementById('modalInstallBtn');
    const pwaStatusBadge = document.getElementById('pwaStatusBadge');
    const pwaStatusDesc = document.getElementById('pwaStatusDesc');
    const iosGuide = document.getElementById('iosInstallGuide');

    const standalone = isStandalone();
    const isIos = isIosDevice();

    if (standalone) {
        // App is already installed and running standalone
        if (headerInstallBtn) headerInstallBtn.classList.add('hidden');
        if (modalInstallBtn) modalInstallBtn.classList.add('hidden');
        if (iosGuide) iosGuide.classList.add('hidden');

        if (pwaStatusBadge) {
            pwaStatusBadge.textContent = 'Installed';
            pwaStatusBadge.className = 'text-[10px] font-mono px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 font-semibold';
        }
        if (pwaStatusDesc) {
            pwaStatusDesc.textContent = 'Running as an installed standalone app with full offline cache support.';
        }
        return;
    }

    // App is running in standard browser tab
    if (deferredPrompt) {
        // Native install prompt is ready (Android Chrome / Edge / Desktop Chrome)
        if (headerInstallBtn) headerInstallBtn.classList.remove('hidden');
        if (modalInstallBtn) {
            modalInstallBtn.classList.remove('hidden');
            modalInstallBtn.innerHTML = '<i data-lucide="download-cloud" class="w-4 h-4"></i><span>Install Oracle App</span>';
        }
        if (iosGuide) iosGuide.classList.add('hidden');

        if (pwaStatusBadge) {
            pwaStatusBadge.textContent = 'Install Ready';
            pwaStatusBadge.className = 'text-[10px] font-mono px-2.5 py-0.5 rounded-full bg-cyan-500/10 text-cyan-300 border border-cyan-500/30';
        }
        refreshIcons();
    } else if (isIos) {
        // iOS Safari doesn't support beforeinstallprompt, provide visual instructions
        if (headerInstallBtn) headerInstallBtn.classList.remove('hidden');
        if (modalInstallBtn) modalInstallBtn.classList.add('hidden');
        if (iosGuide) iosGuide.classList.remove('hidden');

        if (pwaStatusBadge) {
            pwaStatusBadge.textContent = 'iOS Safari';
            pwaStatusBadge.className = 'text-[10px] font-mono px-2.5 py-0.5 rounded-full bg-purple-500/10 text-purple-300 border border-purple-500/30';
        }
    } else {
        // Fallback or unsupported browser
        if (pwaStatusBadge) {
            pwaStatusBadge.textContent = 'Web Browser';
            pwaStatusBadge.className = 'text-[10px] font-mono px-2 py-0.5 rounded-full bg-white/5 text-zinc-400 border border-white/10';
        }
    }
}

/**
 * Trigger PWA installation flow
 */
export async function triggerInstallPrompt() {
    if (deferredPrompt) {
        try {
            deferredPrompt.prompt();
            const choiceResult = await deferredPrompt.userChoice;
            console.log('[Oracle PWA] User install choice:', choiceResult.outcome);
            if (choiceResult.outcome === 'accepted') {
                deferredPrompt = null;
                updateInstallUI();
            }
        } catch (e) {
            console.warn('[Oracle PWA] Error triggering install prompt:', e);
        }
        return;
    }

    if (isIosDevice()) {
        const iosGuide = document.getElementById('iosInstallGuide');
        if (iosGuide) {
            iosGuide.classList.remove('hidden');
            iosGuide.scrollIntoView({ behavior: 'smooth' });
        }
        alert("To install on iOS:\n1. Tap the Share button at the bottom of Safari.\n2. Tap 'Add to Home Screen'.");
        return;
    }

    if (isStandalone()) {
        alert("Poornima Oracle is already installed on your device!");
    } else {
        alert("To install, click the Install App icon in your browser address bar or menu.");
    }
}

/**
 * Register Service Worker for offline capability
 */
export function registerServiceWorker() {
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
        navigator.serviceWorker
            .register('/sw.js', { scope: '/' })
            .then((registration) => {
                console.log('[Oracle PWA] Service Worker registered with scope:', registration.scope);

                // Listen for updates
                registration.addEventListener('updatefound', () => {
                    const newWorker = registration.installing;
                    if (newWorker) {
                        newWorker.addEventListener('statechange', () => {
                            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                                console.log('[Oracle PWA] New update available; refresh to activate.');
                            }
                        });
                    }
                });
            })
            .catch((err) => {
                console.warn('[Oracle PWA] Service Worker registration failed:', err);
            });
    }
}

/**
 * Initialize all PWA listeners
 */
export function initPwa() {
    // Capture native install prompt
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredPrompt = e;
        console.log('[Oracle PWA] beforeinstallprompt captured.');
        updateInstallUI();
    });

    // Handle completed installation
    window.addEventListener('appinstalled', () => {
        console.log('[Oracle PWA] App installed successfully.');
        deferredPrompt = null;
        updateInstallUI();
    });

    // Detect media display mode changes
    try {
        const mediaQuery = window.matchMedia('(display-mode: standalone)');
        mediaQuery.addEventListener('change', () => {
            updateInstallUI();
        });
    } catch (e) {
        // Older browsers
    }

    // Register Service Worker
    registerServiceWorker();

    // Initial UI evaluation
    updateInstallUI();
}
