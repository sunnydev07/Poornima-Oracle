/**
 * ============================================================================
 * Poornima Oracle — Upcoming Deadlines & Exam Countdown Widget (Tier 2 #6)
 * ============================================================================
 *
 * Renders a responsive, collapsible upcoming schedule widget on the welcome screen.
 * Displays real-time days-until countdowns for examinations, holidays, and
 * academic deadlines tailored to the student's campus profile.
 *
 * @module src/js/components/calendarWidget
 */

import { getStudentProfile } from '../profile/profileStore.js';
import { escapeHtml, refreshIcons, adjustTextareaHeight } from '../utils/dom.js';

const STORAGE_COLLAPSED_KEY = 'poornima_calendar_widget_collapsed';

// Fallback events if server API is unreachable or in demo mode
const FALLBACK_EVENTS = [
  {
    id: 'fb-1',
    title: 'Autonomous B.Tech First Mid Term Theory Exam',
    category: 'exam',
    college: 'PIET',
    startDate: '2026-09-09',
    formattedDate: 'Sep 9, 2026',
    countdownLabel: 'Today!',
    daysRemaining: 0,
    urgency: 'critical',
  },
  {
    id: 'fb-2',
    title: 'CIE-I: All First Year & Final Year Programs',
    category: 'exam',
    college: 'PU',
    startDate: '2026-09-24',
    formattedDate: 'Sep 24, 2026',
    countdownLabel: 'In 15 days',
    daysRemaining: 15,
    urgency: 'soon',
  },
  {
    id: 'fb-3',
    title: 'Diwali Holiday Vacation',
    category: 'holiday',
    college: 'GENERAL',
    startDate: '2026-10-18',
    formattedDate: 'Oct 18, 2026',
    countdownLabel: 'In 39 days',
    daysRemaining: 39,
    urgency: 'normal',
  },
];

let currentEventsData = null;
let currentFilter = 'all';
let showAllEvents = false;

/**
 * Check if the widget is currently collapsed (defaults to true)
 */
export function isCalendarCollapsed() {
  try {
    const saved = localStorage.getItem(STORAGE_COLLAPSED_KEY);
    if (saved === null) {
      return true; // Collapsed by default
    }
    return saved === 'true';
  } catch {
    return true;
  }
}

/**
 * Toggle collapsed state and save in localStorage
 */
export function toggleCalendarCollapsed() {
  const willCollapse = !isCalendarCollapsed();
  try {
    localStorage.setItem(STORAGE_COLLAPSED_KEY, willCollapse ? 'true' : 'false');
  } catch {
    // ignore
  }

  const container = document.getElementById('upcomingCalendarWidget');
  if (!container) return;

  const body = container.querySelector('[data-calendar-body]');
  const chevron = container.querySelector('[data-calendar-chevron]');

  if (body) {
    if (willCollapse) {
      body.classList.add('hidden');
    } else {
      body.classList.remove('hidden');
    }
  }

  if (chevron) {
    chevron.style.transform = willCollapse ? 'rotate(-90deg)' : 'rotate(0deg)';
  }

  refreshIcons();
}

/**
 * Fetch calendar events from server API with student profile context
 */
export async function fetchCalendarEvents(college = 'ALL') {
  try {
    const res = await fetch(`/api/calendar?college=${encodeURIComponent(college)}&limit=15`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.ok && Array.isArray(data.upcoming)) {
      return data;
    }
    throw new Error('Invalid response structure');
  } catch (err) {
    console.warn('[CalendarWidget] Using local calendar fallback:', err.message);
    return {
      ok: true,
      today: new Date().toISOString().split('T')[0],
      college,
      counts: {
        total: FALLBACK_EVENTS.length,
        exams: FALLBACK_EVENTS.filter((e) => e.category === 'exam').length,
        holidays: FALLBACK_EVENTS.filter((e) => e.category === 'holiday').length,
        academic: FALLBACK_EVENTS.filter((e) => e.category === 'academic').length,
      },
      nextExam: FALLBACK_EVENTS.find((e) => e.category === 'exam'),
      upcoming: FALLBACK_EVENTS,
    };
  }
}

/**
 * Return CSS color classes for a category
 */
function getCategoryColor(category) {
  switch (category) {
    case 'exam':
      return {
        badge: 'bg-amber-500/10 text-amber-300 border-amber-500/25',
        icon: 'file-text',
        label: 'Exam',
      };
    case 'holiday':
      return {
        badge: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/25',
        icon: 'palm-tree',
        label: 'Holiday',
      };
    case 'event':
      return {
        badge: 'bg-purple-500/10 text-purple-300 border-purple-500/25',
        icon: 'sparkles',
        label: 'Event',
      };
    default:
      return {
        badge: 'bg-cyan-500/10 text-cyan-300 border-cyan-500/25',
        icon: 'calendar',
        label: 'Academic',
      };
  }
}

/**
 * Return countdown badge style based on urgency
 */
function getCountdownBadge(event) {
  if (event.isToday || event.daysRemaining === 0) {
    return `
      <span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-rose-500/20 text-rose-300 border border-rose-500/30 animate-pulse">
        <i data-lucide="flame" class="w-3 h-3"></i>
        Today!
      </span>
    `;
  }

  if (event.daysRemaining === 1) {
    return `
      <span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/30">
        <i data-lucide="clock" class="w-3 h-3"></i>
        Tomorrow
      </span>
    `;
  }

  if (event.daysRemaining > 1 && event.daysRemaining <= 7) {
    return `
      <span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-amber-500/15 text-amber-200 border border-amber-500/20">
        <i data-lucide="alert-circle" class="w-3 h-3"></i>
        In ${event.daysRemaining} days
      </span>
    `;
  }

  return `
    <span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-white/5 text-zinc-300 border border-white/10">
      ${escapeHtml(event.countdownLabel || `In ${event.daysRemaining}d`)}
    </span>
  `;
}

/**
 * Render single event row card
 */
function renderEventCard(event) {
  const cat = getCategoryColor(event.category);
  const collegePill = event.college && event.college !== 'GENERAL'
    ? `<span class="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded bg-white/5 text-zinc-400 border border-white/10 uppercase">${escapeHtml(event.college)}</span>`
    : '';

  const promptText = escapeHtml(JSON.stringify(`Tell me about the upcoming ${event.title} on ${event.formattedDate || event.startDate}`));

  return `
    <div onclick="window.sendCalendarPrompt(${promptText})"
        onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();window.sendCalendarPrompt(${promptText});}"
        tabindex="0"
        role="button"
        aria-label="Ask about ${escapeHtml(event.title)}"
        class="group p-3 rounded-xl bg-white/[0.02] hover:bg-white/[0.06] border border-white/10 hover:border-cyan-500/30 transition-all duration-200 cursor-pointer flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 active:scale-[0.99] focus:outline-none focus:ring-1 focus:ring-cyan-400">
      
      <div class="flex items-start gap-2.5 min-w-0">
        <div class="p-2 rounded-lg ${cat.badge} border shrink-0 mt-0.5">
          <i data-lucide="${cat.icon}" class="w-4 h-4"></i>
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5 flex-wrap mb-0.5">
            <span class="text-[10px] font-semibold uppercase px-1.5 py-0.2 rounded border ${cat.badge}">${cat.label}</span>
            ${collegePill}
            <span class="text-xs text-zinc-400 font-mono flex items-center gap-1">
              <i data-lucide="calendar" class="w-3 h-3 text-zinc-400"></i>
              ${escapeHtml(event.formattedDate || event.startDate)}
            </span>
          </div>
          <h4 class="text-xs sm:text-sm font-medium text-zinc-200 group-hover:text-white transition-colors truncate" title="${escapeHtml(event.title)}">
            ${escapeHtml(event.title)}
          </h4>
        </div>
      </div>

      <div class="flex items-center justify-between sm:justify-end gap-2 shrink-0 pt-1 sm:pt-0 border-t sm:border-t-0 border-white/5">
        ${getCountdownBadge(event)}
        <div class="text-zinc-400 group-hover:text-cyan-400 transition-colors p-1">
          <i data-lucide="arrow-up-right" class="w-3.5 h-3.5"></i>
        </div>
      </div>
    </div>
  `;
}

/**
 * Filter events by active category
 */
function getFilteredEvents(events, filter) {
  if (!Array.isArray(events)) return [];
  if (filter === 'all') return events;
  return events.filter((e) => e.category === filter);
}

/**
 * Set active category tab
 */
window.setCalendarCategoryFilter = function (category) {
  currentFilter = category;
  showAllEvents = false;
  renderWidgetContent();
};

/**
 * Toggle show all events
 */
window.toggleCalendarShowAll = function () {
  showAllEvents = !showAllEvents;
  renderWidgetContent();
};

/**
 * Send calendar prompt to chat input
 */
window.sendCalendarPrompt = function (text) {
  const input = document.getElementById('messageInput');
  if (input) {
    input.value = text;
    adjustTextareaHeight(input);
  }
  if (typeof window.sendMessage === 'function') {
    window.sendMessage({ allowSpeech: true });
  }
};

/**
 * Render the inner body of the calendar widget
 */
function renderWidgetContent() {
  const container = document.getElementById('upcomingCalendarWidget');
  if (!container || !currentEventsData) return;

  const data = currentEventsData;
  const filtered = getFilteredEvents(data.upcoming, currentFilter);
  const displayLimit = showAllEvents ? 10 : 3;
  const visibleEvents = filtered.slice(0, displayLimit);
  const hasMore = filtered.length > 3;

  // Header next deadline badge text
  const nextBadgeEl = container.querySelector('[data-calendar-next-badge]');
  if (nextBadgeEl && data.nextExam) {
    nextBadgeEl.innerHTML = `
      <span class="inline-flex items-center gap-1 text-[11px] font-medium text-amber-300 bg-amber-500/10 border border-amber-500/20 px-2.5 py-0.5 rounded-full truncate max-w-[200px] sm:max-w-xs">
        <i data-lucide="hourglass" class="w-3 h-3 text-amber-400"></i>
        <span>Next Exam: <strong>${escapeHtml(data.nextExam.countdownLabel)}</strong></span>
      </span>
    `;
  }

  // Filter Tabs
  const tabsContainer = container.querySelector('[data-calendar-tabs]');
  if (tabsContainer) {
    const counts = data.counts || {};
    const tabs = [
      { id: 'all', label: `All (${counts.total || data.upcoming.length})` },
      { id: 'exam', label: `Exams (${counts.exams || 0}) 📝` },
      { id: 'holiday', label: `Holidays (${counts.holidays || 0}) 🌴` },
      { id: 'academic', label: `Academic (${counts.academic || 0}) 🎓` },
    ];

    tabsContainer.innerHTML = tabs
      .map(
        (tab) => `
        <button type="button" onclick="window.setCalendarCategoryFilter('${tab.id}')"
            class="px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all ${
              currentFilter === tab.id
                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                : 'bg-white/[0.03] text-zinc-400 hover:text-zinc-200 border border-transparent'
            }">
          ${tab.label}
        </button>
      `
      )
      .join('');
  }

  // Event list
  const listContainer = container.querySelector('[data-calendar-list]');
  if (listContainer) {
    if (visibleEvents.length === 0) {
      listContainer.innerHTML = `
        <div class="py-6 text-center text-zinc-400 text-xs">
          <i data-lucide="calendar-x" class="w-6 h-6 mx-auto mb-1.5 text-zinc-400"></i>
          No upcoming ${currentFilter === 'all' ? 'events' : currentFilter + 's'} found for your campus profile.
        </div>
      `;
    } else {
      listContainer.innerHTML = visibleEvents.map(renderEventCard).join('');
    }
  }

  // Show more toggle button
  const moreContainer = container.querySelector('[data-calendar-more-container]');
  if (moreContainer) {
    if (hasMore) {
      moreContainer.innerHTML = `
        <button type="button" onclick="window.toggleCalendarShowAll()"
            class="text-[11px] text-zinc-400 hover:text-cyan-400 font-medium transition flex items-center justify-center gap-1 mx-auto pt-1">
          <span>${showAllEvents ? 'Show fewer events' : `View ${filtered.length - 3} more deadlines`}</span>
          <i data-lucide="${showAllEvents ? 'chevron-up' : 'chevron-down'}" class="w-3.5 h-3.5"></i>
        </button>
      `;
    } else {
      moreContainer.innerHTML = '';
    }
  }

  refreshIcons();
}

/**
 * Initialize and render the Upcoming Deadlines widget inside a container element
 */
export async function initCalendarWidget() {
  const container = document.getElementById('upcomingCalendarWidget');
  if (!container) return;

  const profile = getStudentProfile();
  const college = profile?.college || 'ALL';
  const isCollapsed = isCalendarCollapsed();

  container.innerHTML = `
    <div class="glass bg-zinc-900/60 border border-white/10 hover:border-white/15 rounded-2xl p-3.5 sm:p-4 shadow-xl transition-all duration-300">
      
      <!-- Widget Header (Always visible) -->
      <div class="flex items-center justify-between gap-2 cursor-pointer select-none" onclick="window.toggleCalendarCollapsed()">
        <div class="flex items-center gap-2.5 min-w-0">
          <div class="p-2 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 shrink-0">
            <i data-lucide="calendar-clock" class="w-4 h-4"></i>
          </div>
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <h3 class="text-xs sm:text-sm font-bold text-white tracking-tight flex items-center gap-1.5">
                <span>Upcoming Deadlines & Exams</span>
              </h3>
              <span class="hidden sm:inline-block text-[10px] font-mono uppercase bg-white/5 border border-white/10 px-1.5 py-0.2 rounded text-zinc-400">
                ${college === 'GENERAL' ? 'All Campuses' : college}
              </span>
            </div>
            <p class="text-[11px] text-zinc-400 truncate hidden sm:block">Live official schedule & countdown</p>
          </div>
        </div>

        <div class="flex items-center gap-2 shrink-0">
          <div data-calendar-next-badge class="hidden md:block"></div>
          <button type="button" aria-label="Toggle calendar widget"
              class="p-1.5 text-zinc-400 hover:text-white rounded-lg hover:bg-white/5 transition">
            <i data-lucide="chevron-down" data-calendar-chevron class="w-4 h-4 transition-transform duration-200"
               style="transform: ${isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)'}"></i>
          </button>
        </div>
      </div>

      <!-- Widget Collapsible Body -->
      <div data-calendar-body class="space-y-3 pt-3 mt-3 border-t border-white/5 ${isCollapsed ? 'hidden' : ''}">
        
        <!-- Category Filter Tabs -->
        <div data-calendar-tabs class="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
          <!-- Populated dynamically -->
        </div>

        <!-- Event Cards List -->
        <div data-calendar-list class="space-y-2">
          <!-- Loading skeleton -->
          <div class="p-3 rounded-xl bg-white/[0.02] border border-white/5 animate-pulse flex items-center justify-between">
            <div class="flex items-center gap-2.5">
              <div class="w-8 h-8 rounded-lg bg-white/5"></div>
              <div class="space-y-1.5">
                <div class="w-36 h-3 bg-white/10 rounded"></div>
                <div class="w-20 h-2 bg-white/5 rounded"></div>
              </div>
            </div>
            <div class="w-16 h-5 bg-white/10 rounded-full"></div>
          </div>
        </div>

        <!-- Show more container -->
        <div data-calendar-more-container></div>
      </div>
    </div>
  `;

  refreshIcons();

  // Load events
  currentEventsData = await fetchCalendarEvents(college);
  renderWidgetContent();

  // Listen for profile changes to reload calendar for their campus
  window.removeEventListener('poornima-profile-updated', handleProfileUpdate);
  window.addEventListener('poornima-profile-updated', handleProfileUpdate);
}

async function handleProfileUpdate(event) {
  const college = event?.detail?.college || 'ALL';
  currentEventsData = await fetchCalendarEvents(college);
  renderWidgetContent();
}

window.toggleCalendarCollapsed = toggleCalendarCollapsed;
