/**
 * ============================================================================
 * Poornima Oracle — RAG 2.0: Automated Notice Ingestion Pipeline
 * ============================================================================
 *
 * Crawls official Poornima Group notice portals, extracts circulars and
 * announcements, chunks the text, generates Gemini embeddings, and upserts
 * into the Pinecone `notices` namespace with full deduplication.
 *
 * Architecture:
 *   - poornima.edu.in (PU): Uses Firestore REST API (Angular CSR, no SSR HTML)
 *   - poornima.org (PCE/PIET): Uses Cheerio on server-rendered HTML
 *
 * Usage:
 *   npm run sync:notices          — manual CLI run
 *   npm run sync:notices:dry      — dry run (no upsert)
 *   POST /api/sync-notices        — admin HTTP trigger (API-key protected)
 *   Automatic cron (6:00 AM IST)  — scheduled inside server.js
 *
 * @module services/crawler/notice-sync
 */

require('dotenv').config();

const crypto = require('crypto');
const cheerio = require('cheerio');
const { GoogleGenAI } = require('@google/genai');
const { Pinecone } = require('@pinecone-database/pinecone');
const { enrichNoticesWithPdfContent } = require('./pdf-extractor');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const NOTICES_NAMESPACE = 'notices';
const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001';
const EMBEDDING_DIMENSIONS = 768;
const CHUNK_MAX_CHARS = 500;
const CHUNK_OVERLAP_CHARS = 100;
const UPSERT_BATCH_SIZE = 50;
const CRAWL_TIMEOUT_MS = 15_000;
const EMBED_TIMEOUT_MS = 20_000;
const MAX_NOTICES_PER_SOURCE = 30;
const EMBED_BATCH_SIZE = 10;
const EMBED_DELAY_MS = 300; // Rate-limit courtesy delay between embedding batches
const ENABLE_PDF_EXTRACTION = process.env.ENABLE_PDF_EXTRACTION !== 'false'; // Default: true
const PDF_CONCURRENCY = Number.parseInt(process.env.PDF_CONCURRENCY || '2', 10);
const MAX_CHUNKS_PER_NOTICE = 25; // Limit chunks per notice to avoid vector flooding
const MAX_SLUG_LENGTH = 60; // Keep deterministic chunk IDs well under Pinecone's ID limit
const URL_HASH_LENGTH = 12; // Hex chars of SHA-256 used to disambiguate same-title notices

/**
 * Firestore REST API endpoints for Poornima University (Angular CSR).
 * These are public read-only collections from the `poornima-5c202` project.
 */
const PU_FIRESTORE_ENDPOINTS = {
  notices: 'https://firestore.googleapis.com/v1/projects/poornima-5c202/databases/(default)/documents/notices',
  calendars: 'https://firestore.googleapis.com/v1/projects/poornima-5c202/databases/(default)/documents/important-calendars',
  news: 'https://firestore.googleapis.com/v1/projects/poornima-5c202/databases/(default)/documents/news',
};

/**
 * SSR HTML sources for Poornima Group (PCE/PIET).
 * These pages render fully server-side and are Cheerio-compatible.
 */
const PCE_HTML_SOURCES = [
  {
    name: 'PCE/PIET Updates',
    college: 'PCE',
    url: 'https://www.poornima.org/updates/',
  },
  {
    name: 'PCE/PIET Homepage',
    college: 'PCE',
    url: 'https://www.poornima.org/',
  },
];

// ---------------------------------------------------------------------------
// In-memory deduplication cache (per-process; backed by deterministic IDs)
// ---------------------------------------------------------------------------

/**
 * SHA-256 hashes of notices whose vectors were ALL upserted successfully.
 *
 * Hashes are deliberately NOT added before embedding/upsert. A transient
 * failure must leave the notice unmarked so the next run (same process or a
 * later cron run) retries it instead of silently losing content.
 *
 * @type {Set<string>}
 */
const processedHashes = new Set();

/**
 * Clear the in-memory dedupe set. Intended for tests; production relies on
 * deterministic chunk IDs so re-processing is idempotent anyway.
 */
function resetProcessedHashes() {
  processedHashes.clear();
}

// ---------------------------------------------------------------------------
// Text Utilities
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic SHA-256 hash for a piece of text.
 */
function contentHash(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Clean up scraped text: collapse whitespace, trim.
 */
function cleanText(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Parse a date string into ISO format (YYYY-MM-DD).
 * Handles formats like "Jun 08, 2026", "08/06/2026", ISO timestamps.
 */
function parseDate(raw) {
  if (!raw || typeof raw !== 'string') return null;

  const trimmed = raw.trim();

  // ISO timestamp (from Firestore)
  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
    return trimmed.split('T')[0];
  }

  // Try native Date parsing (handles "Jun 08, 2026" etc.)
  try {
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime()) && parsed.getFullYear() > 2000) {
      return parsed.toISOString().split('T')[0];
    }
  } catch {
    // Fall through
  }

  // Indian date formats: DD/MM/YYYY, DD-MM-YYYY
  const ddmmyyyy = trimmed.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (ddmmyyyy) {
    const [, day, month, year] = ddmmyyyy;
    try {
      const d = new Date(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`);
      if (!Number.isNaN(d.getTime())) return d.toISOString().split('T')[0];
    } catch {
      // Fall through
    }
  }

  return null;
}

/**
 * Classify a notice into a category based on keywords.
 */
function categorize(text) {
  const lower = (text || '').toLowerCase();
  const categories = [
    { keywords: ['exam', 'examination', 'test', 'mid-term', 'end-term', 'viva', 'practical', 'mercy back'], category: 'examination' },
    { keywords: ['result', 'merit', 'topper', 'grade', 'marksheet'], category: 'results' },
    { keywords: ['holiday', 'vacation', 'festival', 'diwali', 'holi', 'christmas', 'independence'], category: 'holiday' },
    { keywords: ['fee', 'payment', 'dues', 'challan', 'refund', 'scholarship'], category: 'fee' },
    { keywords: ['placement', 'recruitment', 'internship', 'campus drive', 'hiring'], category: 'placement' },
    { keywords: ['admission', 'registration', 'enrollment', 'counseling', 'seat'], category: 'admission' },
    { keywords: ['hostel', 'mess', 'accommodation', 'curfew', 'warden'], category: 'hostel' },
    { keywords: ['bus', 'transport', 'route', 'shuttle'], category: 'transport' },
    { keywords: ['sports', 'cultural', 'fest', 'event', 'competition', 'hackathon'], category: 'events' },
    { keywords: ['rtu', 'university', 'rajasthan technical'], category: 'rtu' },
    { keywords: ['syllabus', 'curriculum', 'timetable', 'schedule', 'calendar'], category: 'academic' },
  ];

  for (const { keywords, category } of categories) {
    if (keywords.some((kw) => lower.includes(kw))) {
      return category;
    }
  }

  return 'general';
}

/**
 * Generate a URL-safe slug from a title string.
 */
function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, MAX_SLUG_LENGTH);
}

/**
 * Normalize a notice URL so equivalent spellings produce the same chunk IDs.
 * Fragments are dropped, host casing is normalized, and default ports are
 * removed. Paths and query strings are preserved because they can identify
 * genuinely different notices.
 *
 * @param {string} rawUrl
 * @returns {string}
 */
function canonicalizeUrl(rawUrl) {
  const input = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!input) return '';

  try {
    const parsed = new URL(input);
    parsed.hash = '';

    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      parsed.hostname = parsed.hostname.toLowerCase();
      if (
        (parsed.protocol === 'http:' && parsed.port === '80') ||
        (parsed.protocol === 'https:' && parsed.port === '443')
      ) {
        parsed.port = '';
      }
    }

    return parsed.href;
  } catch {
    // Keep non-URL / malformed values deterministic without a fragment.
    return input.split('#')[0];
  }
}

/**
 * Short deterministic digest of a notice's canonical URL.
 *
 * @param {string} url
 * @returns {string} 12 lowercase hex characters
 */
function shortUrlHash(url) {
  return contentHash(canonicalizeUrl(url)).slice(0, URL_HASH_LENGTH);
}

/**
 * Build a deterministic, collision-resistant Pinecone vector ID.
 *
 * The URL digest prevents two same-title notices in one college from
 * overwriting each other, while keeping IDs stable across runs so updates to
 * the same URL overwrite idempotently.
 *
 * @param {object} notice
 * @param {number} chunkIdx
 * @returns {string}
 */
function buildChunkId(notice, chunkIdx) {
  const college = slugify(notice.college) || 'unknown';
  const titleSlug = slugify(notice.title) || 'notice';
  return `notice-${college}-${titleSlug}-${shortUrlHash(notice.url)}-c${chunkIdx}`;
}

/**
 * Hash the full canonical notice content used for deduplication.
 *
 * Includes title, URL, college, HTML/feed text, and extracted PDF text so that
 * edits to any content-bearing field cause re-ingestion. A PDF-less HTML edit
 * therefore changes the hash instead of being skipped forever.
 *
 * @param {object} notice
 * @returns {string} SHA-256 hex digest
 */
function noticeContentHash(notice = {}) {
  const fields = [
    notice.title,
    canonicalizeUrl(notice.url),
    notice.college,
    notice.text,
    notice.pdfText,
  ].map((value) => {
    if (typeof value === 'string') return value;
    return value == null ? '' : String(value);
  });

  // NUL separator prevents field-boundary ambiguity (e.g. "ab"+"c" vs "a"+"bc").
  return contentHash(fields.join('\u0000'));
}

// ---------------------------------------------------------------------------
// Text Chunking (Recursive Character Splitter)
// ---------------------------------------------------------------------------

/**
 * Split text into overlapping chunks for embedding.
 *
 * @param {string} text      - Full text to chunk
 * @param {number} maxChars  - Maximum characters per chunk
 * @param {number} overlap   - Characters of overlap between chunks
 * @returns {string[]}       - Array of text chunks
 */
function chunkText(text, maxChars = CHUNK_MAX_CHARS, overlap = CHUNK_OVERLAP_CHARS) {
  if (!text || text.length <= maxChars) {
    return text ? [text] : [];
  }

  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);

    // Try to break at sentence or word boundary
    if (end < text.length) {
      const minBreak = start + Math.max(overlap + 10, Math.floor(maxChars * 0.5));
      const lastSentenceBreak = text.lastIndexOf('. ', end);
      const lastNewline = text.lastIndexOf('\n', end);
      const lastSpace = text.lastIndexOf(' ', end);

      if (lastSentenceBreak >= minBreak) {
        end = lastSentenceBreak + 1;
      } else if (lastNewline >= minBreak) {
        end = lastNewline;
      } else if (lastSpace >= minBreak) {
        end = lastSpace;
      }
    }

    const chunk = text.slice(start, end).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }

    if (end >= text.length) break;

    const nextStart = Math.max(start + 1, end - overlap);
    start = nextStart <= start ? end : nextStart;
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Source 1: Poornima University — Firestore REST API Crawler
// ---------------------------------------------------------------------------

/**
 * Extract a string value from a Firestore document field.
 * Firestore REST API returns typed wrappers like { stringValue: "..." }.
 */
function firestoreFieldValue(field) {
  if (!field) return '';
  return field.stringValue || field.integerValue || field.booleanValue?.toString() || '';
}

/**
 * Crawl PU notices via Firestore REST API.
 *
 * @returns {Promise<{notices: object[], attempted: number, failed: number, errors: string[]}>}
 *   Detailed per-collection results so a total outage is distinguishable from
 *   a genuinely empty collection.
 */
async function crawlPUFirestore() {
  const result = { notices: [], attempted: 0, failed: 0, errors: [] };
  const collections = [
    { endpoint: PU_FIRESTORE_ENDPOINTS.notices, type: 'notice' },
    { endpoint: PU_FIRESTORE_ENDPOINTS.calendars, type: 'calendar' },
    { endpoint: PU_FIRESTORE_ENDPOINTS.news, type: 'news' },
  ];

  for (const { endpoint, type } of collections) {
    result.attempted += 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CRAWL_TIMEOUT_MS);

    try {
      console.log(`[NoticeCrawler] Fetching PU Firestore: ${type}`);
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'PoornimaOracle/2.0 NoticeSync',
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        const message = `PU Firestore ${type} returned HTTP ${response.status}`;
        result.failed += 1;
        result.errors.push(message);
        console.warn(`[NoticeCrawler] ${message}`);
        continue;
      }

      const data = await response.json();
      const documents = data.documents || [];

      for (const doc of documents) {
        if (result.notices.length >= MAX_NOTICES_PER_SOURCE) break;

        const fields = doc.fields || {};
        const title = cleanText(firestoreFieldValue(fields.text) || firestoreFieldValue(fields.title));
        const link = firestoreFieldValue(fields.link) || firestoreFieldValue(fields.url) || '';
        const dateRaw = fields.date?.timestampValue || firestoreFieldValue(fields.date) || '';
        const isNew = fields.isNew?.booleanValue === true;
        const isImportant = fields.isImportant?.booleanValue === true;

        if (!title || title.length < 5) continue;

        // Build richer text content
        const textParts = [title];
        if (isNew) textParts.push('[NEW]');
        if (isImportant) textParts.push('[IMPORTANT]');
        if (type === 'calendar') textParts.push('[Academic Calendar]');
        if (type === 'news') textParts.push('[Campus News]');

        result.notices.push({
          title,
          url: link || `https://poornima.edu.in/updates/`,
          text: textParts.join(' '),
          college: 'PU',
          category: type === 'calendar' ? 'academic' : categorize(title),
          publishedAt: parseDate(dateRaw),
          isNew,
          isImportant,
        });
      }

      console.log(`[NoticeCrawler] PU Firestore ${type}: ${documents.length} documents found`);
    } catch (err) {
      const message = err.name === 'AbortError'
        ? `PU Firestore ${type} timed out`
        : `PU Firestore ${type} error: ${err.message}`;
      result.failed += 1;
      result.errors.push(message);
      console.warn(`[NoticeCrawler] ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Source 2: PCE/PIET — Cheerio HTML Crawler
// ---------------------------------------------------------------------------

/**
 * Crawl poornima.org/updates/ using Cheerio on server-rendered HTML.
 * Uses the exact CSS selectors discovered from the SSR page structure.
 *
 * @returns {Promise<{notices: object[], attempted: number, failed: number, errors: string[]}>}
 */
async function crawlPCEUpdatesPage(url, college) {
  const result = { notices: [], attempted: 1, failed: 0, errors: [] };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CRAWL_TIMEOUT_MS);

  try {
    console.log(`[NoticeCrawler] Crawling HTML: ${url}`);
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const message = `HTTP ${response.status} from ${url}`;
      result.failed = 1;
      result.errors.push(message);
      console.warn(`[NoticeCrawler] ${message}`);
      return result;
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    const notices = [];

    // Strategy 1: Target the structured updates page (poornima.org/updates/)
    // Find the "Notices and Circular" column specifically
    const noticeColumns = $('.updates-column').filter((_, el) => {
      const title = $(el).find('.column-title').text().trim().toLowerCase();
      return title.includes('notice') || title.includes('circular');
    });

    if (noticeColumns.length > 0) {
      noticeColumns.find('.updates-list .updates-item').each((_, el) => {
        if (notices.length >= MAX_NOTICES_PER_SOURCE) return false;

        const $item = $(el);
        const title = cleanText($item.find('a.updates-link').text());
        let href = ($item.find('a.updates-link').attr('href') || '').trim();
        const dateText = cleanText($item.find('.updates-meta').last().text());
        const badges = $item.find('.priority-badge').map((_, b) => $(b).text().trim().toLowerCase()).get();

        if (!title || title.length < 5) return;
        if (!href) return;

        // Resolve relative URLs
        if (href.startsWith('/')) {
          try { href = new URL(href, url).href; } catch { return; }
        }

        notices.push({
          title,
          url: href,
          text: title,
          college,
          category: categorize(title),
          publishedAt: parseDate(dateText),
          isNew: badges.includes('new'),
          isImportant: badges.includes('important'),
        });
      });
    }

    // Strategy 2: Also grab all 3 columns (Calendars, Notices, News)
    $('.updates-column').each((_, col) => {
      const columnTitle = cleanText($(col).find('.column-title').text());
      if (columnTitle.toLowerCase().includes('notice')) return; // Already handled above

      $(col).find('.updates-list .updates-item').each((_, el) => {
        if (notices.length >= MAX_NOTICES_PER_SOURCE) return false;

        const $item = $(el);
        const title = cleanText($item.find('a.updates-link').text());
        let href = ($item.find('a.updates-link').attr('href') || '').trim();
        const dateText = cleanText($item.find('.updates-meta').last().text());

        if (!title || title.length < 5 || !href) return;
        if (href.startsWith('/')) {
          try { href = new URL(href, url).href; } catch { return; }
        }

        // Avoid duplicates
        if (notices.some((n) => n.title.toLowerCase() === title.toLowerCase())) return;

        notices.push({
          title: `${columnTitle}: ${title}`,
          url: href,
          text: `${columnTitle}: ${title}`,
          college,
          category: categorize(columnTitle + ' ' + title),
          publishedAt: parseDate(dateText),
        });
      });
    });

    // Strategy 3: Fallback — broad selector scraping (homepage or non-updates pages)
    if (notices.length === 0) {
      const fallbackSelectors = [
        'a[href*="notice"]', 'a[href*="circular"]', 'a[href*="exam"]',
        'a[href*="result"]', 'a[href$=".pdf"]', '.notice-item a',
        '.news-item a', '.marquee a', '.ticker a',
      ].join(', ');

      $(fallbackSelectors).each((_, el) => {
        if (notices.length >= MAX_NOTICES_PER_SOURCE) return false;

        const rawTitle = cleanText($(el).text());
        let href = ($(el).attr('href') || '').trim();

        if (rawTitle.length < 10 || rawTitle.length > 500) return;
        if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) return;

        // Resolve relative URLs
        if (href.startsWith('/')) {
          try { href = new URL(href, url).href; } catch { return; }
        } else if (!href.startsWith('http')) {
          try { href = new URL(href, url).href; } catch { return; }
        }

        // Skip navigational links
        const titleLower = rawTitle.toLowerCase();
        const skipPatterns = ['home', 'about us', 'contact', 'login', 'signup', 'register', 'menu', 'read more', 'click here'];
        if (skipPatterns.some((p) => titleLower === p)) return;
        if (notices.some((n) => n.title.toLowerCase() === titleLower)) return;

        notices.push({
          title: rawTitle,
          url: href,
          text: rawTitle,
          college,
          category: categorize(rawTitle),
          publishedAt: null,
        });
      });
    }

    console.log(`[NoticeCrawler] ${url}: ${notices.length} items extracted`);
    result.notices = notices;
    return result;
  } catch (err) {
    const message = err.name === 'AbortError'
      ? `Timeout crawling ${url}`
      : `Error crawling ${url}: ${err.message}`;
    result.failed = 1;
    result.errors.push(message);
    console.warn(`[NoticeCrawler] ${message}`);
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Combined Crawler
// ---------------------------------------------------------------------------

/**
 * Merge a source result into the aggregate, deduplicating by title + URL.
 *
 * @param {{notices: object[], attempted: number, failed: number, errors: string[]}} aggregate
 * @param {{notices: object[], attempted: number, failed: number, errors: string[]}} sourceResult
 * @param {Set<string>} seenKeys
 */
function mergeCrawlResult(aggregate, sourceResult, seenKeys) {
  aggregate.attempted += sourceResult.attempted;
  aggregate.failed += sourceResult.failed;
  aggregate.errors.push(...sourceResult.errors);

  for (const notice of sourceResult.notices) {
    const key = (notice.title + notice.url).toLowerCase();
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      aggregate.notices.push(notice);
    }
  }
}

/**
 * Crawl all configured sources (PU Firestore API + PCE/PIET HTML).
 *
 * @returns {Promise<{notices: object[], attempted: number, failed: number, errors: string[]}>}
 *   Detailed results: `attempted > 0 && failed === attempted` means a total
 *   outage, which callers must not report as a successful empty sync.
 */
async function crawlAllSources() {
  const aggregate = { notices: [], attempted: 0, failed: 0, errors: [] };
  const seenKeys = new Set();

  // Source 1: PU via Firestore REST API
  try {
    mergeCrawlResult(aggregate, await crawlPUFirestore(), seenKeys);
  } catch (err) {
    mergeCrawlResult(aggregate, {
      notices: [],
      attempted: 1,
      failed: 1,
      errors: [`PU Firestore crawl failed: ${err.message}`],
    }, seenKeys);
  }

  // Source 2: PCE/PIET via Cheerio HTML
  for (const source of PCE_HTML_SOURCES) {
    try {
      mergeCrawlResult(aggregate, await crawlPCEUpdatesPage(source.url, source.college), seenKeys);
    } catch (err) {
      mergeCrawlResult(aggregate, {
        notices: [],
        attempted: 1,
        failed: 1,
        errors: [`${source.name} crawl failed: ${err.message}`],
      }, seenKeys);
    }
  }

  console.log(
    `[NoticeCrawler] Total raw notices scraped: ${aggregate.notices.length} ` +
    `(sources attempted: ${aggregate.attempted}, failed: ${aggregate.failed})`
  );
  return aggregate;
}

// ---------------------------------------------------------------------------
// Embedding Generation (Google Gemini)
// ---------------------------------------------------------------------------

/**
 * Generate embeddings for an array of text chunks using Gemini.
 *
 * @param {GoogleGenAI} ai        - Initialized GoogleGenAI client
 * @param {string[]}    texts     - Array of text strings to embed
 * @returns {Promise<number[][]>} - Array of 768-dimensional vectors
 */
async function generateEmbeddings(ai, texts) {
  const allEmbeddings = [];

  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);

    const results = await Promise.all(
      batch.map(async (text) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);

        try {
          const response = await ai.models.embedContent({
            model: EMBEDDING_MODEL,
            contents: text,
            config: {
              outputDimensionality: EMBEDDING_DIMENSIONS,
              httpOptions: { timeout: EMBED_TIMEOUT_MS },
              abortSignal: controller.signal,
            },
          });

          return response?.embeddings?.[0]?.values || null;
        } catch (err) {
          console.warn(`[NoticeCrawler] Embedding failed for chunk: ${err.message}`);
          return null;
        } finally {
          clearTimeout(timeout);
        }
      })
    );

    allEmbeddings.push(...results);

    // Rate-limit courtesy delay between batches
    if (i + EMBED_BATCH_SIZE < texts.length) {
      await new Promise((resolve) => setTimeout(resolve, EMBED_DELAY_MS));
    }
  }

  return allEmbeddings;
}

// ---------------------------------------------------------------------------
// Pinecone Upsertion
// ---------------------------------------------------------------------------

/**
 * Upsert notice vectors into the Pinecone `notices` namespace.
 *
 * Batch failures are collected rather than swallowed so the caller can return
 * a truthful `success:false` and avoid marking failed notices as processed.
 *
 * @param {import('@pinecone-database/pinecone').Index} index  - Pinecone index handle
 * @param {Array<{id: string, values: number[], metadata: object}>} vectors - Prepared vectors
 * @returns {Promise<{
 *   upsertedCount: number,
 *   failedBatches: number,
 *   errors: string[],
 *   failedBatchDetails: Array<{batchIndex: number, vectorIds: string[], error: string}>,
 *   upsertedIds: Set<string>
 * }>}
 */
async function upsertToNoticesNamespace(index, vectors) {
  let totalUpserted = 0;
  const errors = [];
  const failedBatchDetails = [];
  const upsertedIds = new Set();

  for (let i = 0; i < vectors.length; i += UPSERT_BATCH_SIZE) {
    const batchIndex = Math.floor(i / UPSERT_BATCH_SIZE) + 1;
    const batch = vectors.slice(i, i + UPSERT_BATCH_SIZE);

    try {
      await index.namespace(NOTICES_NAMESPACE).upsert(batch);
      totalUpserted += batch.length;
      for (const vector of batch) {
        if (vector && vector.id) upsertedIds.add(vector.id);
      }
      console.log(`[NoticeCrawler] Upserted batch ${batchIndex}: ${batch.length} vectors`);
    } catch (err) {
      const message = `Upsert batch ${batchIndex} failed: ${err.message}`;
      errors.push(message);
      failedBatchDetails.push({
        batchIndex,
        vectorIds: batch.map((vector) => vector.id),
        error: err.message,
      });
      console.error(`[NoticeCrawler] ${message}`);
    }
  }

  return {
    upsertedCount: totalUpserted,
    failedBatches: failedBatchDetails.length,
    errors,
    failedBatchDetails,
    upsertedIds,
  };
}

// ---------------------------------------------------------------------------
// Main Sync Pipeline
// ---------------------------------------------------------------------------

/**
 * Normalize the injectable crawl output to the detailed internal shape.
 * Accepts either a plain notices array (legacy callers/tests) or the
 * `{ notices, attempted, failed, errors }` object produced by crawlAllSources.
 *
 * @param {object[]|{notices?: object[], attempted?: number, failed?: number, errors?: string[]}} rawResult
 * @returns {{notices: object[], attempted: number, failed: number, errors: string[]}}
 */
function normalizeCrawlResult(rawResult) {
  if (Array.isArray(rawResult)) {
    return {
      notices: rawResult,
      attempted: rawResult.length > 0 ? 1 : 0,
      failed: 0,
      errors: [],
    };
  }

  if (rawResult && typeof rawResult === 'object') {
    const notices = Array.isArray(rawResult.notices) ? rawResult.notices : [];
    const attemptedValue = Number(rawResult.attempted);
    const failedValue = Number(rawResult.failed);
    const failed = Number.isFinite(failedValue) ? failedValue : 0;
    const attempted = Number.isFinite(attemptedValue)
      ? attemptedValue
      : Math.max(notices.length > 0 ? 1 : 0, failed);
    const errors = Array.isArray(rawResult.errors)
      ? rawResult.errors.map((error) => (typeof error === 'string' ? error : String(error)))
      : [];

    return { notices, attempted, failed, errors };
  }

  throw new TypeError('crawl injection must return an array or a detailed crawl result object');
}

/**
 * Full notice synchronization pipeline.
 *
 * 1. Crawl PU (Firestore API) + PCE/PIET (Cheerio HTML)
 * 2. Deduplicate by content hash (only after a fully successful upsert)
 * 3. Chunk text into embeddable segments
 * 4. Generate Gemini embeddings
 * 5. Upsert into Pinecone `notices` namespace
 *
 * @param {object} [options]
 * @param {GoogleGenAI}  [options.ai]             - Pre-initialized AI client
 * @param {import('@pinecone-database/pinecone').Index} [options.pineconeIndex] - Pre-initialized Pinecone index
 * @param {boolean}      [options.dryRun=false]   - If true, skip the actual upsert
 * @param {Function|object[]|{notices: object[], attempted: number, failed: number, errors: string[]}} [options.crawl]
 *   Injectable crawler (function) or crawl result. Defaults to crawlAllSources.
 * @returns {Promise<{success: boolean, noticesFound: number, chunksProcessed: number, vectorsUpserted: number, errors: string[]}>}
 */
async function syncNotices(options = {}) {
  const startTime = Date.now();
  const errors = [];

  console.log('\n' + '='.repeat(60));
  console.log('[NoticeCrawler] Starting Notice Sync Pipeline (RAG 2.0)');
  console.log('='.repeat(60));

  // --- Step 1: Crawl ---
  let crawlResult;
  try {
    const crawl = options.crawl ?? crawlAllSources;
    const rawResult = typeof crawl === 'function' ? await crawl() : crawl;
    crawlResult = normalizeCrawlResult(rawResult);
  } catch (err) {
    errors.push(`Crawl failed: ${err.message}`);
    return { success: false, noticesFound: 0, chunksProcessed: 0, vectorsUpserted: 0, errors };
  }

  let rawNotices = crawlResult.notices;
  errors.push(...crawlResult.errors);

  // A total outage is not a successful "0 notices" sync. Partial failures are
  // allowed to continue so healthy sources still get ingested.
  if (crawlResult.attempted > 0 && crawlResult.failed === crawlResult.attempted) {
    const message = `All ${crawlResult.attempted} notice sources failed`;
    errors.push(message);
    console.error(`[NoticeCrawler] ${message}`);
    return {
      success: false,
      noticesFound: rawNotices.length,
      chunksProcessed: 0,
      vectorsUpserted: 0,
      errors,
    };
  }

  if (rawNotices.length === 0) {
    console.log('[NoticeCrawler] No notices found. Sync complete (nothing to ingest).');
    return { success: true, noticesFound: 0, chunksProcessed: 0, vectorsUpserted: 0, errors };
  }

  // --- Initialize clients (or use provided ones) ---
  let ai = options.ai;
  let pineconeIndex = options.pineconeIndex;

  if (!ai) {
    const geminiKey = (process.env.GEMINI_API_KEY || '').trim();
    if (!geminiKey) {
      errors.push('GEMINI_API_KEY not configured');
      return { success: false, noticesFound: rawNotices.length, chunksProcessed: 0, vectorsUpserted: 0, errors };
    }
    ai = new GoogleGenAI({ apiKey: geminiKey });
  }

  if (!pineconeIndex) {
    const pineconeKey = (process.env.PINECONE_API_KEY || '').trim();
    const indexName = (process.env.PINECONE_INDEX_NAME || '').trim();
    if (!pineconeKey || !indexName) {
      errors.push('PINECONE_API_KEY or PINECONE_INDEX_NAME not configured');
      return { success: false, noticesFound: rawNotices.length, chunksProcessed: 0, vectorsUpserted: 0, errors };
    }
    const pc = new Pinecone({ apiKey: pineconeKey });
    pineconeIndex = pc.index(indexName);
  }

  // --- Step 1.5: Enrich with PDF Circular Content ---
  if (ENABLE_PDF_EXTRACTION) {
    try {
      rawNotices = await enrichNoticesWithPdfContent(rawNotices, {
        concurrency: PDF_CONCURRENCY,
        delayMs: 200,
      });
    } catch (pdfErr) {
      console.warn(`[NoticeCrawler] PDF enrichment warning: ${pdfErr.message}`);
    }
  }

  // --- Step 2: Deduplicate & Chunk ---
  const chunks = [];
  const noticeRecords = [];
  const seenThisRun = new Set();

  for (const notice of rawNotices) {
    const hash = noticeContentHash(notice);
    if (processedHashes.has(hash) || seenThisRun.has(hash)) {
      continue;
    }
    // Mark only in `seenThisRun`; the module-level set is updated after a
    // fully successful upsert so failures are retried on the next run.
    seenThisRun.add(hash);

    let fullText;
    if (notice.pdfExtracted && notice.pdfText) {
      fullText = `Notice: ${notice.title} (${notice.college}). Category: ${notice.category}. Published: ${notice.publishedAt || 'Recent'}.\n\nCircular Details:\n${notice.pdfText}`.trim();
    } else {
      fullText = `${notice.title}. ${notice.text || ''}`.trim();
    }

    let textChunks = chunkText(fullText);
    if (textChunks.length > MAX_CHUNKS_PER_NOTICE) {
      textChunks = textChunks.slice(0, MAX_CHUNKS_PER_NOTICE);
    }
    if (textChunks.length === 0) continue;

    const record = { hash, chunks: [] };

    for (let chunkIdx = 0; chunkIdx < textChunks.length; chunkIdx++) {
      const chunk = {
        id: buildChunkId(notice, chunkIdx),
        text: textChunks[chunkIdx],
        embedded: false,
        metadata: {
          title: notice.title.slice(0, 200),
          url: notice.url,
          category: notice.category,
          college: notice.college,
          publishedAt: notice.publishedAt || new Date().toISOString().split('T')[0],
          text: textChunks[chunkIdx],
          documentName: notice.title.slice(0, 100),
          source: notice.url,
          chunkIndex: chunkIdx,
          totalChunks: textChunks.length,
          hasPdfContent: Boolean(notice.pdfExtracted),
          ingestedAt: new Date().toISOString(),
        },
      };
      record.chunks.push(chunk);
      chunks.push(chunk);
    }

    noticeRecords.push(record);
  }

  const pdfEnrichedCount = rawNotices.filter((n) => n.pdfExtracted).length;
  console.log(`[NoticeCrawler] Deduplicated: ${rawNotices.length} notices (${pdfEnrichedCount} with full PDF circular text) → ${chunks.length} chunks`);

  if (chunks.length === 0) {
    console.log('[NoticeCrawler] All notices were previously processed. Nothing new to ingest.');
    return {
      success: true,
      noticesFound: rawNotices.length,
      pdfNoticesEnriched: pdfEnrichedCount,
      chunksProcessed: 0,
      vectorsUpserted: 0,
      errors,
    };
  }

  // --- Step 3: Generate Embeddings ---
  console.log(`[NoticeCrawler] Generating embeddings for ${chunks.length} chunks...`);
  let embeddings;
  try {
    embeddings = await generateEmbeddings(ai, chunks.map((c) => c.text));
  } catch (err) {
    errors.push(`Embedding generation failed: ${err.message}`);
    return {
      success: false,
      noticesFound: rawNotices.length,
      pdfNoticesEnriched: pdfEnrichedCount,
      chunksProcessed: chunks.length,
      vectorsUpserted: 0,
      errors,
    };
  }

  // --- Step 4: Prepare vectors ---
  const vectors = [];
  for (let i = 0; i < chunks.length; i++) {
    if (embeddings[i] && Array.isArray(embeddings[i]) && embeddings[i].length === EMBEDDING_DIMENSIONS) {
      chunks[i].embedded = true;
      vectors.push({
        id: chunks[i].id,
        values: embeddings[i],
        metadata: chunks[i].metadata,
      });
    } else {
      errors.push(`Skipped chunk "${chunks[i].id}": invalid embedding`);
    }
  }

  const embeddingFailureCount = chunks.length - vectors.length;
  console.log(`[NoticeCrawler] Valid vectors: ${vectors.length}/${chunks.length}`);

  if (vectors.length === 0) {
    if (options.dryRun) {
      console.log(`[NoticeCrawler] DRY RUN: Generated ${chunks.length} chunks from ${rawNotices.length} notices (${pdfEnrichedCount} circular PDFs enriched with text).`);
      return {
        success: true,
        noticesFound: rawNotices.length,
        pdfNoticesEnriched: pdfEnrichedCount,
        chunksProcessed: chunks.length,
        vectorsUpserted: 0,
        errors,
        dryRun: true,
      };
    }
    return {
      success: false,
      noticesFound: rawNotices.length,
      pdfNoticesEnriched: pdfEnrichedCount,
      chunksProcessed: chunks.length,
      vectorsUpserted: 0,
      errors,
    };
  }

  // --- Step 5: Upsert to Pinecone ---
  if (options.dryRun) {
    console.log(`[NoticeCrawler] DRY RUN: Would upsert ${vectors.length} vectors to namespace '${NOTICES_NAMESPACE}'`);
    return {
      success: true,
      noticesFound: rawNotices.length,
      pdfNoticesEnriched: pdfEnrichedCount,
      chunksProcessed: chunks.length,
      vectorsUpserted: 0,
      errors,
      dryRun: true,
    };
  }

  let upsertResult;
  try {
    upsertResult = await upsertToNoticesNamespace(pineconeIndex, vectors);
  } catch (err) {
    errors.push(`Upsert failed: ${err.message}`);
    return {
      success: false,
      noticesFound: rawNotices.length,
      pdfNoticesEnriched: pdfEnrichedCount,
      chunksProcessed: chunks.length,
      vectorsUpserted: 0,
      errors,
    };
  }

  errors.push(...upsertResult.errors);

  // Success-based dedupe: a notice is remembered only when every one of its
  // chunks embedded AND landed in a successful Pinecone batch. Partial
  // failures therefore leave the notice eligible for retry.
  let markedCount = 0;
  for (const record of noticeRecords) {
    const allEmbedded = record.chunks.every((chunk) => chunk.embedded === true);
    const allUpserted = record.chunks.every((chunk) => upsertResult.upsertedIds.has(chunk.id));
    if (allEmbedded && allUpserted) {
      processedHashes.add(record.hash);
      markedCount += 1;
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('='.repeat(60));
  console.log(`[NoticeCrawler] Sync complete in ${elapsed}s`);
  console.log(`  Notices found:      ${rawNotices.length}`);
  console.log(`  PDFs enriched:      ${pdfEnrichedCount}`);
  console.log(`  Chunks processed:   ${chunks.length}`);
  console.log(`  Vectors upserted:   ${upsertResult.upsertedCount}`);
  console.log(`  Notices marked:     ${markedCount}`);
  if (errors.length > 0) {
    console.log(`  Warnings:           ${errors.length}`);
  }
  console.log('='.repeat(60) + '\n');

  return {
    success: upsertResult.failedBatches === 0 && embeddingFailureCount === 0,
    noticesFound: rawNotices.length,
    pdfNoticesEnriched: pdfEnrichedCount,
    chunksProcessed: chunks.length,
    vectorsUpserted: upsertResult.upsertedCount,
    failedBatches: upsertResult.failedBatches,
    errors,
  };
}

// ---------------------------------------------------------------------------
// CLI Entry Point
// ---------------------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  syncNotices({ dryRun })
    .then((result) => {
      console.log('\nSync Result:', JSON.stringify(result, null, 2));
      process.exit(result.success ? 0 : 1);
    })
    .catch((err) => {
      console.error('Fatal sync error:', err);
      process.exit(1);
    });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  syncNotices,
  crawlAllSources,
  chunkText,
  contentHash,
  categorize,
  enrichNoticesWithPdfContent,
  NOTICES_NAMESPACE,
  // Exposed for deterministic-ID / dedupe regression tests.
  canonicalizeUrl,
  shortUrlHash,
  buildChunkId,
  noticeContentHash,
  normalizeCrawlResult,
  upsertToNoticesNamespace,
  resetProcessedHashes,
};
