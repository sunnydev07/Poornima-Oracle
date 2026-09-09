/**
 * Poornima Oracle - Tool Tray & Fallback Telemetry Component
 * Renders ReAct tool execution steps accordion and fallback agent badges
 */
import { escapeHtml } from '../utils/dom.js';

export function getToolMetadata(toolName, args = {}) {
    switch (toolName) {
        case 'web_search':
            return {
                title: 'Web Search',
                icon: 'search',
                color: 'text-amber-400',
                detail: args.query ? `"${args.query}"` : 'Searching internet...',
            };
        case 'fetch_webpage':
            let domain = '';
            try {
                domain = new URL(args.url).hostname;
            } catch (_) {
                domain = args.url || '';
            }
            return {
                title: 'Web Scraper',
                icon: 'globe',
                color: 'text-emerald-400',
                detail: domain ? `Scraping ${domain}` : 'Extracting webpage...',
            };
        case 'poornima_portal_inspector':
            return {
                title: 'Notice Portal',
                icon: 'landmark',
                color: 'text-cyan-400',
                detail: args.category ? `Checking notices (${args.category})` : 'Scanning poornima.edu.in...',
            };
        case 'datetime_calculator':
            return {
                title: 'Academic Dates',
                icon: 'calendar',
                color: 'text-purple-400',
                detail: args.operation || args.date || 'Computing schedule & deadlines...',
            };
        default:
            if (toolName && toolName.startsWith('mcp__')) {
                const parts = toolName.split('__');
                return {
                    title: `MCP: ${parts[1] || 'Tool'}`,
                    icon: 'cpu',
                    color: 'text-indigo-400',
                    detail: parts[2] || '',
                };
            }
            return {
                title: toolName || 'Agent Tool',
                icon: 'wrench',
                color: 'text-zinc-300',
                detail: '',
            };
    }
}

export function renderToolTrayHtml(tools = [], isRunning = false) {
    if (!Array.isArray(tools) || tools.length === 0) return '';
    const count = tools.length;
    const isExpanded = isRunning;

    const itemsHtml = tools.map((t, idx) => {
        const meta = getToolMetadata(t.tool, t.args || { query: t.query, url: t.url });
        const status = t.status || (isRunning && idx === tools.length - 1 ? 'running' : 'success');

        let statusIndicator = '';
        if (status === 'running') {
            statusIndicator = '<div class="tool-spinner" title="Executing tool..."></div>';
        } else if (status === 'error') {
            statusIndicator = '<i data-lucide="alert-circle" class="w-3.5 h-3.5 text-rose-400 shrink-0" title="Tool execution failed"></i>';
        } else {
            statusIndicator = '<i data-lucide="check-circle" class="w-3.5 h-3.5 text-emerald-400 shrink-0" title="Completed"></i>';
        }

        const summaryText = t.resultSummary ? `<span class="text-[10px] text-zinc-500 font-mono">(${escapeHtml(t.resultSummary)})</span>` : '';

        return `
            <div class="tool-step-item">
                <div class="flex items-center gap-2 overflow-hidden">
                    <i data-lucide="${meta.icon}" class="w-3.5 h-3.5 ${meta.color} shrink-0"></i>
                    <span class="font-medium text-zinc-200 shrink-0">${escapeHtml(meta.title)}:</span>
                    <span class="text-zinc-400 truncate text-[11px]">${escapeHtml(meta.detail)}</span>
                    ${summaryText}
                </div>
                ${statusIndicator}
            </div>`;
    }).join('');

    return `
        <div class="tool-tray" data-tray-wrapper>
            <button type="button" class="tool-tray-header" onclick="toggleToolTray(this)" aria-expanded="${isExpanded ? 'true' : 'false'}">
                <div class="flex items-center gap-2">
                    <i data-lucide="wrench" class="w-3.5 h-3.5 text-cyan-400"></i>
                    <span class="font-medium">Agentic Tools Executed (${count})</span>
                </div>
                <i data-lucide="chevron-down" class="tool-tray-chevron w-3.5 h-3.5 text-zinc-400 ${isExpanded ? 'rotate-180' : ''}"></i>
            </button>
            <div class="tool-tray-body ${isExpanded ? '' : 'hidden'}" data-tray-body>
                ${itemsHtml}
            </div>
        </div>`;
}

export function toggleToolTray(target) {
    const button = (target instanceof HTMLElement && target.tagName === 'BUTTON')
        ? target
        : target?.closest?.('button') || target;
    if (!button) return;

    const wrapper = button.closest('[data-tray-wrapper]');
    if (!wrapper) return;
    const body = wrapper.querySelector('[data-tray-body]');
    const chevron = button.querySelector('.tool-tray-chevron');
    if (!body) return;

    const isCurrentlyHidden = body.classList.contains('hidden') || body.style.display === 'none';
    if (isCurrentlyHidden) {
        body.classList.remove('hidden');
        body.style.display = 'flex';
        chevron?.classList.add('rotate-180');
        button.setAttribute('aria-expanded', 'true');
    } else {
        body.classList.add('hidden');
        body.style.display = 'none';
        chevron?.classList.remove('rotate-180');
        button.setAttribute('aria-expanded', 'false');
    }
}

export function renderFallbackBadgeHtml(provider = '', stage = '') {
    // Hidden per user preference
    return '';
}
