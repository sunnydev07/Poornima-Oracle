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
