const cheerio = require('cheerio');

const DEFAULT_TIMEOUT_MS = 8000;

const CAMPUS_PORTAL_ENDPOINTS = {
  pu_home: 'https://www.poornima.edu.in/',
  pu_admissions: 'https://www.poornima.edu.in/admissions/',
  pce_home: 'https://www.poornima.org/',
};

function createTimeoutSignal(timeoutMs, parentSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`Portal inspector timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  timer.unref?.();

  if (parentSignal) {
    if (parentSignal.aborted) {
      controller.abort(parentSignal.reason);
    } else {
      parentSignal.addEventListener('abort', () => controller.abort(parentSignal.reason), { once: true });
    }
  }

  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

async function inspectPortalSection(targetUrl, timeout) {
  const response = await fetch(targetUrl, {
    method: 'GET',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    signal: timeout.signal,
  });

  if (!response.ok) {
    throw new Error(`Portal returned HTTP ${response.status}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);

  const notices = [];

  // Scrape notices, tickers, circular links, and announcement items
  $(
    'a[href*="notice"], a[href*="circular"], a[href*="announcement"], a[href*="exam"], .notice-item, .marquee, .news-item, li a'
  ).each((_, el) => {
    if (notices.length >= 8) return;
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    let href = $(el).attr('href') || '';

    if (text.length > 15 && text.length < 200 && href && !href.startsWith('#') && !href.startsWith('javascript:')) {
      if (href.startsWith('/')) {
        try {
          const origin = new URL(targetUrl).origin;
          href = `${origin}${href}`;
        } catch {}
      }

      // Avoid duplicates
      if (!notices.some((n) => n.title.toLowerCase() === text.toLowerCase())) {
        notices.push({
          title: text,
          url: href,
        });
      }
    }
  });

  return notices;
}

/**
 * Main Poornima Portal Inspector Tool function
 */
async function executePortalInspector({ section = 'all' }, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const timeout = createTimeoutSignal(timeoutMs, options.signal);

  try {
    const endpointsToInspect = [];
    if (section === 'admissions') {
      endpointsToInspect.push({ name: 'PU Admissions', url: CAMPUS_PORTAL_ENDPOINTS.pu_admissions });
    } else if (section === 'pce' || section === 'piet') {
      endpointsToInspect.push({ name: 'Poornima Group (PCE/PIET)', url: CAMPUS_PORTAL_ENDPOINTS.pce_home });
    } else {
      endpointsToInspect.push({ name: 'Poornima University', url: CAMPUS_PORTAL_ENDPOINTS.pu_home });
      endpointsToInspect.push({ name: 'Poornima Group (PCE/PIET)', url: CAMPUS_PORTAL_ENDPOINTS.pce_home });
    }

    const allNotices = [];
    for (const endpoint of endpointsToInspect) {
      if (timeout.signal.aborted) break;
      try {
        const items = await inspectPortalSection(endpoint.url, timeout);
        for (const item of items) {
          allNotices.push({
            portal: endpoint.name,
            ...item,
          });
        }
      } catch (err) {
        console.warn(`[PortalInspector] Failed checking ${endpoint.name}: ${err.message}`);
      }
    }

    if (allNotices.length === 0) {
      return {
        success: true,
        message: 'No immediate live circular links found in the inspected portal sections. Advise student to check https://poornima.edu.in directly.',
        notices: [],
        sources: [
          {
            id: 'portal-pu',
            title: 'Poornima University Official Portal',
            url: 'https://www.poornima.edu.in',
          },
        ],
      };
    }

    return {
      success: true,
      section,
      noticesCount: allNotices.length,
      notices: allNotices.slice(0, 6),
      sources: allNotices.slice(0, 4).map((item, i) => ({
        id: `portal-notice-${i + 1}`,
        title: item.title,
        url: item.url,
        // Tier 1 #2: live-scraped notices are fresh by definition — stamp
        // today so the chat UI can show the "New" freshness badge.
        publishedAt: new Date().toISOString().split('T')[0],
        college: item.portal || '',
      })),
    };
  } catch (err) {
    return {
      success: false,
      error: `Portal inspection failed: ${err.message}`,
      notices: [],
      sources: [],
    };
  } finally {
    timeout.clear();
  }
}

module.exports = {
  executePortalInspector,
  CAMPUS_PORTAL_ENDPOINTS,
};
