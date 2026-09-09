/**
 * ============================================================================
 * Poornima Oracle — Academic Calendar & Exam Countdown Service (Tier 2 #6)
 * ============================================================================
 *
 * Ingests, parses, and provides upcoming examinations, holidays, and academic
 * deadlines from Poornima Group Google Calendars and PU Firestore collections.
 *
 * Provides:
 *   - Live iCal feed fetching and parsing for PU, PCE, and PIET
 *   - Auto-categorization (Exam, Holiday, Academic, Event)
 *   - Real-time days-until countdown calculation
 *   - College-filtered querying for personalized student widgets
 *   - RAG prompt grounding for chat queries like "When are my exams?"
 *
 * @module services/calendar-service
 */

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour cache
const FETCH_TIMEOUT_MS = 10_000;     // 10s timeout per calendar feed

/**
 * Official Google Calendar feeds for Poornima Group
 */
const CALENDAR_SOURCES = [
  {
    id: 'c_8640cac80344f01d33f5b5f524d338925bdf0cb9258fc9ba211403588007f9ef@group.calendar.google.com',
    name: 'PU Academic Calendar',
    college: 'PU',
    defaultCategory: 'academic',
  },
  {
    id: 'c_2ce27b9b2e5fcf95639a3d368b35ed02c994c6a72dee981efe58ffaea2c45eff@group.calendar.google.com',
    name: 'PU Holiday Calendar',
    college: 'PU',
    defaultCategory: 'holiday',
  },
  {
    id: 'c_cf4f43bf945486118f186136361e4b2a3ea44502a67857888542a57c7a35565b@group.calendar.google.com',
    name: 'Poornima Group No Uniform Days',
    college: 'GENERAL',
    defaultCategory: 'event',
  },
  {
    id: 'c_a2a5f7088894cde989987da5e7a6de963a7d92d82debd612c650bdf8b64bb8e9@group.calendar.google.com',
    name: 'PIET Exam Calendar',
    college: 'PIET',
    defaultCategory: 'exam',
  },
  {
    id: 'c_13b12352b51ff3ead98db6a5ebb56a38b76fdae5513bf7a5d08bceb5bad3e8cb@group.calendar.google.com',
    name: 'PCE Exam Calendar',
    college: 'PCE',
    defaultCategory: 'exam',
  },
  {
    id: 'c_049d58310176c5f7752a5cb41cbe8f565914a02f417c56222cf41dd150e85b62@group.calendar.google.com',
    name: 'PCE Academic Calendar',
    college: 'PCE',
    defaultCategory: 'academic',
  },
  {
    id: 'c_5f5f5b2acf3fa6b1f23903fe1855c3d5f986e66e30adc875770cc9afe96e7d15@group.calendar.google.com',
    name: 'PIET Academic Calendar',
    college: 'PIET',
    defaultCategory: 'academic',
  },
];

// In-memory cache
let cachedEvents = null;
let lastCacheTime = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a Date object to YYYY-MM-DD in IST timezone.
 */
function getTodayISTString() {
  const now = new Date();
  // Adjust to IST (UTC + 5:30)
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(now.getTime() + istOffsetMs);
  return istDate.toISOString().split('T')[0];
}

/**
 * Clean up title text unescaping iCal formatting characters.
 */
function cleanTitle(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\n/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Categorize calendar event based on title keywords.
 */
function categorizeEvent(title, defaultCategory = 'academic') {
  const lower = (title || '').toLowerCase();

  // Exams & Tests
  if (
    lower.includes('exam') ||
    lower.includes('mid term') ||
    lower.includes('mid-term') ||
    lower.includes('end term') ||
    lower.includes('end-term') ||
    lower.includes('mse') ||
    lower.includes('ese') ||
    lower.includes('cie') ||
    lower.includes('practical') ||
    lower.includes('viva') ||
    lower.includes('back test') ||
    lower.includes('mercy back') ||
    lower.includes('test')
  ) {
    return 'exam';
  }

  // Holidays & Vacations
  if (
    lower.includes('holiday') ||
    lower.includes('vacation') ||
    lower.includes('diwali') ||
    lower.includes('holi') ||
    lower.includes('eid') ||
    lower.includes('jayanti') ||
    lower.includes('break') ||
    lower.includes('independence day') ||
    lower.includes('republic day')
  ) {
    return 'holiday';
  }

  // Cultural Events & Celebrations
  if (
    lower.includes('celebration') ||
    lower.includes('fest') ||
    lower.includes('uniform') ||
    lower.includes('dress code') ||
    lower.includes('orientation') ||
    lower.includes('puja') ||
    lower.includes('day') ||
    lower.includes('convocation')
  ) {
    return 'event';
  }

  return defaultCategory;
}

/**
 * Parse an iCal (.ics) string into structured events.
 */
function parseICalContent(icsData, source) {
  if (!icsData || typeof icsData !== 'string') return [];

  const events = [];
  const blocks = icsData.split('BEGIN:VEVENT');

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i].split('END:VEVENT')[0];

    // Summary / Title
    const summaryMatch = block.match(/SUMMARY(?::|;[^:]*:)(.*)/);
    const rawSummary = summaryMatch ? summaryMatch[1] : '';
    const title = cleanTitle(rawSummary);
    if (!title || title.length < 3) continue;

    // DTSTART (supports 20260320 or 20260320T103000Z)
    const dtstartMatch = block.match(/DTSTART(?:;[^:]*)?:(\d{8}(?:T\d{6}Z?)?)/);
    if (!dtstartMatch) continue;
    const rawStart = dtstartMatch[1];
    const startDate = `${rawStart.slice(0, 4)}-${rawStart.slice(4, 6)}-${rawStart.slice(6, 8)}`;

    // DTEND
    const dtendMatch = block.match(/DTEND(?:;[^:]*)?:(\d{8}(?:T\d{6}Z?)?)/);
    let endDate = startDate;
    if (dtendMatch) {
      const rawEnd = dtendMatch[1];
      endDate = `${rawEnd.slice(0, 4)}-${rawEnd.slice(4, 6)}-${rawEnd.slice(6, 8)}`;
    }

    // Description
    const descMatch = block.match(/DESCRIPTION(?::|;[^:]*:)([\s\S]*?)(?:\r?\n[A-Z-]+(?::|;)|$)/);
    const description = descMatch ? cleanTitle(descMatch[1]) : '';

    const category = categorizeEvent(title, source.defaultCategory);
    const eventId = crypto
      .createHash('md5')
      .update(`${source.college}_${title}_${startDate}`)
      .digest('hex')
      .slice(0, 12);

    events.push({
      id: eventId,
      title,
      startDate,
      endDate,
      category,
      college: source.college,
      source: source.name,
      description: description.slice(0, 200),
    });
  }

  return events;
}

// ---------------------------------------------------------------------------
// Core Ingestion & Cache
// ---------------------------------------------------------------------------

/**
 * Fetch all configured Google Calendar feeds and return parsed events.
 */
async function fetchAllCalendarEvents(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedEvents && now - lastCacheTime < CACHE_TTL_MS) {
    return cachedEvents;
  }

  console.log('[CalendarService] Refreshing calendar feeds from Google Calendar...');
  const allEvents = [];
  const seenEventKeys = new Set();

  await Promise.all(
    CALENDAR_SOURCES.map(async (source) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const url = `https://calendar.google.com/calendar/ical/${encodeURIComponent(source.id)}/public/basic.ics`;

      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'PoornimaOracle/2.0 AcademicCalendar',
          },
        });

        if (!response.ok) {
          console.warn(`[CalendarService] ${source.name} returned HTTP ${response.status}`);
          return;
        }

        const icsText = await response.text();
        const parsed = parseICalContent(icsText, source);

        for (const ev of parsed) {
          const key = `${ev.college}_${ev.title}_${ev.startDate}`.toLowerCase();
          if (!seenEventKeys.has(key)) {
            seenEventKeys.add(key);
            allEvents.push(ev);
          }
        }
      } catch (err) {
        console.warn(`[CalendarService] Failed to fetch ${source.name}: ${err.message}`);
      } finally {
        clearTimeout(timeout);
      }
    })
  );

  console.log(`[CalendarService] Total calendar events parsed across all campuses: ${allEvents.length}`);

  if (allEvents.length > 0) {
    cachedEvents = allEvents;
    lastCacheTime = now;
  } else if (!cachedEvents) {
    cachedEvents = [];
  }

  return cachedEvents;
}

/**
 * Calculate countdown and relative date labels.
 */
function enrichEventWithCountdown(event, todayStr) {
  const today = new Date(`${todayStr}T00:00:00Z`);
  const eventDate = new Date(`${event.startDate}T00:00:00Z`);
  const diffDays = Math.round((eventDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

  let countdownLabel;
  let urgency;

  if (diffDays === 0) {
    countdownLabel = 'Today!';
    urgency = 'critical';
  } else if (diffDays === 1) {
    countdownLabel = 'Tomorrow';
    urgency = 'critical';
  } else if (diffDays > 1 && diffDays <= 7) {
    countdownLabel = `In ${diffDays} days`;
    urgency = 'urgent';
  } else if (diffDays > 7 && diffDays <= 30) {
    const weeks = Math.round(diffDays / 7);
    countdownLabel = `In ${diffDays} days (${weeks} wk${weeks > 1 ? 's' : ''})`;
    urgency = 'soon';
  } else if (diffDays > 30) {
    const months = Math.round(diffDays / 30);
    countdownLabel = `In ${diffDays} days (${months} mo${months > 1 ? 's' : ''})`;
    urgency = 'normal';
  } else {
    countdownLabel = `${Math.abs(diffDays)} days ago`;
    urgency = 'past';
  }

  // Nicely formatted date string e.g. "Sep 24, 2026"
  let formattedDate = event.startDate;
  try {
    const parts = event.startDate.split('-');
    if (parts.length === 3) {
      const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
      formattedDate = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }
  } catch {
    // fallback
  }

  return {
    ...event,
    daysRemaining: diffDays,
    countdownLabel,
    formattedDate,
    urgency,
    isToday: diffDays === 0,
    isUpcoming: diffDays >= 0,
  };
}

// ---------------------------------------------------------------------------
// Public API Functions
// ---------------------------------------------------------------------------

/**
 * Retrieve upcoming events with filtering and countdown calculations.
 *
 * @param {object} [options]
 * @param {string} [options.college='ALL']   - 'PU' | 'PCE' | 'PIET' | 'ALL' | 'GENERAL'
 * @param {string} [options.category='all']  - 'exam' | 'holiday' | 'academic' | 'event' | 'all'
 * @param {number} [options.limit=10]        - Max events to return
 * @param {string} [options.currentDate]     - Optional override for today's date (YYYY-MM-DD)
 * @returns {Promise<object>}
 */
async function getUpcomingCalendarEvents(options = {}) {
  const rawEvents = await fetchAllCalendarEvents();
  const todayStr = options.currentDate || getTodayISTString();
  const college = (options.college || 'ALL').toUpperCase();
  const category = (options.category || 'all').toLowerCase();
  const limit = Math.min(Math.max(Number.parseInt(options.limit || '10', 10), 1), 50);

  // Filter events from today onward
  let filtered = rawEvents
    .filter((ev) => ev.startDate >= todayStr)
    .map((ev) => enrichEventWithCountdown(ev, todayStr));

  // Filter by college
  if (college !== 'ALL') {
    filtered = filtered.filter((ev) => ev.college === college || ev.college === 'GENERAL');
  }

  // Filter by category
  if (category !== 'all') {
    filtered = filtered.filter((ev) => ev.category === category);
  }

  // Sort chronologically ascending
  filtered.sort((a, b) => a.startDate.localeCompare(b.startDate));

  // Compute stats across all upcoming for this college
  const allCollegeUpcoming = rawEvents
    .filter((ev) => ev.startDate >= todayStr)
    .filter((ev) => college === 'ALL' || ev.college === college || ev.college === 'GENERAL')
    .map((ev) => enrichEventWithCountdown(ev, todayStr));

  const counts = {
    total: allCollegeUpcoming.length,
    exams: allCollegeUpcoming.filter((e) => e.category === 'exam').length,
    holidays: allCollegeUpcoming.filter((e) => e.category === 'holiday').length,
    academic: allCollegeUpcoming.filter((e) => e.category === 'academic').length,
    events: allCollegeUpcoming.filter((e) => e.category === 'event').length,
  };

  // Find next immediate exam and holiday
  const nextExam = allCollegeUpcoming.find((e) => e.category === 'exam') || null;
  const nextHoliday = allCollegeUpcoming.find((e) => e.category === 'holiday') || null;

  return {
    ok: true,
    today: todayStr,
    college,
    category,
    counts,
    nextExam,
    nextHoliday,
    upcoming: filtered.slice(0, limit),
  };
}

/**
 * Generate a concise context string for RAG queries regarding upcoming dates.
 *
 * @param {string} [college='GENERAL'] - Student college
 * @param {number} [limit=5]           - Limit
 * @returns {Promise<string>}
 */
async function getCalendarContextForPrompt(college = 'GENERAL', limit = 5) {
  try {
    const data = await getUpcomingCalendarEvents({ college, limit });
    if (!data.upcoming || data.upcoming.length === 0) return '';

    const lines = [
      `Official Upcoming Academic Deadlines & Examinations (${data.today} onwards):`,
    ];

    if (data.nextExam) {
      lines.push(`- NEXT EXAM: ${data.nextExam.title} on ${data.nextExam.startDate} (${data.nextExam.countdownLabel})`);
    }

    for (const ev of data.upcoming.slice(0, limit)) {
      lines.push(`- [${ev.category.toUpperCase()}] ${ev.title} | Date: ${ev.startDate} (${ev.countdownLabel}) | Campus: ${ev.college}`);
    }

    return lines.join('\n');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  fetchAllCalendarEvents,
  getUpcomingCalendarEvents,
  getCalendarContextForPrompt,
  parseICalContent,
  categorizeEvent,
  enrichEventWithCountdown,
  getTodayISTString,
  CALENDAR_SOURCES,
};
