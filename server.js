require('dotenv').config();

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const compression = require('compression');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const xss = require('xss');
const NodeCache = require('node-cache');
const { GoogleGenAI } = require('@google/genai');
const { Pinecone } = require('@pinecone-database/pinecone');

const app = express();
const PORT = Number(process.env.PORT) || 3001;
const DEFAULT_CORS_ORIGIN = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean)
  : undefined;

const requiredEnvVars = ['GEMINI_API_KEY', 'PINECONE_API_KEY', 'PINECONE_INDEX_NAME'];
const missingEnvVars = requiredEnvVars.filter(
  (envVar) => !process.env[envVar] || !process.env[envVar].trim()
);

const geminiApiKey = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.trim() : '';
const pineconeApiKey = process.env.PINECONE_API_KEY ? process.env.PINECONE_API_KEY.trim() : '';
const pineconeIndexName = process.env.PINECONE_INDEX_NAME ? process.env.PINECONE_INDEX_NAME.trim() : '';
const embeddingModel = process.env.GEMINI_EMBEDDING_MODEL
  ? process.env.GEMINI_EMBEDDING_MODEL.trim()
  : 'gemini-embedding-001';

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, min), max);
}

function parseBoundedNumber(value, fallback, min, max) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, min), max);
}

const CHAT_RATE_LIMIT_WINDOW_MS = parsePositiveInteger(
  process.env.RATE_LIMIT_WINDOW_MS,
  15 * 60 * 1000
);
const CHAT_RATE_LIMIT_MAX = parsePositiveInteger(process.env.CHAT_RATE_LIMIT_MAX, 20);
const RAG_TOP_K = parseBoundedInteger(process.env.RAG_TOP_K, 6, 1, 8);
const RAG_MIN_SCORE = parseBoundedNumber(process.env.RAG_MIN_SCORE, 0.35, 0, 1);
const RAG_REQUEST_TIMEOUT_MS = parsePositiveInteger(process.env.RAG_REQUEST_TIMEOUT_MS, 15000);
const RAG_REQUEST_RETRIES = parseBoundedInteger(process.env.RAG_REQUEST_RETRIES, 2, 0, 5);
// Pinecone treats 0 as "use default retries"; -1 forces a single attempt.
const PINECONE_MAX_RETRIES = RAG_REQUEST_RETRIES > 0 ? RAG_REQUEST_RETRIES : -1;

const ai = geminiApiKey ? new GoogleGenAI({ apiKey: geminiApiKey }) : null;
const pinecone = pineconeApiKey
  ? new Pinecone({
      apiKey: pineconeApiKey,
      fetchApi: createTimeoutFetch(RAG_REQUEST_TIMEOUT_MS),
      maxRetries: PINECONE_MAX_RETRIES,
    })
  : null;
const pineconeIndex = pinecone && pineconeIndexName ? pinecone.index(pineconeIndexName) : null;
const queryCacheTtlSeconds = Number.parseInt(process.env.QUERY_CACHE_TTL_SECONDS, 10);
const queryCache = new NodeCache({
  stdTTL: Number.isFinite(queryCacheTtlSeconds) && queryCacheTtlSeconds > 0
    ? queryCacheTtlSeconds
    : 3600,
  checkperiod: 120,
  useClones: false,
});

function createTimeoutFetch(timeoutMs) {
  return async (url, init = {}) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();

    if (init.signal) {
      if (init.signal.aborted) {
        controller.abort(init.signal.reason);
      } else {
        init.signal.addEventListener(
          'abort',
          () => controller.abort(init.signal.reason),
          { once: true }
        );
      }
    }

    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  };
}

function validateApiKeyFormat(key, name, minLength) {
  if (!key) return { valid: false, reason: 'not set or empty' };
  if (key.length < minLength) return { valid: false, reason: `too short (${key.length} chars, expected at least ${minLength})` };
  const validPattern = /^[A-Za-z0-9_-]+$/;
  if (!validPattern.test(key)) return { valid: false, reason: 'contains invalid characters (only alphanumeric, underscore, and hyphen allowed)' };
  return { valid: true };
}

function validateApiKeysAtStartup() {
  const issues = [];

  const geminiValidation = validateApiKeyFormat(geminiApiKey, 'GEMINI_API_KEY', 20);
  if (!geminiValidation.valid) {
    issues.push(`GEMINI_API_KEY is ${geminiValidation.reason}`);
  }

  const pineconeValidation = validateApiKeyFormat(pineconeApiKey, 'PINECONE_API_KEY', 20);
  if (!pineconeValidation.valid) {
    issues.push(`PINECONE_API_KEY is ${pineconeValidation.reason}`);
  }

  if (issues.length > 0) {
    console.warn('\n' + '='.repeat(60));
    console.warn('API KEY CONFIGURATION WARNINGS:');
    console.warn('='.repeat(60));
    issues.forEach((issue) => console.warn(`  - ${issue}`));
    console.warn('='.repeat(60));
    console.warn('The server will start, but API calls may fail if keys are invalid.');
    console.warn('='.repeat(60) + '\n');
  }
}

const badWords = ['fuck', 'shit', 'stupid', 'bakwaas','laude','behenchod','gandu'];
const MAX_HISTORY_MESSAGES = 4;
const MAX_MESSAGE_CHARS = 2000;
const MAX_CONTEXT_CHARS = 4000;

const chatRateLimiter = rateLimit({
  windowMs: CHAT_RATE_LIMIT_WINDOW_MS,
  max: CHAT_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many chat requests. Please wait and try again.' },
});

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          'https://unpkg.com',
          'https://cdnjs.cloudflare.com',
        ],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          'https://fonts.googleapis.com',
          'https://unpkg.com',
        ],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        connectSrc: [
          "'self'",
          'https://generativelanguage.googleapis.com',
          'https://*.generativelanguage.googleapis.com',
          'https://aiplatform.googleapis.com',
          'https://*.aiplatform.googleapis.com',
        ],
        imgSrc: ["'self'", 'data:', 'https:'],
        workerSrc: ["'self'", 'blob:'],
      },
    },
  })
);
app.use(compression());
app.use(cors(DEFAULT_CORS_ORIGIN ? { origin: DEFAULT_CORS_ORIGIN } : undefined));
app.use(express.json({ limit: '32kb' }));

function sanitizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return xss(value, {
    whiteList: {},
    stripIgnoreTag: true,
    stripIgnoreTagBody: ['script', 'style'],
  }).trim();
}

function detectApiKeyError(error) {
  const errorMessage = error?.message || String(error).toLowerCase();
  const errorCode = error?.code || error?.status || '';

  if (
    errorCode === 401 ||
    errorCode === 403 ||
    errorMessage.includes('api_key') ||
    errorMessage.includes('api key') ||
    errorMessage.includes('apikey') ||
    errorMessage.includes('unauthorized') ||
    errorMessage.includes('forbidden') ||
    errorMessage.includes('invalid api') ||
    errorMessage.includes('invalid api key') ||
    errorMessage.includes('permission denied') ||
    errorMessage.includes('permission_denied') ||
    errorMessage.includes('authentication') ||
    errorMessage.includes('unauthorized.') ||
    errorMessage.includes('api key is invalid') ||
    errorMessage.includes('key is invalid') ||
    errorMessage.includes('bad request') ||
    errorMessage.includes('quota exceeded') ||
    errorMessage.includes('rate limit')
  ) {
    return {
      isApiKeyError: true,
      service: errorMessage.includes('pinecone') || errorCode === 403 && errorMessage.includes('index')
        ? 'Pinecone'
        : errorMessage.includes('gemini') || errorMessage.includes('google')
        ? 'Gemini'
        : 'Unknown',
      reason: parseApiKeyErrorReason(error, errorMessage),
    };
  }
  return { isApiKeyError: false };
}

function parseApiKeyErrorReason(error, errorMessage) {
  if (errorMessage.includes('quota exceeded') || errorMessage.includes('rate limit')) {
    return 'API quota or rate limit exceeded';
  }
  if (errorMessage.includes('invalid') || errorMessage.includes('malformed')) {
    return 'API key format is invalid or malformed';
  }
  if (errorMessage.includes('expired')) {
    return 'API key has expired';
  }
  if (errorMessage.includes('unauthorized') || errorMessage.includes('forbidden') || errorMessage.includes('permission')) {
    return 'API key lacks required permissions or is not authorized';
  }
  if (errorMessage.includes('not found') || errorMessage.includes('does not exist')) {
    return 'API key does not exist or has been deleted';
  }
  return error?.message || 'Unknown API key error';
}

function logApiKeyError(service, reason, error) {
  console.error('='.repeat(60));
  console.error(`API KEY ERROR DETECTED - ${service} Service`);
  console.error('='.repeat(60));
  console.error(`Problem: ${reason}`);
  console.error(`Details: ${error?.message || error}`);
  console.error(`Full Error:`, error);
  console.error('='.repeat(60));
  console.error('Suggested fixes:');
  console.error('  1. Verify your API key is correctly set in environment variables');
  console.error('  2. Check if the API key is active and not expired');
  console.error('  3. Ensure the API key has the required permissions/scopes');
  console.error('  4. Check if you have exceeded your API usage quota');
  console.error('='.repeat(60));
}

function isAbusive(text) {
  if (typeof text !== 'string') {
    return false;
  }

  const lowerText = text.toLowerCase();
  return badWords.some((word) => lowerText.includes(word));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorStatus(error) {
  const status = error?.status || error?.code || error?.response?.status;
  const parsed = Number.parseInt(status, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function isTransientError(error) {
  const status = getErrorStatus(error);
  if ([408, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  const code = String(error?.code || error?.name || '').toLowerCase();
  const message = String(error?.message || error || '').toLowerCase();
  return (
    code.includes('abort') ||
    code === 'etimedout' ||
    code === 'econnreset' ||
    code === 'econnrefused' ||
    code === 'eai_again' ||
    message.includes('timeout') ||
    message.includes('temporarily unavailable') ||
    message.includes('connection reset')
  );
}

async function withTransientRetries(operationName, operation) {
  for (let attempt = 0; attempt <= RAG_REQUEST_RETRIES; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= RAG_REQUEST_RETRIES || !isTransientError(error)) {
        throw error;
      }

      const delayMs = Math.min(250 * 2 ** attempt, 2000);
      console.warn(
        `${operationName} failed: ${error?.message || error}. ` +
        `Retrying in ${delayMs}ms (${attempt + 1}/${RAG_REQUEST_RETRIES}).`
      );
      await delay(delayMs);
    }
  }

  return null;
}

function createRequestAbortController(timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();

  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout),
  };
}

function getRecentHistoryEntries(history) {
  if (!Array.isArray(history) || history.length < 2) {
    return [];
  }

  return history
    .slice(0, -1)
    .slice(-MAX_HISTORY_MESSAGES)
    .map((message) => {
      if (!message || typeof message !== 'object') {
        return null;
      }

      const content = sanitizeText(message.content);
      if (!content) {
        return null;
      }

      return {
        role: message.role === 'user' ? 'user' : 'assistant',
        content,
      };
    })
    .filter(Boolean);
}

function buildHistoryContext(history) {
  return getRecentHistoryEntries(history)
    .map((message) => {
      const role = message.role === 'user' ? 'User' : 'Poornima Oracle';
      return `${role}: ${message.content}`;
    })
    .join('\n')
    .slice(0, MAX_CONTEXT_CHARS);
}

function buildContextSnippets(matches) {
  return matches
    .map((match) => sanitizeText(match?.metadata?.text))
    .filter(Boolean)
    .slice(0, 3)
    .join('\n\n')
    .slice(0, MAX_CONTEXT_CHARS);
}

function looksLikeUrl(value) {
  return /^https?:\/\//i.test(sanitizeText(value));
}

function getFirstMetadataValue(metadata, keys) {
  if (!metadata || typeof metadata !== 'object') {
    return '';
  }

  for (const key of keys) {
    const value = sanitizeText(metadata[key]);
    if (value) {
      return value;
    }
  }

  return '';
}

function buildSources(matches) {
  return matches
    .map((match, index) => {
      const metadata = match?.metadata || {};
      const id = sanitizeText(match?.id) || `source-${index + 1}`;
      const rawTitle = getFirstMetadataValue(metadata, [
        'documentName',
        'document',
        'title',
        'file',
        'source',
      ]);
      const rawUrl = getFirstMetadataValue(metadata, ['url', 'link']);
      const sourceValue = sanitizeText(metadata.source);
      const url = rawUrl || (looksLikeUrl(sourceValue) ? sourceValue : '');
      const title = rawTitle && !looksLikeUrl(rawTitle) ? rawTitle : id;
      const score = typeof match?.score === 'number' ? Number(match.score.toFixed(4)) : null;

      return { id, title, url, score };
    })
    .filter((source) => source.title || source.url)
    .slice(0, 3);
}

function filterRelevantMatches(matches) {
  return matches.filter((match) => (
    typeof match?.score === 'number' &&
    Number.isFinite(match.score) &&
    match.score >= RAG_MIN_SCORE
  ));
}

function writeSse(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  res.flush?.();
}

function setSseHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
}

function normalizeForCache(value) {
  return sanitizeText(value)
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function getQueryCacheKey(message, history) {
  const payload = {
    v: 2,
    message: normalizeForCache(message),
    history: getRecentHistoryEntries(history).map((entry) => ({
      role: entry.role,
      content: normalizeForCache(entry.content),
    })),
  };

  return crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

function writeCachedResponse(res, cachedResponse) {
  setSseHeaders(res);
  writeSse(res, 'sources', { sources: cachedResponse.sources });
  writeSse(res, 'token', { text: cachedResponse.answer });
  writeSse(res, 'done', {
    answer: cachedResponse.answer,
    sources: cachedResponse.sources,
    cached: true,
  });
  res.end();
}

function buildSystemInstruction(contextSnippets) {
  return `You are "Poornima Oracle", the official AI assistant for the Poornima Group of Colleges (PU, PCE, PIET).

Use the provided database context to answer only Poornima-related questions accurately.
Keep answers short, usually 2-3 sentences. Use bullet points when more detail is needed.
If the answer is not present in the provided context, say you do not have enough information instead of guessing.
When relevant, identify whether the user is a student, parent, or faculty member.
When money is involved, include exact INR amounts.
When relevant, distinguish between student awards and alumni awards, and between student leave and faculty leave.

Context:
${contextSnippets || 'No relevant database context was found.'}`;
}

async function createQueryEmbedding(message) {
  return withTransientRetries('Gemini embedding', async () => {
    const abortController = createRequestAbortController(RAG_REQUEST_TIMEOUT_MS);
    try {
      const embedResponse = await ai.models.embedContent({
        model: embeddingModel,
        contents: message,
        config: {
          outputDimensionality: 768,
          httpOptions: {
            timeout: RAG_REQUEST_TIMEOUT_MS,
          },
          abortSignal: abortController.signal,
        },
      });

      return embedResponse?.embeddings?.[0]?.values || [];
    } finally {
      abortController.clear();
    }
  });
}

async function startAnswerStream(message, historyContext, contextSnippets) {
  return withTransientRetries('Gemini answer stream start', async () => {
    const abortController = createRequestAbortController(RAG_REQUEST_TIMEOUT_MS);
    try {
      return await ai.models.generateContentStream({
        model: 'gemini-2.5-flash',
        config: {
          systemInstruction: buildSystemInstruction(contextSnippets),
          httpOptions: {
            timeout: RAG_REQUEST_TIMEOUT_MS,
          },
          abortSignal: abortController.signal,
        },
        contents: [
          {
            role: 'user',
            parts: [{ text: `Previous Conversation:\n${historyContext || 'None'}\n\nQuestion: ${message}` }],
          },
        ],
      });
    } finally {
      abortController.clear();
    }
  });
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/styles.css', (req, res) => {
  res.sendFile(path.join(__dirname, 'styles.css'));
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    configured: missingEnvVars.length === 0,
    missingEnvVars,
  });
});

app.post('/api/chat', chatRateLimiter, async (req, res) => {
  try {
    const message = sanitizeText(req.body?.message);
    const history = Array.isArray(req.body?.history) ? req.body.history : [];

    if (!message) {
      return res.status(400).json({ error: 'Message is required.' });
    }

    if (message.length > MAX_MESSAGE_CHARS) {
      return res.status(400).json({
        error: `Message must be ${MAX_MESSAGE_CHARS} characters or less.`,
      });
    }

    const queryCacheKey = getQueryCacheKey(message, history);
    const cachedResponse = queryCache.get(queryCacheKey);
    if (cachedResponse) {
      console.log('Cache hit for query:', message.slice(0, 200));
      return writeCachedResponse(res, cachedResponse);
    }

    if (missingEnvVars.length > 0 || !ai || !pineconeIndex) {
      return res.status(503).json({
        error: `Server is missing required environment variables: ${missingEnvVars.join(', ')}.`,
      });
    }

    console.log('User query:', message.slice(0, 200));

    setSseHeaders(res);

    if (isAbusive(message)) {
      const answer = 'Arre yaar, itni bakwaas mat kar! Thoda dimag laga ke baat kar.';
      writeSse(res, 'sources', { sources: [] });
      writeSse(res, 'token', { text: answer });
      writeSse(res, 'done', { answer, sources: [] });
      return res.end();
    }

    const queryVector = await createQueryEmbedding(message);
    if (!Array.isArray(queryVector) || queryVector.length === 0) {
      writeSse(res, 'error', { error: 'Failed to generate an embedding for the query.' });
      return res.end();
    }

    const queryResponse = await pineconeIndex.query({
      topK: RAG_TOP_K,
      vector: queryVector,
      includeMetadata: true,
    });

    const matches = Array.isArray(queryResponse?.matches) ? queryResponse.matches : [];
    const relevantMatches = filterRelevantMatches(matches);
    const contextSnippets = buildContextSnippets(relevantMatches);
    const historyContext = buildHistoryContext(history);
    const sources = buildSources(relevantMatches);

    writeSse(res, 'sources', { sources });

    const stream = await startAnswerStream(message, historyContext, contextSnippets);

    let answer = '';
    for await (const chunk of stream) {
      const text = typeof chunk?.text === 'string' ? chunk.text : '';
      if (!text) {
        continue;
      }

      answer += text;
      writeSse(res, 'token', { text });
    }

    answer = sanitizeText(answer) || 'I could not generate a response. Please try again.';
    queryCache.set(queryCacheKey, { answer, sources });
    writeSse(res, 'done', { answer, sources });
    res.end();
  } catch (error) {
    const apiKeyError = detectApiKeyError(error);
    if (apiKeyError.isApiKeyError) {
      logApiKeyError(apiKeyError.service, apiKeyError.reason, error);
      if (res.headersSent) {
        writeSse(res, 'error', {
          error: `API key error with ${apiKeyError.service}: ${apiKeyError.reason}. Please check server console for details.`,
        });
        return res.end();
      }

      return res.status(401).json({
        error: `API key error with ${apiKeyError.service}: ${apiKeyError.reason}. Please check server console for details.`,
      });
    }
    console.error('Error in /api/chat:', error);
    if (res.headersSent) {
      writeSse(res, 'error', { error: 'Failed to process the query.' });
      return res.end();
    }

    res.status(500).json({ error: 'Failed to process the query.' });
  }
});

app.post('/api/feedback', (req, res) => {
  const rating = sanitizeText(req.body?.rating);

  if (!['up', 'down'].includes(rating)) {
    return res.status(400).json({ error: 'Feedback rating must be "up" or "down".' });
  }

  const feedback = {
    messageId: sanitizeText(req.body?.messageId),
    rating,
    question: sanitizeText(req.body?.question).slice(0, MAX_MESSAGE_CHARS),
    answer: sanitizeText(req.body?.answer).slice(0, MAX_CONTEXT_CHARS),
    sources: Array.isArray(req.body?.sources) ? req.body.sources.slice(0, 5) : [],
    createdAt: new Date().toISOString(),
  };

  console.log('Chat feedback:', JSON.stringify(feedback));
  res.json({ ok: true });
});

const server = app.listen(PORT, () => {
  validateApiKeysAtStartup();
  console.log(`Poornima Instructor server running on http://localhost:${PORT}`);

  if (missingEnvVars.length > 0) {
    console.warn(`Missing environment variables: ${missingEnvVars.join(', ')}`);
  }
});

server.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use.`);
    console.error('Stop the existing process or start with a different port, for example:');
    console.error('  $env:PORT=3002; node server.js');
    process.exit(1);
  }

  console.error('Server startup failed:', error);
  process.exit(1);
});
