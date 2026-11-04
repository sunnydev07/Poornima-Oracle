# 🔮 Poornima Oracle — Campus RAG Assistant & AI Co-Pilot

[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-4.21-000000?style=flat-square&logo=express&logoColor=white)](https://expressjs.com/)
[![Pinecone](https://img.shields.io/badge/Pinecone-VectorDB-0052FF?style=flat-square)](https://www.pinecone.io/)
[![Google Gemini](https://img.shields.io/badge/Gemini-2.0--Flash-4285F4?style=flat-square&logo=google&logoColor=white)](https://ai.google.dev/)
[![MCP](https://img.shields.io/badge/Model%20Context%20Protocol-SDK%201.30-purple?style=flat-square)](https://modelcontextprotocol.io/)
[![Tailwind CSS](https://img.shields.io/badge/TailwindCSS-3.4-38B2AC?style=flat-square&logo=tailwind-css&logoColor=white)](https://tailwindcss.com/)
[![PWA Ready](https://img.shields.io/badge/PWA-Installable-blueviolet?style=flat-square&logo=pwa&logoColor=white)](https://web.dev/progressive-web-apps/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)

**Poornima Oracle** is a next-generation, RAG-powered intelligent campus co-pilot and automated document retrieval system engineered for the **Poornima Group of Colleges** — covering **Poornima University (PU)**, **Poornima College of Engineering (PCE)**, and **Poornima Institute of Engineering & Technology (PIET)**.

It grounds conversational AI in verified institutional knowledge, official circulars, exam schedules, and academic calendars with real-time SSE streaming, dual-tier cloud fallback resilience, autonomous tool calling via the Model Context Protocol (MCP), and an installable Progressive Web App (PWA).

---

## 📑 Table of Contents

- [✨ Core Capabilities](#-core-capabilities)
- [🏗️ System Architecture](#️-system-architecture)
- [📁 Project Structure](#-project-structure)
- [🚀 Quick Start](#-quick-start)
- [⚙️ Environment Configuration](#️-environment-configuration)
- [🔌 API Reference](#-api-reference)
- [📜 Available Scripts](#-available-scripts)
- [🧪 Testing & Diagnostics](#-testing--diagnostics)
- [🌐 Deployment](#-deployment)
- [📄 License & Authors](#-license--authors)

---

## ✨ Core Capabilities

### 🧠 1. RAG 2.0 & Automated Knowledge Ingestion
- **Automated Notice Crawler (`services/crawler/notice-sync.js`)**:
  - **Poornima University (PU)**: Directly accesses the Firestore REST API (`poornima-5c202`) for Angular client-rendered notices, announcements, and calendars.
  - **Poornima College of Engineering (PCE) & PIET**: Scrapes server-rendered HTML portals using Cheerio with full metadata extraction.
- **Deep PDF Circular Extraction (`services/crawler/pdf-extractor.js`)**: Downloads and parses attached official PDF notices, circulars, and fee guidelines with `pdf-parse`, chunking tabular data and text for semantic vector indexing.
- **Pinecone Vector Database**: Multi-namespace vector indexing (`__default__` for institutional documents, `notices` for real-time circulars) with 768-dimensional embeddings via Google `gemini-embedding-001`.
- **Scheduled Synchronization**: Built-in automated cron runner (`30 0 * * *` — 6:00 AM IST) and authenticated on-demand admin trigger (`POST /api/sync-notices`).

### 🛡️ 2. Resilient Dual-Tier Cloud Fallback
- **Zero-Failure Architecture**: Automatic routing when knowledge base coverage is low (score < 0.35), Gemini returns an out-of-scope refusal, or primary API keys hit rate limits (`429` / `503`).
- **Tier 1 Fallback**: OpenRouter Free API (utilizing `meta-llama/llama-3.3-70b-instruct:free` or equivalent zero-cost LLMs).
- **Tier 2 Fallback**: Hosted Remote Ollama Cloud API (e.g. `nemotron-3-nano:30b`).
- **Client-Provided Key Overrides**: Supports `x-openrouter-key`, `x-ollama-key`, and `x-ollama-host` request headers.

### 🛠️ 3. Model Context Protocol (MCP) & Autonomous Tools
- **MCP Integration (`@modelcontextprotocol/sdk`)**: Configurable MCP servers defined in [`mcp-servers.json`](file:///c:/Users/sunny/Desktop/CO-Founder/poornima-oracle/Poornima-Oracle/mcp-servers.json) for structured external tools (SQLite, GitHub, and custom SSE servers).
- **Native Tool Dispatcher (`services/tool-dispatcher.js`)**:
  - 🔍 **Web Search**: Real-time external campus intelligence using DuckDuckGo (zero-key fallback) or Tavily Search API.
  - 🌐 **Web Scraper**: Real-time content fetching and HTML markdown extraction with Cheerio.
  - 🏛️ **Portal Inspector**: Direct extraction of live official campus portals.
  - ⏰ **Date/Time Calculator**: Accurate calculations for exam countdowns, registration cutoffs, and event dates.

### 📅 4. Academic Calendar & Countdown Widget
- **Dynamic Calendar Engine (`services/calendar-service.js`)**: Tracks university & college exams, assignment submissions, fee payment cutoffs, holidays, and campus fests.
- **Frontend Countdown Cards (`src/js/components/calendarWidget.js`)**: Collapsible, responsive widget showing upcoming deadlines with badge indicators and campus-based filtering (`PU`, `PCE`, `PIET`, `ALL`).
- **Context Injection**: Calendar deadlines are automatically fed into the LLM system prompt for accurate temporal awareness.

### 📱 5. Progressive Web App (PWA) & Offline UX
- **Installable Application**: Service Worker (`sw.js`) and Web App Manifest (`manifest.json`) allow installation as a native desktop or mobile app on Android, iOS, Windows, and macOS.
- **Offline Reliability**: Cache-first asset strategy with offline fallback page and offline status badge indicator.
- **Locally Vendored Assets**: Icons and UI libraries vendored locally to guarantee zero external CDN dependency breakages.

### 👤 6. Personalization & User Experience
- **Profile Store (`src/js/profile/profileStore.js`)**: Students and faculty can configure their institution (`PU`, `PCE`, `PIET`), department, year, semester, and section to receive personalized answers.
- **Voice & Audio Interface**: Integrated Web Speech API for speech-to-text queries and natural text-to-speech response playback.
- **Chat History & Export**: Export chat sessions directly into Markdown, JSON, or plain text formats.
- **Security**: Hardened with Helmet HTTP security headers, CORS origin whitelisting, Express Rate Limiting, and XSS input sanitization.

---

## 🏗️ System Architecture

```
                                  +---------------------------------------+
                                  |         User Browser / PWA            |
                                  |   (Speech I/O | Profile | Calendar)   |
                                  +---------------------------------------+
                                                     |
                                            SSE / HTTP Requests
                                                     v
                                  +---------------------------------------+
                                  |          Express 4.21 Server          |
                                  | (Helmet | RateLimiter | In-Memory LRU)|
                                  +---------------------------------------+
                                                     |
             +--------------------+------------------+--------------------+--------------------+
             |                    |                                       |                    |
             v                    v                                       v                    v
  +--------------------+  +--------------------------------+  +--------------------+  +--------------------+
  | Pinecone Vector DB |  |      Google Gemini 2.0         |  |   Dual Fallback    |  |    MCP Manager     |
  |  (768-dim Vectors) |  |   (gemini-2.0-flash Core)      |  |     Router         |  | & Tool Dispatcher  |
  |                    |  +--------------------------------+  |                    |  |                    |
  | Namespaces:        |                  |                   | - OpenRouter (Llama|  | - Web Search (DDG) |
  | - __default__      |                  | (low score/429)   |   3.3 70B Free)    |  | - Web Scraper      |
  | - notices          |                  +------------------>| - Ollama Cloud API |  | - Portal Inspector |
  +--------------------+                                      +--------------------+  | - Datetime Calc    |
             ^                                                                        +--------------------+
             |
  +------------------------------------------------+
  |    Automated Notice Ingestion Pipeline         |
  |   (Firestore REST / Cheerio / pdf-parse)       |
  |   - Cron Job (Daily at 6:00 AM IST)            |
  |   - Admin Endpoint: POST /api/sync-notices     |
  +------------------------------------------------+
```

---

## 📁 Project Structure

```
Poornima-Oracle/
├── .github/
│   └── workflows/
│       └── static.yml              # GitHub Actions static Pages deployment
├── services/
│   ├── calendar-service.js         # Academic calendar & events aggregation
│   ├── fallback-router.js          # Dual-tier OpenRouter/Ollama fallback engine
│   ├── mcp-manager.js              # Model Context Protocol server connector
│   ├── tool-dispatcher.js          # Native tools (search, scraper, datetime)
│   ├── crawler/
│   │   ├── notice-sync.js          # PU Firestore & PCE/PIET portal crawler
│   │   └── pdf-extractor.js        # Circular download & PDF parser
│   └── tools/
│       ├── datetime-calculator.js  # Date arithmetic for deadlines
│       ├── portal-inspector.js     # Live campus website parser
│       ├── web-scraper.js          # Cheerio web scraper
│       └── web-search.js           # DuckDuckGo / Tavily search
├── src/
│   └── js/
│       ├── app.js                  # Main client application orchestration
│       ├── config.js               # Frontend configuration & API routes
│       ├── state.js                # Client state management
│       ├── components/
│       │   └── calendarWidget.js   # Collapsible countdown calendar widget
│       ├── profile/
│       │   └── profileStore.js     # Student profile & college selection store
│       ├── pwa/
│       │   └── installPrompt.js    # PWA install banner & lifecycle
│       └── utils/
│           └── chatExport.js       # Conversation export (MD / JSON / Text)
├── index.html                      # Single-page application entry
├── server.js                       # Express server, RAG orchestration, API routes
├── sw.js                           # Progressive Web App service worker
├── manifest.json                   # PWA manifest specifications
├── mcp-servers.json                # External MCP server definitions
├── styles.css                      # Compiled Tailwind CSS styles
├── tailwind.config.js              # Tailwind styling configuration
├── test-calendar-service.js        # Unit test suite for calendar queries
├── test-pdf-extractor.js           # Unit test suite for PDF parsing
├── test-pinecone.js                # Pinecone connectivity & namespace verification
├── package.json                    # Project dependencies & npm scripts
└── .env.example                    # Environment variable documentation template
```

---

## 🚀 Quick Start

### 1. Prerequisites
- **Node.js**: v18.0.0 or higher
- **Pinecone Account**: [app.pinecone.io](https://app.pinecone.io)
- **Google AI Studio Key**: [aistudio.google.com](https://aistudio.google.com/app/apikey)

### 2. Clone & Install
```bash
git clone https://github.com/sunnydev07/Poornima-Oracle.git
cd Poornima-Oracle
npm install
```

### 3. Configure Environment
Copy the configuration template:
```bash
cp .env.example .env
```
Populate your `.env` with your API credentials (refer to the [Configuration](#️-environment-configuration) section).

### 4. Build Styles & Launch Server
```bash
# Verify syntax across all modules
npm run check

# Start the local development server
npm run dev
```

Open [http://localhost:3001](http://localhost:3001) in your browser.

---

## ⚙️ Environment Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | Optional | `3001` | HTTP server listening port |
| `CORS_ORIGIN` | Optional | `*` | Allowed CORS origins (comma-separated for multiple) |
| `GEMINI_API_KEY` | **Required** | — | Google Gemini API Key |
| `GEMINI_MODEL` | Optional | `gemini-2.0-flash` | Gemini model for conversational RAG |
| `GEMINI_EMBEDDING_MODEL` | Optional | `gemini-embedding-001` | Embedding model for vector generation (768-dim) |
| `PINECONE_API_KEY` | **Required** | — | Pinecone API authentication key |
| `PINECONE_INDEX_NAME` | **Required** | `poornima-oracle` | Target Pinecone vector index name |
| `PINECONE_NAMESPACE` | Optional | `__default__` | Namespace for core institutional documents |
| `RATE_LIMIT_WINDOW_MS` | Optional | `900000` (15m) | Rate limiting evaluation window in ms |
| `CHAT_RATE_LIMIT_MAX` | Optional | `20` | Maximum queries permitted per IP per window |
| `RAG_TOP_K` | Optional | `6` | Number of vector chunks retrieved per query |
| `RAG_MIN_SCORE` | Optional | `0.35` | Minimum cosine similarity score threshold |
| `ADMIN_API_KEY` | Optional | — | Secret token for triggering `/api/sync-notices` |
| `NOTICE_SYNC_CRON` | Optional | `30 0 * * *` | Cron schedule for automatic notice crawl (6:00 AM IST) |
| `NOTICE_SYNC_ENABLED` | Optional | `true` | Enable or disable the background sync cron |
| `FALLBACK_ENABLED` | Optional | `true` | Toggle the secondary cloud fallback system |
| `OPENROUTER_API_KEY` | Optional | — | Tier 1 Fallback: OpenRouter API Key |
| `OPENROUTER_MODEL` | Optional | `meta-llama/llama-3.3-70b-instruct:free` | Model name for Tier 1 fallback |
| `OLLAMA_HOST` | Optional | `https://ollama.com` | Tier 2 Fallback: Remote hosted Ollama URL |
| `OLLAMA_API_KEY` | Optional | — | API key for authenticated cloud Ollama hosts |
| `OLLAMA_CLOUD_MODEL` | Optional | `nemotron-3-nano:30b` | Model name for Tier 2 fallback |
| `TAVILY_API_KEY` | Optional | — | Optional search key (DuckDuckGo works without keys) |

---

## 🔌 API Reference

### 1. System Health
```http
GET /api/health
```
Returns system readiness, vector database configuration, active fallback providers, connected MCP servers, uptime, and memory usage.

### 2. Stream Conversational RAG
```http
POST /api/chat
Content-Type: application/json
```
Streams responses using **Server-Sent Events (SSE)**.

**Request Body:**
```json
{
  "message": "When are the mid-term examinations for B.Tech Semester 4?",
  "history": [
    { "role": "user", "text": "Hi" },
    { "role": "model", "text": "Hello! How can I assist you with Poornima campus information today?" }
  ],
  "profile": {
    "college": "PU",
    "department": "Computer Science",
    "year": "2nd Year",
    "semester": "Semester 4"
  }
}
```

### 3. Academic Calendar & Deadlines
```http
GET /api/calendar?campus=PU&category=exam&daysAhead=60&limit=15
```
Retrieves structured academic events, examination schedules, submission deadlines, and holidays.
- Query Parameters:
  - `campus`: `PU`, `PCE`, `PIET`, or `ALL` (default: `ALL`)
  - `category`: `all`, `exam`, `submission`, `fee`, `holiday`, `event`
  - `daysAhead`: Integer days to look ahead (default: `90`)
  - `limit`: Max items to return (1–100, default: `25`)

### 4. Model Connectivity Diagnostics
```http
GET /api/test-models
```
Validates Gemini API key credentials and tests available model candidates (`gemini-2.0-flash`, `gemini-1.5-flash`, etc.).

### 5. Automated Notice Ingestion (Admin)
```http
POST /api/sync-notices
x-admin-key: <your_ADMIN_API_KEY>
Content-Type: application/json

{
  "dryRun": false
}
```
Triggers the live portal crawler and PDF circular extractor to vectorize and upsert new announcements into Pinecone.

### 6. User Feedback
```http
POST /api/feedback
Content-Type: application/json

{
  "messageId": "msg_123456",
  "rating": 1,
  "comment": "Accurate details regarding exam timings."
}
```

---

## 📜 Available Scripts

| Command | Action |
|---|---|
| `npm run dev` | Start the Express backend server with `node server.js` |
| `npm run build:css` | Compile and minify Tailwind CSS from `tailwind.input.css` to `styles.css` |
| `npm run check` | Run static node syntax checks across all backend, crawler, service, and frontend scripts |
| `npm run start:prod` | Run the application in production mode using PM2 process manager |
| `npm run sync:notices` | Manually run the notice crawler and PDF ingestion pipeline |
| `npm run sync:notices:dry` | Execute the notice crawler in dry-run mode (no vector upserts) |
| `npm run test:pinecone` | Verify Pinecone vector index connection and query latency |
| `npm run test:pdf` | Test circular PDF download and table parsing |
| `npm run test:calendar` | Test academic calendar filtering and upcoming event extraction |

---

## 🧪 Testing & Diagnostics

Verify all subsystem components prior to production deployment:

```bash
# 1. Test syntax integrity
npm run check

# 2. Test Pinecone vector database connection
npm run test:pinecone

# 3. Test PDF parser on official circulars
npm run test:pdf

# 4. Test calendar filtering engine
npm run test:calendar
```

---

## 🌐 Deployment

### Frontend (GitHub Pages)
The static frontend is configured with a GitHub Actions workflow in [`.github/workflows/static.yml`](file:///c:/Users/sunny/Desktop/CO-Founder/poornima-oracle/Poornima-Oracle/.github/workflows/static.yml). Every push to `main` automatically deploys the frontend directly to GitHub Pages.

### Backend (Cloud Platforms / PM2)
The backend can be hosted on **Render**, **Railway**, **Google Cloud Run**, or any Linux VPS:

```bash
# Production start via PM2
npm run start:prod

# Check logs
pm2 logs poornima-oracle
```

Make sure to set the environment variables in your hosting dashboard and configure `CORS_ORIGIN` to match your frontend domain.

---

## 📄 License & Authors

Distributed under the **MIT License**. See `LICENSE` for details.

Developed with ❤️ by **[Sunny Kumar Dev](https://github.com/sunnydev07)** for the students, faculty, and administration of the **Poornima Group of Colleges**.
