require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
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

const ai = geminiApiKey ? new GoogleGenAI({ apiKey: geminiApiKey }) : null;
const pinecone = pineconeApiKey ? new Pinecone({ apiKey: pineconeApiKey }) : null;

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

app.use(cors(DEFAULT_CORS_ORIGIN ? { origin: DEFAULT_CORS_ORIGIN } : undefined));
app.use(express.json({ limit: '32kb' }));

function sanitizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
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

function buildHistoryContext(history) {
  if (!Array.isArray(history) || history.length < 2) {
    return '';
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

      const role = message.role === 'user' ? 'User' : 'Poornima Oracle';
      return `${role}: ${content}`;
    })
    .filter(Boolean)
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

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    configured: missingEnvVars.length === 0,
    missingEnvVars,
  });
});

app.post('/api/chat', async (req, res) => {
  try {
    if (missingEnvVars.length > 0 || !ai || !pinecone) {
      return res.status(503).json({
        error: `Server is missing required environment variables: ${missingEnvVars.join(', ')}.`,
      });
    }

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

    console.log('User query:', message.slice(0, 200));

    if (isAbusive(message)) {
      return res.json({
        answer: 'Arre yaar, itni bakwaas mat kar! Thoda dimag laga ke baat kar.',
      });
    }

    const embedResponse = await ai.models.embedContent({
      model: embeddingModel,
      contents: message,
      config: {
        outputDimensionality: 768,
      },
    });

    const queryVector = embedResponse?.embeddings?.[0]?.values || [];
    if (!Array.isArray(queryVector) || queryVector.length === 0) {
      return res.status(502).json({
        error: 'Failed to generate an embedding for the query.',
      });
    }

    const index = pinecone.index(pineconeIndexName);
    const queryResponse = await index.query({
      topK: 3,
      vector: queryVector,
      includeMetadata: true,
    });

    const matches = Array.isArray(queryResponse?.matches) ? queryResponse.matches : [];
    const contextSnippets = buildContextSnippets(matches);
    const historyContext = buildHistoryContext(history);

    const aiResponse = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      config: {
        systemInstruction: buildSystemInstruction(contextSnippets),
      },
      contents: [
        {
          role: 'user',
          parts: [{ text: `Previous Conversation:\n${historyContext || 'None'}\n\nQuestion: ${message}` }],
        },
      ],
    });

    const answer = sanitizeText(aiResponse?.text) || 'I could not generate a response. Please try again.';
    res.json({ answer });
  } catch (error) {
    const apiKeyError = detectApiKeyError(error);
    if (apiKeyError.isApiKeyError) {
      logApiKeyError(apiKeyError.service, apiKeyError.reason, error);
      return res.status(401).json({
        error: `API key error with ${apiKeyError.service}: ${apiKeyError.reason}. Please check server console for details.`,
      });
    }
    console.error('Error in /api/chat:', error);
    res.status(500).json({ error: 'Failed to process the query.' });
  }
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
