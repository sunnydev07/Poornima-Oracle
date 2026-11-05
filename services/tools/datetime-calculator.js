/**
 * Datetime Calculator Tool
 * Computes Indian Standard Time (IST, UTC+5:30) dates, academic deadlines, and day intervals.
 */

function getIstDate() {
  // Return the real instant. IST conversion happens via Intl timeZone options;
  // manually shifting the clock here would apply the +5:30 offset twice.
  return new Date();
}

function getIstDateString(date = new Date()) {
  return date.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function executeDatetimeCalculator({ operation = 'current_date', startDate, endDate, daysToAdd }) {
  const istNow = getIstDate();

  if (operation === 'current_date') {
    const formattedDate = getIstDateString(istNow);
    const dayOfWeek = istNow.toLocaleDateString('en-IN', { weekday: 'long', timeZone: 'Asia/Kolkata' });
    const formattedTime = istNow.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });

    return {
      success: true,
      timeZone: 'Asia/Kolkata (IST)',
      currentDate: formattedDate,
      dayOfWeek,
      currentTime: formattedTime,
      academicYear: `${formattedDate.slice(0, 4)}-${Number(formattedDate.slice(0, 4)) + 1}`,
    };
  }

  if (operation === 'days_between') {
    if (!startDate || !endDate) {
      return {
        success: false,
        error: 'Both startDate and endDate (YYYY-MM-DD) are required for days_between.',
      };
    }

    const start = new Date(`${startDate}T00:00:00Z`);
    const end = new Date(`${endDate}T00:00:00Z`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return {
        success: false,
        error: 'Invalid date format. Use YYYY-MM-DD.',
      };
    }

    const diffMs = end.getTime() - start.getTime();
    const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

    return {
      success: true,
      startDate,
      endDate,
      daysBetween: diffDays,
      isPast: diffDays < 0,
    };
  }

  if (operation === 'add_days') {
    const base = startDate ? new Date(`${startDate}T00:00:00Z`) : new Date(`${getIstDateString(istNow)}T00:00:00Z`);
    if (Number.isNaN(base.getTime())) {
      return {
        success: false,
        error: 'Invalid startDate format. Use YYYY-MM-DD.',
      };
    }

    const days = Number.parseInt(daysToAdd, 10) || 0;
    const target = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);

    return {
      success: true,
      baseDate: base.toISOString().slice(0, 10),
      daysAdded: days,
      resultDate: target.toISOString().slice(0, 10),
      dayOfWeek: target.toLocaleDateString('en-IN', { weekday: 'long', timeZone: 'UTC' }),
    };
  }

  return {
    success: false,
    error: `Unknown operation "${operation}". Supported operations: current_date, days_between, add_days.`,
  };
}

module.exports = {
  executeDatetimeCalculator,
  getIstDate,
  getIstDateString,
};
