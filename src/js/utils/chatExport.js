/**
 * Poornima Oracle - Conversation Export (Markdown / PDF)
 * Zero-backend export: Markdown via Blob download, PDF via browser print.
 */
import { state } from '../state.js';
import { escapeHtml, refreshIcons } from './dom.js';

function defaultRenderMarkdown(text) {
    try {
        if (typeof window !== 'undefined' && window.marked && window.DOMPurify) {
            return window.DOMPurify.sanitize(window.marked.parse(String(text || '')));
        }
    } catch (err) {
        console.warn('[Oracle] Markdown render for export failed, using plain text:', err);
    }
    return escapeHtml(String(text || ''));
}

export function slugifyFilename(title) {
    const slug = String(title || 'chat')
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 50);
    return slug || 'chat';
}

export function getExportFilename(conv, ext) {
    const date = new Date().toISOString().split('T')[0];
    return `poornima-oracle-${slugifyFilename(conv?.title)}-${date}.${ext}`;
}

function formatSourceLine(src) {
    const title = String(src?.title || 'Untitled source').trim() || 'Untitled source';
    const url = typeof src?.url === 'string' ? src.url.trim() : '';
    const publishedAt = typeof src?.publishedAt === 'string' ? src.publishedAt.trim() : '';
    const dateSuffix = publishedAt ? ` (Published: ${publishedAt})` : '';
    const safeTitle = title.replace(/[\[\]]/g, '');
    if (url && /^https?:\/\//i.test(url)) {
        return `- [${safeTitle}](${url})${dateSuffix}`;
    }
    return `- ${safeTitle}${dateSuffix}`;
}

export function buildMarkdownExport(conv) {
    const title = String(conv?.title || 'New Chat').trim() || 'New Chat';
    const exportedAt = new Date().toLocaleString();
    const messages = Array.isArray(conv?.messages) ? conv.messages : [];

    const lines = [
        `# ${title}`,
        '',
        `_Exported from Poornima Oracle on ${exportedAt}_`,
        '',
    ];

    let questionNumber = 0;
    let includedAnything = false;

    for (const msg of messages) {
        const content = String(msg?.content || '').trim();
        if (msg?.role === 'user') {
            if (!content) continue;
            questionNumber += 1;
            includedAnything = true;
            lines.push('---', '', `## Question ${questionNumber}`, '', content, '');
        } else if (msg?.role === 'assistant') {
            const sources = Array.isArray(msg?.sources) ? msg.sources : [];
            if (!content && sources.length === 0) continue;
            includedAnything = true;
            lines.push('### Oracle', '');
            if (content) lines.push(content, '');
            if (sources.length > 0) {
                lines.push('**Sources:**', '');
                for (const src of sources) lines.push(formatSourceLine(src));
                lines.push('');
            }
        }
    }

    if (!includedAnything) {
        lines.push('_This conversation has no messages yet._', '');
    }

    lines.push('---', '', '_Poornima Oracle can make mistakes. Please verify important info._', '');
    return lines.join('\n');
}

export function buildPrintHtml(conv, renderMarkdown = defaultRenderMarkdown) {
    const title = String(conv?.title || 'New Chat').trim() || 'New Chat';
    const safeTitle = escapeHtml(title);
    const exportedAt = escapeHtml(new Date().toLocaleString());
    const messages = Array.isArray(conv?.messages) ? conv.messages : [];

    let questionNumber = 0;
    let body = '';

    for (const msg of messages) {
        const content = String(msg?.content || '').trim();
        if (msg?.role === 'user') {
            if (!content) continue;
            questionNumber += 1;
            body += `<section class="q"><div class="role">Question ${questionNumber} — You</div>`
                + `<div class="text">${escapeHtml(content).replace(/\n/g, '<br>')}</div></section>`;
        } else if (msg?.role === 'assistant') {
            const sources = Array.isArray(msg?.sources) ? msg.sources : [];
            if (!content && sources.length === 0) continue;
            body += '<section class="a"><div class="role">Oracle</div>';
            if (content) body += `<div class="text">${renderMarkdown(content)}</div>`;
            if (sources.length > 0) {
                body += '<div class="sources"><div class="sources-title">Sources</div><ul>';
                for (const src of sources) {
                    const srcTitle = escapeHtml(String(src?.title || 'Untitled source'));
                    const url = typeof src?.url === 'string' ? src.url.trim() : '';
                    const publishedAt = typeof src?.publishedAt === 'string' ? src.publishedAt.trim() : '';
                    const dateSuffix = publishedAt ? ` <span class="date">(Published: ${escapeHtml(publishedAt)})</span>` : '';
                    const link = url && /^https?:\/\//i.test(url)
                        ? `<a href="${escapeHtml(url)}">${srcTitle}</a>`
                        : srcTitle;
                    body += `<li>${link}${dateSuffix}</li>`;
                }
                body += '</ul></div>';
            }
            body += '</section>';
        }
    }

    if (!body) {
        body = '<p class="empty">This conversation has no messages yet.</p>';
    }

    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">`
        + `<title>${safeTitle} — Poornima Oracle</title>`
        + `<style>body{font-family:Georgia,'Times New Roman',serif;color:#111;max-width:720px;margin:0 auto;padding:32px 20px;line-height:1.65;}`
        + `header{border-bottom:2px solid #111;padding-bottom:12px;margin-bottom:20px;}`
        + `h1{font-size:22px;margin:0 0 4px;}header p{margin:0;color:#555;font-size:12px;}`
        + `section{margin:0 0 16px;padding:12px 14px;border-radius:8px;page-break-inside:avoid;}`
        + `.q{background:#f1f5f9;border:1px solid #cbd5e1;}`
        + `.a{background:#fff;border:1px solid #e2e8f0;}`
        + `.role{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#475569;margin-bottom:6px;}`
        + `.text{white-space:pre-wrap;overflow-wrap:anywhere;}`
        + `.text pre{white-space:pre-wrap;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:8px;overflow-x:auto;}`
        + `.text table{border-collapse:collapse;max-width:100%;}.text th,.text td{border:1px solid #cbd5e1;padding:4px 8px;text-align:left;}`
        + `.sources{margin-top:10px;font-size:12px;}.sources-title{font-weight:700;margin-bottom:4px;}`
        + `.sources ul{margin:4px 0 0;padding-left:18px;}.sources a{color:#0e7490;}.date{color:#555;}`
        + `footer{margin-top:24px;padding-top:10px;border-top:1px solid #ddd;font-size:11px;color:#666;}`
        + `.empty{color:#555;font-style:italic;}</style></head><body>`
        + `<header><h1>${safeTitle}</h1><p>Exported from Poornima Oracle on ${exportedAt}</p></header>`
        + `<main>${body}</main>`
        + `<footer>Poornima Oracle can make mistakes. Please verify important info.</footer>`
        + `</body></html>`;
}

export function downloadMarkdown(conv) {
    const markdown = buildMarkdownExport(conv);
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = getExportFilename(conv, 'md');
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function printConversation(conv, renderMarkdown = defaultRenderMarkdown) {
    const html = buildPrintHtml(conv, renderMarkdown);
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
    document.body.appendChild(iframe);

    const cleanup = () => {
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
    };

    const frameWindow = iframe.contentWindow;
    const frameDoc = iframe.contentDocument || (frameWindow && frameWindow.document);
    if (!frameWindow || !frameDoc) {
        cleanup();
        return;
    }

    frameDoc.open();
    frameDoc.write(html);
    frameDoc.close();
    frameWindow.focus();

    if (typeof frameWindow.onafterprint !== 'undefined' || 'onafterprint' in frameWindow) {
        frameWindow.onafterprint = cleanup;
    }
    window.setTimeout(() => {
        try {
            frameWindow.print();
        } catch (err) {
            console.warn('[Oracle] Print failed:', err);
            cleanup();
        }
    }, 250);
    // Fallback cleanup in case afterprint never fires (e.g. dialog dismissed).
    window.setTimeout(cleanup, 60 * 1000);
}

async function resolveConversation(id) {
    if (state.activeConversation && state.activeConversation.id === id) {
        return state.activeConversation;
    }
    if (!state.store) return null;
    try {
        return await state.store.getConversation(id);
    } catch (err) {
        console.warn('[Oracle] Export failed to load conversation:', err);
        return null;
    }
}

function isExportable(conv) {
    return conv && Array.isArray(conv.messages) && conv.messages.some((m) => String(m?.content || '').trim());
}

export async function exportConversationById(id, format = 'markdown') {
    const conv = await resolveConversation(id);
    if (!conv || !isExportable(conv)) {
        alert('This conversation has no messages to export yet.');
        return;
    }
    closeExportMenu();
    if (format === 'print') {
        printConversation(conv);
    } else {
        downloadMarkdown(conv);
    }
}

export function exportActiveConversation(anchorEl) {
    const conv = state.activeConversation;
    if (!conv || !isExportable(conv)) {
        alert('This conversation has no messages to export yet.');
        return;
    }
    toggleExportMenu(anchorEl, conv.id);
}

export async function handleExportConversation(id, anchorEl) {
    const conv = await resolveConversation(id);
    if (!conv || !isExportable(conv)) {
        alert('This conversation has no messages to export yet.');
        return;
    }
    toggleExportMenu(anchorEl, conv.id);
}

export function closeExportMenu() {
    document.getElementById('chatExportMenu')?.remove();
    if (closeExportMenu._outsideHandler) {
        document.removeEventListener('pointerdown', closeExportMenu._outsideHandler);
        closeExportMenu._outsideHandler = null;
    }
    if (closeExportMenu._escapeHandler) {
        document.removeEventListener('keydown', closeExportMenu._escapeHandler);
        closeExportMenu._escapeHandler = null;
    }
}

export function toggleExportMenu(anchorEl, convId) {
    const existing = document.getElementById('chatExportMenu');
    if (existing) {
        const sameConv = existing.getAttribute('data-conv-id') === String(convId);
        closeExportMenu();
        if (sameConv) return;
    }

    const safeId = escapeHtml(String(convId || ''));
    const menu = document.createElement('div');
    menu.id = 'chatExportMenu';
    menu.setAttribute('data-conv-id', String(convId || ''));
    menu.className = 'fixed z-[90] w-60 rounded-xl border border-white/10 bg-zinc-900/95 shadow-2xl backdrop-blur-md p-1.5';
    menu.innerHTML = `
        <p class="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">Export conversation</p>
        <button type="button" onclick="handleExportMenuChoice('${safeId}', 'markdown')"
            class="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-xs text-zinc-300 hover:bg-white/10 hover:text-white transition text-left">
            <i data-lucide="file-text" class="w-4 h-4 text-cyan-400 shrink-0"></i>
            <span><span class="block font-medium">Download Markdown</span>
            <span class="block text-[11px] text-zinc-500">Q&A + sources as .md</span></span>
        </button>
        <button type="button" onclick="handleExportMenuChoice('${safeId}', 'print')"
            class="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-xs text-zinc-300 hover:bg-white/10 hover:text-white transition text-left">
            <i data-lucide="printer" class="w-4 h-4 text-cyan-400 shrink-0"></i>
            <span><span class="block font-medium">Save as PDF</span>
            <span class="block text-[11px] text-zinc-500">Print-friendly view</span></span>
        </button>`;
    document.body.appendChild(menu);

    const rect = anchorEl?.getBoundingClientRect?.();
    const menuWidth = 240;
    const menuHeight = 170;
    let left = rect ? rect.right - menuWidth : window.innerWidth - menuWidth - 16;
    let top = rect ? rect.bottom + 8 : 72;
    left = Math.max(8, Math.min(left, window.innerWidth - menuWidth - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - menuHeight - 8));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    refreshIcons();

    window.setTimeout(() => {
        closeExportMenu._outsideHandler = (event) => {
            if (!menu.isConnected) return;
            if (event.target instanceof Node && !menu.contains(event.target)) {
                closeExportMenu();
            }
        };
        closeExportMenu._escapeHandler = (event) => {
            if (event.key === 'Escape') closeExportMenu();
        };
        document.addEventListener('pointerdown', closeExportMenu._outsideHandler);
        document.addEventListener('keydown', closeExportMenu._escapeHandler);
    }, 0);
}

export async function handleExportMenuChoice(id, format) {
    await exportConversationById(id, format);
}
