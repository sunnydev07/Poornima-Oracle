/**
 * Poornima Oracle - Application State
 */
import { ensureApiEndpoint, DEMO_MODE_STORAGE_KEY, AUTO_READ_STORAGE_KEY } from './config.js';

export const state = {
    store: null,
    activeConversation: null,
    conversationHistory: [],
    isLoading: false,
    activeAbortController: null,
    demoMode: typeof localStorage !== 'undefined' ? localStorage.getItem(DEMO_MODE_STORAGE_KEY) === 'true' : false,
    apiEndpoint: typeof window !== 'undefined' ? ensureApiEndpoint() : '',
    messageCount: 0,
    chatStarted: false,
    isSidebarCollapsed: false,
    autoReadEnabled: typeof localStorage !== 'undefined' ? localStorage.getItem(AUTO_READ_STORAGE_KEY) === 'true' : false,
    speechUserGestureUnlocked: false,
    currentSpeechMessageId: '',
    currentSpeechUtterance: null,
    recognitionInstance: null,
    isListening: false,
    scrollAffordanceTimer: null,
};

export function setApiEndpoint(endpoint) {
    state.apiEndpoint = endpoint;
}

export function setDemoMode(isDemo) {
    state.demoMode = isDemo;
}

export function setIsLoading(loading) {
    state.isLoading = loading;
}

export function setActiveConversation(conv) {
    state.activeConversation = conv;
    state.conversationHistory = conv ? conv.messages : [];
}

export function resetActiveConversation(newConv) {
    state.activeConversation = newConv;
    state.conversationHistory = newConv.messages;
}
