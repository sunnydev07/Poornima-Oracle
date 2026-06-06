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

Requirements: Node.js 18+, npm, a Gemini API key, and a Pinecone index.

```bash
npm install
```

Create `.env` in the project root:

```env
GEMINI_API_KEY=your_gemini_api_key
PINECONE_API_KEY=your_pinecone_api_key
PINECONE_INDEX_NAME=poornima

# Optional
PORT=3001
GEMINI_EMBEDDING_MODEL=gemini-embedding-001
CORS_ORIGIN=
RATE_LIMIT_WINDOW_MS=900000
CHAT_RATE_LIMIT_MAX=20
QUERY_CACHE_TTL_SECONDS=3600
RAG_TOP_K=6
RAG_MIN_SCORE=0.35
RAG_REQUEST_TIMEOUT_MS=15000
RAG_REQUEST_RETRIES=2
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
| `npm run check` | Validate `server.js` syntax |

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

The chat stream emits `sources`, `token`, `done`, or `error` events.

## Deployment

1. Configure the required environment variables on the hosting platform.
2. Run `npm run build:css` after changing Tailwind classes or configuration.
3. Start with `npm start` or `npm run start:prod`.
4. Verify the deployment at `/api/health`.

Do not commit `.env` files or API keys.
