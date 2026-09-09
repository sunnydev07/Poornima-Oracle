/**
 * Poornima Oracle - Source Chips Component
 * Renders citations for Portal, Live Web, MCP, and Vector DB documents
 */
import { escapeHtml, getSafeUrl } from '../utils/dom.js';

export function renderSourceChips(sources) {
    if (!Array.isArray(sources) || sources.length === 0) return '';
    const chips = sources.map((src, index) => {
        const safeTitle = escapeHtml(src.title || `Document ${index + 1}`);
        const safeUrl = getSafeUrl(src.url);
        const scorePercent = typeof src.score === 'number' ? Math.round(src.score * 100) : null;
        const srcId = String(src.id || '');

        const isPortal = srcId.startsWith('portal-') || (safeUrl && (safeUrl.includes('poornima.edu.in/notices') || safeUrl.includes('poornima.org')));
        const isWeb = srcId.startsWith('web-') || (!isPortal && safeUrl && safeUrl.startsWith('http') && !scorePercent);
        const isMcp = srcId.startsWith('mcp-');

        if (isPortal) {
            return `
                <a href="${safeUrl || '#'}" ${safeUrl ? 'target="_blank" rel="noopener noreferrer"' : ''}
                   class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-amber-500/30 bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 text-xs transition-colors group">
                    <i data-lucide="landmark" class="w-3 h-3 text-amber-400 group-hover:scale-110 transition-transform shrink-0"></i>
                    <span class="truncate max-w-[160px]">${safeTitle}</span>
                    <span class="text-[10px] px-1.5 py-0.2 bg-amber-500/20 rounded-md font-mono text-amber-200">Portal</span>
                </a>`;
        }

        if (isWeb) {
            return `
                <a href="${safeUrl || '#'}" ${safeUrl ? 'target="_blank" rel="noopener noreferrer"' : ''}
                   class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 text-xs transition-colors group">
                    <i data-lucide="globe" class="w-3 h-3 text-emerald-400 group-hover:scale-110 transition-transform shrink-0"></i>
                    <span class="truncate max-w-[160px]">${safeTitle}</span>
                    <span class="text-[10px] px-1.5 py-0.2 bg-emerald-500/20 rounded-md font-mono text-emerald-200">Live Web</span>
                </a>`;
        }

        if (isMcp) {
            return `
                <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-purple-500/30 bg-purple-500/10 text-purple-300 text-xs">
                    <i data-lucide="cpu" class="w-3 h-3 text-purple-400 shrink-0"></i>
                    <span class="truncate max-w-[160px]">${safeTitle}</span>
                    <span class="text-[10px] px-1.5 py-0.2 bg-purple-500/20 rounded-md font-mono text-purple-200">MCP</span>
                </span>`;
        }

        if (safeUrl) {
            return `
                <a href="${safeUrl}" target="_blank" rel="noopener noreferrer" 
                   class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-cyan-500/20 bg-cyan-500/5 hover:bg-cyan-500/15 text-cyan-300 text-xs transition-colors group">
                    <i data-lucide="external-link" class="w-3 h-3 text-cyan-400 group-hover:scale-110 transition-transform shrink-0"></i>
                    <span class="truncate max-w-[160px]">${safeTitle}</span>
                    ${scorePercent ? `<span class="text-[10px] px-1.5 py-0.2 bg-cyan-500/20 rounded-md font-mono text-cyan-200">${scorePercent}%</span>` : ''}
                </a>`;
        }

        return `
            <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-white/10 bg-white/5 text-zinc-300 text-xs">
                <i data-lucide="file-text" class="w-3 h-3 text-zinc-400 shrink-0"></i>
                <span class="truncate max-w-[160px]">${safeTitle}</span>
                ${scorePercent ? `<span class="text-[10px] px-1.5 py-0.2 bg-white/10 rounded-md font-mono text-zinc-400">${scorePercent}%</span>` : ''}
            </span>`;
    }).join('');

    return `
        <div class="mt-3 pt-3 border-t border-white/5 flex flex-wrap items-center gap-2">
            <span class="text-[11px] uppercase tracking-wider text-zinc-500 font-semibold flex items-center gap-1">
                <i data-lucide="check-check" class="w-3 h-3 text-cyan-400"></i> Sources:
            </span>
            ${chips}
        </div>`;
}
