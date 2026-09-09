/**
 * Poornima Oracle - Speech Synthesis (Text-to-Speech)
 */
import { state } from '../state.js';
import { AUTO_READ_STORAGE_KEY } from '../config.js';
import { refreshIcons } from '../utils/dom.js';

export function canUseSpeechSynthesis() {
    return typeof window !== 'undefined' && Boolean(window.speechSynthesis && typeof window.SpeechSynthesisUtterance === 'function');
}

export function toggleAutoRead() {
    if (!canUseSpeechSynthesis()) return;

    state.speechUserGestureUnlocked = true;
    state.autoReadEnabled = !state.autoReadEnabled;
    localStorage.setItem(AUTO_READ_STORAGE_KEY, state.autoReadEnabled ? 'true' : 'false');
    updateAutoReadToggle();

    if (!state.autoReadEnabled) {
        stopCurrentSpeech();
    }
}

export function updateAutoReadToggle() {
    const toggle = document.getElementById('autoReadToggle');
    if (!toggle) return;

    toggle.setAttribute('aria-pressed', state.autoReadEnabled ? 'true' : 'false');
    toggle.setAttribute(
        'aria-label',
        state.autoReadEnabled ? 'Turn off auto-read AI answers' : 'Turn on auto-read AI answers'
    );
    toggle.title = state.autoReadEnabled ? 'Auto-read is on' : 'Auto-read is off';
}

export function toggleMessageSpeech(messageId) {
    state.speechUserGestureUnlocked = true;

    if (state.currentSpeechMessageId === messageId) {
        stopCurrentSpeech();
        return;
    }

    speakAssistantMessage(messageId);
}

export function readAssistantMessage(messageId) {
    state.speechUserGestureUnlocked = true;
    speakAssistantMessage(messageId);
}

export function maybeAutoReadAssistantMessage(messageId) {
    if (!state.autoReadEnabled || !state.speechUserGestureUnlocked) return;
    speakAssistantMessage(messageId);
}

export function speakAssistantMessage(messageId) {
    if (!canUseSpeechSynthesis()) return;

    const message = state.conversationHistory.find(item => item.id === messageId && item.role === 'assistant');
    if (!message) return;

    const speechText = getReadableSpeechText(message.content);
    if (!speechText) return;

    stopCurrentSpeech();

    const utterance = new SpeechSynthesisUtterance(speechText);
    utterance.lang = 'en-IN';
    utterance.rate = 1;
    utterance.pitch = 1;
    state.currentSpeechMessageId = messageId;
    state.currentSpeechUtterance = utterance;
    updateSpeechButton(messageId, true);

    utterance.onend = () => finishCurrentSpeech(messageId, utterance);
    utterance.onerror = () => finishCurrentSpeech(messageId, utterance);
    window.speechSynthesis.speak(utterance);
}

export function stopCurrentSpeech() {
    if (!canUseSpeechSynthesis()) return;

    const previousMessageId = state.currentSpeechMessageId;
    state.currentSpeechMessageId = '';
    state.currentSpeechUtterance = null;
    window.speechSynthesis.cancel();

    if (previousMessageId) {
        updateSpeechButton(previousMessageId, false);
    }
}

export function finishCurrentSpeech(messageId, utterance) {
    if (state.currentSpeechUtterance !== utterance) return;

    state.currentSpeechMessageId = '';
    state.currentSpeechUtterance = null;
    updateSpeechButton(messageId, false);
}

export function updateSpeechButton(messageId, speaking) {
    const buttons = document.querySelectorAll(`[data-speech-for="${CSS.escape(messageId)}"]`);
    if (!buttons.length) return;

    buttons.forEach((button) => {
        const isLabeled = button.dataset.speechLabel === 'true';
        const label = speaking ? 'Stop reading' : 'Read Aloud';
        button.setAttribute('aria-pressed', speaking ? 'true' : 'false');
        button.setAttribute('aria-label', speaking ? 'Stop reading response aloud' : 'Read response aloud');
        button.innerHTML = `<i data-lucide="${speaking ? 'volume-x' : 'volume-2'}" class="w-4 h-4"></i>${isLabeled ? `<span>${label}</span>` : ''}`;
    });
    refreshIcons();
}

export function getReadableSpeechText(text) {
    return String(text || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/^[\s>*-]+/gm, '')
        .replace(/[*_~|]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}
