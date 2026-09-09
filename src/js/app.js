/**
 * Poornima Oracle - Core Application Orchestrator
 * Bootstraps modules, manages message lifecycle, and exposes public event handlers
 */
import { state } from './state.js';
import { ensureApiEndpoint, ACTIVE_CONV_STORAGE_KEY } from './config.js';
import { ConversationStore, migrateOldHistory, saveConversationHistory } from './storage/conversationStore.js';
import {
    refreshIcons,
    escapeHtml,
    adjustTextareaHeight,
    scrollChatToBottom,
    updateScrollToBottomButton,
} from './utils/dom.js';
import { createStreamRenderer } from './utils/markdown.js';
import { ClickSpark } from './components/sparkCanvas.js';
import {
    initializeVoiceFeatures,
    toggleSpeechRecognition,
    stopSpeechRecognition,
} from './audio/speechRecognition.js';
import {
    toggleAutoRead,
    toggleMessageSpeech,
    readAssistantMessage,
    maybeAutoReadAssistantMessage,
    stopCurrentSpeech,
} from './audio/speechSynthesizer.js';
import {
    showApiModal,
    closeApiModal,
    handleModalBackdropClick,
    toggleFallbackConfigVisibility,
    togglePasswordVisibility,
    saveApiEndpoint,
    skipSetup,
    initModalListeners,
} from './components/modal.js';
import {
    renderSidebarConversations,
    handleSwitchConversation,
    handleDeleteConversation,
    openMobileSidebar,
    closeMobileSidebar,
    toggleSidebarDesktop,
    startNewChat,
} from './components/sidebar.js';
import { renderSourceChips } from './components/sourceChips.js';
import { renderToolTrayHtml, toggleToolTray, renderFallbackBadgeHtml } from './components/toolTray.js';
import {
    createMessageId,
    renderUserMessage,
    renderAssistantShell,
    renderAssistantMessage,
    renderAssistantActionBar,
    copyAssistantMessage,
    regenerateAssistantMessage,
} from './components/messageBubble.js';
import { renderWelcomeScreen, sendSuggestion } from './components/welcomeScreen.js';
import { submitFeedback, renderFeedbackControls } from './api/feedback.js';
import { callGeminiAPI, runDemoStream } from './api/sseClient.js';
import { initPwa, triggerInstallPrompt } from './pwa/installPrompt.js';
import { updateProfileUI, openProfileModal } from './profile/profileStore.js';
import {
    exportActiveConversation,
    handleExportConversation,
    handleExportMenuChoice,
} from './utils/chatExport.js';

export function stopGenerating() {
    if (state.activeAbortController) {
        try {
            state.activeAbortController.abort();
        } catch (e) {
            console.warn('[Oracle] Abort error:', e);
        }
        state.activeAbortController = null;
    }
    state.isLoading = false;
    const sendBtn = document.getElementById('sendButton');
    if (sendBtn) {
        sendBtn.disabled = false;
        sendBtn.innerHTML = '<i data-lucide="send" class="w-5 h-5"></i>';
        sendBtn.title = 'Send message';
        sendBtn.setAttribute('aria-label', 'Send message');
        sendBtn.onclick = () => sendMessage({ allowSpeech: true });
    }
    refreshIcons();
}

export function handleKeyPress(event) {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage({ allowSpeech: true });
    }
}

let lastScrollTop = 0;

function initializeScrollAffordance() {
    const chatContainer = document.getElementById('chatContainer');
    if (!chatContainer) return;

    chatContainer.addEventListener('scroll', handleChatScroll, { passive: true });
    updateScrollToBottomButton();
}

function handleChatScroll() {
    const chatContainer = document.getElementById('chatContainer');
    const header = document.getElementById('mainHeader');
    if (!chatContainer) return;

    const currentScrollTop = Math.max(0, chatContainer.scrollTop);
    const scrollDelta = currentScrollTop - lastScrollTop;

    if (header) {
        if (currentScrollTop <= 30) {
            // Near the top: always keep header visible
            header.classList.remove('header-hidden');
        } else if (scrollDelta > 8 && currentScrollTop > 60) {
            // Scrolling down: hide header to give content maximum screen area
            header.classList.add('header-hidden');
        } else if (scrollDelta < -8) {
            // Scrolling up: smoothly reveal header
            header.classList.remove('header-hidden');
        }
    }

    lastScrollTop = currentScrollTop;

    if (state.scrollAffordanceTimer) return;

    state.scrollAffordanceTimer = window.setTimeout(() => {
        state.scrollAffordanceTimer = null;
        updateScrollToBottomButton();
    }, 100);
}

export async function sendMessage(options = {}) {
    if (state.isLoading) return;

    if (options.allowSpeech) {
        state.speechUserGestureUnlocked = true;
    }

    const input = document.getElementById('messageInput');
    const hasMessageOverride = typeof options.message === 'string';
    const message = (hasMessageOverride ? options.message : (input ? input.value : '')).trim();
    if (!message) return;

    const chatContainer = document.getElementById('chatContainer');
    if (!state.chatStarted) {
        if (chatContainer) chatContainer.innerHTML = '';
        state.chatStarted = true;
    }

    state.messageCount++;
    state.isLoading = true;

    const sendBtn = document.getElementById('sendButton');
    if (sendBtn) {
        sendBtn.disabled = false;
        sendBtn.innerHTML = '<i data-lucide="square" class="w-4 h-4 fill-current text-rose-400"></i>';
        sendBtn.title = 'Stop generating';
        sendBtn.setAttribute('aria-label', 'Stop generating');
        sendBtn.onclick = (e) => {
            e.preventDefault();
            stopGenerating();
        };
    }
    state.activeAbortController = new AbortController();

    // Add User Message
    const userMessage = { id: createMessageId('user'), role: 'user', content: String(message) };
    state.conversationHistory.push(userMessage);

    // Auto-title conversation from the first user message
    if (state.activeConversation && !state.activeConversation.titled) {
        state.activeConversation.title = state.store.generateTitle(message);
        state.activeConversation.titled = true;
        window.setTimeout(() => renderSidebarConversations(), 0);
    }

    saveConversationHistory(state.store, state.activeConversation);
    renderUserMessage(userMessage);
    refreshIcons();

    if (!hasMessageOverride && input) {
        input.value = '';
        input.style.height = 'auto';
    }
    if (chatContainer) chatContainer.scrollTop = chatContainer.scrollHeight;
    updateScrollToBottomButton();

    const assistantId = createMessageId('assistant');
    const assistantShell = renderAssistantShell(assistantId);
    if (!assistantShell) return;

    const streamRenderer = createStreamRenderer(assistantShell.contentEl);
    refreshIcons();
    if (chatContainer) chatContainer.scrollTop = chatContainer.scrollHeight;
    updateScrollToBottomButton();

    const executedTools = [];
    let fallbackProvider = '';

    try {
        let responsePayload;
        if (state.demoMode || !state.apiEndpoint) {
            responsePayload = await runDemoStream(streamRenderer);
        } else {
            responsePayload = await callGeminiAPI(message, {
                onStatus: (statusData) => {
                    fallbackProvider = statusData.provider || fallbackProvider;
                    assistantShell.badgeEl.innerHTML = renderFallbackBadgeHtml(statusData.provider, statusData.stage);
                    refreshIcons();
                    if (chatContainer) chatContainer.scrollTop = chatContainer.scrollHeight;
                    updateScrollToBottomButton();
                },
                onToolCall: (toolData) => {
                    const newTool = {
                        id: `${toolData.tool || 'tool'}-${executedTools.length}`,
                        tool: toolData.tool,
                        query: toolData.query || toolData.args?.query || toolData.args?.url || '',
                        args: toolData.args || {},
                        status: 'running',
                    };
                    executedTools.push(newTool);
                    assistantShell.toolTrayEl.innerHTML = renderToolTrayHtml(executedTools, true);
                    refreshIcons();
                    if (chatContainer) chatContainer.scrollTop = chatContainer.scrollHeight;
                    updateScrollToBottomButton();
                },
                onToolResult: (resultData) => {
                    const toolName = resultData.tool;
                    for (let i = executedTools.length - 1; i >= 0; i--) {
                        if (executedTools[i].tool === toolName && executedTools[i].status === 'running') {
                            executedTools[i].status = resultData.status || 'success';
                            executedTools[i].resultSummary = resultData.resultSummary || '';
                            break;
                        }
                    }
                    assistantShell.toolTrayEl.innerHTML = renderToolTrayHtml(executedTools, true);
                    refreshIcons();
                    if (chatContainer) chatContainer.scrollTop = chatContainer.scrollHeight;
                    updateScrollToBottomButton();
                },
                onSources: (sources) => {
                    assistantShell.sourcesEl.innerHTML = renderSourceChips(sources);
                    refreshIcons();
                    if (chatContainer) chatContainer.scrollTop = chatContainer.scrollHeight;
                    updateScrollToBottomButton();
                },
                onToken: (answer) => {
                    streamRenderer(answer);
                    if (chatContainer) chatContainer.scrollTop = chatContainer.scrollHeight;
                    updateScrollToBottomButton();
                },
            });
        }

        if (executedTools.length > 0) {
            executedTools.forEach((t) => {
                if (t.status === 'running') t.status = 'success';
            });
            assistantShell.toolTrayEl.innerHTML = renderToolTrayHtml(executedTools, false);
            refreshIcons();
        }

        const isFallback = Boolean(responsePayload.fallback || executedTools.length > 0 || fallbackProvider);
        if (isFallback && !assistantShell.badgeEl.innerHTML) {
            assistantShell.badgeEl.innerHTML = renderFallbackBadgeHtml(responsePayload.provider || fallbackProvider, '');
            refreshIcons();
        }

        const responseText = String(responsePayload.answer || '');
        const sources = Array.isArray(responsePayload.sources) ? responsePayload.sources : [];
        streamRenderer.flush(responseText);
        assistantShell.sourcesEl.innerHTML = renderSourceChips(sources);
        assistantShell.feedbackEl.innerHTML = renderFeedbackControls(assistantId);
        state.conversationHistory.push({
            id: assistantId,
            role: 'assistant',
            content: responseText,
            sources,
            feedback: '',
            question: message,
            fallback: isFallback,
            provider: responsePayload.provider || fallbackProvider || '',
            tools: executedTools,
        });
        saveConversationHistory(state.store, state.activeConversation);
        assistantShell.actionEl.innerHTML = renderAssistantActionBar(assistantId);
        refreshIcons();
        maybeAutoReadAssistantMessage(assistantId);

    } catch (err) {
        if (err.name === 'AbortError') {
            const partialText = assistantShell.contentEl.innerText.trim();
            if (!partialText) {
                assistantShell.wrapper.remove();
            } else {
                assistantShell.contentEl.insertAdjacentHTML('beforeend', '<p class="text-xs text-zinc-500 italic mt-2">[Generation stopped]</p>');
            }
        } else {
            const errHTML = `<div class="mt-3 bg-rose-500/10 border border-rose-500/20 text-rose-400 px-3 py-2 rounded-xl text-xs flex items-center justify-between">
                <span>Error: ${escapeHtml(err.message)}</span>
                <button type="button" onclick="regenerateAssistantMessage('${escapeHtml(assistantId)}')" class="underline hover:text-rose-300 ml-2">Retry</button>
            </div>`;
            assistantShell.contentEl.insertAdjacentHTML('beforeend', errHTML);
        }
    } finally {
        state.isLoading = false;
        state.activeAbortController = null;
        if (sendBtn) {
            sendBtn.disabled = false;
            sendBtn.innerHTML = '<i data-lucide="send" class="w-5 h-5"></i>';
            sendBtn.title = 'Send message';
            sendBtn.setAttribute('aria-label', 'Send message');
            sendBtn.onclick = () => sendMessage({ allowSpeech: true });
        }
        refreshIcons();
        if (chatContainer) chatContainer.scrollTop = chatContainer.scrollHeight;
        updateScrollToBottomButton();
    }
}

// Bind all public interfaces to window for inline HTML onclick/onkeydown handlers
window.refreshIcons = refreshIcons;
window.sendMessage = sendMessage;
window.stopGenerating = stopGenerating;
window.handleKeyPress = handleKeyPress;
window.adjustTextareaHeight = adjustTextareaHeight;
window.sendSuggestion = sendSuggestion;
window.toggleSpeechRecognition = toggleSpeechRecognition;
window.toggleAutoRead = toggleAutoRead;
window.toggleMessageSpeech = toggleMessageSpeech;
window.readAssistantMessage = readAssistantMessage;
window.copyAssistantMessage = copyAssistantMessage;
window.regenerateAssistantMessage = regenerateAssistantMessage;
window.submitFeedback = submitFeedback;
window.renderFeedbackControls = renderFeedbackControls;
window.toggleToolTray = toggleToolTray;
window.scrollChatToBottom = scrollChatToBottom;
window.showApiModal = showApiModal;
window.closeApiModal = closeApiModal;
window.handleModalBackdropClick = handleModalBackdropClick;
window.toggleFallbackConfigVisibility = toggleFallbackConfigVisibility;
window.togglePasswordVisibility = togglePasswordVisibility;
window.saveApiEndpoint = saveApiEndpoint;
window.skipSetup = skipSetup;
window.openMobileSidebar = openMobileSidebar;
window.closeMobileSidebar = closeMobileSidebar;
window.toggleSidebarDesktop = toggleSidebarDesktop;
window.startNewChat = startNewChat;
window.handleSwitchConversation = handleSwitchConversation;
window.handleDeleteConversation = handleDeleteConversation;
window.exportActiveConversation = exportActiveConversation;
window.handleExportConversation = handleExportConversation;
window.handleExportMenuChoice = handleExportMenuChoice;
window.triggerInstallPrompt = triggerInstallPrompt;
window.openProfileModal = openProfileModal;

// Application Initialization
window.addEventListener('load', async () => {
    refreshIcons();
    if (window.marked) {
        window.marked.setOptions({ gfm: true, breaks: true });
    }

    state.apiEndpoint = ensureApiEndpoint();
    const endpointInput = document.getElementById('apiEndpoint');
    if (endpointInput) {
        endpointInput.value = state.apiEndpoint;
    }

    // 1. Initialize IndexedDB conversation store
    state.store = new ConversationStore();
    await state.store.init();

    // 2. Migrate any legacy single-conversation localStorage data
    const migratedId = await migrateOldHistory(state.store);

    // 3. Determine which conversation to restore
    const savedActiveId = migratedId || localStorage.getItem(ACTIVE_CONV_STORAGE_KEY);
    let restored = false;

    if (savedActiveId) {
        try {
            const conv = await state.store.getConversation(savedActiveId);
            if (conv && conv.messages.length > 0) {
                state.activeConversation = conv;
                state.conversationHistory = state.activeConversation.messages;
                state.chatStarted = true;
                state.messageCount = conv.messages.length;
                localStorage.setItem(ACTIVE_CONV_STORAGE_KEY, conv.id);

                const chatContainer = document.getElementById('chatContainer');
                if (chatContainer) {
                    chatContainer.innerHTML = '';
                    for (const msg of conv.messages) {
                        if (msg.role === 'user') renderUserMessage(msg);
                        else if (msg.role === 'assistant') renderAssistantMessage(msg);
                    }
                    requestAnimationFrame(() => {
                        chatContainer.scrollTop = chatContainer.scrollHeight;
                        updateScrollToBottomButton();
                    });
                }
                restored = true;
            }
        } catch (e) {
            console.warn('[Oracle] Failed to restore conversation:', e);
        }
    }

    if (!restored) {
        state.activeConversation = {
            id: state.store.generateId(),
            title: 'New Chat',
            titled: false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages: [],
        };
        state.conversationHistory = state.activeConversation.messages;
        localStorage.setItem(ACTIVE_CONV_STORAGE_KEY, state.activeConversation.id);
        renderWelcomeScreen();
    }

    // 4. Render sidebar with all stored conversations
    await renderSidebarConversations();

    initializeVoiceFeatures();
    initializeScrollAffordance();
    initModalListeners();
    initPwa();
    updateProfileUI();
    refreshIcons();

    // Focus input on desktop only
    if (window.innerWidth > 768) {
        document.getElementById('messageInput')?.focus();
    }

    new ClickSpark();
});
