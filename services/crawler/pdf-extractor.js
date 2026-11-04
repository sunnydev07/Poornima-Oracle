/**
 * ============================================================================
 * Poornima Oracle — PDF Circular Content Extractor (RAG 2.0 Tier 1)
 * ============================================================================
 *
 * Automatically downloads and extracts text from linked circular PDFs
 * (Google Drive files, Google Docs text exports, direct PDF URLs) discovered
 * during the notice crawl. Extracted text is cleaned, structured, and chunked
 * for rich vector embedding in Pinecone.
 *
 * @module services/crawler/pdf-extractor
 */

const { PDFParse } = require('pdf-parse');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MAX_PDF_BYTES = 15 * 1024 * 1024; // 15 MB download limit
const PDF_FETCH_TIMEOUT_MS = 15_000;    // 15s timeout per PDF fetch
const MAX_PAGES_PER_PDF = 15;           // Limit parsing to first 15 pages of circulars
const MIN_MEANINGFUL_TEXT_CHARS = 40;   // Ignore scanned/blank documents with < 40 chars
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

// In-memory cache per run to prevent redundant downloads of the same PDF
const pdfExtractCache = new Map();

// ---------------------------------------------------------------------------
// URL Detection & ID Extraction
// ---------------------------------------------------------------------------

/**
 * Determine if a URL is likely to point to a PDF or Google Drive/Docs document.
 *
 * @param {string} url - Target URL to inspect
 * @returns {boolean}
 */
function isPdfOrDriveUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();

  // Rejection filter for common non-PDF domains
  if (
    trimmed.includes('calendar.google.com') ||
    trimmed.includes('facebook.com') ||
    trimmed.includes('instagram.com') ||
    trimmed.includes('twitter.com') ||
    trimmed.includes('youtube.com') ||
    trimmed.startsWith('mailto:') ||
    trimmed.startsWith('tel:') ||
    trimmed.startsWith('#')
  ) {
    return false;
  }

  // Google Drive file or Google Doc
  if (
    trimmed.includes('drive.google.com') ||
    trimmed.includes('docs.google.com')
  ) {
    return (
      trimmed.includes('/file/d/') ||
      trimmed.includes('/document/d/') ||
      trimmed.includes('/open?') ||
      trimmed.includes('/uc?') ||
      trimmed.includes('id=')
    );
  }

  // Direct PDF URL (ends in .pdf or has .pdf in the path)
  try {
    const parsed = new URL(trimmed);
    const pathname = parsed.pathname.toLowerCase();
    return pathname.endsWith('.pdf') || pathname.includes('.pdf');
  } catch {
    return trimmed.toLowerCase().includes('.pdf');
  }
}

/**
 * Extract Google Drive file ID from standard share/view URLs.
 *
 * @param {string} url - Google Drive URL
 * @returns {string|null} - Extracted file ID or null
 */
function extractGoogleDriveId(url) {
  if (!url || typeof url !== 'string') return null;

  // /file/d/<ID>/view
  const fileMatch = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (fileMatch && fileMatch[1]) return fileMatch[1];

  // /document/d/<ID>/edit
  const docMatch = url.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (docMatch && docMatch[1]) return docMatch[1];

  // ?id=<ID> or &id=<ID>
  const queryMatch = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (queryMatch && queryMatch[1]) return queryMatch[1];

  return null;
}

/**
 * Build candidate direct download URLs for a given URL.
 *
 * @param {string} url - Original URL
 * @returns {string[]} - List of candidate download URLs in priority order
 */
function getDownloadUrls(url) {
  if (!url || typeof url !== 'string') return [];
  const driveId = extractGoogleDriveId(url);

  if (driveId) {
    const candidates = [
      `https://drive.usercontent.google.com/download?id=${driveId}&export=download&confirm=t`,
      `https://drive.google.com/uc?export=download&id=${driveId}&confirm=t`,
    ];

    // If it's a Google Doc document, text export is also available
    if (url.includes('/document/d/')) {
      candidates.unshift(`https://docs.google.com/document/d/${driveId}/export?format=txt`);
    }

    return candidates;
  }

  return [url];
}

// ---------------------------------------------------------------------------
// Text Cleaning
// ---------------------------------------------------------------------------

/**
 * Clean and normalize extracted PDF text.
 * Strips page artifacts (e.g. "-- 1 of 5 --"), collapses excessive whitespace,
 * and removes non-printable characters.
 *
 * @param {string} rawText - Raw text extracted from PDF
 * @returns {string} - Cleaned text
 */
function cleanPdfText(rawText) {
  if (!rawText || typeof rawText !== 'string') return '';

  return rawText
    // Remove page markers like "-- 1 of 5 --", "Page 1 of 4", etc.
    .replace(/--\s*\d+\s*of\s*\d+\s*--/gi, ' ')
    .replace(/\bPage\s+\d+\s+(of\s+\d+)?\b/gi, ' ')
    // Replace non-printable characters
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    // Normalize line breaks
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // Collapse 3+ consecutive newlines into 2
    .replace(/\n{3,}/g, '\n\n')
    // Collapse horizontal spaces and tabs on the same line
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// PDF Fetch & Parse Core
// ---------------------------------------------------------------------------

/**
 * Fetch a buffer with timeout and size limit enforcement.
 *
 * @param {string} downloadUrl - Direct download URL
 * @param {number} [timeoutMs] - Timeout in milliseconds
 * @returns {Promise<Buffer|null>}
 */
async function fetchBufferWithTimeout(downloadUrl, timeoutMs = PDF_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(downloadUrl, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/pdf,text/plain,application/octet-stream,*/*',
      },
      redirect: 'follow',
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }

    // Check Content-Length header if provided
    const contentLength = Number.parseInt(response.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_PDF_BYTES) {
      console.warn(`[PDFExtractor] Skipped ${downloadUrl}: size (${contentLength} bytes) exceeds limit (${MAX_PDF_BYTES})`);
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (buffer.length > MAX_PDF_BYTES) {
      console.warn(`[PDFExtractor] Skipped: downloaded ${buffer.length} bytes exceeds limit`);
      return null;
    }

    return buffer;
  } catch (err) {
    if (err.name !== 'AbortError') {
      // Quietly ignore transient network fetch errors; caller will try fallback
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Parse a PDF buffer using pdf-parse and return extracted text.
 *
 * @param {Buffer} buffer - Raw PDF buffer
 * @param {number} [maxPages] - Maximum pages to parse
 * @returns {Promise<{success: boolean, text: string, charCount: number, error?: string}>}
 */
async function parsePdfBuffer(buffer, maxPages = MAX_PAGES_PER_PDF) {
  if (!buffer || !Buffer.isBuffer(buffer)) {
    return { success: false, text: '', charCount: 0, error: 'Invalid buffer' };
  }

  // Check if buffer is plain text (e.g. from Google Docs txt export)
  const headerPreview = buffer.slice(0, 10).toString('utf8');
  if (!headerPreview.includes('%PDF')) {
    const textPreview = buffer.toString('utf8');
    const cleaned = cleanPdfText(textPreview);
    if (cleaned.length >= MIN_MEANINGFUL_TEXT_CHARS) {
      return { success: true, text: cleaned, charCount: cleaned.length };
    }
    return { success: false, text: '', charCount: 0, error: 'Not a PDF or text file' };
  }

  let parser = null;
  try {
    parser = new PDFParse({ data: buffer });
    const result = await parser.getText({ first: maxPages });
    const rawText = result?.text || '';
    const cleaned = cleanPdfText(rawText);

    // Verify whether actual textual content was extracted (vs. scanned blank photocopy)
    const alphanumericCount = (cleaned.match(/[a-zA-Z0-9]/g) || []).length;
    if (alphanumericCount < MIN_MEANINGFUL_TEXT_CHARS) {
      return {
        success: false,
        text: '',
        charCount: 0,
        error: 'Insufficient text (likely a scanned image without OCR)',
      };
    }

    return {
      success: true,
      text: cleaned,
      charCount: cleaned.length,
      pagesParsed: result?.total || 1,
    };
  } catch (err) {
    return {
      success: false,
      text: '',
      charCount: 0,
      error: err?.message || 'PDF parse error',
    };
  } finally {
    if (parser && typeof parser.destroy === 'function') {
      try {
        await parser.destroy();
      } catch {
        // ignore destroy error
      }
    }
  }
}

/**
 * Download and extract text from a notice URL.
 * Automatically handles Google Drive view links, direct PDF URLs, caching,
 * timeouts, and fallback endpoints.
 *
 * @param {string} url - Notice URL
 * @param {object} [options]
 * @param {number} [options.maxPages=MAX_PAGES_PER_PDF] - Page limit
 * @returns {Promise<{success: boolean, text: string, charCount: number, sourceUrl: string, error?: string}>}
 */
async function extractNoticePdfText(url, options = {}) {
  if (!url || typeof url !== 'string') {
    return { success: false, text: '', charCount: 0, sourceUrl: url, error: 'Missing URL' };
  }

  const trimmedUrl = url.trim();

  // Check cache first
  if (pdfExtractCache.has(trimmedUrl)) {
    return pdfExtractCache.get(trimmedUrl);
  }

  if (!isPdfOrDriveUrl(trimmedUrl)) {
    const result = { success: false, text: '', charCount: 0, sourceUrl: trimmedUrl, error: 'Not a PDF or Drive URL' };
    pdfExtractCache.set(trimmedUrl, result);
    return result;
  }

  const downloadUrls = getDownloadUrls(trimmedUrl);
  const maxPages = options.maxPages || MAX_PAGES_PER_PDF;

  for (const dlUrl of downloadUrls) {
    try {
      const buffer = await fetchBufferWithTimeout(dlUrl);
      if (!buffer) continue;

      const parseResult = await parsePdfBuffer(buffer, maxPages);
      if (parseResult.success) {
        const finalResult = {
          success: true,
          text: parseResult.text,
          charCount: parseResult.charCount,
          pagesParsed: parseResult.pagesParsed,
          sourceUrl: trimmedUrl,
        };
        pdfExtractCache.set(trimmedUrl, finalResult);
        return finalResult;
      }
    } catch {
      // Try next candidate URL
    }
  }

  const failedResult = {
    success: false,
    text: '',
    charCount: 0,
    sourceUrl: trimmedUrl,
    error: 'Failed to download or parse PDF content',
  };
  pdfExtractCache.set(trimmedUrl, failedResult);
  return failedResult;
}

/**
 * Enrich a list of crawled notices with extracted PDF content.
 * Processes notices with concurrency control and courtesy rate limiting.
 *
 * @param {Array<object>} notices - Array of scraped notices
 * @param {object} [options]
 * @param {number} [options.concurrency=2] - Parallel download concurrency
 * @param {number} [options.delayMs=150]   - Delay between batches
 * @returns {Promise<Array<object>>} - Notices with `pdfExtracted`, `pdfText`, and enriched `text`
 */
async function enrichNoticesWithPdfContent(notices, options = {}) {
  if (!Array.isArray(notices) || notices.length === 0) {
    return notices || [];
  }

  const concurrency = options.concurrency || 2;
  const delayMs = options.delayMs || 150;
  let enrichedCount = 0;
  let skippedCount = 0;

  console.log(`[PDFExtractor] Starting PDF content enrichment for ${notices.length} notices (concurrency=${concurrency})...`);

  for (let i = 0; i < notices.length; i += concurrency) {
    const batch = notices.slice(i, i + concurrency);

    await Promise.all(
      batch.map(async (notice) => {
        if (!notice || !notice.url || !isPdfOrDriveUrl(notice.url)) {
          if (notice) notice.pdfExtracted = false;
          skippedCount++;
          return;
        }

        try {
          const result = await extractNoticePdfText(notice.url, options);
          if (result.success && result.text) {
            notice.pdfExtracted = true;
            notice.pdfText = result.text;
            notice.pdfCharCount = result.charCount;

            // Combine title, metadata, and extracted PDF circular content
            notice.text = [
              notice.title,
              notice.college ? `College: ${notice.college}` : '',
              notice.publishedAt ? `Published: ${notice.publishedAt}` : '',
              '\n--- Circular Content ---',
              result.text,
            ]
              .filter(Boolean)
              .join('\n');

            enrichedCount++;
            console.log(`[PDFExtractor] ✓ Extracted ${result.charCount} chars for: "${notice.title.slice(0, 60)}"`);
          } else {
            notice.pdfExtracted = false;
            // Keep original text
          }
        } catch (err) {
          notice.pdfExtracted = false;
          console.warn(`[PDFExtractor] ⚠ Failed to extract PDF for "${notice.title.slice(0, 50)}": ${err.message}`);
        }
      })
    );

    if (i + concurrency < notices.length && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  console.log(`[PDFExtractor] Finished: ${enrichedCount} circular PDFs extracted, ${skippedCount} non-PDF notices skipped.`);
  return notices;
}

/**
 * Clear the in-memory PDF extraction cache.
 */
function clearPdfCache() {
  pdfExtractCache.clear();
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  isPdfOrDriveUrl,
  extractGoogleDriveId,
  getDownloadUrls,
  cleanPdfText,
  parsePdfBuffer,
  extractNoticePdfText,
  enrichNoticesWithPdfContent,
  clearPdfCache,
  MAX_PDF_BYTES,
  PDF_FETCH_TIMEOUT_MS,
  MAX_PAGES_PER_PDF,
};
