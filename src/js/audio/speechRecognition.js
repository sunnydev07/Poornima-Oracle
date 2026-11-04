/**
 * Poornima Oracle - Speech Recognition (Voice-to-Text)
 */
import { state } from '../state.js';
import { canUseSpeechSynthesis, updateAutoReadToggle } from './speechSynthesizer.js';
import { adjustTextareaHeight } from '../utils/dom.js';

export function getSpeechRecognitionConstructor() {
    if (typeof window === 'undefined') return null;
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export function initializeVoiceFeatures() {
    updateAutoReadToggle();

    const micButton = document.getElementById('micButton');
    if (!getSpeechRecognitionConstructor() && micButton) {
        micButton.classList.add('hidden');
        micButton.setAttribute('aria-hidden', 'true');
    }

    const autoReadToggle = document.getElementById('autoReadToggle');
    if (!canUseSpeechSynthesis() && autoReadToggle) {
        autoReadToggle.classList.add('hidden');
        autoReadToggle.setAttribute('aria-hidden', 'true');
    }
}

export function toggleSpeechRecognition() {
    if (state.isListening) {
        stopSpeechRecognition();
        return;
    }

    const RecognitionCtor = getSpeechRecognitionConstructor();
    const micButton = document.getElementById('micButton');
    if (!RecognitionCtor) {
        if (micButton) {
            micButton.classList.add('hidden');
            micButton.setAttribute('aria-hidden', 'true');
        }
        return;
    }

    if (!state.recognitionInstance) {
        state.recognitionInstance = new RecognitionCtor();
        state.recognitionInstance.continuous = false;
        state.recognitionInstance.interimResults = false;
        state.recognitionInstance.lang = 'en-IN';

        state.recognitionInstance.onstart = () => setListeningState(true);
        state.recognitionInstance.onend = () => setListeningState(false);
        state.recognitionInstance.onspeechend = () => {
            if (state.isListening) {
                state.recognitionInstance.stop();
            }
        };
        state.recognitionInstance.onerror = (event) => {
            console.warn('Speech recognition error:', event.error || event);
            setListeningState(false);
        };
        state.recognitionInstance.onresult = (event) => {
            const transcript = Array.from(event.results || [])
                .map((result) => result?.[0]?.transcript || '')
                .join(' ')
                .trim();
            appendTranscriptToInput(transcript);
        };
    }

    try {
        state.recognitionInstance.start();
    } catch (error) {
        console.warn('Speech recognition could not start:', error);
        setListeningState(false);
    }
}

export function stopSpeechRecognition() {
    if (state.recognitionInstance && state.isListening) {
        try {
            state.recognitionInstance.stop();
        } catch (error) {
            console.warn('Speech recognition could not stop:', error);
        }
    }
    setListeningState(false);
}

export function setListeningState(listening) {
    state.isListening = listening;
    const micButton = document.getElementById('micButton');
    if (!micButton) return;

    micButton.classList.toggle('mic-listening', listening);
    micButton.setAttribute('aria-pressed', listening ? 'true' : 'false');
    micButton.setAttribute('aria-label', listening ? 'Stop voice input' : 'Start voice input');
    micButton.title = listening ? 'Listening...' : 'Start voice input';
}

export function appendTranscriptToInput(transcript) {
    if (!transcript) return;

    const input = document.getElementById('messageInput');
    if (!input) return;

    const needsSpace = input.value && !/\s$/.test(input.value);
    input.value = `${input.value}${needsSpace ? ' ' : ''}${transcript}`;
    adjustTextareaHeight(input);
    input.focus();
}
