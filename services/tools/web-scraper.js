const cheerio = require('cheerio');

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_CONTENT_CHARS = 3500;

/**
 * SSRF Safety Guardrail: Blocks private, local, and cloud metadata hostnames and IP addresses
 */
function isDisallowedHost(hostname) {
  if (!hostname || typeof hostname !== 'string') return true;
  const host = hostname.toLowerCase().trim();

  // Common local aliases
  if (['localhost', '0.0.0.0', '127.0.0.1', '::1', '[::1]'].includes(host)) {
    return true;
  }

  // IPv4 Private & Link-local ranges:
  // 127.0.0.0/8, 10.0.0.0/8, 192.168.0.0/16, 169.254.0.0/16 (metadata service)
  if (
    host.startsWith('127.') ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    host.startsWith('169.254.')
  ) {
    return true;
  }

  // 172.16.0.0 - 172.31.255.255
  const match172 = host.match(/^172\.(\d+)\./);
  if (match172) {
    const octet = Number.parseInt(match172[1], 10);
    if (octet >= 16 && octet <= 31) {
      return true;
    }
  }

  // IPv6 unique local and link-local (fc00::/7, fe80::/10)
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) {
    return true;
  }

  return false;
}

function createTimeoutSignal(timeoutMs, parentSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`Web scrape timed out after ${timeoutMs}ms`));
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

/**
 * Fetch and extract clean article/page text from target URL
 */
async function executeWebScraper({ url }, options = {}) {
  if (!url || typeof url !== 'string' || !url.trim()) {
    return {
      success: false,
      error: 'A valid URL is required.',
    };
  }

  const cleanUrl = url.trim();
  let parsedUrl;
  try {
    parsedUrl = new URL(cleanUrl);
  } catch {
    return {
      success: false,
      error: `Invalid URL format: ${cleanUrl}`,
    };
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return {
      success: false,
      error: 'Security Error: Only http and https protocols are permitted.',
    };
  }

  if (isDisallowedHost(parsedUrl.hostname)) {
    return {
      success: false,
      error: `Security Error: Access to private or local network target "${parsedUrl.hostname}" is blocked.`,
    };
  }

  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const timeout = createTimeoutSignal(timeoutMs, options.signal);

  try {
    const response = await fetch(parsedUrl.href, {
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      signal: timeout.signal,
    });

    if (!response.ok) {
      return {
        success: false,
        error: `Failed to fetch webpage: HTTP ${response.status} ${response.statusText}`,
      };
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
      return {
        success: false,
        error: `Unsupported content type "${contentType}". Only web articles and HTML pages can be scraped.`,
      };
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Remove noise, headers, footers, navigation, scripts, ads
    $(
      'script, style, nav, footer, header, noscript, iframe, svg, form, [role="navigation"], [role="banner"], [aria-hidden="true"]'
    ).remove();

    const title =
      $('title').text().trim() ||
      $('meta[property="og:title"]').attr('content') ||
      $('h1').first().text().trim() ||
      parsedUrl.hostname;

    // Prefer main or article if available
    let contentEl = $('main, article, #content, .content, #main');
    if (!contentEl.length) {
      contentEl = $('body');
    }

    let cleanText = contentEl
      .text()
      .replace(/\s+/g, ' ')
      .trim();

    if (cleanText.length > MAX_CONTENT_CHARS) {
      cleanText = cleanText.slice(0, MAX_CONTENT_CHARS) + '... [Content truncated]';
    }

    return {
      success: true,
      title,
      url: cleanUrl,
      text: cleanText || 'No readable textual content found on this webpage.',
      sources: [
        {
          id: `webpage-${Buffer.from(cleanUrl).toString('hex').slice(0, 8)}`,
          title,
          url: cleanUrl,
        },
      ],
    };
  } catch (err) {
    return {
      success: false,
      error: `Failed to read webpage: ${err.message}`,
    };
  } finally {
    timeout.clear();
  }
}

module.exports = {
  executeWebScraper,
  isDisallowedHost,
};
