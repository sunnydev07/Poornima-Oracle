# Poornima Oracle

Minimal RAG assistant for the Poornima Group of Colleges (PU, PCE, PIET).

## Quick Start

1. Install dependencies.

	npm install

2. Create a .env file in the project root.

	GEMINI_API_KEY=your_gemini_api_key
	PINECONE_API_KEY=your_pinecone_api_key
	PINECONE_INDEX_NAME=poornima
	GEMINI_EMBEDDING_MODEL=gemini-embedding-001
	PORT=3001

3. Start the server.

	npm start

4. Open the app.

	http://localhost:3001

## Scripts

- npm start: run the server
- npm run check: syntax check for server.js

## API

- GET /api/health: health and env-status check
- POST /api/chat: chat endpoint

## Notes

- index.html is served from /
- PINECONE_ENV is not required with the current Pinecone SDK
- GEMINI_EMBEDDING_MODEL must match the embedding model used to build your Pinecone vectors
- Never commit real API keys

## Troubleshooting

- Port already in use (EADDRINUSE):
  - Start on another port: $env:PORT=3002; npm start
  - Or stop the process using 3001, then restart
- Missing env vars: check GET /api/health response
