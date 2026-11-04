/**
 * Poornima Oracle - Student Profile Store
 * Manages campus affiliation, residential status, and academic context
 */
import { refreshIcons } from '../utils/dom.js';

export const PROFILE_STORAGE_KEY = 'poornima_student_profile';

export const DEFAULT_PROFILE = {
    college: 'GENERAL', // 'PU' | 'PCE' | 'PIET' | 'GENERAL'
    status: 'day_scholar', // 'hosteller' | 'day_scholar' | 'bus_commuter'
    course: 'B.Tech', // 'B.Tech' | 'BBA' | 'BCA' | 'MBA' | 'Diploma' | 'Other'
    year: '1st', // '1st' | '2nd' | '3rd' | '4th' | 'Faculty' | 'Alumni'
    branch: '', // e.g. 'CSE', 'AI-DS', 'ECE', 'Civil'
};

/**
 * Retrieve active student profile with fallback defaults
 */
export function getStudentProfile() {
    try {
        const raw = localStorage.getItem(PROFILE_STORAGE_KEY);
        if (!raw) return { ...DEFAULT_PROFILE };
        const parsed = JSON.parse(raw);
        return {
            college: parsed.college || DEFAULT_PROFILE.college,
            status: parsed.status || DEFAULT_PROFILE.status,
            course: parsed.course || DEFAULT_PROFILE.course,
            year: parsed.year || DEFAULT_PROFILE.year,
            branch: typeof parsed.branch === 'string' ? parsed.branch.trim() : '',
        };
    } catch (e) {
        console.warn('[ProfileStore] Failed to read stored profile, using defaults:', e);
        return { ...DEFAULT_PROFILE };
    }
}

/**
 * Persist student profile changes and dispatch update event
 */
export function saveStudentProfile(updatedData) {
    const current = getStudentProfile();
    const updated = {
        ...current,
        ...updatedData,
        branch: typeof updatedData.branch === 'string' ? updatedData.branch.trim() : current.branch,
    };

    try {
        localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(updated));
    } catch (e) {
        console.warn('[ProfileStore] Failed to save profile to localStorage:', e);
    }

    window.dispatchEvent(new CustomEvent('poornima-profile-updated', { detail: updated }));
    updateProfileUI();
    return updated;
}

/**
 * Produce a clean, concise header badge string
 * e.g. "🎓 PCE · 2nd Yr · Hosteller" or "🎓 Student Profile"
 */
export function formatProfileBadgeText(profile = getStudentProfile()) {
    if (!profile) return '🎓 Student Profile';

    const isDefault =
        profile.college === 'GENERAL' &&
        profile.status === 'day_scholar' &&
        profile.year === '1st' &&
        !profile.branch;

    if (isDefault) {
        return '🎓 Student Profile';
    }

    const collegeLabel = profile.college === 'GENERAL' ? 'Campus' : profile.college;
    const statusLabel =
        profile.status === 'hosteller'
            ? 'Hosteller'
            : profile.status === 'bus_commuter'
            ? 'Bus Commuter'
            : 'Day Scholar';

    const academicParts = [];
    if (profile.year && profile.year !== 'Other') {
        academicParts.push(profile.year.includes('Yr') || profile.year.includes('Year') ? profile.year : `${profile.year} Yr`);
    }
    if (profile.branch) {
        academicParts.push(profile.branch);
    }

    const segments = [collegeLabel];
    if (academicParts.length > 0) {
        segments.push(academicParts.join(' '));
    }
    segments.push(statusLabel);

    return `🎓 ${segments.join(' · ')}`;
}

/**
 * Synchronize UI elements displaying student profile information
 */
export function updateProfileUI() {
    const profile = getStudentProfile();
    const pillText = document.getElementById('profilePillText');
    if (pillText) {
        pillText.textContent = formatProfileBadgeText(profile);
    }

    const pillBtn = document.getElementById('profilePillButton');
    if (pillBtn) {
        const isCustomized =
            profile.college !== 'GENERAL' ||
            profile.status !== 'day_scholar' ||
            Boolean(profile.branch);

        if (isCustomized) {
            pillBtn.classList.remove('text-zinc-300', 'border-white/10');
            pillBtn.classList.add('text-cyan-300', 'border-cyan-500/30', 'bg-cyan-500/10');
        } else {
            pillBtn.classList.remove('text-cyan-300', 'border-cyan-500/30', 'bg-cyan-500/10');
            pillBtn.classList.add('text-zinc-300', 'border-white/10');
        }
    }

    // Populate inputs in settings modal if elements are present in DOM
    const collegeSelect = document.getElementById('profileCollege');
    const statusSelect = document.getElementById('profileStatus');
    const yearSelect = document.getElementById('profileYear');
    const courseSelect = document.getElementById('profileCourse');
    const branchInput = document.getElementById('profileBranch');

    if (collegeSelect) collegeSelect.value = profile.college;
    if (statusSelect) statusSelect.value = profile.status;
    if (yearSelect) yearSelect.value = profile.year;
    if (courseSelect) courseSelect.value = profile.course;
    if (branchInput) branchInput.value = profile.branch || '';

    refreshIcons();
}

/**
 * Open Settings Modal and scroll directly to the Student Profile card
 */
export function openProfileModal() {
    if (typeof window.showApiModal === 'function') {
        window.showApiModal();
        requestAnimationFrame(() => {
            const profileSection = document.getElementById('studentProfileSection');
            if (profileSection) {
                profileSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
                profileSection.classList.add('ring-2', 'ring-cyan-500/40');
                setTimeout(() => {
                    profileSection.classList.remove('ring-2', 'ring-cyan-500/40');
                }, 1500);
            }
        });
    }
}
