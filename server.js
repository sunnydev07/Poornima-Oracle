require('dotenv').config();

const crypto = require('crypto');
const path = require('path');
const { AsyncLocalStorage } = require('node:async_hooks');
const express = require('express');
const compression = require('compression');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const xss = require('xss');
const NodeCache = require('node-cache');
const { GoogleGenAI } = require('@google/genai');
const { Pinecone } = require('@pinecone-database/pinecone');
const { fallbackRouter, DEFAULT_OLLAMA_HOST } = require('./services/fallback-router');
const { mcpManager } = require('./services/mcp-manager');
const cron = require('node-cron');
const { syncNotices, NOTICES_NAMESPACE } = require('./services/crawler/notice-sync');
const { getUpcomingCalendarEvents, getCalendarContextForPrompt } = require('./services/calendar-service');
const chatContract = require('./chat-contract');

const requiredEnvVars = ['GEMINI_API_KEY', 'PINECONE_API_KEY', 'PINECONE_INDEX_NAME'];
const noticeSyncCron = process.env.NOTICE_SYNC_CRON ? process.env.NOTICE_SYNC_CRON.trim() : '30 0 * * *'; // Default: 6:00 AM IST (00:30 UTC)
const noticeSyncEnabled = process.env.NOTICE_SYNC_ENABLED !== 'false'; // Default: true

const badWordsRegex = /\b(fuck|shit|bakwaas|behenchod|gandu)\b/i;
const MAX_HISTORY_MESSAGES = 4;
const MAX_MESSAGE_CHARS = 2000;
const MAX_CONTEXT_CHARS = 4000;
const MAX_ANSWER_CHARS = 12000;
const MAX_SOURCE_TITLE_CHARS = 2048;
const MAX_FEEDBACK_SOURCES = 5;
const ANSWER_HEARTBEAT_MS = 15000;
const REFUSAL_BUFFER_MAX = 220;
const TIMEOUT_ERROR_MESSAGE = 'The response took too long. Please try again.';
const BUSY_ERROR_MESSAGE = 'The assistant is busy. Please try again shortly.';
const PROVIDER_REQUEST_ERROR_MESSAGE = 'The assistant service could not process this request.';
const PLACEHOLDER_ANSWER = 'I could not generate a response. Please try again.';
const FALLBACK_PLACEHOLDER_ANSWER = 'I was unable to complete the request. Please consult https://poornima.edu.in.';

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

function getEnvTrim(name) {
  return process.env[name] ? process.env[name].trim() : '';
}

function parseCorsOrigins(value) {
  if (Array.isArray(value)) {
    return value.map((origin) => String(origin).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(',').map((origin) => origin.trim()).filter(Boolean);
  }
  return undefined;
}

function buildConfig(overrides = {}) {
  const baseConfig = {
    answerTimeoutMs: parsePositiveInteger(process.env.REQUEST_TIMEOUT_MS, 90000),
    answerIdleTimeoutMs: parsePositiveInteger(process.env.ANSWER_IDLE_TIMEOUT_MS, 30000),
    maxConcurrentGenerations: parsePositiveInteger(process.env.MAX_CONCURRENT_GENERATIONS, 5),
    trustProxyHops: parseBoundedInteger(process.env.TRUST_PROXY_HOPS, 0, 0, 10),
    chatRateLimitMax: parsePositiveInteger(process.env.CHAT_RATE_LIMIT_MAX, 20),
    chatRateLimitWindowMs: parsePositiveInteger(process.env.RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
    feedbackRateLimitMax: parsePositiveInteger(process.env.FEEDBACK_RATE_LIMIT_MAX, 30),
    feedbackRateLimitWindowMs: parsePositiveInteger(process.env.FEEDBACK_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
    cacheMaxKeys: parsePositiveInteger(process.env.CACHE_MAX_KEYS, 1000),
    corsOrigins: parseCorsOrigins(process.env.CORS_ORIGIN),
    ragRequestRetries: parseBoundedInteger(process.env.RAG_REQUEST_RETRIES, 2, 0, 5),
    ragRequestTimeoutMs: parsePositiveInteger(process.env.RAG_REQUEST_TIMEOUT_MS, 15000),
    ragTopK: parseBoundedInteger(process.env.RAG_TOP_K, 6, 1, 8),
    ragMinScore: parseBoundedNumber(process.env.RAG_MIN_SCORE, 0.35, 0, 1),
    queryCacheTtlSeconds: parsePositiveInteger(process.env.QUERY_CACHE_TTL_SECONDS, 3600),
    embeddingModel: getEnvTrim('GEMINI_EMBEDDING_MODEL') || 'gemini-embedding-001',
    chatModel: getEnvTrim('GEMINI_MODEL') || 'gemini-3.5-flash',
    pineconeNamespace: getEnvTrim('PINECONE_NAMESPACE'),
    pineconeIndexName: getEnvTrim('PINECONE_INDEX_NAME'),
  };

  const definedOverrides = {};
  for (const [key, value] of Object.entries(overrides || {})) {
    if (value !== undefined) {
      definedOverrides[key] = value;
    }
  }

  return { ...baseConfig, ...definedOverrides };
}

function getMissingEnvVars() {
  return requiredEnvVars.filter(
    (envVar) => !process.env[envVar] || !process.env[envVar].trim()
  );
}

function getAllowedOllamaHost(rawHost) {
  if (typeof rawHost !== 'string' || !rawHost.trim()) {
    return '';
  }

  let parsed;
  try {
    parsed = new URL(rawHost.trim());
  } catch {
    return '';
  }

  if (parsed.protocol !== 'https:') {
    return '';
  }

  let configuredHostname = 'ollama.com';
  try {
    configuredHostname = new URL(process.env.OLLAMA_HOST || DEFAULT_OLLAMA_HOST).hostname.toLowerCase();
  } catch {
    // Keep the default allowlist entry.
  }

  const allowedHostnames = new Set([configuredHostname, 'ollama.com']);
  if (!allowedHostnames.has(parsed.hostname.toLowerCase())) {
    console.warn('Rejected disallowed x-ollama-host override:', parsed.hostname);
    return '';
  }

  return parsed.origin;
}

function combineAbortSignals(signals) {
  const activeSignals = signals.filter(
    (signal) => signal && typeof signal.addEventListener === 'function'
  );
  if (activeSignals.length === 0) {
    return undefined;
  }
  if (activeSignals.length === 1) {
    return activeSignals[0];
  }
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any(activeSignals);
  }

  const controller = new AbortController();
  for (const signal of activeSignals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

function createTimeoutFetch(timeoutMs, requestSignalStorage) {
  return async (url, init = {}) => {
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => {
      timeoutController.abort(new Error(`Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref?.();

    const storedSignal = requestSignalStorage && typeof requestSignalStorage.getStore === 'function'
      ? requestSignalStorage.getStore()
      : null;
    const signal = combineAbortSignals([init.signal, storedSignal, timeoutController.signal]);

    let response;
    try {
      response = await fetch(url, {
        ...init,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      clearTimeout(timeout);
      throw error;
    }

    if (!response.body) {
      clearTimeout(timeout);
      return response;
    }

    // Keep the timeout armed while the body is consumed so a stalled body read
    // fails too, and clear it when the wrapped stream finishes or is cancelled.
    const body = response.body.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(chunk);
      },
      flush() {
        clearTimeout(timeout);
      },
      cancel() {
        clearTimeout(timeout);
      },
    }));

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

function createDefaultAi() {
  const geminiApiKey = getEnvTrim('GEMINI_API_KEY');
  return geminiApiKey ? new GoogleGenAI({ apiKey: geminiApiKey }) : null;
}

function createDefaultPineconeIndex(config, requestSignalStorage) {
  const pineconeApiKey = getEnvTrim('PINECONE_API_KEY');
  const pineconeIndexName = config.pineconeIndexName || getEnvTrim('PINECONE_INDEX_NAME');
  if (!pineconeApiKey || !pineconeIndexName) {
    return null;
  }

  // Pinecone treats 0 as "use default retries"; -1 forces a single attempt.
  const maxRetries = config.ragRequestRetries > 0 ? config.ragRequestRetries : -1;
  const pinecone = new Pinecone({
    apiKey: pineconeApiKey,
    fetchApi: createTimeoutFetch(config.ragRequestTimeoutMs, requestSignalStorage),
    maxRetries,
  });
  return pinecone.index(pineconeIndexName);
}

function createBoundedQueryCache(config) {
  const store = new NodeCache({
    stdTTL: config.queryCacheTtlSeconds,
    checkperiod: 120,
    useClones: true,
  });
  const insertionOrder = [];
  const maxKeys = Math.max(1, Number(config.cacheMaxKeys) || 1);

  return {
    get(key) {
      return store.get(key);
    },
    set(key, value) {
      const existingIndex = insertionOrder.indexOf(key);
      if (existingIndex >= 0) {
        insertionOrder.splice(existingIndex, 1);
      }
      while (insertionOrder.length >= maxKeys) {
        const oldestKey = insertionOrder.shift();
        if (oldestKey !== undefined) {
          store.del(oldestKey);
        }
      }
      insertionOrder.push(key);
      return store.set(key, value);
    },
    del(key) {
      const index = insertionOrder.indexOf(key);
      if (index >= 0) {
        insertionOrder.splice(index, 1);
      }
      return store.del(key);
    },
    flushAll() {
      insertionOrder.length = 0;
      return store.flushAll();
    },
  };
}

function validateApiKeyFormat(key, name, minLength) {
  if (!key) return { valid: false, reason: 'not set or empty' };
  if (key.length < minLength) return { valid: false, reason: `too short (${key.length} chars, expected at least ${minLength})` };
  const validPattern = /^[A-Za-z0-9._-]+$/;
  if (!validPattern.test(key)) return { valid: false, reason: 'contains invalid characters (only alphanumeric, dot, underscore, and hyphen allowed)' };
  return { valid: true };
}

function validateApiKeysAtStartup() {
  const issues = [];

  const geminiValidation = validateApiKeyFormat(getEnvTrim('GEMINI_API_KEY'), 'GEMINI_API_KEY', 20);
  if (!geminiValidation.valid) {
    issues.push(`GEMINI_API_KEY is ${geminiValidation.reason}`);
  }

  const pineconeValidation = validateApiKeyFormat(getEnvTrim('PINECONE_API_KEY'), 'PINECONE_API_KEY', 20);
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
  const errorStatus = getErrorStatus(error);
  if (errorStatus === 400) {
    return { isApiKeyError: false };
  }

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
    errorMessage.includes('key is invalid')
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
  // Inspect every candidate so a non-numeric `code` (e.g. "ECONNRESET")
  // cannot mask a numeric `response.status`.
  const candidates = [error?.status, error?.code, error?.response?.status];
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined || candidate === '') {
      continue;
    }
    const parsed = typeof candidate === 'number'
      ? candidate
      : Number.parseInt(String(candidate), 10);
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }
  return null;
}

function isAbortOrTimeoutError(error) {
  if (!error) {
    return false;
  }
  const name = String(error.name || '').toLowerCase();
  const code = String(error.code || '').toLowerCase();
  const message = String(error.message || error).toLowerCase();
  return (
    name === 'aborterror' ||
    name === 'timeouterror' ||
    code === 'abort_err' ||
    code === 'aborted' ||
    code === 'request_timeout' ||
    message.includes('aborted') ||
    message.includes('timeout') ||
    message.includes('timed out')
  );
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

async function withTransientRetries(retries, operationName, operation) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (
        attempt >= retries ||
        isAbortOrTimeoutError(error) ||
        !isTransientError(error)
      ) {
        throw error;
      }

      const delayMs = Math.min(250 * 2 ** attempt, 2000);
      console.warn(
        `${operationName} failed: ${error?.message || error}. ` +
        `Retrying in ${delayMs}ms (${attempt + 1}/${retries}).`
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

function createRequestTimeoutError() {
  const error = new Error('The response took too long.');
  error.name = 'TimeoutError';
  error.code = 'REQUEST_TIMEOUT';
  return error;
}

function getRecentHistoryEntries(history, currentMessage = '') {
  if (!Array.isArray(history) || history.length === 0) {
    return [];
  }

  let cleanHistory = chatContract.normalizeHistory(history);

  if (cleanHistory.length > 0 && typeof currentMessage === 'string' && currentMessage.trim()) {
    const last = cleanHistory[cleanHistory.length - 1];
    if (last.role === 'user' && last.content.trim() === chatContract.cleanPlainText(currentMessage).trim()) {
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
    .map((match) => chatContract.cleanPlainText(match?.metadata?.text, MAX_CONTEXT_CHARS))
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
      // Skip unsafe schemes (e.g. javascript:) and fall through to the next
      // URL-bearing metadata key, such as `link`.
      const rawUrl = ['url', 'link']
        .map((key) => sanitizeText(metadata[key]))
        .find((candidate) => candidate && looksLikeUrl(candidate)) || '';
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

function filterRelevantMatches(matches, minScore) {
  return matches.filter((match) => (
    typeof match?.score === 'number' &&
    Number.isFinite(match.score) &&
    match.score >= minScore
  ));
}

function writeSse(res, event, payload) {
  if (res.destroyed || res.writableEnded) {
    return;
  }

  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    res.flush?.();
  } catch {
    // The client disconnected between the state check and the write.
  }
}

function endResponseQuietly(res) {
  if (!res.writableEnded && !res.destroyed) {
    res.end();
  }
}

function sendJson(res, statusCode, payload) {
  if (res.destroyed || res.writableEnded || res.headersSent) {
    return false;
  }
  res.status(statusCode).json(payload);
  return true;
}

function setSseHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
}

function startAnswerHeartbeat(res) {
  const timer = setInterval(() => {
    if (!res.destroyed && !res.writableEnded) {
      try {
        res.write(': ping\n\n');
      } catch {
        // Ignore a write racing with a client disconnect.
      }
    }
  }, ANSWER_HEARTBEAT_MS);
  timer.unref?.();
  return timer;
}

function stopAnswerHeartbeat(timer) {
  if (timer) {
    clearInterval(timer);
  }
}

function normalizeForCache(value) {
  return chatContract.cleanPlainText(value, MAX_MESSAGE_CHARS)
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function getQueryCacheKey(message, history, profile = null) {
  const payload = {
    v: 4,
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
  endResponseQuietly(res);
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

async function streamFallbackResponse(deps, res, {
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
  const { queryCache } = deps;
  if (!res.headersSent) {
    setSseHeaders(res);
  }

  const heartbeatTimer = startAnswerHeartbeat(res);
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
      endResponseQuietly(res);
      return;
    }

    const finalAnswer = (result?.answer || fallbackAnswer).trim() || FALLBACK_PLACEHOLDER_ANSWER;
    const sources = Array.isArray(result?.sources) && result.sources.length > 0
      ? result.sources
      : initialSources;
    const provider = result?.provider || 'Fallback Cloud Agent';

    if (sources.length > 0) {
      writeSse(res, 'sources', { sources });
    }

    if (
      queryCacheKey &&
      result &&
      result.success !== false &&
      finalAnswer !== FALLBACK_PLACEHOLDER_ANSWER
    ) {
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
    endResponseQuietly(res);
  } catch (fallbackError) {
    console.error('Error during fallback streaming:', fallbackError);
    if (!res.writableEnded && !res.destroyed) {
      writeSse(res, 'error', { error: 'Failed to process the query via fallback services.' });
      endResponseQuietly(res);
    }
  } finally {
    stopAnswerHeartbeat(heartbeatTimer);
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

async function createQueryEmbedding(deps, message) {
  const { ai, config, pineconeRequestSignalStorage } = deps;
  return withTransientRetries(config.ragRequestRetries, 'Gemini embedding', async () => {
    const abortController = createRequestAbortController(config.ragRequestTimeoutMs);
    const requestSignal = pineconeRequestSignalStorage.getStore();
    const combinedSignal = combineAbortSignals([abortController.signal, requestSignal]);
    try {
      const embedResponse = await ai.models.embedContent({
        model: config.embeddingModel,
        contents: message,
        config: {
          outputDimensionality: 768,
          httpOptions: {
            timeout: config.ragRequestTimeoutMs,
          },
          abortSignal: combinedSignal,
        },
      });

      return embedResponse?.embeddings?.[0]?.values || [];
    } finally {
      abortController.clear();
    }
  });
}

async function startAnswerStream(deps, message, historyContext, contextSnippets, profile, externalSignal) {
  const { ai, config } = deps;
  const abortController = createRequestAbortController(config.ragRequestTimeoutMs);
  const combinedSignal = combineAbortSignals([externalSignal, abortController.signal]);
  const modelsToTry = [config.chatModel, 'gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.0-flash']
    .filter((m, i, arr) => arr.indexOf(m) === i);
  let lastError;
  try {
    for (const modelName of modelsToTry) {
      try {
        return await ai.models.generateContentStream({
          model: modelName,
          config: {
            systemInstruction: buildSystemInstruction(contextSnippets, profile),
            httpOptions: {
              timeout: config.ragRequestTimeoutMs,
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
      } catch (err) {
        lastError = err;
        const status = getErrorStatus(err);
        // Throttling, malformed requests, and aborts are not model-availability
        // failures: surface them immediately instead of walking the model chain.
        if (status === 429 || status === 400 || isAbortOrTimeoutError(err)) {
          throw err;
        }
        console.warn(`Model ${modelName} failed to start stream:`, err?.message || err);
      }
    }
    throw lastError;
  } finally {
    abortController.clear();
  }
}

function acquireGenerationPermit(deps) {
  if (deps.activeGenerations >= deps.config.maxConcurrentGenerations) {
    return false;
  }
  deps.activeGenerations += 1;
  return true;
}

function releaseGenerationPermit(deps, permitState) {
  if (!permitState.acquired) {
    return;
  }
  permitState.acquired = false;
  deps.activeGenerations = Math.max(0, deps.activeGenerations - 1);
}

async function handleChatRequest(deps, req, res) {
  const {
    ai,
    pineconeIndex,
    queryCache,
    missingEnvVars,
    config,
    pineconeRequestSignalStorage,
  } = deps;

  const clientAbortController = new AbortController();
  const permitState = { acquired: false };
  let clientDisconnected = false;
  let timedOut = false;
  let overallTimer = null;
  let idleTimer = null;
  let heartbeatTimer = null;

  const abortForDisconnect = () => {
    if (res.writableEnded) {
      return;
    }
    clientDisconnected = true;
    if (!clientAbortController.signal.aborted) {
      clientAbortController.abort(new Error('Client disconnected.'));
    }
  };

  // `req` emits 'close' once its body has been fully consumed, so only treat it
  // as a disconnect when the request itself never completed. The response's
  // 'close' fires on real client aborts.
  const onRequestClose = () => {
    if (req.complete === false) {
      abortForDisconnect();
    }
  };
  const onResponseClose = () => {
    if (!res.writableEnded) {
      abortForDisconnect();
    }
  };
  req.on('close', onRequestClose);
  res.on('close', onResponseClose);

  const markTimedOut = () => {
    if (clientDisconnected || timedOut) {
      return;
    }
    timedOut = true;
    if (!clientAbortController.signal.aborted) {
      clientAbortController.abort(createRequestTimeoutError());
    }
  };

  const clearIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
  const resetIdleTimer = () => {
    clearIdleTimer();
    if (config.answerIdleTimeoutMs > 0) {
      idleTimer = setTimeout(markTimedOut, config.answerIdleTimeoutMs);
      idleTimer.unref?.();
    }
  };
  const startOverallTimer = () => {
    if (config.answerTimeoutMs > 0 && !overallTimer) {
      overallTimer = setTimeout(markTimedOut, config.answerTimeoutMs);
      overallTimer.unref?.();
    }
  };
  const stopHeartbeat = () => {
    if (heartbeatTimer) {
      stopAnswerHeartbeat(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  try {
    return await pineconeRequestSignalStorage.run(clientAbortController.signal, async () => {
      let message = '';
      let history = [];
      let profile = null;
      let queryCacheKey = null;
      let currentFallbackRouter = fallbackRouter;

      try {
        message = chatContract.cleanPlainText(req.body?.message, MAX_MESSAGE_CHARS);
        history = Array.isArray(req.body?.history) ? req.body.history : [];
        profile = sanitizeProfile(req.body?.profile);

        const clientOpenRouterKey = req.headers['x-openrouter-key'] ? String(req.headers['x-openrouter-key']).trim().slice(0, 512) : '';
        const clientOllamaKey = req.headers['x-ollama-key'] ? String(req.headers['x-ollama-key']).trim().slice(0, 512) : '';
        const clientOllamaHost = getAllowedOllamaHost(req.headers['x-ollama-host']);
        const clientFallbackHeader = req.headers['x-fallback-enabled'] ? String(req.headers['x-fallback-enabled']).trim() : '';
        const fallbackEnabled = clientFallbackHeader ? clientFallbackHeader !== 'false' : undefined;
        // Provider credentials/hosts are client-supplied, so their answers must never
        // enter the shared query cache (otherwise one response can be served to all users).
        const hasProviderOverrides = Boolean(clientOpenRouterKey || clientOllamaKey || clientOllamaHost);
        queryCacheKey = message && !hasProviderOverrides
          ? getQueryCacheKey(message, history, profile)
          : null;

        currentFallbackRouter = fallbackRouter.withOverrides({
          ...(clientOpenRouterKey ? { openrouterApiKey: clientOpenRouterKey } : {}),
          ...(clientOllamaKey ? { ollamaApiKey: clientOllamaKey } : {}),
          ...(clientOllamaHost ? { ollamaHost: clientOllamaHost } : {}),
          ...(fallbackEnabled !== undefined ? { enabled: fallbackEnabled } : {}),
        });

        if (!message) {
          return sendJson(res, 400, { error: 'Message is required.' });
        }

        if (message.length > MAX_MESSAGE_CHARS) {
          return sendJson(res, 400, {
            error: `Message must be ${MAX_MESSAGE_CHARS} characters or less.`,
          });
        }

        const cachedResponse = queryCacheKey ? queryCache.get(queryCacheKey) : null;
        if (cachedResponse) {
          return writeCachedResponse(res, cachedResponse);
        }

        if (!acquireGenerationPermit(deps)) {
          res.set('Retry-After', '5');
          return sendJson(res, 429, { error: 'Chat service is busy. Please try again shortly.' });
        }
        permitState.acquired = true;

        if (missingEnvVars.length > 0 || !ai || !pineconeIndex) {
          if (currentFallbackRouter.isConfigured()) {
            return streamFallbackResponse(deps, res, {
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
          return sendJson(res, 503, {
            error: `Server is missing required environment variables: ${missingEnvVars.join(', ')}.`,
          });
        }

        if (isAbusive(message)) {
          setSseHeaders(res);
          const answer = 'Please keep the conversation respectful and campus-related. How can I assist you with Poornima academic or administrative queries?';
          writeSse(res, 'sources', { sources: [] });
          writeSse(res, 'token', { text: answer });
          writeSse(res, 'done', { answer, sources: [] });
          return endResponseQuietly(res);
        }

        let queryVector;
        try {
          queryVector = await createQueryEmbedding(deps, message);
        } catch (embedError) {
          if (clientDisconnected) {
            return endResponseQuietly(res);
          }
          if (timedOut || isAbortOrTimeoutError(embedError)) {
            throw embedError;
          }
          console.warn('Embedding generation failed:', embedError?.message || embedError);
          if (currentFallbackRouter.isConfigured()) {
            return streamFallbackResponse(deps, res, {
              message,
              history,
              contextSnippets: '',
              profile,
              reason: 'embedding_error',
              clientAbortController,
              queryCacheKey,
              router: currentFallbackRouter,
            });
          }
          return sendJson(res, 502, { error: 'Failed to generate an embedding for the query.' });
        }

        if (clientDisconnected) {
          return endResponseQuietly(res);
        }
        if (timedOut) {
          throw createRequestTimeoutError();
        }

        if (!Array.isArray(queryVector) || queryVector.length === 0) {
          if (currentFallbackRouter.isConfigured()) {
            return streamFallbackResponse(deps, res, {
              message,
              history,
              contextSnippets: '',
              profile,
              reason: 'embedding_empty',
              clientAbortController,
              queryCacheKey,
              router: currentFallbackRouter,
            });
          }
          return sendJson(res, 502, { error: 'Failed to generate an embedding for the query.' });
        }

        let allMatches = [];
        try {
          // === RAG 2.0: Dual-Namespace Parallel Query ===
          // Query both the handbook (__default__) and notices namespaces concurrently
          const baseQueryOptions = {
            topK: config.ragTopK,
            vector: queryVector,
            includeMetadata: true,
          };

          const hasNamespaceApi = typeof pineconeIndex.namespace === 'function';
          let handbookMatches = [];
          let noticeMatches = [];

          if (hasNamespaceApi) {
            const handbookIndex = config.pineconeNamespace
              ? pineconeIndex.namespace(config.pineconeNamespace)
              : pineconeIndex;

            const [handbookResult, noticesResult] = await Promise.allSettled([
              handbookIndex.query(baseQueryOptions),
              pineconeIndex.namespace(NOTICES_NAMESPACE).query(baseQueryOptions),
            ]);

            handbookMatches = handbookResult.status === 'fulfilled'
              ? (Array.isArray(handbookResult.value?.matches) ? handbookResult.value.matches : [])
              : [];
            noticeMatches = noticesResult.status === 'fulfilled'
              ? (Array.isArray(noticesResult.value?.matches) ? noticesResult.value.matches : [])
              : [];

            if (handbookResult.status === 'rejected') {
              console.warn('Handbook namespace query failed:', handbookResult.reason?.message || handbookResult.reason);
            }
            if (noticesResult.status === 'rejected') {
              console.warn('Notices namespace query failed:', noticesResult.reason?.message || noticesResult.reason);
            }
          } else {
            // Plain-object Pinecone mocks (and legacy single-index clients) do
            // not expose namespace(); query the default index only.
            const handbookResult = await pineconeIndex.query(baseQueryOptions);
            handbookMatches = Array.isArray(handbookResult?.matches) ? handbookResult.matches : [];
          }

          // Tag notice matches with portal-notice IDs for frontend badge rendering
          for (const match of noticeMatches) {
            if (match?.id && !match.id.startsWith('portal-notice-')) {
              match.id = `portal-notice-${match.id}`;
            }
          }

          // Combine and sort by cosine similarity score (descending)
          allMatches = [...handbookMatches, ...noticeMatches]
            .sort((a, b) => (b?.score || 0) - (a?.score || 0));

          console.log(`RAG 2.0: Handbook=${handbookMatches.length} + Notices=${noticeMatches.length} → ${allMatches.length} total matches`);
        } catch (pineconeError) {
          if (clientDisconnected) {
            return endResponseQuietly(res);
          }
          console.warn('Pinecone query failed:', pineconeError?.message || pineconeError);
          if (currentFallbackRouter.isConfigured()) {
            return streamFallbackResponse(deps, res, {
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

        if (clientDisconnected) {
          return endResponseQuietly(res);
        }
        if (timedOut) {
          throw createRequestTimeoutError();
        }

        const relevantMatches = filterRelevantMatches(allMatches, config.ragMinScore);
        const contextSnippets = buildContextSnippets(relevantMatches);
        const historyContext = buildHistoryContext(history, message);
        const sources = buildSources(relevantMatches);

        // Tier 2 #6: Grounding with official Academic Calendar & Exam Schedule
        let calendarContext = '';
        try {
          calendarContext = await deps.calendarContextForPrompt(profile?.college || 'ALL', 5);
        } catch (calErr) {
          console.warn('Calendar context lookup failed:', calErr?.message || calErr);
        }

        if (clientDisconnected) {
          return endResponseQuietly(res);
        }
        if (timedOut) {
          throw createRequestTimeoutError();
        }

        const combinedSnippets = calendarContext
          ? (contextSnippets ? `${calendarContext}\n\n${contextSnippets}` : calendarContext)
          : contextSnippets;

        if (calendarContext) {
          // Keep retrieved document sources first so citations stay stable.
          sources.push({
            id: 'live-academic-calendar',
            title: 'Poornima Academic Calendar (Live Feed)',
            url: 'https://calendar.google.com',
            score: 0.95,
            category: 'Academic Calendar',
            college: profile?.college || 'ALL',
          });
        }

        // Trigger Condition: Knowledge gap (no relevant matches with score >= RAG_MIN_SCORE AND no calendar context)
        if (relevantMatches.length === 0 && !calendarContext && currentFallbackRouter.isConfigured()) {
          console.log(`Knowledge gap detected: 0 matches with score >= ${config.ragMinScore}. Escalating to Fallback Router.`);
          return streamFallbackResponse(deps, res, {
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

        startOverallTimer();

        let stream;
        try {
          stream = await startAnswerStream(
            deps,
            message,
            historyContext,
            combinedSnippets,
            profile,
            clientAbortController.signal
          );
        } catch (geminiError) {
          if (clientDisconnected) {
            return endResponseQuietly(res);
          }
          if (timedOut || isAbortOrTimeoutError(geminiError)) {
            throw geminiError;
          }

          const providerStatus = getErrorStatus(geminiError);
          if (providerStatus === 429) {
            res.set('Retry-After', '30');
            return sendJson(res, 429, { error: BUSY_ERROR_MESSAGE });
          }
          if (providerStatus === 400) {
            return sendJson(res, 502, { error: PROVIDER_REQUEST_ERROR_MESSAGE });
          }

          console.warn('Primary Gemini stream start failed:', geminiError?.message || geminiError);
          if (currentFallbackRouter.isConfigured()) {
            console.log('Gemini start failed. Escalating to Fallback Router.');
            return streamFallbackResponse(deps, res, {
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

        if (clientDisconnected) {
          return endResponseQuietly(res);
        }
        if (timedOut) {
          throw createRequestTimeoutError();
        }
        if (clientAbortController.signal.aborted) {
          return endResponseQuietly(res);
        }

        setSseHeaders(res);
        writeSse(res, 'sources', { sources });
        heartbeatTimer = startAnswerHeartbeat(res);
        resetIdleTimer();

        let answer = '';
        let refusalBuffer = '';
        let refusalChecked = false;

        try {
          for await (const chunk of stream) {
            // Reset on every chunk, including empty text chunks.
            resetIdleTimer();

            if (timedOut) {
              break;
            }
            if (clientDisconnected) {
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
                stopHeartbeat();
                return streamFallbackResponse(deps, res, {
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
        } catch (streamError) {
          if (clientDisconnected) {
            return endResponseQuietly(res);
          }
          if (timedOut || isAbortOrTimeoutError(streamError)) {
            if (!res.destroyed && !res.writableEnded) {
              writeSse(res, 'error', { error: TIMEOUT_ERROR_MESSAGE });
              endResponseQuietly(res);
            }
            return;
          }
          throw streamError;
        } finally {
          clearIdleTimer();
        }

        if (timedOut) {
          if (!res.destroyed && !res.writableEnded) {
            writeSse(res, 'error', { error: TIMEOUT_ERROR_MESSAGE });
            endResponseQuietly(res);
          }
          return;
        }
        if (clientDisconnected || clientAbortController.signal.aborted) {
          return endResponseQuietly(res);
        }

        // Check refusal on short responses (< REFUSAL_BUFFER_MAX)
        if (!refusalChecked && refusalBuffer) {
          if (currentFallbackRouter.isConfigured() && isRefusalResponse(refusalBuffer)) {
            console.log('Short refusal response detected from Gemini. Escalating to Fallback Router.');
            stopHeartbeat();
            return streamFallbackResponse(deps, res, {
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

        answer = answer.trim() || PLACEHOLDER_ANSWER;
        if (queryCacheKey && answer !== PLACEHOLDER_ANSWER) {
          queryCache.set(queryCacheKey, { answer, sources });
        }
        writeSse(res, 'done', { answer, sources });
        endResponseQuietly(res);
      } catch (error) {
        if (clientDisconnected) {
          endResponseQuietly(res);
          return;
        }

        if (timedOut || isAbortOrTimeoutError(error)) {
          if (res.headersSent) {
            writeSse(res, 'error', { error: TIMEOUT_ERROR_MESSAGE });
            endResponseQuietly(res);
          } else {
            sendJson(res, 504, { error: TIMEOUT_ERROR_MESSAGE });
          }
          return;
        }

        const providerStatus = getErrorStatus(error);
        if (providerStatus === 429) {
          if (res.headersSent) {
            writeSse(res, 'error', { error: BUSY_ERROR_MESSAGE });
            endResponseQuietly(res);
          } else {
            res.set('Retry-After', '30');
            sendJson(res, 429, { error: BUSY_ERROR_MESSAGE });
          }
          return;
        }
        if (providerStatus === 400) {
          if (res.headersSent) {
            writeSse(res, 'error', { error: PROVIDER_REQUEST_ERROR_MESSAGE });
            endResponseQuietly(res);
          } else {
            sendJson(res, 502, { error: PROVIDER_REQUEST_ERROR_MESSAGE });
          }
          return;
        }

        if (!res.headersSent && currentFallbackRouter.isConfigured()) {
          console.warn('Recovering from error in /api/chat via Fallback Router:', error?.message || error);
          return streamFallbackResponse(deps, res, {
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
            endResponseQuietly(res);
            return;
          }

          sendJson(res, 401, {
            error: `API key error with ${apiKeyError.service}: ${apiKeyError.reason}. Please check server console for details.`,
          });
          return;
        }
        console.error('Error in /api/chat:', error);
        const userFacingError = error?.message ? `Failed to process query: ${error.message}` : 'Failed to process the query.';
        if (res.headersSent) {
          writeSse(res, 'error', { error: userFacingError });
          endResponseQuietly(res);
        } else {
          sendJson(res, 500, { error: userFacingError });
        }
      } finally {
        clearIdleTimer();
        if (overallTimer) {
          clearTimeout(overallTimer);
          overallTimer = null;
        }
        stopHeartbeat();
        releaseGenerationPermit(deps, permitState);
      }
    });
  } finally {
    req.off('close', onRequestClose);
    res.off('close', onResponseClose);
  }
}

function getProvidedAdminKey(req) {
  const adminKeyHeader = req.headers['x-admin-key'];
  const authorizationHeader = req.headers.authorization;
  const rawKey = adminKeyHeader
    ? String(adminKeyHeader)
    : (typeof authorizationHeader === 'string' ? authorizationHeader.replace('Bearer ', '') : '');
  return rawKey.trim();
}

function timingSafeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left ?? ''), 'utf8');
  const rightBuffer = Buffer.from(String(right ?? ''), 'utf8');
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function createApp(options = {}) {
  const config = buildConfig(options.config);
  const corsOrigins = parseCorsOrigins(config.corsOrigins);
  const pineconeRequestSignalStorage = options.pineconeRequestSignalStorage || new AsyncLocalStorage();
  const ai = Object.prototype.hasOwnProperty.call(options, 'ai') ? options.ai : createDefaultAi();
  const pineconeIndex = Object.prototype.hasOwnProperty.call(options, 'pineconeIndex')
    ? options.pineconeIndex
    : createDefaultPineconeIndex(config, pineconeRequestSignalStorage);
  const missingEnvVars = Array.isArray(options.missingEnvVars)
    ? options.missingEnvVars
    : getMissingEnvVars();
  const queryCache = options.queryCache || createBoundedQueryCache(config);
  const adminApiKey = Object.prototype.hasOwnProperty.call(options, 'adminApiKey')
    ? String(options.adminApiKey || '').trim()
    : getEnvTrim('ADMIN_API_KEY');
  // Injectable so API tests never reach the live Google Calendar feed.
  const calendarContextForPrompt = typeof options.calendarContextForPrompt === 'function'
    ? options.calendarContextForPrompt
    : getCalendarContextForPrompt;

  const deps = {
    ai,
    pineconeIndex,
    queryCache,
    missingEnvVars,
    config,
    pineconeRequestSignalStorage,
    adminApiKey,
    calendarContextForPrompt,
    activeGenerations: 0,
  };

  const app = express();
  app.set('trust proxy', config.trustProxyHops);
  app.locals.deps = deps;

  const chatRateLimiter = rateLimit({
    windowMs: config.chatRateLimitWindowMs,
    max: config.chatRateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many chat requests. Please wait and try again.' },
  });

  const feedbackRateLimiter = rateLimit({
    windowMs: config.feedbackRateLimitWindowMs,
    max: config.feedbackRateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many feedback submissions. Please wait and try again.' },
  });

  const jsonBodyParser = express.json({ limit: '32kb' });

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
            'https://poornima-oracle-api.onrender.com',
            ...(corsOrigins || []),
          ],
          imgSrc: ["'self'", 'data:', 'https:'],
          workerSrc: ["'self'", 'blob:'],
        },
      },
    })
  );
  app.use(compression());
  app.use(cors(corsOrigins ? { origin: corsOrigins } : undefined));
  app.use('/src', express.static(path.join(__dirname, 'src'), { dotfiles: 'deny', index: false }));

  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
  });

  app.get('/index.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
  });

  app.get('/styles.css', (req, res) => {
    res.sendFile(path.join(__dirname, 'styles.css'));
  });

  app.get('/manifest.json', (req, res) => {
    res.sendFile(path.join(__dirname, 'manifest.json'));
  });

  app.get('/sw.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'sw.js'));
  });

  app.get('/chat-contract.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'chat-contract.js'));
  });

  app.get('/chat-request-owner.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'chat-request-owner.js'));
  });

  app.get('/poornima-oracle.svg', (req, res) => {
    res.sendFile(path.join(__dirname, 'poornima-oracle.svg'));
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

  app.get('/api/test-models', async (req, res) => {
    if (!adminApiKey) {
      return res.status(503).json({
        error: 'Admin API key not configured. Set ADMIN_API_KEY in environment.',
      });
    }
    if (!timingSafeStringEqual(getProvidedAdminKey(req), adminApiKey)) {
      return res.status(401).json({ error: 'Unauthorized. Invalid admin API key.' });
    }

    const results = {};
    if (!ai) {
      return res.status(500).json({ error: 'AI not initialized' });
    }

    // 1. Try listing models
    try {
      const listRes = await ai.models.list();
      const models = [];
      if (listRes && typeof listRes[Symbol.asyncIterator] === 'function') {
        for await (const m of listRes) {
          models.push(m.name || m.id || m);
        }
      } else if (Array.isArray(listRes?.models)) {
        models.push(...listRes.models.map(m => m.name || m.id || m));
      }
      results.availableModels = models.slice(0, 30);
    } catch (listErr) {
      results.listError = listErr?.message || String(listErr);
    }

    // 2. Test generation on common model candidates
    const candidates = ['gemini-3.5-flash', 'gemini-3.8-flash', 'gemini-flash-latest', 'gemini-2.5-flash'];
    results.tests = {};
    for (const m of candidates) {
      try {
        const resp = await ai.models.generateContent({
          model: m,
          contents: 'Hi',
        });
        results.tests[m] = { success: true, text: resp?.text?.slice(0, 50) || 'OK' };
      } catch (err) {
        results.tests[m] = { success: false, error: err?.message || String(err) };
      }
    }

    res.json(results);
  });

  app.get('/api/calendar', async (req, res) => {
    try {
      const requestedCampus = String(req.query.campus || req.query.college || 'ALL').toUpperCase();
      const campus = ['PU', 'PCE', 'PIET', 'GENERAL', 'ALL'].includes(requestedCampus)
        ? requestedCampus
        : 'ALL';
      const category = (req.query.category || 'all').toLowerCase();
      const daysAhead = parsePositiveInteger(req.query.daysAhead, 90);
      const limit = parseBoundedInteger(req.query.limit, 25, 1, 100);

      const data = await getUpcomingCalendarEvents({
        college: campus,
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

  app.post('/api/chat', jsonBodyParser, chatRateLimiter, (req, res) => {
    handleChatRequest(deps, req, res).catch((error) => {
      console.error('Unhandled error in /api/chat handler:', error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'Failed to process the query.' });
      } else {
        endResponseQuietly(res);
      }
    });
  });

  app.post('/api/feedback', jsonBodyParser, feedbackRateLimiter, (req, res) => {
    const rating = sanitizeText(req.body?.rating);

    if (!['up', 'down'].includes(rating)) {
      return res.status(400).json({ error: 'Feedback rating must be "up" or "down".' });
    }

    const rawAnswer = typeof req.body?.answer === 'string' ? req.body.answer : '';
    if (rawAnswer.length > MAX_ANSWER_CHARS) {
      return res.status(400).json({
        error: `Feedback answer must be ${MAX_ANSWER_CHARS} characters or less.`,
      });
    }

    const rawSources = Array.isArray(req.body?.sources)
      ? req.body.sources.slice(0, MAX_FEEDBACK_SOURCES)
      : [];
    for (const source of rawSources) {
      if (source && typeof source === 'object' &&
        typeof source.title === 'string' &&
        source.title.length > MAX_SOURCE_TITLE_CHARS) {
        return res.status(400).json({
          error: `Source title must be ${MAX_SOURCE_TITLE_CHARS} characters or less.`,
        });
      }
    }

    const feedback = {
      messageId: sanitizeText(req.body?.messageId),
      rating,
      question: sanitizeText(req.body?.question).slice(0, MAX_MESSAGE_CHARS),
      answer: sanitizeText(rawAnswer).slice(0, MAX_ANSWER_CHARS),
      sources: rawSources,
      createdAt: new Date().toISOString(),
    };

    // Never log student question/answer text; metadata only.
    console.info('Chat feedback received:', JSON.stringify({
      messageId: feedback.messageId,
      rating: feedback.rating,
      sourceCount: feedback.sources.length,
    }));
    res.json({ ok: true, messageId: feedback.messageId });
  });

  // ---------------------------------------------------------------------------
  // RAG 2.0: Notice Sync Admin Endpoint & Runner
  // ---------------------------------------------------------------------------

  let noticeSyncRunning = false;

  /**
   * Run the notice sync pipeline with shared AI/Pinecone clients.
   * Returns the sync result object.
   */
  async function runNoticeSync(syncOptions = {}) {
    if (noticeSyncRunning) {
      return { success: false, errors: ['A sync is already in progress.'] };
    }

    noticeSyncRunning = true;
    try {
      return await syncNotices({
        ai: ai || undefined,
        pineconeIndex: pineconeIndex || undefined,
        ...syncOptions,
      });
    } finally {
      noticeSyncRunning = false;
    }
  }

  app.locals.runNoticeSync = runNoticeSync;

  /**
   * POST /api/sync-notices — Admin-only endpoint to trigger notice ingestion.
   * Protected by ADMIN_API_KEY header check.
   */
  app.post('/api/sync-notices', jsonBodyParser, async (req, res) => {
    if (!adminApiKey) {
      return res.status(503).json({
        error: 'Admin API key not configured. Set ADMIN_API_KEY in environment.',
      });
    }

    if (!timingSafeStringEqual(getProvidedAdminKey(req), adminApiKey)) {
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

  // Map body-parser failures to the stable JSON contract.
  app.use((error, req, res, next) => {
    if (res.headersSent) {
      return next(error);
    }
    if (error?.type === 'entity.too.large' || error?.status === 413) {
      return res.status(413).json({ error: 'Request body is too large.' });
    }
    if (
      error?.type === 'entity.parse.failed' ||
      (error instanceof SyntaxError && error?.status === 400 && 'body' in error)
    ) {
      return res.status(400).json({ error: 'Request body must contain valid JSON.' });
    }
    return next(error);
  });

  return app;
}

function startServer() {
  const app = createApp();
  const deps = app.locals.deps;
  const PORT = Number(process.env.PORT) || 3001;

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
          const result = await app.locals.runNoticeSync();
          console.log(`[NoticeSyncCron] Sync completed: ${result.vectorsUpserted || 0} vectors upserted, ${result.errors?.length || 0} warnings`);
        } catch (err) {
          console.error('[NoticeSyncCron] Sync failed:', err.message);
        }
      }, {
        noOverlap: true,
      });
      console.log(`[NoticeSyncCron] Scheduled: "${noticeSyncCron}" (server time / UTC)`);
    } else if (!noticeSyncEnabled) {
      console.log('[NoticeSyncCron] Disabled (NOTICE_SYNC_ENABLED=false)');
    } else {
      console.warn(`[NoticeSyncCron] Invalid cron expression: "${noticeSyncCron}". Skipping schedule.`);
    }

    if (deps.missingEnvVars.length > 0) {
      console.warn(`Missing environment variables: ${deps.missingEnvVars.join(', ')}`);
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
  process.on('unhandledRejection', (reason) => {
    console.error('[Process] Unhandled promise rejection:', reason);
  });
  process.on('uncaughtException', (error) => {
    console.error('[Process] Uncaught exception:', error);
  });

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = { createApp, createTimeoutFetch };
