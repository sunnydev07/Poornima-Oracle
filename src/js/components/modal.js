/**
 * Poornima Oracle - Settings Modal Component
 * Manages API endpoint configuration and fallback provider credentials
 */
import { state } from '../state.js';
import { getDefaultApiEndpoint, DEMO_MODE_STORAGE_KEY, GEMINI_ENDPOINT_STORAGE_KEY, FALLBACK_STORAGE_KEYS } from '../config.js';
import { refreshIcons } from '../utils/dom.js';
import { updateInstallUI } from '../pwa/installPrompt.js';

export function showApiModal() {
    const endpointInput = document.getElementById('apiEndpoint');
    if (endpointInput) {
        endpointInput.value = state.demoMode ? '' : (state.apiEndpoint || getDefaultApiEndpoint());
    }

    const toggle = document.getElementById('fallbackAgentToggle');
    if (toggle) {
        toggle.checked = localStorage.getItem(FALLBACK_STORAGE_KEYS.ENABLED) !== 'false';
    }

    const orKeyInput = document.getElementById('openrouterApiKey');
    if (orKeyInput) {
        orKeyInput.value = localStorage.getItem(FALLBACK_STORAGE_KEYS.OPENROUTER_KEY) || '';
    }

    const olHostInput = document.getElementById('ollamaHost');
    if (olHostInput) {
        olHostInput.value = localStorage.getItem(FALLBACK_STORAGE_KEYS.OLLAMA_HOST) || '';
    }

    const olKeyInput = document.getElementById('ollamaApiKey');
    if (olKeyInput) {
        olKeyInput.value = localStorage.getItem(FALLBACK_STORAGE_KEYS.OLLAMA_KEY) || '';
    }

    toggleFallbackConfigVisibility();
    updateInstallUI();
    const modal = document.getElementById('apiModal');
    if (modal) modal.classList.remove('hidden');
    refreshIcons();
}

export function closeApiModal() {
    const modal = document.getElementById('apiModal');
    if (modal) modal.classList.add('hidden');
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
    localStorage.setItem(DEMO_MODE_STORAGE_KEY, 'false');
    localStorage.setItem(GEMINI_ENDPOINT_STORAGE_KEY, endpoint);

    const toggle = document.getElementById('fallbackAgentToggle');
    if (toggle) {
        localStorage.setItem(FALLBACK_STORAGE_KEYS.ENABLED, toggle.checked ? 'true' : 'false');
    }

    const orKeyInput = document.getElementById('openrouterApiKey');
    if (orKeyInput) {
        localStorage.setItem(FALLBACK_STORAGE_KEYS.OPENROUTER_KEY, orKeyInput.value.trim());
    }

    const olHostInput = document.getElementById('ollamaHost');
    if (olHostInput) {
        localStorage.setItem(FALLBACK_STORAGE_KEYS.OLLAMA_HOST, olHostInput.value.trim());
    }

    const olKeyInput = document.getElementById('ollamaApiKey');
    if (olKeyInput) {
        localStorage.setItem(FALLBACK_STORAGE_KEYS.OLLAMA_KEY, olKeyInput.value.trim());
    }

    closeApiModal();
}

export function skipSetup() {
    state.demoMode = true;
    state.apiEndpoint = '';
    localStorage.setItem(DEMO_MODE_STORAGE_KEY, 'true');
    closeApiModal();
}

export function initModalListeners() {
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeApiModal();
        }
    });
}
