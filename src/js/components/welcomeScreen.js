/**
 * Poornima Oracle - Welcome Screen & Suggestion Cards Component
 */
import { ALL_PROMPTS, PROMPT_COLOR_CLASSES } from '../config.js';
import { escapeHtml, refreshIcons, adjustTextareaHeight } from '../utils/dom.js';
import { initCalendarWidget } from './calendarWidget.js';

export function shufflePrompts(prompts) {
    const shuffled = [...prompts];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

export function createSuggestionCard(data) {
    const colorClasses = PROMPT_COLOR_CLASSES[data.color] || PROMPT_COLOR_CLASSES.cyan;
    const promptValue = escapeHtml(JSON.stringify(data.prompt));

    return `
        <div onclick="sendSuggestion(${promptValue})"
            onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();sendSuggestion(${promptValue});}"
            tabindex="0"
            role="button"
            aria-label="Ask ${escapeHtml(data.title)}: ${escapeHtml(data.description)}"
            data-suggestion-card
            class="liquid-glass liquid-glass-rim p-4 rounded-[24px] cursor-pointer ${colorClasses.border} transition-all group active:scale-98 touch-manipulation focus:outline-none focus:ring-2 focus:ring-cyan-400 hover:-translate-y-0.5 hover:shadow-[0_20px_42px_-22px_rgba(50,173,230,0.6)]">
            <div class="flex items-start gap-3">
                <div class="liquid-icon-well h-10 w-10 ${colorClasses.bg} ${colorClasses.text} ${colorClasses.hoverText} shrink-0">
                    <i data-lucide="${escapeHtml(data.icon)}" class="w-5 h-5"></i>
                </div>
                <div>
                    <h3 class="font-semibold text-zinc-200 text-sm">${escapeHtml(data.title)}</h3>
                    <p class="text-xs text-zinc-500 mt-1">${escapeHtml(data.description)}</p>
                </div>
            </div>
        </div>`;
}

export function renderWelcomeScreen() {
    const template = document.getElementById('welcomeTemplate');
    if (!template) return;

    const chatContainer = document.getElementById('chatContainer');
    if (!chatContainer) return;

    const welcomeScreen = template.content.cloneNode(true);
    const suggestionGrid = welcomeScreen.querySelector('[data-suggestion-grid]');
    if (suggestionGrid) {
        suggestionGrid.innerHTML = shufflePrompts(ALL_PROMPTS).slice(0, 4).map(createSuggestionCard).join('');
        suggestionGrid.querySelectorAll('[data-suggestion-card]').forEach((card, index) => {
            card.style.animation = 'staggerIn 0.4s ease-out both';
            card.style.animationDelay = `${index * 100}ms`;
        });
    }
    chatContainer.appendChild(welcomeScreen);
    refreshIcons();
    initCalendarWidget();
}

export function sendSuggestion(text) {
    const input = document.getElementById('messageInput');
    if (input) {
        input.value = text;
        adjustTextareaHeight(input);
    }
    if (typeof window.sendMessage === 'function') {
        window.sendMessage({ allowSpeech: true });
    }
}
