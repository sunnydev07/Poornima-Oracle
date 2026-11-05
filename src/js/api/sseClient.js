/**
 * Poornima Oracle - Server-Sent Events (SSE) Client
 * Handles streaming HTTP communication with the backend /api/chat endpoint
 */
import { state } from '../state.js';
import { ensureApiEndpoint, FALLBACK_STORAGE_KEYS } from '../config.js';
import { getStudentProfile } from '../profile/profileStore.js';

const MAX_CLIENT_HISTORY_TURNS = 8;
const MAX_CLIENT_TURN_CHARS = 2000;

function readStorageSetting(key, fallback = '') {
    try {
        const value = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
        return value === null ? fallback : value;
    } catch {
        return fallback;
    }
}

function getPriorHistory(conversationHistory, message) {
    const history = Array.isArray(conversationHistory) ? conversationHistory.slice() : [];
    const last = history[history.length - 1];
    if (last?.role === 'user' && String(last.content || '').trim() === String(message || '').trim()) {
        history.pop();
    }
    return history;
}

export function buildChatPayload(message, conversationHistory) {
    const priorHistory = getPriorHistory(conversationHistory, message);
    const contract = typeof window !== 'undefined' ? window.PoornimaChatContract : null;

    if (contract && typeof contract.buildChatRequestPayload === 'function') {
        return contract.buildChatRequestPayload(message, priorHistory);
    }

    // Fallback keeps the request below the server's 32 KB body limit even if the
    // shared contract script failed to load.
    return {
        message: String(message || '').slice(0, MAX_CLIENT_TURN_CHARS),
        history: priorHistory
            .slice(-MAX_CLIENT_HISTORY_TURNS)
            .map(({ role, content }) => ({
                role: role === 'user' ? 'user' : 'assistant',
                content: String(content || '').slice(0, MAX_CLIENT_TURN_CHARS),
            }))
            .filter((entry) => entry.content),
    };
}

export function parseSseEvent(block) {
    const lines = block.split(/\r?\n/);
    let event = 'message';
    const dataLines = [];

    for (const line of lines) {
        if (line.startsWith('event:')) {
            event = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trimStart());
        }
    }

    if (!dataLines.length) return null;

    try {
        return { event, data: JSON.parse(dataLines.join('\n')) };
    } catch (error) {
        throw new Error('Received malformed stream data.');
    }
}

export async function runDemoStream(render, signal) {
    const answer = 'I am currently in **Demo Mode**. Please configure a backend API endpoint to stream Poornima Oracle answers with citations.';
    let rendered = '';
    for (const token of answer.split(/(\s+)/)) {
        if (signal?.aborted) {
            const abortError = new Error('Generation stopped.');
            abortError.name = 'AbortError';
            throw abortError;
        }
        rendered += token;
        render(rendered);
        await new Promise((resolve) => window.setTimeout(resolve, 35));
    }
    render.flush(answer);
    return { answer, sources: [] };
}

export async function callGeminiAPI(message, handlers = {}) {
    if (!state.apiEndpoint) {
        state.apiEndpoint = ensureApiEndpoint();
    }

    if (!state.apiEndpoint) throw new Error('API endpoint not configured.');
    const fetchSignal = state.activeAbortController ? state.activeAbortController.signal : undefined;

    const fallbackEnabled = readStorageSetting(FALLBACK_STORAGE_KEYS.ENABLED, 'true') !== 'false';
    const openrouterKey = (readStorageSetting(FALLBACK_STORAGE_KEYS.OPENROUTER_KEY) || '').trim();
    const ollamaKey = (readStorageSetting(FALLBACK_STORAGE_KEYS.OLLAMA_KEY) || '').trim();
    const ollamaHost = (readStorageSetting(FALLBACK_STORAGE_KEYS.OLLAMA_HOST) || '').trim();

    const headers = {
        'Content-Type': 'application/json',
        'x-fallback-enabled': String(fallbackEnabled),
    };
    if (openrouterKey) headers['x-openrouter-key'] = openrouterKey;
    if (ollamaKey) headers['x-ollama-key'] = ollamaKey;
    if (ollamaHost) headers['x-ollama-host'] = ollamaHost;

    const payload = buildChatPayload(message, state.conversationHistory);
    payload.profile = getStudentProfile();

    const resp = await fetch(state.apiEndpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: fetchSignal,
    });

    if (!resp.ok) {
        const contentType = resp.headers.get('content-type') || '';
        let detail = '';

        if (contentType.includes('application/json')) {
            const data = await resp.json().catch(() => null);
            detail = typeof data?.error === 'string' ? data.error : '';
        }

        if (resp.status === 413) {
            throw new Error('This conversation is too long to send. Start a new chat to continue.');
        }

        throw new Error(detail || `Request failed: ${resp.status}`);
    }

    const contentType = resp.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream')) {
        const data = await resp.json();
        const answer = data?.answer || data?.response || data?.text || data?.choices?.[0]?.message?.content || JSON.stringify(data);
        return {
            answer: String(answer),
            sources: Array.isArray(data?.sources) ? data.sources : [],
            provider: data?.provider || '',
            fallback: Boolean(data?.fallback),
        };
    }

    const reader = resp.body?.getReader();
    if (!reader) {
        throw new Error('Streaming is not supported by this browser.');
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let answer = '';
    let sources = [];
    let donePayload = null;

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';

        for (const eventBlock of events) {
            const event = parseSseEvent(eventBlock);
            if (!event) continue;

            if (event.event === 'status') {
                handlers.onStatus?.(event.data);
            } else if (event.event === 'tool_call') {
                handlers.onToolCall?.(event.data);
            } else if (event.event === 'tool_result') {
                handlers.onToolResult?.(event.data);
            } else if (event.event === 'sources') {
                sources = Array.isArray(event.data?.sources) ? event.data.sources : [];
                handlers.onSources?.(sources);
            } else if (event.event === 'token') {
                const token = typeof event.data?.text === 'string' ? event.data.text : '';
                answer += token;
                handlers.onToken?.(answer, token);
            } else if (event.event === 'done') {
                donePayload = event.data || {};
            } else if (event.event === 'error') {
                throw new Error(event.data?.error || 'Streaming request failed.');
            }
        }
    }

    if (buffer.trim()) {
        const event = parseSseEvent(buffer);
        if (event?.event === 'done') {
            donePayload = event.data || {};
        }
    }

    return {
        answer: String(donePayload?.answer || answer),
        sources: Array.isArray(donePayload?.sources) ? donePayload.sources : sources,
        provider: donePayload?.provider || '',
        fallback: Boolean(donePayload?.fallback),
    };
}
