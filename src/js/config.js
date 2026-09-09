/**
 * Poornima Oracle - Configuration & Constants
 */

export const DEFAULT_API_ENDPOINT = typeof window !== 'undefined' && window.location?.origin 
    ? `${window.location.origin}/api/chat`
    : 'https://poornima-oracle.onrender.com/api/chat';

export const HISTORY_STORAGE_KEY = 'poornimaOracleConversationHistory';
export const DEMO_MODE_STORAGE_KEY = 'poornimaOracleDemoMode';
export const AUTO_READ_STORAGE_KEY = 'poornimaOracleAutoRead';
export const ACTIVE_CONV_STORAGE_KEY = 'activeConversationId';
export const GEMINI_ENDPOINT_STORAGE_KEY = 'geminiApiEndpoint';

export const FALLBACK_STORAGE_KEYS = {
    ENABLED: 'poornima_fallback_enabled',
    OPENROUTER_KEY: 'poornima_openrouter_key',
    OLLAMA_HOST: 'poornima_ollama_host',
    OLLAMA_KEY: 'poornima_ollama_key',
};

export const PROMPT_COLOR_CLASSES = {
    cyan: {
        border: 'hover:border-cyan-500/30',
        bg: 'bg-cyan-500/10',
        text: 'text-cyan-400',
        hoverText: 'group-hover:text-cyan-300',
    },
    rose: {
        border: 'hover:border-rose-500/30',
        bg: 'bg-rose-500/10',
        text: 'text-rose-400',
        hoverText: 'group-hover:text-rose-300',
    },
    amber: {
        border: 'hover:border-amber-500/30',
        bg: 'bg-amber-500/10',
        text: 'text-amber-400',
        hoverText: 'group-hover:text-amber-300',
    },
    emerald: {
        border: 'hover:border-emerald-500/30',
        bg: 'bg-emerald-500/10',
        text: 'text-emerald-400',
        hoverText: 'group-hover:text-emerald-300',
    },
};

export const ALL_PROMPTS = [
    {
        title: 'Anti-Ragging',
        description: 'Policy and reporting',
        icon: 'shield',
        color: 'cyan',
        prompt: 'What is Poornima University anti-ragging policy, and what should a student do to report an incident?',
    },
    {
        title: 'Hostel Rules',
        description: 'Prohibited items',
        icon: 'ban',
        color: 'rose',
        prompt: 'What items are prohibited in Poornima hostel rooms, and why are those rules enforced?',
    },
    {
        title: 'SCOPE',
        description: 'Scholarship details',
        icon: 'graduation-cap',
        color: 'emerald',
        prompt: 'Explain the SCOPE scholarship for online courses, including eligibility, benefits, and how to apply.',
    },
    {
        title: 'Library',
        description: 'Hours and services',
        icon: 'library',
        color: 'amber',
        prompt: 'What are the library hours at Poornima, and what services can students use there?',
    },
    {
        title: 'Attendance',
        description: 'Minimum rules',
        icon: 'clipboard-check',
        color: 'cyan',
        prompt: 'Explain Poornima attendance rules, minimum attendance requirements, and what happens if a student falls short.',
    },
    {
        title: 'Back Exam',
        description: 'Process overview',
        icon: 'refresh-cw',
        color: 'rose',
        prompt: 'Explain the back exam process at Poornima, including forms, fees, schedule, and result handling.',
    },
    {
        title: 'Fees',
        description: 'Payment guidance',
        icon: 'receipt',
        color: 'emerald',
        prompt: 'Summarize the Poornima fee structure and payment process for a student who wants clear next steps.',
    },
    {
        title: 'Placements',
        description: 'Campus hiring',
        icon: 'briefcase',
        color: 'amber',
        prompt: 'How does the Poornima placement process work, from registration to interviews and offer letters?',
    },
    {
        title: 'Campus Wi-Fi',
        description: 'Access help',
        icon: 'wifi',
        color: 'cyan',
        prompt: 'How can a Poornima student access campus Wi-Fi, and what should they do if login does not work?',
    },
    {
        title: 'Labs',
        description: 'Usage rules',
        icon: 'microscope',
        color: 'emerald',
        prompt: 'Explain Poornima lab access, lab rules, and how students should prepare for practical sessions.',
    },
    {
        title: 'Clubs',
        description: 'Events and activities',
        icon: 'calendar-days',
        color: 'amber',
        prompt: 'What clubs and events can Poornima students join, and how should a fresher get started?',
    },
    {
        title: 'Canteen',
        description: 'Food options',
        icon: 'utensils',
        color: 'rose',
        prompt: 'Tell me about Poornima canteen options, timings, payment, and basic student etiquette.',
    },
    {
        title: 'Sports',
        description: 'Facilities and teams',
        icon: 'trophy',
        color: 'cyan',
        prompt: 'What sports facilities, teams, and student participation options are available at Poornima?',
    },
    {
        title: 'Transport',
        description: 'Bus support',
        icon: 'bus',
        color: 'emerald',
        prompt: 'Explain Poornima transport options, bus route support, passes, and whom students should contact for changes.',
    },
    {
        title: 'Hostel Mess',
        description: 'Meal timings',
        icon: 'chef-hat',
        color: 'amber',
        prompt: 'What are Poornima hostel mess timings, common rules, and what should students do for meal-related issues?',
    },
    {
        title: 'Faculty Hours',
        description: 'Meet teachers',
        icon: 'users',
        color: 'rose',
        prompt: 'How can students meet faculty during faculty hours or office hours for academic help at Poornima?',
    },
    {
        title: 'Registration',
        description: 'Courses and forms',
        icon: 'list-checks',
        color: 'cyan',
        prompt: 'Explain the Poornima course registration process, important forms, deadlines, and common mistakes to avoid.',
    },
    {
        title: 'Late Work',
        description: 'Submission policy',
        icon: 'clock',
        color: 'rose',
        prompt: 'What is the late submission process at Poornima, and how should a student request an extension properly?',
    },
    {
        title: 'Alumni',
        description: 'Network benefits',
        icon: 'network',
        color: 'emerald',
        prompt: 'How can Poornima students use the alumni network for mentoring, internships, placements, and career guidance?',
    },
    {
        title: 'Wellbeing',
        description: 'Counseling and advice',
        icon: 'heart-handshake',
        color: 'amber',
        prompt: 'How can students access mental health counseling at Poornima, and give one short practical piece of student advice for today.',
    },
];

export function getDefaultApiEndpoint() {
    return DEFAULT_API_ENDPOINT;
}

export function ensureApiEndpoint() {
    const storedEndpoint = localStorage.getItem(GEMINI_ENDPOINT_STORAGE_KEY);
    const normalizedStoredEndpoint = typeof storedEndpoint === 'string' ? storedEndpoint.trim() : '';
    const endpoint = normalizedStoredEndpoint || getDefaultApiEndpoint();

    if (!normalizedStoredEndpoint) {
        localStorage.setItem(GEMINI_ENDPOINT_STORAGE_KEY, endpoint);
    }

    return endpoint;
}
