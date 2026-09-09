/**
 * Poornima Oracle - Server-Sent Events (SSE) Client
 * Handles streaming HTTP communication with the backend /api/chat endpoint
 */
import { state } from '../state.js';
import { ensureApiEndpoint, FALLBACK_STORAGE_KEYS } from '../config.js';

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

export async function runDemoStream(render) {
    const answer = 'I am currently in **Demo Mode**. Please configure a backend API endpoint to stream Poornima Oracle answers with citations.';
    let rendered = '';
    for (const token of answer.split(/(\s+)/)) {
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

    const fallbackEnabled = localStorage.getItem(FALLBACK_STORAGE_KEYS.ENABLED) !== 'false';
    const openrouterKey = (localStorage.getItem(FALLBACK_STORAGE_KEYS.OPENROUTER_KEY) || '').trim();
    const ollamaKey = (localStorage.getItem(FALLBACK_STORAGE_KEYS.OLLAMA_KEY) || '').trim();
    const ollamaHost = (localStorage.getItem(FALLBACK_STORAGE_KEYS.OLLAMA_HOST) || '').trim();

    const headers = {
        'Content-Type': 'application/json',
        'x-fallback-enabled': String(fallbackEnabled),
    };
    if (openrouterKey) headers['x-openrouter-key'] = openrouterKey;
    if (ollamaKey) headers['x-ollama-key'] = ollamaKey;
    if (ollamaHost) headers['x-ollama-host'] = ollamaHost;

    const resp = await fetch(state.apiEndpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ message: message, history: state.conversationHistory }),
        signal: fetchSignal,
    });

    if (!resp.ok) {
        const txt = await resp.text().catch(() => null);
        throw new Error(txt || `Request failed: ${resp.status}`);
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
