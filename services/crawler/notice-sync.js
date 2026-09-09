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
// In-memory deduplication cache (persisted per-run; could be file-backed)
// ---------------------------------------------------------------------------

/** @type {Set<string>} SHA-256 hashes of previously processed content */
const processedHashes = new Set();

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
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
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
      const lastSentenceBreak = text.lastIndexOf('. ', end);
      const lastNewline = text.lastIndexOf('\n', end);
      const lastSpace = text.lastIndexOf(' ', end);

      if (lastSentenceBreak > start + maxChars * 0.5) {
        end = lastSentenceBreak + 1;
      } else if (lastNewline > start + maxChars * 0.5) {
        end = lastNewline;
      } else if (lastSpace > start + maxChars * 0.5) {
        end = lastSpace;
      }
    }

    const chunk = text.slice(start, end).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }

    start = end - overlap;
    if (start >= text.length) break;
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
 * Returns structured notice objects.
 */
async function crawlPUFirestore() {
  const allNotices = [];
  const collections = [
    { endpoint: PU_FIRESTORE_ENDPOINTS.notices, type: 'notice' },
    { endpoint: PU_FIRESTORE_ENDPOINTS.calendars, type: 'calendar' },
    { endpoint: PU_FIRESTORE_ENDPOINTS.news, type: 'news' },
  ];

  for (const { endpoint, type } of collections) {
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
        console.warn(`[NoticeCrawler] PU Firestore ${type} returned HTTP ${response.status}`);
        continue;
      }

      const data = await response.json();
      const documents = data.documents || [];

      for (const doc of documents) {
        if (allNotices.length >= MAX_NOTICES_PER_SOURCE) break;

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

        allNotices.push({
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
      if (err.name === 'AbortError') {
        console.warn(`[NoticeCrawler] PU Firestore ${type} timed out`);
      } else {
        console.warn(`[NoticeCrawler] PU Firestore ${type} error: ${err.message}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  return allNotices;
}

// ---------------------------------------------------------------------------
// Source 2: PCE/PIET — Cheerio HTML Crawler
// ---------------------------------------------------------------------------

/**
 * Crawl poornima.org/updates/ using Cheerio on server-rendered HTML.
 * Uses the exact CSS selectors discovered from the SSR page structure.
 */
async function crawlPCEUpdatesPage(url, college) {
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
      console.warn(`[NoticeCrawler] HTTP ${response.status} from ${url}`);
      return [];
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
    return notices;
  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn(`[NoticeCrawler] Timeout crawling ${url}`);
    } else {
      console.warn(`[NoticeCrawler] Error crawling ${url}: ${err.message}`);
    }
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Combined Crawler
// ---------------------------------------------------------------------------

/**
 * Crawl all configured sources (PU Firestore API + PCE/PIET HTML).
 */
async function crawlAllSources() {
  const allNotices = [];
  const seenKeys = new Set();

  // Source 1: PU via Firestore REST API
  try {
    const puNotices = await crawlPUFirestore();
    for (const notice of puNotices) {
      const key = (notice.title + notice.url).toLowerCase();
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        allNotices.push(notice);
      }
    }
  } catch (err) {
    console.warn(`[NoticeCrawler] PU Firestore crawl failed: ${err.message}`);
  }

  // Source 2: PCE/PIET via Cheerio HTML
  for (const source of PCE_HTML_SOURCES) {
    try {
      const notices = await crawlPCEUpdatesPage(source.url, source.college);
      for (const notice of notices) {
        const key = (notice.title + notice.url).toLowerCase();
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          allNotices.push(notice);
        }
      }
    } catch (err) {
      console.warn(`[NoticeCrawler] ${source.name} crawl failed: ${err.message}`);
    }
  }

  console.log(`[NoticeCrawler] Total raw notices scraped: ${allNotices.length}`);
  return allNotices;
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
 * @param {import('@pinecone-database/pinecone').Index} index  - Pinecone index handle
 * @param {Array<{id: string, values: number[], metadata: object}>} vectors - Prepared vectors
 * @returns {Promise<{upsertedCount: number}>}
 */
async function upsertToNoticesNamespace(index, vectors) {
  let totalUpserted = 0;

  for (let i = 0; i < vectors.length; i += UPSERT_BATCH_SIZE) {
    const batch = vectors.slice(i, i + UPSERT_BATCH_SIZE);

    try {
      await index.upsert({
        records: batch,
        namespace: NOTICES_NAMESPACE,
      });
      totalUpserted += batch.length;
      console.log(`[NoticeCrawler] Upserted batch ${Math.floor(i / UPSERT_BATCH_SIZE) + 1}: ${batch.length} vectors`);
    } catch (err) {
      console.error(`[NoticeCrawler] Upsert batch failed: ${err.message}`);
    }
  }

  return { upsertedCount: totalUpserted };
}

// ---------------------------------------------------------------------------
// Main Sync Pipeline
// ---------------------------------------------------------------------------

/**
 * Full notice synchronization pipeline.
 *
 * 1. Crawl PU (Firestore API) + PCE/PIET (Cheerio HTML)
 * 2. Deduplicate by content hash
 * 3. Chunk text into embeddable segments
 * 4. Generate Gemini embeddings
 * 5. Upsert into Pinecone `notices` namespace
 *
 * @param {object} [options]
 * @param {GoogleGenAI}  [options.ai]             - Pre-initialized AI client
 * @param {import('@pinecone-database/pinecone').Index} [options.pineconeIndex] - Pre-initialized Pinecone index
 * @param {boolean}      [options.dryRun=false]   - If true, skip the actual upsert
 * @returns {Promise<{success: boolean, noticesFound: number, chunksProcessed: number, vectorsUpserted: number, errors: string[]}>}
 */
async function syncNotices(options = {}) {
  const startTime = Date.now();
  const errors = [];

  console.log('\n' + '='.repeat(60));
  console.log('[NoticeCrawler] Starting Notice Sync Pipeline (RAG 2.0)');
  console.log('='.repeat(60));

  // --- Initialize clients (or use provided ones) ---
  let ai = options.ai;
  let pineconeIndex = options.pineconeIndex;

  if (!ai) {
    const geminiKey = (process.env.GEMINI_API_KEY || '').trim();
    if (!geminiKey) {
      return { success: false, noticesFound: 0, chunksProcessed: 0, vectorsUpserted: 0, errors: ['GEMINI_API_KEY not configured'] };
    }
    ai = new GoogleGenAI({ apiKey: geminiKey });
  }

  if (!pineconeIndex) {
    const pineconeKey = (process.env.PINECONE_API_KEY || '').trim();
    const indexName = (process.env.PINECONE_INDEX_NAME || '').trim();
    if (!pineconeKey || !indexName) {
      return { success: false, noticesFound: 0, chunksProcessed: 0, vectorsUpserted: 0, errors: ['PINECONE_API_KEY or PINECONE_INDEX_NAME not configured'] };
    }
    const pc = new Pinecone({ apiKey: pineconeKey });
    pineconeIndex = pc.index(indexName);
  }

  // --- Step 1: Crawl ---
  let rawNotices;
  try {
    rawNotices = await crawlAllSources();
  } catch (err) {
    errors.push(`Crawl failed: ${err.message}`);
    return { success: false, noticesFound: 0, chunksProcessed: 0, vectorsUpserted: 0, errors };
  }

  if (rawNotices.length === 0) {
    console.log('[NoticeCrawler] No notices found. Sync complete (nothing to ingest).');
    return { success: true, noticesFound: 0, chunksProcessed: 0, vectorsUpserted: 0, errors };
  }

  // --- Step 2: Deduplicate & Chunk ---
  const chunks = [];

  for (const notice of rawNotices) {
    const hash = contentHash(notice.title + notice.url);
    if (processedHashes.has(hash)) {
      continue;
    }
    processedHashes.add(hash);

    const fullText = `${notice.title}. ${notice.text || ''}`.trim();
    const textChunks = chunkText(fullText);

    for (let chunkIdx = 0; chunkIdx < textChunks.length; chunkIdx++) {
      const chunkId = `notice-${notice.college.toLowerCase()}-${slugify(notice.title)}-c${chunkIdx}`;
      chunks.push({
        id: chunkId,
        text: textChunks[chunkIdx],
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
          ingestedAt: new Date().toISOString(),
        },
      });
    }
  }

  console.log(`[NoticeCrawler] Deduplicated: ${rawNotices.length} notices → ${chunks.length} chunks`);

  if (chunks.length === 0) {
    console.log('[NoticeCrawler] All notices were previously processed. Nothing new to ingest.');
    return { success: true, noticesFound: rawNotices.length, chunksProcessed: 0, vectorsUpserted: 0, errors };
  }

  // --- Step 3: Generate Embeddings ---
  console.log(`[NoticeCrawler] Generating embeddings for ${chunks.length} chunks...`);
  let embeddings;
  try {
    embeddings = await generateEmbeddings(ai, chunks.map((c) => c.text));
  } catch (err) {
    errors.push(`Embedding generation failed: ${err.message}`);
    return { success: false, noticesFound: rawNotices.length, chunksProcessed: chunks.length, vectorsUpserted: 0, errors };
  }

  // --- Step 4: Prepare vectors ---
  const vectors = [];
  for (let i = 0; i < chunks.length; i++) {
    if (embeddings[i] && Array.isArray(embeddings[i]) && embeddings[i].length === EMBEDDING_DIMENSIONS) {
      vectors.push({
        id: chunks[i].id,
        values: embeddings[i],
        metadata: chunks[i].metadata,
      });
    } else {
      errors.push(`Skipped chunk "${chunks[i].id}": invalid embedding`);
    }
  }

  console.log(`[NoticeCrawler] Valid vectors: ${vectors.length}/${chunks.length}`);

  if (vectors.length === 0) {
    return { success: false, noticesFound: rawNotices.length, chunksProcessed: chunks.length, vectorsUpserted: 0, errors };
  }

  // --- Step 5: Upsert to Pinecone ---
  if (options.dryRun) {
    console.log(`[NoticeCrawler] DRY RUN: Would upsert ${vectors.length} vectors to namespace '${NOTICES_NAMESPACE}'`);
    return { success: true, noticesFound: rawNotices.length, chunksProcessed: chunks.length, vectorsUpserted: 0, errors, dryRun: true };
  }

  let upsertResult;
  try {
    upsertResult = await upsertToNoticesNamespace(pineconeIndex, vectors);
  } catch (err) {
    errors.push(`Upsert failed: ${err.message}`);
    return { success: false, noticesFound: rawNotices.length, chunksProcessed: chunks.length, vectorsUpserted: 0, errors };
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('='.repeat(60));
  console.log(`[NoticeCrawler] Sync complete in ${elapsed}s`);
  console.log(`  Notices found:    ${rawNotices.length}`);
  console.log(`  Chunks processed: ${chunks.length}`);
  console.log(`  Vectors upserted: ${upsertResult.upsertedCount}`);
  if (errors.length > 0) {
    console.log(`  Warnings:         ${errors.length}`);
  }
  console.log('='.repeat(60) + '\n');

  return {
    success: true,
    noticesFound: rawNotices.length,
    chunksProcessed: chunks.length,
    vectorsUpserted: upsertResult.upsertedCount,
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
  NOTICES_NAMESPACE,
};
