/**
 * Poornima Oracle - Message Bubble Component
 * Renders user and assistant message cards, action bars, and shells
 */
import { state } from '../state.js';
import { escapeHtml, refreshIcons, writeClipboardText, showCopyTooltip } from '../utils/dom.js';
import { renderMarkdown } from '../utils/markdown.js';
import { renderSourceChips } from './sourceChips.js';
import { renderToolTrayHtml, renderFallbackBadgeHtml } from './toolTray.js';
import { renderFeedbackControls } from '../api/feedback.js';
import { stopCurrentSpeech } from '../audio/speechSynthesizer.js';
import { saveConversationHistory } from '../storage/conversationStore.js';

export function createMessageId(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function renderUserMessage(message) {
    const chatContainer = document.getElementById('chatContainer');
    if (!chatContainer) return;

    const userMsgHTML = `
        <div class="flex justify-end mb-6 animate-slide-in" data-message-id="${escapeHtml(message.id || '')}">
            <div class="spatial-user-bubble max-w-[85%] md:max-w-[70%] p-3 md:p-4 rounded-[24px] rounded-br-md">
                <p class="text-sm md:text-base leading-relaxed font-medium">${escapeHtml(message.content)}</p>
            </div>
            <div class="liquid-icon-well w-8 h-8 rounded-full bg-white flex items-center justify-center ml-2 md:ml-3 mt-auto mb-1 shadow-md shrink-0">
                <i data-lucide="user" class="w-5 h-5 text-black"></i>
            </div>
        </div>`;
    chatContainer.insertAdjacentHTML('beforeend', userMsgHTML);
}

export function renderAssistantShell(messageId) {
    const chatContainer = document.getElementById('chatContainer');
    if (!chatContainer) return null;

    const aiMsgHTML = `
        <div class="flex justify-start mb-6 animate-slide-in" data-message-id="${escapeHtml(messageId)}">
            <div class="liquid-icon-well w-8 h-8 rounded-full bg-zinc-800 border border-white/10 flex items-center justify-center mr-2 md:mr-3 mt-auto mb-1 shrink-0">
                <i data-lucide="bot" class="w-5 h-5 text-cyan-400"></i>
            </div>
            <div class="group max-w-[85%] md:max-w-[70%]">
                <div data-fallback-badge-container></div>
                <div data-tool-tray-container></div>
                <div class="spatial-assistant-card liquid-glass liquid-glass-rim text-zinc-200 p-4 md:p-5 rounded-[26px] rounded-bl-md shadow-sm text-sm md:text-base">
                    <div class="ai-markdown" data-ai-content role="status" aria-live="polite">
                        <div class="flex items-center h-6"><div class="typing-shimmer h-1.5 w-24 rounded-full"></div></div>
                    </div>
                    <div data-source-list></div>
                    <div data-feedback-list></div>
                </div>
                <div data-action-list></div>
            </div>
        </div>`;
    chatContainer.insertAdjacentHTML('beforeend', aiMsgHTML);
    const wrapper = chatContainer.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
    return {
        wrapper,
        badgeEl: wrapper.querySelector('[data-fallback-badge-container]'),
        toolTrayEl: wrapper.querySelector('[data-tool-tray-container]'),
        contentEl: wrapper.querySelector('[data-ai-content]'),
        sourcesEl: wrapper.querySelector('[data-source-list]'),
        feedbackEl: wrapper.querySelector('[data-feedback-list]'),
        actionEl: wrapper.querySelector('[data-action-list]'),
    };
}

export function renderAssistantMessage(message) {
    const messageId = message.id || createMessageId('assistant');
    const shell = renderAssistantShell(messageId);
    if (!shell) return;

    if (message.fallback || message.provider) {
        shell.badgeEl.innerHTML = renderFallbackBadgeHtml(message.provider, '');
    }
    if (Array.isArray(message.tools) && message.tools.length > 0) {
        shell.toolTrayEl.innerHTML = renderToolTrayHtml(message.tools, false);
    }

    shell.contentEl.innerHTML = renderMarkdown(message.content);
    shell.sourcesEl.innerHTML = renderSourceChips(message.sources || []);
    shell.feedbackEl.innerHTML = renderFeedbackControls(messageId, message.feedback);
    shell.actionEl.innerHTML = renderAssistantActionBar(messageId);
    refreshIcons();
}

export function renderAssistantActionBar(messageId) {
    const safeMessageId = escapeHtml(messageId);

    return `
        <div class="assistant-action-bar liquid-capsule mt-2 ml-1 inline-flex flex-wrap items-center gap-1 p-1 text-xs text-zinc-300 opacity-100 transition md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
            <button type="button" class="relative inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 py-2 font-medium hover:bg-white/10 hover:text-white transition" aria-label="Copy response" onclick="copyAssistantMessage('${safeMessageId}', this)">
                <i data-lucide="copy" class="w-4 h-4"></i>
                <span>Copy</span>
                <span class="copy-tooltip" data-copy-tooltip>Copied!</span>
            </button>
            <button type="button" class="speech-button inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 py-2 font-medium hover:bg-white/10 hover:text-white transition" aria-label="Read response aloud" aria-pressed="false" data-speech-for="${safeMessageId}" data-speech-label="true" onclick="readAssistantMessage('${safeMessageId}')">
                <i data-lucide="volume-2" class="w-4 h-4"></i>
                <span>Read Aloud</span>
            </button>
            <button type="button" class="inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 py-2 font-medium hover:bg-white/10 hover:text-white transition" aria-label="Regenerate response" onclick="regenerateAssistantMessage('${safeMessageId}')">
                <i data-lucide="refresh-cw" class="w-4 h-4"></i>
                <span>Regenerate</span>
            </button>
        </div>`;
}

export function getAssistantMessage(messageId) {
    return state.conversationHistory.find((item) => item.id === messageId && item.role === 'assistant') || null;
}

export async function copyAssistantMessage(messageId, button) {
    const message = getAssistantMessage(messageId);
    const text = message?.content || '';
    if (!text) return;

    try {
        await writeClipboardText(text);
        showCopyTooltip(button);
    } catch (error) {
        console.warn('Response could not be copied:', error);
    }
}

export function buildRegenerationState(messages, messageId) {
    const currentMessages = Array.isArray(messages) ? messages : [];
    const assistantIndex = currentMessages.findIndex((message) => (
        message?.id === messageId && message?.role === 'assistant'
    ));
    if (assistantIndex === -1) return null;

    const assistantMessage = currentMessages[assistantIndex];
    const previousMessage = currentMessages[assistantIndex - 1];
    const pairedUserIndex = previousMessage?.role === 'user' ? assistantIndex - 1 : -1;
    const question = String(assistantMessage.question || previousMessage?.content || '').trim();
    if (!question) return null;

    const removedIndexes = new Set([assistantIndex, pairedUserIndex].filter((index) => index >= 0));
    return {
        question,
        messages: currentMessages.filter((_, index) => !removedIndexes.has(index)),
        removedIds: [...removedIndexes]
            .sort((first, second) => first - second)
            .map((index) => currentMessages[index]?.id)
            .filter(Boolean),
    };
}

export async function regenerateAssistantMessage(messageId) {
    if (state.isLoading) return;

    const regeneration = buildRegenerationState(state.conversationHistory, messageId);
    if (!regeneration) return;

    state.conversationHistory = regeneration.messages;
    if (state.activeConversation) {
        state.activeConversation.messages = state.conversationHistory;
        state.activeConversation.updatedAt = Date.now();
        saveConversationHistory(state.store, state.activeConversation);
    }
    regeneration.removedIds.forEach((id) => {
        if (id) document.querySelector(`[data-message-id="${CSS.escape(id)}"]`)?.remove();
    });

    stopCurrentSpeech();
    if (typeof window.sendMessage === 'function') {
        await window.sendMessage({ allowSpeech: true, message: regeneration.question });
    }
}
