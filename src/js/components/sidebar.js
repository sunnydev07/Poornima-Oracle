/**
 * Poornima Oracle - Sidebar & Multi-Conversation Navigation Component
 */
import { state } from '../state.js';
import { ACTIVE_CONV_STORAGE_KEY } from '../config.js';
import { escapeHtml, refreshIcons, updateScrollToBottomButton } from '../utils/dom.js';
import { renderUserMessage, renderAssistantMessage } from './messageBubble.js';
import { renderWelcomeScreen } from './welcomeScreen.js';
import { stopSpeechRecognition } from '../audio/speechRecognition.js';
import { stopCurrentSpeech } from '../audio/speechSynthesizer.js';

export function openMobileSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebarOverlay');
    if (sidebar) sidebar.style.width = '';
    sidebar?.classList.remove('-translate-x-full');
    overlay?.classList.remove('hidden');
}

export function closeMobileSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebarOverlay');
    sidebar?.classList.add('-translate-x-full');
    overlay?.classList.add('hidden');
}

export function toggleSidebarDesktop() {
    const sidebar = document.getElementById('sidebar');
    const collapseIcon = document.getElementById('collapseIcon');
    state.isSidebarCollapsed = !state.isSidebarCollapsed;

    if (state.isSidebarCollapsed) {
        sidebar?.classList.add('collapsed', 'w-20');
        sidebar?.classList.remove('w-72', 'md:w-72');
        if (sidebar) sidebar.style.width = '80px';
        collapseIcon?.classList.add('rotate-180');
    } else {
        sidebar?.classList.remove('collapsed', 'w-20');
        sidebar?.classList.add('w-72');
        if (sidebar) sidebar.style.width = '';
        collapseIcon?.classList.remove('rotate-180');
    }
}

export async function renderSidebarConversations() {
    const listEl = document.getElementById('conversationsList');
    const emptyEl = document.getElementById('convListEmpty');
    if (!listEl || !state.store) return;

    let convs = [];
    try {
        convs = await state.store.getAllConversations();
    } catch (e) {
        console.warn(e);
    }

    listEl.querySelectorAll('[data-conv-item]').forEach((el) => el.remove());

    const activeId = state.activeConversation ? state.activeConversation.id : '';

    if (convs.length === 0) {
        if (emptyEl) emptyEl.classList.remove('hidden');
        return;
    }
    if (emptyEl) emptyEl.classList.add('hidden');

    const fragment = document.createDocumentFragment();
    convs.forEach((conv) => {
        const isActive = conv.id === activeId;
        const item = document.createElement('div');
        item.setAttribute('data-conv-item', conv.id);
        item.className = [
            'sidebar-item group flex items-center gap-2.5 p-3 rounded-xl cursor-pointer',
            'border transition-all mb-1 touch-manipulation',
            isActive
                ? 'bg-zinc-800/70 border-cyan-500/20 text-white shadow-[0_0_12px_rgba(34,211,238,0.08)]'
                : 'border-transparent hover:bg-white/5 hover:border-white/10 text-zinc-400 hover:text-zinc-200',
        ].join(' ');

        const safeId = escapeHtml(conv.id);
        item.innerHTML = `
            <i data-lucide="${isActive ? 'message-square-text' : 'message-square'}"
                class="sidebar-icon w-4 h-4 ${isActive ? 'text-cyan-400' : 'text-zinc-600 group-hover:text-zinc-400'} shrink-0 transition-colors"></i>
            <span class="sidebar-text text-xs truncate flex-1 ${isActive ? 'font-medium text-white' : 'font-light'}">${escapeHtml(conv.title || 'New Chat')}</span>
            <button class="sidebar-text opacity-0 group-hover:opacity-100 p-1 rounded-lg
                           text-zinc-600 hover:text-rose-400 hover:bg-rose-500/10 transition-all shrink-0"
                    title="Delete conversation"
                    onclick="event.stopPropagation(); handleDeleteConversation('${safeId}')">
                <i data-lucide="trash-2" class="w-3 h-3"></i>
            </button>`;

        item.addEventListener('click', () => handleSwitchConversation(conv.id));
        fragment.appendChild(item);
    });

    listEl.prepend(fragment);
    refreshIcons();
}

export async function handleSwitchConversation(id) {
    if (state.activeConversation && state.activeConversation.id === id) {
        if (window.innerWidth < 768) closeMobileSidebar();
        return;
    }
    if (typeof window.stopGenerating === 'function') {
        window.stopGenerating();
    }

    if (state.activeConversation && state.activeConversation.messages.length > 0) {
        try {
            await state.store.saveConversation(state.activeConversation);
        } catch (e) {
            console.warn(e);
        }
    }

    try {
        const conv = await state.store.getConversation(id);
        if (!conv) return;

        state.activeConversation = conv;
        state.conversationHistory = state.activeConversation.messages;
        localStorage.setItem(ACTIVE_CONV_STORAGE_KEY, id);
        state.chatStarted = conv.messages.length > 0;
        state.messageCount = conv.messages.length;
        state.isLoading = false;
        stopSpeechRecognition();
        stopCurrentSpeech();

        const chatContainer = document.getElementById('chatContainer');
        if (chatContainer) chatContainer.innerHTML = '';

        if (conv.messages.length === 0) {
            renderWelcomeScreen();
        } else {
            for (const msg of conv.messages) {
                if (msg.role === 'user') renderUserMessage(msg);
                else if (msg.role === 'assistant') renderAssistantMessage(msg);
            }
            requestAnimationFrame(() => {
                if (chatContainer) chatContainer.scrollTop = chatContainer.scrollHeight;
                updateScrollToBottomButton();
            });
        }

        document.getElementById('mainHeader')?.classList.remove('header-hidden');

        const input = document.getElementById('messageInput');
        if (input) {
            input.value = '';
            input.style.height = 'auto';
        }
        const sendBtn = document.getElementById('sendButton');
        if (sendBtn) {
            sendBtn.disabled = false;
            sendBtn.innerHTML = '<i data-lucide="send" class="w-5 h-5"></i>';
        }

        await renderSidebarConversations();
        refreshIcons();
        if (window.innerWidth < 768) closeMobileSidebar();
        else input?.focus();
    } catch (e) {
        console.error('[Oracle] Failed to switch conversation:', e);
    }
}

export async function handleDeleteConversation(id) {
    if (!confirm('Are you sure you want to delete this conversation?')) return;
    try {
        await state.store.deleteConversation(id);
        if (state.activeConversation && state.activeConversation.id === id) {
            await startNewChat();
        } else {
            await renderSidebarConversations();
        }
    } catch (e) {
        console.error('[Oracle] Failed to delete conversation:', e);
    }
}

export async function startNewChat() {
    if (state.activeConversation && state.activeConversation.messages.length > 0) {
        try {
            await state.store.saveConversation(state.activeConversation);
        } catch (e) {
            console.warn(e);
        }
    }

    if (typeof window.stopGenerating === 'function') {
        window.stopGenerating();
    }
    stopSpeechRecognition();
    stopCurrentSpeech();
    state.chatStarted = false;
    state.messageCount = 0;
    state.isLoading = false;

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

    const chatContainer = document.getElementById('chatContainer');
    if (chatContainer) chatContainer.innerHTML = '';
    renderWelcomeScreen();
    updateScrollToBottomButton();
    document.getElementById('mainHeader')?.classList.remove('header-hidden');

    const input = document.getElementById('messageInput');
    if (input) {
        input.value = '';
        input.style.height = 'auto';
    }

    const sendBtn = document.getElementById('sendButton');
    if (sendBtn) {
        sendBtn.disabled = false;
        sendBtn.innerHTML = '<i data-lucide="send" class="w-5 h-5"></i>';
    }

    refreshIcons();
    await renderSidebarConversations();

    if (window.innerWidth < 768) {
        closeMobileSidebar();
    } else {
        input?.focus();
    }
}
