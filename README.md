# Poornima Oracle

Poornima Oracle is a web-based RAG assistant for Poornima Group of Colleges information. It serves a polished single-page chat UI and a Node.js/Express backend that retrieves context from Pinecone, generates answers with Google Gemini, and streams responses back to the browser with source metadata.

## Features

- Poornima-focused chat assistant for students, parents, and faculty
- Retrieval-augmented answers using Pinecone vectors and Gemini generation
- Streaming Server-Sent Events response flow for live token updates
- Source chips from matched Pinecone metadata
- Conversation history in the browser
- Demo mode when a backend endpoint is not configured
- Voice input and optional auto-read controls in the UI
- Abuse filtering, XSS sanitization, rate limiting, compression, and Helmet middleware
- In-memory query caching with configurable TTL
- Feedback endpoint for thumbs-up/thumbs-down response capture

## Tech Stack

- Frontend: HTML, Tailwind CSS, vanilla JavaScript
- Backend: Node.js, Express
- AI: Google GenAI SDK with `gemini-2.5-flash`
- Embeddings: Gemini embedding model, default `gemini-embedding-001`
- Vector database: Pinecone
- Process manager: PM2 for production start script

## Project Structure

```text
.
|-- index.html          # Single-page chat UI
|-- server.js           # Express server and RAG API
|-- styles.css          # Generated Tailwind stylesheet
|-- tailwind.input.css  # Tailwind input file
|-- tailwind.config.js  # Tailwind configuration
|-- package.json        # Scripts and dependencies
`-- test-pinecone.js    # Pinecone connection helper
```

## Requirements

- Node.js 18 or newer
- npm
- Gemini API key
- Pinecone API key
- Pinecone index containing vectors generated with the same embedding model and dimensionality used by the server

The current server requests Gemini embeddings with `outputDimensionality: 768`, so the Pinecone index must be compatible with that vector size.

## Environment Variables

Create a `.env` file in the project root.

```env
GEMINI_API_KEY=your_gemini_api_key
PINECONE_API_KEY=your_pinecone_api_key
PINECONE_INDEX_NAME=poornima
GEMINI_EMBEDDING_MODEL=gemini-embedding-001
PORT=3001
CORS_ORIGIN=
RATE_LIMIT_WINDOW_MS=900000
CHAT_RATE_LIMIT_MAX=20
QUERY_CACHE_TTL_SECONDS=3600
RAG_TOP_K=6
RAG_MIN_SCORE=0.35
RAG_REQUEST_TIMEOUT_MS=15000
RAG_REQUEST_RETRIES=2
```

Required variables:

- `GEMINI_API_KEY`
- `PINECONE_API_KEY`
- `PINECONE_INDEX_NAME`

Optional variables:

- `GEMINI_EMBEDDING_MODEL`: defaults to `gemini-embedding-001`
- `PORT`: defaults to `3001`
- `CORS_ORIGIN`: comma-separated allowlist for browser origins
- `RATE_LIMIT_WINDOW_MS`: defaults to `900000` milliseconds
- `CHAT_RATE_LIMIT_MAX`: defaults to `20` requests per IP per window
- `QUERY_CACHE_TTL_SECONDS`: defaults to `3600` seconds
- `RAG_TOP_K`: Pinecone matches to request, defaults to `6`, clamped from `1` to `8`
- `RAG_MIN_SCORE`: minimum Pinecone score used for context and sources, defaults to `0.35`, clamped from `0` to `1`
- `RAG_REQUEST_TIMEOUT_MS`: Gemini/Pinecone request timeout, defaults to `15000` milliseconds
- `RAG_REQUEST_RETRIES`: transient upstream retries, defaults to `2`, clamped from `0` to `5`

Do not commit real API keys or private environment files.

## Local Setup

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Open the app:

```text
http://localhost:3001
```

The frontend defaults to:

```text
https://poornima-oracle.onrender.com/api/chat
```

Use the settings button in the UI to point the browser to your local endpoint:

```text
http://localhost:3001/api/chat
```

## Scripts

```bash
npm run build:css
npm run dev
npm start
npm run start:prod
npm run check
```

- `build:css`: rebuilds `styles.css` from Tailwind input
- `dev`: starts `server.js`
- `start`: starts `server.js`
- `start:prod`: starts the app with PM2 as `poornima-oracle`
- `check`: runs a Node syntax check on `server.js`

## API

### `GET /`

Serves `index.html`.

### `GET /styles.css`

Serves the generated Tailwind stylesheet.

### `GET /api/health`

Returns whether required environment variables are configured.

Example response:

```json
{
  "ok": true,
  "configured": true,
  "missingEnvVars": []
}
```

### `POST /api/chat`

Accepts a user message and optional conversation history, retrieves top matches from Pinecone, and streams Gemini output using Server-Sent Events.

Request body:

```json
{
  "message": "What is the attendance rule at Poornima?",
  "history": [
    {
      "role": "user",
      "content": "Tell me about academics"
    }
  ]
}
```

Stream events:

- `sources`: source metadata from Pinecone matches
- `token`: generated text chunk
- `done`: final answer and source list
- `error`: streaming error payload

### `POST /api/feedback`

Stores a sanitized feedback payload in the server log.

Request body:

```json
{
  "messageId": "message-id",
  "rating": "up",
  "question": "Student question",
  "answer": "Assistant answer",
  "sources": []
}
```

`rating` must be `up` or `down`.

## Production Notes

1. Set environment variables in the hosting provider dashboard.
2. Build CSS after Tailwind changes:

   ```bash
   npm run build:css
   ```

3. Start the server:

   ```bash
   npm start
   ```

4. For PM2-based hosting:

   ```bash
   npm run start:prod
   ```

5. Check the health endpoint after deployment:

   ```text
   https://your-domain.example/api/health
   ```

## Troubleshooting

- `configured: false` from `/api/health`: check `GEMINI_API_KEY`, `PINECONE_API_KEY`, and `PINECONE_INDEX_NAME`.
- `EADDRINUSE`: another process is using the port. On PowerShell, start with another port:

  ```powershell
  $env:PORT=3002; npm start
  ```
