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

export function createMessageId(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function renderUserMessage(message) {
    const chatContainer = document.getElementById('chatContainer');
    if (!chatContainer) return;

    const userMsgHTML = `
        <div class="flex justify-end mb-6 animate-slide-in" data-message-id="${escapeHtml(message.id || '')}">
            <div class="max-w-[85%] md:max-w-[70%] bg-white text-black p-3 md:p-4 rounded-2xl rounded-br-sm shadow-lg">
                <p class="text-sm md:text-base leading-relaxed font-medium">${escapeHtml(message.content)}</p>
            </div>
            <div class="w-8 h-8 rounded-lg bg-white flex items-center justify-center ml-2 md:ml-3 mt-auto mb-1 shadow-md shrink-0">
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
            <div class="w-8 h-8 rounded-lg bg-zinc-800 border border-white/10 flex items-center justify-center mr-2 md:mr-3 mt-auto mb-1 shrink-0">
                <i data-lucide="bot" class="w-5 h-5 text-cyan-400"></i>
            </div>
            <div class="group max-w-[85%] md:max-w-[70%]">
                <div data-fallback-badge-container></div>
                <div data-tool-tray-container></div>
                <div class="bg-zinc-800/80 border border-white/5 text-zinc-200 p-3 md:p-4 rounded-2xl rounded-bl-sm shadow-sm text-sm md:text-base">
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
        <div class="assistant-action-bar flex md:opacity-0 md:group-hover:opacity-100 transition mt-2 ml-1 items-center gap-2 text-xs text-zinc-500">
            <button type="button" class="relative inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 font-medium hover:bg-white/10 hover:text-white transition" aria-label="Copy response" onclick="copyAssistantMessage('${safeMessageId}', this)">
                <i data-lucide="copy" class="w-4 h-4"></i>
                <span>Copy</span>
                <span class="copy-tooltip" data-copy-tooltip>Copied!</span>
            </button>
            <button type="button" class="speech-button inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 font-medium hover:bg-white/10 hover:text-white transition" aria-label="Read response aloud" aria-pressed="false" data-speech-for="${safeMessageId}" data-speech-label="true" onclick="readAssistantMessage('${safeMessageId}')">
                <i data-lucide="volume-2" class="w-4 h-4"></i>
                <span>Read Aloud</span>
            </button>
            <button type="button" class="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 font-medium hover:bg-white/10 hover:text-white transition" aria-label="Regenerate response" onclick="regenerateAssistantMessage('${safeMessageId}')">
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

export function getAssistantQuestion(messageId) {
    const messageIndex = state.conversationHistory.findIndex((item) => item.id === messageId && item.role === 'assistant');
    if (messageIndex === -1) return '';

    const message = state.conversationHistory[messageIndex];
    if (message.question) return message.question;

    for (let index = messageIndex - 1; index >= 0; index--) {
        if (state.conversationHistory[index]?.role === 'user') {
            return state.conversationHistory[index].content || '';
        }
    }

    return '';
}

export async function regenerateAssistantMessage(messageId) {
    if (state.isLoading) return;

    const question = getAssistantQuestion(messageId).trim();
    if (!question) return;

    stopCurrentSpeech();
    if (typeof window.sendMessage === 'function') {
        await window.sendMessage({ allowSpeech: true, message: question });
    }
}
