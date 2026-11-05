/**
 * Poornima Oracle - Settings Modal Component
 * Manages API endpoint configuration and fallback provider credentials
 */
import { state } from '../state.js';
import { getDefaultApiEndpoint, DEMO_MODE_STORAGE_KEY, GEMINI_ENDPOINT_STORAGE_KEY, FALLBACK_STORAGE_KEYS } from '../config.js';
import { refreshIcons } from '../utils/dom.js';
import { updateInstallUI } from '../pwa/installPrompt.js';
import { saveStudentProfile, updateProfileUI } from '../profile/profileStore.js';
import { syncSidebarAccessibility } from './sidebar.js';

function safeStorageGet(key, fallback = null) {
    try {
        const value = window.localStorage.getItem(key);
        return value === null ? fallback : value;
    } catch (error) {
        console.warn('[Oracle] localStorage read failed:', error);
        return fallback;
    }
}

function safeStorageSet(key, value) {
    try {
        window.localStorage.setItem(key, value);
        return true;
    } catch (error) {
        console.warn('[Oracle] localStorage write failed:', error);
        return false;
    }
}

let lastFocusedElement = null;

export function showApiModal() {
    lastFocusedElement = document.activeElement;
    const endpointInput = document.getElementById('apiEndpoint');
    if (endpointInput) {
        endpointInput.value = state.demoMode ? '' : (state.apiEndpoint || getDefaultApiEndpoint());
    }

    const toggle = document.getElementById('fallbackAgentToggle');
    if (toggle) {
        toggle.checked = safeStorageGet(FALLBACK_STORAGE_KEYS.ENABLED) !== 'false';
    }

    const orKeyInput = document.getElementById('openrouterApiKey');
    if (orKeyInput) {
        orKeyInput.value = safeStorageGet(FALLBACK_STORAGE_KEYS.OPENROUTER_KEY) || '';
    }

    const olHostInput = document.getElementById('ollamaHost');
    if (olHostInput) {
        olHostInput.value = safeStorageGet(FALLBACK_STORAGE_KEYS.OLLAMA_HOST) || '';
    }

    const olKeyInput = document.getElementById('ollamaApiKey');
    if (olKeyInput) {
        olKeyInput.value = safeStorageGet(FALLBACK_STORAGE_KEYS.OLLAMA_KEY) || '';
    }

    toggleFallbackConfigVisibility();
    updateInstallUI();
    updateProfileUI();
    const modal = document.getElementById('apiModal');
    if (modal) modal.classList.remove('hidden');
    for (const region of [document.getElementById('sidebar'), document.getElementById('mainChat')]) {
        if (!region) continue;
        region.inert = true;
        region.setAttribute('aria-hidden', 'true');
    }
    requestAnimationFrame(() => document.getElementById('apiEndpoint')?.focus());
    refreshIcons();
}

export function closeApiModal() {
    const modal = document.getElementById('apiModal');
    if (modal) modal.classList.add('hidden');
    syncSidebarAccessibility();
    if (lastFocusedElement?.isConnected) lastFocusedElement.focus();
    lastFocusedElement = null;
}

export function handleModalBackdropClick(event) {
    if (event.target === document.getElementById('apiModal')) {
        closeApiModal();
    }
}

export function toggleFallbackConfigVisibility() {
    const toggle = document.getElementById('fallbackAgentToggle');
    const section = document.getElementById('fallbackConfigSection');
    if (!toggle || !section) return;

    if (toggle.checked) {
        section.classList.remove('opacity-40', 'pointer-events-none');
    } else {
        section.classList.add('opacity-40', 'pointer-events-none');
    }
}

export function togglePasswordVisibility(inputId, btn) {
    const input = document.getElementById(inputId);
    if (!input) return;

    const isPassword = input.type === 'password';
    input.type = isPassword ? 'text' : 'password';
    btn.innerHTML = `<i data-lucide="${isPassword ? 'eye-off' : 'eye'}" class="w-4 h-4"></i>`;
    refreshIcons();
}

export function saveApiEndpoint() {
    const endpointInput = document.getElementById('apiEndpoint');
    const endpoint = (endpointInput ? endpointInput.value.trim() : '') || getDefaultApiEndpoint();
    state.apiEndpoint = endpoint;
    state.demoMode = false;
    safeStorageSet(DEMO_MODE_STORAGE_KEY, 'false');
    safeStorageSet(GEMINI_ENDPOINT_STORAGE_KEY, endpoint);

    const toggle = document.getElementById('fallbackAgentToggle');
    if (toggle) {
        safeStorageSet(FALLBACK_STORAGE_KEYS.ENABLED, toggle.checked ? 'true' : 'false');
    }

    const orKeyInput = document.getElementById('openrouterApiKey');
    if (orKeyInput) {
        safeStorageSet(FALLBACK_STORAGE_KEYS.OPENROUTER_KEY, orKeyInput.value.trim());
    }

    const olHostInput = document.getElementById('ollamaHost');
    if (olHostInput) {
        safeStorageSet(FALLBACK_STORAGE_KEYS.OLLAMA_HOST, olHostInput.value.trim());
    }

    const olKeyInput = document.getElementById('ollamaApiKey');
    if (olKeyInput) {
        safeStorageSet(FALLBACK_STORAGE_KEYS.OLLAMA_KEY, olKeyInput.value.trim());
    }

    // Save Student Personalization Profile
    const collegeSelect = document.getElementById('profileCollege');
    const statusSelect = document.getElementById('profileStatus');
    const yearSelect = document.getElementById('profileYear');
    const courseSelect = document.getElementById('profileCourse');
    const branchInput = document.getElementById('profileBranch');

    if (collegeSelect && statusSelect) {
        saveStudentProfile({
            college: collegeSelect.value,
            status: statusSelect.value,
            year: yearSelect ? yearSelect.value : '1st',
            course: courseSelect ? courseSelect.value : 'B.Tech',
            branch: branchInput ? branchInput.value.trim() : '',
        });
    }

    closeApiModal();
}

export function skipSetup() {
    state.demoMode = true;
    state.apiEndpoint = '';
    safeStorageSet(DEMO_MODE_STORAGE_KEY, 'true');
    closeApiModal();
}

export function initModalListeners() {
    document.addEventListener('keydown', (event) => {
        const modal = document.getElementById('apiModal');
        if (!modal || modal.classList.contains('hidden')) return;

        if (event.key === 'Escape') {
            event.preventDefault();
            closeApiModal();
            return;
        }
        if (event.key !== 'Tab') return;

        const focusable = [...modal.querySelectorAll(
            'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )].filter((element) => element.getClientRects().length > 0);
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first || !last) {
            event.preventDefault();
            modal.focus();
        } else if (!modal.contains(document.activeElement)) {
            event.preventDefault();
            first.focus();
        } else if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    });
}
