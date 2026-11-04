/**
 * Poornima Oracle - Markdown Rendering Utilities
 */
import { escapeHtml } from './dom.js';

export function renderMarkdown(text) {
    if (!text) return '<p class="text-zinc-500 italic">No response</p>';

    if (typeof window !== 'undefined' && window.marked && window.DOMPurify) {
        const rawHtml = window.marked.parse(String(text));
        return window.DOMPurify.sanitize(rawHtml, {
            ADD_ATTR: ['target', 'rel'],
            ALLOWED_URI_REGEXP: /^(?:(?:https?|ftp|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
        });
    }

    return escapeHtml(String(text)).replace(/\r\n/g, '\n').replace(/\n/g, '<br/>');
}

export function createStreamRenderer(contentEl) {
    let latestText = '';
    let lastRenderTime = 0;
    let renderTimeout = null;

    const updateDom = (text) => {
        contentEl.innerHTML = renderMarkdown(text);
        lastRenderTime = Date.now();
    };

    const render = (text) => {
        latestText = text;
        const now = Date.now();
        // Throttle markdown AST parsing to 100ms intervals to maintain 60fps
        if (now - lastRenderTime > 100) {
            if (renderTimeout) clearTimeout(renderTimeout);
            updateDom(latestText);
        } else if (!renderTimeout) {
            renderTimeout = setTimeout(() => {
                updateDom(latestText);
                renderTimeout = null;
            }, 100);
        }
    };

    render.flush = (text) => {
        if (renderTimeout) clearTimeout(renderTimeout);
        latestText = text;
        updateDom(latestText);
    };

    return render;
}
