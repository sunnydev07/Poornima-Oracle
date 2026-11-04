/**
 * Poornima Oracle - Feedback API
 * Thumbs up / down feedback submission and controls
 */
import { state } from '../state.js';
import { ensureApiEndpoint } from '../config.js';
import { escapeHtml } from '../utils/dom.js';
import { canUseSpeechSynthesis } from '../audio/speechSynthesizer.js';
import { saveConversationHistory } from '../storage/conversationStore.js';

export function renderFeedbackControls(messageId, selectedRating = '') {
    if (!messageId) return '';

    const upPressed = selectedRating === 'up' ? 'true' : 'false';
    const downPressed = selectedRating === 'down' ? 'true' : 'false';
    const speechControl = canUseSpeechSynthesis()
        ? `<button type="button" class="speech-button inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] hover:bg-white/10 hover:text-white transition" aria-label="Read response aloud" aria-pressed="false" data-speech-for="${escapeHtml(messageId)}" onclick="toggleMessageSpeech('${escapeHtml(messageId)}')">
                <i data-lucide="volume-2" class="w-4 h-4"></i>
            </button>`
        : '';

    return `
        <div class="mt-3 flex items-center gap-2 text-zinc-500" data-feedback-for="${escapeHtml(messageId)}">
            ${speechControl}
            <button type="button" class="feedback-button inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] hover:bg-white/10 hover:text-white transition" aria-label="Helpful response" aria-pressed="${upPressed}" onclick="submitFeedback('${escapeHtml(messageId)}', 'up')">
                <i data-lucide="thumbs-up" class="w-4 h-4"></i>
            </button>
            <button type="button" class="feedback-button inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] hover:bg-white/10 hover:text-white transition" aria-label="Unhelpful response" aria-pressed="${downPressed}" onclick="submitFeedback('${escapeHtml(messageId)}', 'down')">
                <i data-lucide="thumbs-down" class="w-4 h-4"></i>
            </button>
        </div>`;
}

export async function submitFeedback(messageId, rating) {
    const message = state.conversationHistory.find((item) => item.id === messageId && item.role === 'assistant');
    if (!message) return;

    message.feedback = rating;
    saveConversationHistory(state.store, state.activeConversation);
    updateFeedbackButtons(messageId, rating);

    if (state.demoMode) return;

    try {
        await fetch(getFeedbackEndpoint(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messageId,
                rating,
                question: message.question || '',
                answer: message.content || '',
                sources: message.sources || [],
            }),
        });
    } catch (error) {
        console.warn('Feedback could not be sent:', error);
    }
}

export function updateFeedbackButtons(messageId, rating) {
    const wrapper = document.querySelector(`[data-feedback-for="${CSS.escape(messageId)}"]`);
    if (!wrapper) return;

    wrapper.querySelectorAll('.feedback-button').forEach((button) => {
        const label = button.getAttribute('aria-label') || '';
        const isSelected = rating === 'up' ? label.includes('Helpful') : label.includes('Unhelpful');
        button.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
    });
}

export function getFeedbackEndpoint() {
    const endpoint = state.apiEndpoint || ensureApiEndpoint();
    try {
        const url = new URL(endpoint, window.location.href);
        if (/\/api\/chat\/?$/.test(url.pathname)) {
            url.pathname = url.pathname.replace(/\/api\/chat\/?$/, '/api/feedback');
        } else {
            url.pathname = '/api/feedback';
        }
        return url.toString();
    } catch (error) {
        return '/api/feedback';
    }
}
