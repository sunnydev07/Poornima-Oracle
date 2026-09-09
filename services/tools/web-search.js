const cheerio = require('cheerio');

const DEFAULT_TIMEOUT_MS = 8000;

function createTimeoutSignal(timeoutMs, parentSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`Web search timed out after ${timeoutMs}ms`));
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
 * Search DuckDuckGo HTML endpoint (zero API key required)
 */
async function searchDuckDuckGo(query, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const timeout = createTimeoutSignal(timeoutMs, options.signal);

  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
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
      throw new Error(`DuckDuckGo returned HTTP ${response.status}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    const results = [];

    $('.result').each((i, el) => {
      if (results.length >= 4) return;
      const linkEl = $(el).find('.result__title a');
      const title = linkEl.text().trim();
      let rawLink = linkEl.attr('href') || '';

      // Decode DuckDuckGo redirection wrapper (//duckduckgo.com/l/?uddg=...)
      if (rawLink.includes('uddg=')) {
        try {
          const parsed = new URL(rawLink, 'https://duckduckgo.com');
          const decoded = parsed.searchParams.get('uddg');
          if (decoded) rawLink = decoded;
        } catch {
          // Keep rawLink
        }
      }

      const snippet = $(el).find('.result__snippet').text().trim();
      if (title && rawLink && !rawLink.startsWith('/')) {
        results.push({
          title,
          url: rawLink,
          snippet,
        });
      }
    });

    return results;
  } finally {
    timeout.clear();
  }
}

/**
 * Optional Tavily Search fallback if TAVILY_API_KEY is configured
 */
async function searchTavily(query, apiKey, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const timeout = createTimeoutSignal(timeoutMs, options.signal);

  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: 'basic',
        max_results: 4,
        include_domains: ['poornima.edu.in', 'poornima.org', 'rtu.ac.in'],
      }),
      signal: timeout.signal,
    });

    if (!response.ok) {
      throw new Error(`Tavily API returned HTTP ${response.status}`);
    }

    const data = await response.json();
    const rawResults = Array.isArray(data?.results) ? data.results : [];

    return rawResults.map((item) => ({
      title: item.title || '',
      url: item.url || '',
      snippet: item.content || '',
    }));
  } finally {
    timeout.clear();
  }
}

/**
 * Main Web Search Tool function
 */
async function executeWebSearch({ query }, options = {}) {
  if (!query || typeof query !== 'string' || !query.trim()) {
    return {
      success: false,
      error: 'Search query is required.',
      results: [],
      sources: [],
    };
  }

  const cleanQuery = query.trim();
  const tavilyKey = process.env.TAVILY_API_KEY ? process.env.TAVILY_API_KEY.trim() : '';

  // 1. Try Tavily if key is configured
  if (tavilyKey) {
    try {
      const results = await searchTavily(cleanQuery, tavilyKey, options);
      if (results.length > 0) {
        return {
          success: true,
          provider: 'Tavily Search',
          query: cleanQuery,
          results,
          sources: results.map((r, i) => ({
            id: `web-${i + 1}`,
            title: r.title,
            url: r.url,
          })),
        };
      }
    } catch (err) {
      console.warn(`[WebSearch] Tavily search failed: ${err.message}. Falling back to DuckDuckGo.`);
    }
  }

  // 2. Primary free search via DuckDuckGo
  try {
    const results = await searchDuckDuckGo(cleanQuery, options);
    return {
      success: true,
      provider: 'DuckDuckGo',
      query: cleanQuery,
      results,
      sources: results.map((r, i) => ({
        id: `web-${i + 1}`,
        title: r.title,
        url: r.url,
      })),
    };
  } catch (err) {
    console.error(`[WebSearch] DuckDuckGo search error: ${err.message}`);
    return {
      success: false,
      error: `Web search failed: ${err.message}`,
      results: [],
      sources: [],
    };
  }
}

module.exports = {
  executeWebSearch,
  searchDuckDuckGo,
  searchTavily,
};
