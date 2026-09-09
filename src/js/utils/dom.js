/**
 * Poornima Oracle - DOM & UI Utilities
 */

export function refreshIcons() {
    if (typeof window !== 'undefined' && window.lucide?.createIcons) {
        window.lucide.createIcons();
    }
}

export function escapeHtml(text) {
    if (!text) return '';
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return String(text).replace(/[&<>"']/g, (m) => map[m]);
}

export function getSafeUrl(value) {
    if (typeof value !== 'string' || !value.trim()) {
        return '';
    }

    try {
        const url = new URL(value.trim(), window.location.href);
        return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
    } catch (error) {
        return '';
    }
}

export function adjustTextareaHeight(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 150) + 'px';
}

export function updateScrollToBottomButton() {
    const chatContainer = document.getElementById('chatContainer');
    const scrollButton = document.getElementById('scrollToBottomButton');
    if (!chatContainer || !scrollButton) return;

    const isAwayFromBottom = chatContainer.scrollTop < chatContainer.scrollHeight - chatContainer.clientHeight - 100;
    scrollButton.classList.toggle('hidden', !isAwayFromBottom);
}

export function scrollChatToBottom() {
    const chatContainer = document.getElementById('chatContainer');
    if (!chatContainer) return;

    chatContainer.scrollTo({ top: chatContainer.scrollHeight, behavior: 'smooth' });
    window.setTimeout(updateScrollToBottomButton, 120);
}

export async function writeClipboardText(text) {
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
    }

    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.setAttribute('readonly', '');
    textArea.style.position = 'fixed';
    textArea.style.opacity = '0';
    document.body.appendChild(textArea);
    textArea.select();
    document.execCommand('copy');
    textArea.remove();
}

export function showCopyTooltip(button) {
    const tooltip = button?.querySelector('[data-copy-tooltip]');
    if (!tooltip) return;

    tooltip.classList.add('is-visible');
    if (button.copyTooltipTimer) {
        window.clearTimeout(button.copyTooltipTimer);
    }

    button.copyTooltipTimer = window.setTimeout(() => {
        tooltip.classList.remove('is-visible');
    }, 1100);
}
