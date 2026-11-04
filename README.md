# Poornima Oracle

Poornima Oracle is a RAG-based assistant for Poornima Group of Colleges. It combines a single-page chat interface with an Express backend that retrieves context from Pinecone and streams Gemini responses to the browser.

## Highlights

- Gemini-powered answers grounded in Pinecone data
- Server-Sent Events (SSE) response streaming
- Browser chat history, voice input, and text-to-speech
- Query caching, rate limiting, input sanitization, compression, and Helmet
- Health and feedback endpoints
- Demo mode when no backend endpoint is configured

## Stack

- Frontend: HTML, Tailwind CSS, vanilla JavaScript
- Backend: Node.js, Express
- AI: Google Gemini (`gemini-2.5-flash`)
- Embeddings: `gemini-embedding-001`
- Vector database: Pinecone

## Setup

Requirements: Node.js 20+ (required by `@google/genai`), npm, a Gemini API key, and a Pinecone index.

```bash
npm ci
```

Copy `.env.example` to `.env` in the project root and fill in the required credentials locally. The `.env` file is ignored by Git; never commit or share it.

```env
GEMINI_API_KEY=your_gemini_api_key
PINECONE_API_KEY=your_pinecone_api_key
PINECONE_INDEX_NAME=poornima

# Optional
PORT=3001
GEMINI_EMBEDDING_MODEL=gemini-embedding-001
# Exact comma-separated browser origins; leave unset for same-origin only.
CORS_ORIGIN=
# Set only to the verified count of trusted reverse-proxy hops (default: 0).
TRUST_PROXY_HOPS=0
RATE_LIMIT_WINDOW_MS=900000
CHAT_RATE_LIMIT_MAX=20
FEEDBACK_RATE_LIMIT_WINDOW_MS=900000
FEEDBACK_RATE_LIMIT_MAX=10
QUERY_CACHE_TTL_SECONDS=3600
QUERY_CACHE_MAX_KEYS=1000
RAG_TOP_K=6
RAG_MIN_SCORE=0.35
RAG_REQUEST_TIMEOUT_MS=15000
RAG_REQUEST_RETRIES=2
ANSWER_TIMEOUT_MS=120000
ANSWER_IDLE_TIMEOUT_MS=30000
MAX_CONCURRENT_GENERATIONS=5
```

The server generates 768-dimensional embeddings. The Pinecone index must use the same vector dimension.

Start the app:

```bash
npm run dev
```

Open `http://localhost:3001`. The frontend defaults to the deployed API, so use its settings panel to select `http://localhost:3001/api/chat` for local development.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the local server |
| `npm start` | Start the server |
| `npm run start:prod` | Start with PM2 |
| `npm run build:css` | Rebuild the minified Tailwind stylesheet |
| `npm run check` | Validate server modules and inline browser JavaScript syntax |
| `npm test` | Run offline API, browser-module, contract, and cancellation tests under `test/` (mock providers only) |
| `npm run check:css` | Rebuild Tailwind CSS and fail if the checked-in output is stale |
| `npm audit --omit=dev` | Audit production dependencies |

Optional browser smoke test (requires Python Playwright and Chromium): start `py -3 -m http.server 3001 --bind 127.0.0.1` in the project root, then run `py -3 scripts/accessibility-smoke.py` in a second terminal. Set `POORNIMA_SMOKE_BASE_URL` to override the local URL; if a proxy is configured, set `NO_PROXY=127.0.0.1,localhost` for the test process. The script allows only requests to the local static server and blocks external/CDN requests; it does not call Gemini or Pinecone.

## API

| Endpoint | Description |
| --- | --- |
| `GET /api/health` | Report configuration status and missing required variables |
| `POST /api/chat` | Stream grounded responses using SSE |
| `POST /api/feedback` | Record sanitized up/down feedback in server logs |

Example chat request:

```json
{
  "message": "What is the attendance policy?",
  "history": [
    {
      "role": "user",
      "content": "Tell me about academics."
    }
  ]
}
```

`message` is the current turn. `history` contains only prior `{ "role": "user" | "assistant", "content": "..." }` turns; do not repeat the current message in history. The browser keeps the newest prior context, normally up to 8 turns and 2,000 characters per turn, and prunes older turns when the serialized UTF-8 payload would exceed 24 KiB. The server enforces a 32 KiB JSON body limit and uses at most 4,000 characters of recent history in the model prompt. Plain-text `<` characters and markdown punctuation are preserved; output HTML is sanitized at the browser rendering boundary.

The stream emits `sources`, `token`, `done`, or `error` SSE events. Failures before stream setup return JSON HTTP errors (including `429` with `Retry-After` for provider throttling); failures after SSE starts use an `error` event and may include partial tokens. Successful streamed text, the `done.answer`, and cached answers are kept identical.

## Deployment

1. Configure the required environment variables on the hosting platform.
2. Run `npm run build:css` after changing Tailwind classes or configuration.
3. Start with `npm start` or `npm run start:prod`.
4. Verify the deployment at `/api/health`.
5. Set `CORS_ORIGIN` to exact production browser origins. Keep `TRUST_PROXY_HOPS=0` unless the hosting topology is verified; if a reverse proxy is used, configure its exact hop count and verify client-IP behavior with the platform owner.
6. Configure provider-side quota limits and usage alerts. Rate limits, concurrency caps, and cache are in-memory per Node process, not global across PM2 workers or replicas. Public anonymous exposure may require authentication/session controls and a shared limiter/budget before scaling.

Feedback logs include rating, request ID, and text lengths only; they do not log question or answer content. The local tests use mocked providers and do not call Gemini or Pinecone.

Do not commit `.env` files or API keys. If real credentials were ever committed, the owner must privately verify and rotate/revoke them, update deployment secrets, and decide separately whether a history rewrite is warranted; none of those owner actions are performed by this remediation.
