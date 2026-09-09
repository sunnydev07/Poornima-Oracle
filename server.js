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
const { fallbackRouter } = require('./services/fallback-router');
const { mcpManager } = require('./services/mcp-manager');
const cron = require('node-cron');
const { syncNotices, NOTICES_NAMESPACE } = require('./services/crawler/notice-sync');
const { getUpcomingCalendarEvents, getCalendarContextForPrompt } = require('./services/calendar-service');

const app = express();
app.set('trust proxy', 1);
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
const pineconeNamespace = process.env.PINECONE_NAMESPACE ? process.env.PINECONE_NAMESPACE.trim() : '';
const embeddingModel = process.env.GEMINI_EMBEDDING_MODEL
  ? process.env.GEMINI_EMBEDDING_MODEL.trim()
  : 'gemini-embedding-001';
const adminApiKey = process.env.ADMIN_API_KEY ? process.env.ADMIN_API_KEY.trim() : '';
const noticeSyncCron = process.env.NOTICE_SYNC_CRON ? process.env.NOTICE_SYNC_CRON.trim() : '30 0 * * *'; // Default: 6:00 AM IST (00:30 UTC)
const noticeSyncEnabled = process.env.NOTICE_SYNC_ENABLED !== 'false'; // Default: true

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
  maxKeys: 1000,
  useClones: true,
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

const badWordsRegex = /\b(fuck|shit|bakwaas|behenchod|gandu)\b/i;
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
          'https://poornima-oracle.onrender.com',
          ...(DEFAULT_CORS_ORIGIN || []),
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
app.use(express.static(path.join(__dirname)));

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
  const errorMessage = (error?.message || String(error)).toLowerCase();
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
  return badWordsRegex.test(text);
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

function getRecentHistoryEntries(history, currentMessage = '') {
  if (!Array.isArray(history) || history.length === 0) {
    return [];
  }

  let cleanHistory = history
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

  if (cleanHistory.length > 0 && typeof currentMessage === 'string' && currentMessage.trim()) {
    const last = cleanHistory[cleanHistory.length - 1];
    if (last.role === 'user' && last.content.trim() === sanitizeText(currentMessage).trim()) {
      cleanHistory = cleanHistory.slice(0, -1);
    }
  }

  return cleanHistory.slice(-MAX_HISTORY_MESSAGES);
}

function buildHistoryContext(history, currentMessage = '') {
  return getRecentHistoryEntries(history, currentMessage)
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
      // Tier 1 #2: pass notice freshness metadata through so the chat UI
      // can render "Live Notice" + "New" badges for portal-notice-* sources.
      const publishedAt = getFirstMetadataValue(metadata, [
        'publishedAt',
        'published_at',
        'date',
        'ingestedAt',
      ]);
      const college = getFirstMetadataValue(metadata, ['college']);
      const category = getFirstMetadataValue(metadata, ['category']);

      const source = { id, title, url, score };
      if (publishedAt) source.publishedAt = publishedAt;
      if (college) source.college = college;
      if (category) source.category = category;
      return source;
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

function getQueryCacheKey(message, history, profile = null) {
  const payload = {
    v: 3,
    message: normalizeForCache(message),
    history: getRecentHistoryEntries(history, message).map((entry) => ({
      role: entry.role,
      content: normalizeForCache(entry.content),
    })),
    profile: profile
      ? { c: profile.college, s: profile.status, y: profile.year, cr: profile.course, b: profile.branch }
      : null,
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
    provider: cachedResponse.provider,
    fallback: cachedResponse.fallback,
  });
  res.end();
}

const REFUSAL_PATTERNS = [
  /do not have (enough |any )?information/i,
  /don't have (enough |any )?information/i,
  /not (present|found|available|mentioned) in the (provided )?(context|database|documents|records)/i,
  /no information (is )?(available|provided|found) in the (provided )?context/i,
  /cannot find (any )?information/i,
  /could not find (any )?information/i,
  /I (do not|don't) have access to/i,
  /my knowledge base does not contain/i,
  /outside the scope of the provided/i,
  /no relevant database context was found/i,
  /no relevant context was found/i,
  /I cannot answer this question based on the provided/i,
  /I am unable to answer based on the provided/i,
  /I (do not|don't) have (any )?records/i,
];

function isRefusalResponse(text) {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length > 350) return false;
  return REFUSAL_PATTERNS.some((pattern) => pattern.test(trimmed));
}

async function streamFallbackResponse(res, {
  message,
  history = [],
  contextSnippets = '',
  profile = null,
  reason = 'knowledge_gap',
  clientAbortController,
  queryCacheKey = null,
  initialSources = [],
  router = fallbackRouter,
}) {
  if (!res.headersSent) {
    setSseHeaders(res);
  }

  let fallbackAnswer = '';
  try {
    const result = await router.handleFallback({
      message,
      history,
      contextSnippets,
      profile,
      reason,
      signal: clientAbortController.signal,
      onStatus: (statusPayload) => {
        if (!clientAbortController.signal.aborted) {
          writeSse(res, 'status', statusPayload);
        }
      },
      onToolCall: (toolPayload) => {
        if (!clientAbortController.signal.aborted) {
          writeSse(res, 'tool_call', toolPayload);
        }
      },
      onToolResult: (resultPayload) => {
        if (!clientAbortController.signal.aborted) {
          writeSse(res, 'tool_result', resultPayload);
        }
      },
      onToken: (text) => {
        if (!clientAbortController.signal.aborted) {
          fallbackAnswer += text;
          writeSse(res, 'token', { text });
        }
      },
    });

    if (clientAbortController.signal.aborted) {
      return;
    }

    const finalAnswer = (result?.answer || fallbackAnswer).trim() ||
      'I was unable to complete the request. Please consult https://poornima.edu.in.';
    const sources = Array.isArray(result?.sources) && result.sources.length > 0
      ? result.sources
      : initialSources;
    const provider = result?.provider || 'Fallback Cloud Agent';

    if (sources.length > 0) {
      writeSse(res, 'sources', { sources });
    }

    if (queryCacheKey && finalAnswer) {
      queryCache.set(queryCacheKey, {
        answer: finalAnswer,
        sources,
        provider,
        fallback: true,
      });
    }

    writeSse(res, 'done', {
      answer: finalAnswer,
      sources,
      provider,
      fallback: true,
    });
    res.end();
  } catch (fallbackError) {
    console.error('Error during fallback streaming:', fallbackError);
    if (!res.writableEnded) {
      writeSse(res, 'error', { error: 'Failed to process the query via fallback services.' });
      res.end();
    }
  }
}


function sanitizeProfile(rawProfile) {
  if (!rawProfile || typeof rawProfile !== 'object') return null;
  const college = ['PU', 'PCE', 'PIET', 'GENERAL'].includes(rawProfile.college) ? rawProfile.college : 'GENERAL';
  const status = ['hosteller', 'day_scholar', 'bus_commuter'].includes(rawProfile.status) ? rawProfile.status : 'day_scholar';
  const course = typeof rawProfile.course === 'string' ? rawProfile.course.slice(0, 30).trim() : 'B.Tech';
  const year = typeof rawProfile.year === 'string' ? rawProfile.year.slice(0, 20).trim() : '1st';
  const branch = typeof rawProfile.branch === 'string' ? rawProfile.branch.slice(0, 50).trim() : '';
  return { college, status, course, year, branch };
}

function formatProfileContext(profile) {
  if (!profile) return '';
  const collegeNames = {
    PU: 'Poornima University (PU)',
    PCE: 'Poornima College of Engineering (PCE)',
    PIET: 'Poornima Institute of Engineering & Technology (PIET)',
    GENERAL: 'Poornima Group of Colleges (General)',
  };
  const statusNames = {
    hosteller: 'Hosteller (Campus Resident)',
    day_scholar: 'Day Scholar (Commuter)',
    bus_commuter: 'Bus Commuter (College Bus Service)',
  };
  const parts = [
    `- Institution: ${collegeNames[profile.college] || profile.college}`,
    `- Residential/Transport Status: ${statusNames[profile.status] || profile.status}`,
  ];
  if (profile.year || profile.course || profile.branch) {
    const academicDesc = [profile.year, profile.course, profile.branch].filter(Boolean).join(' ');
    parts.push(`- Academic Level: ${academicDesc}`);
  }
  return `Student Profile:\n${parts.join('\n')}\n*Tailor campus regulations, curfew/mess hours, exam patterns, and transport rules directly to this student profile.*`;
}

function buildSystemInstruction(contextSnippets, profile = null) {
  const profileSection = profile ? `\n\n${formatProfileContext(profile)}` : '';
  return `You are "Poornima Oracle", the official campus AI assistant for Poornima Group of Colleges (PU, PCE, PIET) in Jaipur, created and developed by Sunny Dev (GitHub: sunnydev07).

Guidelines:
1. Creator & Identity: You were created and developed by Sunny Dev (GitHub: sunnydev07). Acknowledge your creator accurately when asked.
2. Scope & Accuracy: Answer campus queries using the verified institutional context below. Differentiate between PU, PCE, and PIET.
3. Brevity: Keep responses direct and concise (typically 2-4 sentences, or clean markdown bullets for lists). Avoid conversational filler.
4. Precision: Quote monetary amounts in INR. Differentiate student vs. faculty rules (fees, attendance, exams, leave).
5. Uncertainty: If context lacks required facts, state clearly what is unknown without guessing, and direct the user to campus administration or poornima.edu.in.${profileSection}

Verified Context:
${contextSnippets || 'No direct institutional database context found.'}`;
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

async function startAnswerStream(message, historyContext, contextSnippets, profile, externalSignal) {
  return withTransientRetries('Gemini answer stream start', async () => {
    const abortController = createRequestAbortController(RAG_REQUEST_TIMEOUT_MS);
    const combinedSignal = externalSignal || abortController.signal;
    try {
      return await ai.models.generateContentStream({
        model: 'gemini-2.5-flash',
        config: {
          systemInstruction: buildSystemInstruction(contextSnippets, profile),
          httpOptions: {
            timeout: RAG_REQUEST_TIMEOUT_MS,
          },
          abortSignal: combinedSignal,
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
    fallback: {
      enabled: fallbackRouter.isEnabled(),
      configured: fallbackRouter.isConfigured(),
      providers: fallbackRouter.getAvailableProviders(),
    },
    mcp: mcpManager.getStatus(),
    uptimeSeconds: Math.floor(process.uptime()),
    memoryUsage: process.memoryUsage(),
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/calendar', async (req, res) => {
  try {
    const campus = (req.query.campus || req.query.college || 'ALL').toUpperCase();
    const category = (req.query.category || 'all').toLowerCase();
    const daysAhead = parsePositiveInteger(req.query.daysAhead, 90);
    const limit = parseBoundedInteger(req.query.limit, 25, 1, 100);

    const data = await getUpcomingCalendarEvents({
      campus,
      category,
      daysAhead,
      limit,
    });

    res.json({
      ok: true,
      ...data,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Error fetching calendar events in /api/calendar:', err);
    res.status(500).json({
      ok: false,
      error: 'Failed to retrieve academic calendar events',
    });
  }
});

app.post('/api/chat', chatRateLimiter, async (req, res) => {
  const clientAbortController = new AbortController();
  req.on('close', () => {
    if (!res.writableEnded) {
      clientAbortController.abort();
    }
  });

  const message = sanitizeText(req.body?.message);
  const history = Array.isArray(req.body?.history) ? req.body.history : [];
  const profile = sanitizeProfile(req.body?.profile);
  const queryCacheKey = message ? getQueryCacheKey(message, history, profile) : null;

  const clientOpenRouterKey = req.headers['x-openrouter-key'] ? String(req.headers['x-openrouter-key']).trim() : '';
  const clientOllamaKey = req.headers['x-ollama-key'] ? String(req.headers['x-ollama-key']).trim() : '';
  const clientOllamaHost = req.headers['x-ollama-host'] ? String(req.headers['x-ollama-host']).trim() : '';
  const clientFallbackHeader = req.headers['x-fallback-enabled'] ? String(req.headers['x-fallback-enabled']).trim() : '';
  const fallbackEnabled = clientFallbackHeader ? clientFallbackHeader !== 'false' : undefined;

  const currentFallbackRouter = fallbackRouter.withOverrides({
    ...(clientOpenRouterKey ? { openrouterApiKey: clientOpenRouterKey } : {}),
    ...(clientOllamaKey ? { ollamaApiKey: clientOllamaKey } : {}),
    ...(clientOllamaHost ? { ollamaHost: clientOllamaHost } : {}),
    ...(fallbackEnabled !== undefined ? { enabled: fallbackEnabled } : {}),
  });

  try {
    if (!message) {
      return res.status(400).json({ error: 'Message is required.' });
    }

    if (message.length > MAX_MESSAGE_CHARS) {
      return res.status(400).json({
        error: `Message must be ${MAX_MESSAGE_CHARS} characters or less.`,
      });
    }

    const cachedResponse = queryCacheKey ? queryCache.get(queryCacheKey) : null;
    if (cachedResponse) {
      console.log('Cache hit for query:', message.slice(0, 200));
      return writeCachedResponse(res, cachedResponse);
    }

    if (missingEnvVars.length > 0 || !ai || !pineconeIndex) {
      if (currentFallbackRouter.isConfigured()) {
        console.log('Primary RAG unconfigured or missing env vars. Escalating directly to Fallback Router.');
        return streamFallbackResponse(res, {
          message,
          history,
          contextSnippets: '',
          profile,
          reason: 'primary_unconfigured',
          clientAbortController,
          queryCacheKey,
          router: currentFallbackRouter,
        });
      }
      return res.status(503).json({
        error: `Server is missing required environment variables: ${missingEnvVars.join(', ')}.`,
      });
    }

    console.log('User query:', message.slice(0, 200));

    if (isAbusive(message)) {
      setSseHeaders(res);
      const answer = 'Please keep the conversation respectful and campus-related. How can I assist you with Poornima academic or administrative queries?';
      writeSse(res, 'sources', { sources: [] });
      writeSse(res, 'token', { text: answer });
      writeSse(res, 'done', { answer, sources: [] });
      return res.end();
    }

    let queryVector;
    try {
      queryVector = await createQueryEmbedding(message);
    } catch (embedError) {
      console.warn('Embedding generation failed:', embedError?.message || embedError);
      if (currentFallbackRouter.isConfigured()) {
        console.log('Embedding generation failed. Escalating to Fallback Router.');
        return streamFallbackResponse(res, {
          message,
          history,
          contextSnippets: '',
          reason: 'embedding_error',
          clientAbortController,
          queryCacheKey,
          router: currentFallbackRouter,
        });
      }
      return res.status(502).json({ error: 'Failed to generate an embedding for the query.' });
    }

    if (!Array.isArray(queryVector) || queryVector.length === 0) {
      if (currentFallbackRouter.isConfigured()) {
        console.log('Empty embedding vector received. Escalating to Fallback Router.');
        return streamFallbackResponse(res, {
          message,
          history,
          contextSnippets: '',
          reason: 'embedding_empty',
          clientAbortController,
          queryCacheKey,
          router: currentFallbackRouter,
        });
      }
      return res.status(502).json({ error: 'Failed to generate an embedding for the query.' });
    }

    let queryResponse;
    try {
      // === RAG 2.0: Dual-Namespace Parallel Query ===
      // Query both the handbook (__default__) and notices namespaces concurrently
      const baseQueryOptions = {
        topK: RAG_TOP_K,
        vector: queryVector,
        includeMetadata: true,
      };

      const handbookQuery = pineconeIndex.query({
        ...baseQueryOptions,
        ...(pineconeNamespace ? { namespace: pineconeNamespace } : {}),
      });

      const noticesQuery = pineconeIndex.query({
        ...baseQueryOptions,
        namespace: NOTICES_NAMESPACE,
      });

      const [handbookResult, noticesResult] = await Promise.allSettled([handbookQuery, noticesQuery]);

      // Merge matches from both namespaces
      const handbookMatches = handbookResult.status === 'fulfilled'
        ? (Array.isArray(handbookResult.value?.matches) ? handbookResult.value.matches : [])
        : [];
      const noticeMatches = noticesResult.status === 'fulfilled'
        ? (Array.isArray(noticesResult.value?.matches) ? noticesResult.value.matches : [])
        : [];

      if (handbookResult.status === 'rejected') {
        console.warn('Handbook namespace query failed:', handbookResult.reason?.message || handbookResult.reason);
      }
      if (noticesResult.status === 'rejected') {
        console.warn('Notices namespace query failed:', noticesResult.reason?.message || noticesResult.reason);
      }

      // Tag notice matches with portal-notice IDs for frontend badge rendering
      for (const match of noticeMatches) {
        if (match?.id && !match.id.startsWith('portal-notice-')) {
          match.id = `portal-notice-${match.id}`;
        }
      }

      // Combine and sort by cosine similarity score (descending)
      const allMatches = [...handbookMatches, ...noticeMatches]
        .sort((a, b) => (b?.score || 0) - (a?.score || 0));

      queryResponse = { matches: allMatches };

      console.log(`RAG 2.0: Handbook=${handbookMatches.length} + Notices=${noticeMatches.length} → ${allMatches.length} total matches`);
    } catch (pineconeError) {
      console.warn('Pinecone query failed:', pineconeError?.message || pineconeError);
      if (currentFallbackRouter.isConfigured()) {
        console.log('Pinecone query failed. Escalating to Fallback Router.');
        return streamFallbackResponse(res, {
          message,
          history,
          contextSnippets: '',
          profile,
          reason: 'pinecone_error',
          clientAbortController,
          queryCacheKey,
          router: currentFallbackRouter,
        });
      }
      throw pineconeError;
    }

    const matches = Array.isArray(queryResponse?.matches) ? queryResponse.matches : [];
    const relevantMatches = filterRelevantMatches(matches);
    const contextSnippets = buildContextSnippets(relevantMatches);
    const historyContext = buildHistoryContext(history, message);
    const sources = buildSources(relevantMatches);

    // Tier 2 #6: Grounding with official Academic Calendar & Exam Schedule
    let calendarContext = '';
    try {
      calendarContext = await getCalendarContextForPrompt(message, profile?.college || 'ALL');
    } catch (calErr) {
      console.warn('Calendar context lookup failed:', calErr?.message || calErr);
    }

    const combinedSnippets = calendarContext
      ? (contextSnippets ? `${calendarContext}\n\n${contextSnippets}` : calendarContext)
      : contextSnippets;

    if (calendarContext) {
      sources.unshift({
        id: 'live-academic-calendar',
        title: 'Poornima Academic Calendar (Live Feed)',
        url: 'https://calendar.google.com',
        score: 0.95,
        category: 'Academic Calendar',
        college: profile?.college || 'ALL',
      });
    }

    if (clientAbortController.signal.aborted) {
      return;
    }

    // Trigger Condition: Knowledge gap (no relevant matches with score >= RAG_MIN_SCORE AND no calendar context)
    if (relevantMatches.length === 0 && !calendarContext && currentFallbackRouter.isConfigured()) {
      console.log(`Knowledge gap detected: 0 matches with score >= ${RAG_MIN_SCORE}. Escalating to Fallback Router.`);
      return streamFallbackResponse(res, {
        message,
        history,
        contextSnippets: '',
        profile,
        reason: 'knowledge_gap',
        clientAbortController,
        queryCacheKey,
        initialSources: sources,
        router: currentFallbackRouter,
      });
    }

    setSseHeaders(res);
    writeSse(res, 'sources', { sources });

    let stream;
    try {
      stream = await startAnswerStream(message, historyContext, combinedSnippets, profile, clientAbortController.signal);
    } catch (geminiError) {
      console.warn('Primary Gemini stream start failed:', geminiError?.message || geminiError);
      if (currentFallbackRouter.isConfigured()) {
        console.log('Gemini start failed. Escalating to Fallback Router.');
        return streamFallbackResponse(res, {
          message,
          history,
          contextSnippets: combinedSnippets,
          profile,
          reason: isTransientError(geminiError) ? 'gemini_quota' : 'gemini_error',
          clientAbortController,
          queryCacheKey,
          initialSources: sources,
          router: currentFallbackRouter,
        });
      }
      throw geminiError;
    }

    let answer = '';
    let refusalBuffer = '';
    let refusalChecked = false;
    const REFUSAL_BUFFER_MAX = 220;

    for await (const chunk of stream) {
      if (clientAbortController.signal.aborted) {
        break;
      }

      const text = typeof chunk?.text === 'string' ? chunk.text : '';
      if (!text) {
        continue;
      }

      answer += text;

      // Check if primary response starts with a refusal phrase
      if (!refusalChecked && currentFallbackRouter.isConfigured()) {
        refusalBuffer += text;
        if (refusalBuffer.length < REFUSAL_BUFFER_MAX) {
          continue;
        }

        if (isRefusalResponse(refusalBuffer)) {
          console.log('Gemini output indicates refusal / lack of information. Escalating to Fallback Router.');
          refusalChecked = true;
          return streamFallbackResponse(res, {
            message,
            history,
            contextSnippets: combinedSnippets,
            profile,
            reason: 'refusal',
            clientAbortController,
            queryCacheKey,
            initialSources: sources,
            router: currentFallbackRouter,
          });
        }

        refusalChecked = true;
        writeSse(res, 'token', { text: refusalBuffer });
      } else {
        writeSse(res, 'token', { text });
      }
    }

    if (clientAbortController.signal.aborted) {
      return;
    }

    // Check refusal on short responses (< REFUSAL_BUFFER_MAX)
    if (!refusalChecked && refusalBuffer) {
      if (currentFallbackRouter.isConfigured() && isRefusalResponse(refusalBuffer)) {
        console.log('Short refusal response detected from Gemini. Escalating to Fallback Router.');
        return streamFallbackResponse(res, {
          message,
          history,
          contextSnippets,
          profile,
          reason: 'refusal',
          clientAbortController,
          queryCacheKey,
          initialSources: sources,
          router: currentFallbackRouter,
        });
      }
      writeSse(res, 'token', { text: refusalBuffer });
    }

    answer = answer.trim() || 'I could not generate a response. Please try again.';
    queryCache.set(queryCacheKey, { answer, sources });
    writeSse(res, 'done', { answer, sources });
    res.end();
  } catch (error) {
    if (!res.headersSent && currentFallbackRouter.isConfigured()) {
      console.warn('Recovering from error in /api/chat via Fallback Router:', error?.message || error);
      return streamFallbackResponse(res, {
        message,
        history,
        contextSnippets: '',
        profile,
        reason: 'chat_error',
        clientAbortController,
        queryCacheKey,
        router: currentFallbackRouter,
      });
    }

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

const feedbackRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many feedback submissions. Please wait and try again.' },
});

app.post('/api/feedback', feedbackRateLimiter, (req, res) => {
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

// ---------------------------------------------------------------------------
// RAG 2.0: Notice Sync Admin Endpoint & Runner
// ---------------------------------------------------------------------------

let noticeSyncRunning = false;

/**
 * Run the notice sync pipeline with shared AI/Pinecone clients.
 * Returns the sync result object.
 */
async function runNoticeSync(options = {}) {
  if (noticeSyncRunning) {
    return { success: false, errors: ['A sync is already in progress.'] };
  }

  noticeSyncRunning = true;
  try {
    const result = await syncNotices({
      ai: ai || undefined,
      pineconeIndex: pineconeIndex || undefined,
      ...options,
    });
    return result;
  } finally {
    noticeSyncRunning = false;
  }
}

/**
 * POST /api/sync-notices — Admin-only endpoint to trigger notice ingestion.
 * Protected by ADMIN_API_KEY header check.
 */
app.post('/api/sync-notices', async (req, res) => {
  // Authenticate with admin API key
  const providedKey = (req.headers['x-admin-key'] || req.headers['authorization']?.replace('Bearer ', '') || '').trim();

  if (!adminApiKey) {
    return res.status(503).json({
      error: 'Admin API key not configured. Set ADMIN_API_KEY in environment.',
    });
  }

  if (providedKey !== adminApiKey) {
    return res.status(401).json({ error: 'Unauthorized. Invalid admin API key.' });
  }

  if (noticeSyncRunning) {
    return res.status(409).json({ error: 'A notice sync is already in progress. Try again later.' });
  }

  const dryRun = req.body?.dryRun === true;

  // Run sync asynchronously but respond with result
  try {
    console.log(`[NoticeSyncAPI] Manual sync triggered (dryRun=${dryRun})`);
    const result = await runNoticeSync({ dryRun });
    res.json({ ok: result.success, ...result });
  } catch (err) {
    console.error('[NoticeSyncAPI] Sync error:', err);
    res.status(500).json({ error: 'Notice sync failed.', details: err.message });
  }
});

async function gracefulShutdown(signal) {
  console.log(`Received ${signal}. Closing HTTP server gracefully...`);
  await mcpManager.closeAll().catch(() => {});
  server.close(() => {
    console.log('HTTP server closed. Exiting process.');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('Forced shutdown due to timeout.');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

const server = app.listen(PORT, () => {
  validateApiKeysAtStartup();
  console.log(`Poornima Instructor server running on http://localhost:${PORT}`);

  if (fallbackRouter.isConfigured()) {
    console.log(`[FallbackRouter] Dual Cloud Core Active: ${fallbackRouter.getAvailableProviders().join(' | ')}`);
  } else {
    console.log('[FallbackRouter] Idle (No fallback keys configured in environment)');
  }

  mcpManager.initialize().then((status) => {
    if (status.activeServersCount > 0) {
      console.log(`[McpManager] Active MCP servers: ${status.activeServersCount}, Total MCP tools: ${status.totalToolsCount}`);
    } else {
      console.log('[McpManager] Ready (0 active external servers in mcp-servers.json)');
    }
  }).catch((err) => {
    console.warn('[McpManager] Initialization warning:', err.message);
  });

  // RAG 2.0: Schedule automatic notice sync cron
  if (noticeSyncEnabled && cron.validate(noticeSyncCron)) {
    cron.schedule(noticeSyncCron, async () => {
      console.log(`[NoticeSyncCron] Scheduled sync triggered at ${new Date().toISOString()}`);
      try {
        const result = await runNoticeSync();
        console.log(`[NoticeSyncCron] Sync completed: ${result.vectorsUpserted || 0} vectors upserted, ${result.errors?.length || 0} warnings`);
      } catch (err) {
        console.error('[NoticeSyncCron] Sync failed:', err.message);
      }
    }, {
      timezone: 'Asia/Kolkata',
      noOverlap: true,
    });
    console.log(`[NoticeSyncCron] Scheduled: "${noticeSyncCron}" (Asia/Kolkata timezone)`);
  } else if (!noticeSyncEnabled) {
    console.log('[NoticeSyncCron] Disabled (NOTICE_SYNC_ENABLED=false)');
  } else {
    console.warn(`[NoticeSyncCron] Invalid cron expression: "${noticeSyncCron}". Skipping schedule.`);
  }

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
