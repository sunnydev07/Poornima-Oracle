if (require.main === module) require('dotenv').config();

const crypto = require('crypto');
const path = require('path');
const { AsyncLocalStorage } = require('node:async_hooks');
const express = require('express');
const compression = require('compression');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const NodeCache = require('node-cache');
const {
  MAX_MESSAGE_CHARS,
  MAX_HISTORY_MESSAGE_CHARS,
  MAX_CONTEXT_CHARS,
  MAX_ANSWER_CHARS,
  cleanPlainText,
  cleanStreamText,
  normalizeHistory,
  buildHistoryContext,
} = require('./chat-contract');
const { GoogleGenAI } = require('@google/genai');
const { Pinecone } = require('@pinecone-database/pinecone');

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

const queryCacheTtlSeconds = Number.parseInt(process.env.QUERY_CACHE_TTL_SECONDS, 10);

function createTimeoutFetch(timeoutMs, requestSignalStorage) {
  return async (url, init = {}) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Upstream request timed out.')), timeoutMs);
    const linkedSignals = [...new Set([init.signal, requestSignalStorage?.getStore()].filter(Boolean))];
    const abortListeners = [];
    const cleanup = () => {
      clearTimeout(timeout);
      for (const [signal, listener] of abortListeners) {
        signal.removeEventListener('abort', listener);
      }
    };
    timeout.unref?.();

    for (const signal of linkedSignals) {
      if (signal.aborted) {
        controller.abort(signal.reason);
        break;
      }
      const listener = () => controller.abort(signal.reason);
      signal.addEventListener('abort', listener, { once: true });
      abortListeners.push([signal, listener]);
    }

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });
      if (!response.body) {
        cleanup();
        return response;
      }

      const { readable, writable } = new TransformStream();
      response.body.pipeTo(writable, { signal: controller.signal }).then(cleanup, cleanup);
      return new Response(readable, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      cleanup();
      throw error;
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

const badWords = ['fuck', 'shit', 'stupid', 'bakwaas', 'laude', 'behenchod', 'gandu'];

function createApp(options = {}) {
  const app = express();
  const appConfig = {
    corsOrigins: DEFAULT_CORS_ORIGIN || [],
    bodyLimit: '32kb',
    chatRateLimitWindowMs: CHAT_RATE_LIMIT_WINDOW_MS,
    chatRateLimitMax: CHAT_RATE_LIMIT_MAX,
    ragTopK: RAG_TOP_K,
    ragMinScore: RAG_MIN_SCORE,
    ragRequestTimeoutMs: RAG_REQUEST_TIMEOUT_MS,
    ragRequestRetries: RAG_REQUEST_RETRIES,
    answerTimeoutMs: parsePositiveInteger(process.env.ANSWER_TIMEOUT_MS, 120000),
    answerIdleTimeoutMs: parsePositiveInteger(process.env.ANSWER_IDLE_TIMEOUT_MS, 30000),
    maxConcurrentGenerations: parsePositiveInteger(process.env.MAX_CONCURRENT_GENERATIONS, 5),
    feedbackRateLimitWindowMs: parsePositiveInteger(process.env.FEEDBACK_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
    feedbackRateLimitMax: parsePositiveInteger(process.env.FEEDBACK_RATE_LIMIT_MAX, 10),
    cacheMaxKeys: parsePositiveInteger(process.env.QUERY_CACHE_MAX_KEYS, 1000),
    trustProxyHops: parseBoundedInteger(process.env.TRUST_PROXY_HOPS, 0, 0, 5),
    ...options.config,
  };
  const pineconeRequestSignalStorage = options.pineconeRequestSignalStorage || new AsyncLocalStorage();
  const aiClient = Object.prototype.hasOwnProperty.call(options, 'ai')
    ? options.ai
    : (geminiApiKey ? new GoogleGenAI({ apiKey: geminiApiKey }) : null);
  const pineconeIndexClient = Object.prototype.hasOwnProperty.call(options, 'pineconeIndex')
    ? options.pineconeIndex
    : (pineconeApiKey && pineconeIndexName
      ? new Pinecone({
          apiKey: pineconeApiKey,
          fetchApi: createTimeoutFetch(RAG_REQUEST_TIMEOUT_MS, pineconeRequestSignalStorage),
          maxRetries: PINECONE_MAX_RETRIES,
        }).index(pineconeIndexName)
      : null);
  const appMissingEnvVars = options.missingEnvVars || missingEnvVars;
  const queryCache = options.queryCache || new NodeCache({
    stdTTL: queryCacheTtlSeconds > 0 ? queryCacheTtlSeconds : 3600,
    checkperiod: 120,
    useClones: false,
  });
  const storeCachedResponse = (key, value) => {
    const maxKeys = parsePositiveInteger(appConfig.cacheMaxKeys, 1000);
    if (!queryCache.has(key) && queryCache.keys().length >= maxKeys) {
      const oldestKey = queryCache.keys()[0];
      if (oldestKey) queryCache.del(oldestKey);
    }
    queryCache.set(key, value);
  };
  let activeGenerations = 0;
  const chatRateLimiter = rateLimit({
    windowMs: appConfig.chatRateLimitWindowMs,
    max: appConfig.chatRateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many chat requests. Please wait and try again.' },
  });
  const feedbackRateLimiter = rateLimit({
    windowMs: appConfig.feedbackRateLimitWindowMs,
    max: appConfig.feedbackRateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many feedback submissions. Please wait and try again.' },
  });

  app.set('trust proxy', appConfig.trustProxyHops);
  app.use((req, res, next) => {
    req.requestId = crypto.randomUUID();
    res.setHeader('X-Request-ID', req.requestId);
    next();
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
  app.use(cors({
    origin(origin, callback) {
      callback(null, !origin || appConfig.corsOrigins.includes(origin));
    },
  }));
  app.use(express.json({ limit: appConfig.bodyLimit }));

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

function classifyUpstreamError(error) {
  const status = getErrorStatus(error);
  const message = String(error?.message || '').toLowerCase();
  const code = String(error?.code || error?.name || '').toLowerCase();

  if (status === 429 || message.includes('quota exceeded') || message.includes('rate limit')) {
    const retryHeader = error?.response?.headers?.get?.('retry-after') ||
      error?.headers?.get?.('retry-after');
    const parsedRetryAfter = Number.parseInt(retryHeader, 10);
    return {
      status: 429,
      message: 'The assistant is busy. Please try again shortly.',
      retryAfter: Number.isFinite(parsedRetryAfter)
        ? Math.min(Math.max(parsedRetryAfter, 1), 3600)
        : 30,
    };
  }
  if (status === 408 || status === 504 || code.includes('abort') || message.includes('timeout')) {
    return { status: 504, message: 'The response took too long. Please try again.' };
  }
  if (status === 401 || status === 403) {
    return { status: 502, message: 'The assistant service could not authorize this request.' };
  }
  return { status: 502, message: 'The assistant service could not process this request.' };
}

function isTransientError(error) {
  const status = getErrorStatus(error);
  if ([408, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  const code = String(error?.code || error?.name || '').toLowerCase();
  const message = String(error?.message || error || '').toLowerCase();
  return (
    code === 'etimedout' ||
    code === 'econnreset' ||
    code === 'econnrefused' ||
    code === 'eai_again' ||
    message.includes('timeout') ||
    message.includes('temporarily unavailable') ||
    message.includes('connection reset')
  );
}

async function withTransientRetries(operationName, operation, maxRetries = RAG_REQUEST_RETRIES) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= maxRetries || !isTransientError(error)) {
        throw error;
      }

      const delayMs = Math.min(250 * 2 ** attempt, 2000);
      console.warn('Transient upstream request failed', {
        operation: operationName,
        requestAttempt: attempt + 1,
        maxRetries,
        retryInMs: delayMs,
        errorName: error?.name || 'Error',
        status: getErrorStatus(error),
      });
      await delay(delayMs);
    }
  }

  return null;
}

function getRecentHistoryEntries(history) {
  return normalizeHistory(history);
}

function buildContextSnippets(matches) {
  return matches
    .map((match) => cleanPlainText(match?.metadata?.text, MAX_CONTEXT_CHARS))
    .filter(Boolean)
    .slice(0, 3)
    .join('\n\n')
    .slice(0, MAX_CONTEXT_CHARS);
}

function looksLikeUrl(value) {
  return /^https?:\/\//i.test(cleanPlainText(value, MAX_HISTORY_MESSAGE_CHARS));
}

function normalizeSourceUrl(value) {
  const candidate = cleanPlainText(value, 2048);
  if (!candidate) return '';

  try {
    const url = new URL(candidate);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      return '';
    }
    return url.toString();
  } catch (error) {
    return '';
  }
}

function getFirstMetadataValue(metadata, keys) {
  if (!metadata || typeof metadata !== 'object') {
    return '';
  }

  for (const key of keys) {
    const value = cleanPlainText(metadata[key], MAX_HISTORY_MESSAGE_CHARS);
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
      const id = cleanPlainText(match?.id, 200) || `source-${index + 1}`;
      const rawTitle = getFirstMetadataValue(metadata, [
        'documentName',
        'document',
        'title',
        'file',
        'source',
      ]);
      const sourceValue = cleanPlainText(metadata.source, MAX_HISTORY_MESSAGE_CHARS);
      const urlCandidates = [metadata.url, metadata.link, sourceValue];
      const url = urlCandidates.map(normalizeSourceUrl).find(Boolean) || '';
      const title = rawTitle && !looksLikeUrl(rawTitle)
        ? cleanPlainText(rawTitle, 500)
        : id;
      const score = typeof match?.score === 'number' ? Number(match.score.toFixed(4)) : null;

      return { id, title, url, score };
    })
    .filter((source) => source.title || source.url)
    .slice(0, 3);
}

function filterRelevantMatches(matches, minimumScore = RAG_MIN_SCORE) {
  return matches.filter((match) => (
    typeof match?.score === 'number' &&
    Number.isFinite(match.score) &&
    match.score >= minimumScore
  ));
}

function writeSse(res, event, payload) {
  if (res.destroyed || res.writableEnded || !res.writable) return false;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  res.flush?.();
  return true;
}

function setSseHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
}

function normalizeForCache(value) {
  return cleanPlainText(value, MAX_HISTORY_MESSAGE_CHARS)
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

async function createQueryEmbedding(message, aiClient, appConfig, signal) {
  return withTransientRetries('Gemini embedding', async () => {
    const embedResponse = await aiClient.models.embedContent({
      model: embeddingModel,
      contents: message,
      config: {
        outputDimensionality: 768,
        httpOptions: {
          timeout: appConfig.ragRequestTimeoutMs,
        },
        abortSignal: signal,
      },
    });

    return embedResponse?.embeddings?.[0]?.values || [];
  }, appConfig.ragRequestRetries);
}

async function startAnswerStream(message, historyContext, contextSnippets, aiClient, appConfig, signal) {
  return withTransientRetries('Gemini answer stream start', () => aiClient.models.generateContentStream({
    model: 'gemini-2.5-flash',
    config: {
      systemInstruction: buildSystemInstruction(contextSnippets),
      httpOptions: {
        timeout: appConfig.answerTimeoutMs,
      },
      abortSignal: signal,
    },
    contents: [
      {
        role: 'user',
        parts: [{ text: `Previous Conversation:\n${historyContext || 'None'}\n\nQuestion: ${message}` }],
      },
    ],
  }), appConfig.ragRequestRetries);
}

  app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

  app.get('/styles.css', (req, res) => {
    res.sendFile(path.join(__dirname, 'styles.css'));
  });

  app.get('/chat-contract.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'chat-contract.js'));
  });

  app.get('/chat-request-owner.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'chat-request-owner.js'));
  });

  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      configured: appMissingEnvVars.length === 0 && Boolean(aiClient && pineconeIndexClient),
      missingEnvVars: appMissingEnvVars,
    });
  });

  app.post('/api/chat', chatRateLimiter, async (req, res) => {
    const rawMessage = req.body?.message;
    const message = cleanPlainText(rawMessage, MAX_MESSAGE_CHARS + 1);

    if (!message) {
      return res.status(400).json({ error: 'Message is required.' });
    }
    if (message.length > MAX_MESSAGE_CHARS) {
      return res.status(400).json({
        error: `Message must be ${MAX_MESSAGE_CHARS} characters or less.`,
      });
    }

    let history;
    try {
      history = normalizeHistory(req.body?.history === undefined ? [] : req.body.history);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    const queryCacheKey = getQueryCacheKey(message, history);
    const cachedResponse = queryCache.get(queryCacheKey);
    if (cachedResponse) {
      return writeCachedResponse(res, cachedResponse);
    }

    if (appMissingEnvVars.length > 0 || !aiClient || !pineconeIndexClient) {
      return res.status(503).json({ error: 'Chat service is not configured.' });
    }
    if (activeGenerations >= appConfig.maxConcurrentGenerations) {
      res.setHeader('Retry-After', '5');
      return res.status(429).json({ error: 'Chat service is busy. Please try again shortly.' });
    }

    if (isAbusive(message)) {
      const answer = 'Please keep the conversation respectful. I can help with Poornima-related questions.';
      setSseHeaders(res);
      writeSse(res, 'sources', { sources: [] });
      writeSse(res, 'token', { text: answer });
      writeSse(res, 'done', { answer, sources: [] });
      return res.end();
    }

    activeGenerations += 1;
    const abortController = new AbortController();
    let clientDisconnected = false;
    let answerTimedOut = false;
    let idleTimedOut = false;
    let answerDeadline;
    let idleTimeout;
    let heartbeat;
    let released = false;
    const releaseGeneration = () => {
      if (released) return;
      released = true;
      activeGenerations = Math.max(0, activeGenerations - 1);
    };
    const onResponseClose = () => {
      if (!res.writableEnded) {
        clientDisconnected = true;
        abortController.abort(new Error('Client disconnected.'));
      }
    };

    res.on('close', onResponseClose);

    try {
      const queryVector = await createQueryEmbedding(
        message,
        aiClient,
        appConfig,
        abortController.signal
      );
      if (!Array.isArray(queryVector) || queryVector.length === 0) {
        return res.status(502).json({ error: 'Unable to prepare the request. Please try again.' });
      }
      if (abortController.signal.aborted) return;

      const queryResponse = await pineconeRequestSignalStorage.run(
        abortController.signal,
        () => pineconeIndexClient.query({
          topK: appConfig.ragTopK,
          vector: queryVector,
          includeMetadata: true,
        })
      );

      const matches = Array.isArray(queryResponse?.matches) ? queryResponse.matches : [];
      const relevantMatches = filterRelevantMatches(matches, appConfig.ragMinScore);
      const contextSnippets = buildContextSnippets(relevantMatches);
      const historyContext = buildHistoryContext(history);
      const sources = buildSources(relevantMatches);

      const resetIdleTimeout = () => {
        clearTimeout(idleTimeout);
        idleTimeout = setTimeout(() => {
          idleTimedOut = true;
          abortController.abort(new Error('Answer stream idle timeout.'));
        }, appConfig.answerIdleTimeoutMs);
        idleTimeout.unref?.();
      };
      answerDeadline = setTimeout(() => {
        answerTimedOut = true;
        abortController.abort(new Error('Answer deadline exceeded.'));
      }, appConfig.answerTimeoutMs);
      answerDeadline.unref?.();
      resetIdleTimeout();

      const stream = await startAnswerStream(
        message,
        historyContext,
        contextSnippets,
        aiClient,
        appConfig,
        abortController.signal
      );
      if (clientDisconnected || abortController.signal.aborted) return;

      setSseHeaders(res);
      heartbeat = setInterval(() => {
        if (!res.destroyed && !res.writableEnded) {
          res.write(': heartbeat\n\n');
          res.flush?.();
        }
      }, 15000);
      heartbeat.unref?.();
      writeSse(res, 'sources', { sources });

      let answer = '';
      let answerLimitReached = false;
      for await (const chunk of stream) {
        if (abortController.signal.aborted || res.destroyed || res.writableEnded) break;

        const remainingChars = MAX_ANSWER_CHARS - answer.length;
        const text = cleanStreamText(chunk?.text, remainingChars);
        if (!text) {
          if (remainingChars <= 0) {
            answerLimitReached = true;
            break;
          }
          continue;
        }

        answer += text;
        writeSse(res, 'token', { text });
        resetIdleTimeout();
        if (answer.length >= MAX_ANSWER_CHARS) {
          answerLimitReached = true;
          break;
        }
      }

      if (clientDisconnected || res.destroyed || res.writableEnded) return;
      if (answerTimedOut || idleTimedOut) {
        writeSse(res, 'error', { error: 'The response took too long. Please try again.' });
        return res.end();
      }

      if (!answer) {
        answer = 'I could not generate a response. Please try again.';
        writeSse(res, 'token', { text: answer });
      }
      storeCachedResponse(queryCacheKey, { answer, sources });
      writeSse(res, 'done', { answer, sources, truncated: answerLimitReached });
      res.end();
    } catch (error) {
      if (clientDisconnected || res.destroyed || res.writableEnded) return;
      const upstreamFailure = answerTimedOut || idleTimedOut
        ? { status: 504, message: 'The response took too long. Please try again.' }
        : classifyUpstreamError(error);
      console.error('Chat request failed', {
        requestId: req.requestId,
        errorName: error?.name || 'Error',
        status: upstreamFailure.status,
      });
      if (res.headersSent) {
        writeSse(res, 'error', {
          error: upstreamFailure.message,
          status: upstreamFailure.status,
          retryAfter: upstreamFailure.retryAfter,
        });
        return res.end();
      }
      if (upstreamFailure.retryAfter) {
        res.setHeader('Retry-After', String(upstreamFailure.retryAfter));
      }
      return res.status(upstreamFailure.status).json({ error: upstreamFailure.message });
    } finally {
      clearTimeout(answerDeadline);
      clearTimeout(idleTimeout);
      clearInterval(heartbeat);
      res.off('close', onResponseClose);
      releaseGeneration();
    }
  });

  app.post('/api/feedback', feedbackRateLimiter, (req, res) => {
    const rating = req.body?.rating;
    const rawMessageId = req.body?.messageId;
    const rawQuestion = req.body?.question;
    const rawAnswer = req.body?.answer;
    const rawSources = req.body?.sources;

    if (typeof rating !== 'string' || !['up', 'down'].includes(rating)) {
      return res.status(400).json({ error: 'Feedback rating must be "up" or "down".' });
    }
    if (rawMessageId !== undefined && (typeof rawMessageId !== 'string' || rawMessageId.length > 200)) {
      return res.status(400).json({ error: 'Feedback message ID is invalid.' });
    }
    if (rawQuestion !== undefined && (typeof rawQuestion !== 'string' || rawQuestion.length > MAX_MESSAGE_CHARS)) {
      return res.status(400).json({ error: `Feedback question must be ${MAX_MESSAGE_CHARS} characters or less.` });
    }
    if (rawAnswer !== undefined && (typeof rawAnswer !== 'string' || rawAnswer.length > MAX_ANSWER_CHARS)) {
      return res.status(400).json({ error: `Feedback answer must be ${MAX_ANSWER_CHARS} characters or less.` });
    }
    if (rawSources !== undefined && (!Array.isArray(rawSources) || rawSources.length > 5)) {
      return res.status(400).json({ error: 'Feedback sources must contain at most five entries.' });
    }

    const sources = [];
    for (const source of rawSources || []) {
      if (!source || typeof source !== 'object' || Array.isArray(source)) {
        return res.status(400).json({ error: 'Feedback source metadata is invalid.' });
      }
      const fields = ['id', 'title', 'url'];
      if (fields.some((field) => source[field] !== undefined &&
        (typeof source[field] !== 'string' || source[field].length > 2048))) {
        return res.status(400).json({ error: 'Feedback source metadata is too large.' });
      }
      let url = cleanPlainText(source.url, 2048);
      try {
        const parsedUrl = new URL(url);
        url = ['http:', 'https:'].includes(parsedUrl.protocol) ? parsedUrl.toString() : '';
      } catch (error) {
        url = '';
      }
      sources.push({
        id: cleanPlainText(source.id, 200),
        title: cleanPlainText(source.title, 500),
        url,
      });
    }

    const messageId = cleanPlainText(rawMessageId, 200);
    const question = cleanPlainText(rawQuestion, MAX_MESSAGE_CHARS);
    const answer = cleanPlainText(rawAnswer, MAX_ANSWER_CHARS);
    console.info('Feedback received', {
      requestId: req.requestId,
      rating,
      questionLength: question.length,
      answerLength: answer.length,
      sourceCount: sources.length,
    });
    res.json({ ok: true, messageId });
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) {
      return res.end();
    }

    if (error?.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Request body is too large.' });
    }
    if (error?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Request body must contain valid JSON.' });
    }

    console.error('Unhandled request error', {
      requestId: req.requestId,
      errorName: error?.name || 'Error',
    });
    return res.status(500).json({ error: 'Internal server error.' });
  });

  return app;
}

if (require.main === module) {
  const app = createApp();
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

    console.error('Server startup failed:', error?.name || 'Error');
    process.exit(1);
  });
}

module.exports = { createApp, createTimeoutFetch };
