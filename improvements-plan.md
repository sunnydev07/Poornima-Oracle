# 🔮 Poornima Oracle — Critical Bugs & System Improvements Plan

**Project:** Poornima Oracle (Campus RAG Assistant)  
**Repository:** `sunnydev07/Poornima-Oracle`  
**Location:** `C:\Users\sunny\Desktop\CO-Founder\poornima-oracle\Poornima-Oracle`  
**Generated Date:** 2026-09-04  
**Audit Scope:** Full Stack (`server.js`, `index.html`, `test-pinecone.js`, `styles.css`, `tailwind.config.js`, `package.json`)  
**Methodology:** Automated deep-inspection, Context7 MCP API verification (`@google/genai`, `@pinecone-database/pinecone`), and dedicated backend/frontend audit subagents.

---

## 📑 Table of Contents

1. [Executive Summary & System Architecture](#1-executive-summary--system-architecture)
2. [Critical Bugs to Fix Immediately (P0 / P1)](#2-critical-bugs-to-fix-immediately-p0--p1)
   - [Bug 1: RAG Sources & Citation Rendering Suppressed in UI](#bug-1-rag-sources--citation-rendering-suppressed-in-ui)
   - [Bug 2: Hardcoded Production Remote Endpoint & LocalStorage Lock-in](#bug-2-hardcoded-production-remote-endpoint--localstorage-lock-in)
   - [Bug 3: Flawed Precedence in API Error Detection Disables Key Diagnostics](#bug-3-flawed-precedence-in-api-error-detection-disables-key-diagnostics)
   - [Bug 4: Premature SSE Headers Nullify HTTP Status Codes & Error Handling](#bug-4-premature-sse-headers-nullify-http-status-codes--error-handling)
   - [Bug 5: Missing SSE Client Disconnect & Mid-Stream Timeout Handlers](#bug-5-missing-sse-client-disconnect--mid-stream-timeout-handlers)
   - [Bug 6: Multi-Turn Conversation History Truncation Drops Previous Assistant Responses](#bug-6-multi-turn-conversation-history-truncation-drops-previous-assistant-responses)
   - [Bug 7: Missing `AbortController` Causes Stream State Bleed on "New Chat"](#bug-7-missing-abortcontroller-causes-stream-state-bleed-on-new-chat)
   - [Bug 8: Destructive Mid-Stream Error Handling Wipes Prior Streamed Output](#bug-8-destructive-mid-stream-error-handling-wipes-prior-streamed-output)
   - [Bug 9: Permanent Runaway Canvas Loop in `ClickSpark` Draining CPU & Battery](#bug-9-permanent-runaway-canvas-loop-in-clickspark-draining-cpu--battery)
   - [Bug 10: Missing Static Asset Middleware in Express (`Cannot GET /`)](#bug-10-missing-static-asset-middleware-in-express-cannot-get-)
3. [Security & Architectural Vulnerabilities (P1 / P2)](#3-security--architectural-vulnerabilities-p1--p2)
   - [Sec 1: Missing `trust proxy` Enables Global Rate Limiter Denial of Service](#sec-1-missing-trust-proxy-enables-global-rate-limiter-denial-of-service)
   - [Sec 2: Unbounded In-Memory Cache (`node-cache`) Leading to OOM Crash](#sec-2-unbounded-in-memory-cache-node-cache-leading-to-oom-crash)
   - [Sec 3: Destructive Sanitization (`xss` with `whiteList: {}`) Corrupting Markdown and Math](#sec-3-destructive-sanitization-xss-with-whitelist--corrupting-markdown-and-math)
   - [Sec 4: Wildcard CORS Fallback & CSP Directive Mismatches](#sec-4-wildcard-cors-fallback--csp-directive-mismatches)
   - [Sec 5: Unbounded Feedback Endpoint Flooding & Ephemeral Storage](#sec-5-unbounded-feedback-endpoint-flooding--ephemeral-storage)
   - [Sec 6: Missing Server Graceful Shutdown Handlers (`SIGTERM`/`SIGINT`)](#sec-6-missing-server-graceful-shutdown-handlers-sigtermsigint)
   - [Sec 7: Missing Pinecone Namespace Support & Euclidean Metric Assumption](#sec-7-missing-pinecone-namespace-support--euclidean-metric-assumption)
4. [UX, Performance & Accessibility (a11y) Improvements (P2 / P3)](#4-ux-performance--accessibility-a11y-improvements-p2--p3)
   - [UX 1: Assistant Action Bar Hidden on Mobile Screens & Touch Laptops](#ux-1-assistant-action-bar-hidden-on-mobile-screens--touch-laptops)
   - [UX 2: Mobile Sidebar Overlay Z-Index Glitch Allowing Accidental Clicks](#ux-2-mobile-sidebar-overlay-z-index-glitch-allowing-accidental-clicks)
   - [UX 3: Desktop Collapse Inline Style Poisoning Mobile Drawer](#ux-3-desktop-collapse-inline-style-poisoning-mobile-drawer)
   - [UX 4: Flawed "Regenerate" Appending Duplicate Questions](#ux-4-flawed-regenerate-appending-duplicate-questions)
   - [UX 5: Accidental Instant Conversation Deletion](#ux-5-accidental-instant-conversation-deletion)
   - [UX 6: Unstable External Google Search Thumbnail for Oracle Avatar](#ux-6-unstable-external-google-search-thumbnail-for-oracle-avatar)
   - [UX 7: Synchronous Full Markdown Parsing During High-Speed Streaming](#ux-7-synchronous-full-markdown-parsing-during-high-speed-streaming)
   - [A11y 1: Viewport Zoom Disabled (`user-scalable=no` Violation)](#a11y-1-viewport-zoom-disabled-user-scalableno-violation)
   - [A11y 2: Non-Semantic Interactive Divs Failing Keyboard Navigation](#a11y-2-non-semantic-interactive-divs-failing-keyboard-navigation)
   - [A11y 3: Low Contrast Text Violating WCAG 2.1 AA](#a11y-3-low-contrast-text-violating-wcag-21-aa)
   - [A11y 4: Missing ARIA Live Region for Screen Readers](#a11y-4-missing-aria-live-region-for-screen-readers)
5. [Refactoring & Modularization Blueprint](#5-refactoring--modularization-blueprint)
6. [Implementation Roadmap & Prioritized Task List](#6-implementation-roadmap--prioritized-task-list)

---

## 1. Executive Summary & System Architecture

**Poornima Oracle** is designed as an institutional campus AI assistant for Poornima Group of Colleges (PU, PCE, PIET). It integrates:
- **Vector Retrieval**: Pinecone Index with 768-dimensional embeddings (`models/embedding-001` or `text-embedding-004`).
- **Generation & Synthesis**: Google Gemini 2.5 Flash via `@google/genai` (v1.28.0).
- **Transport**: Real-time Server-Sent Events (SSE) streaming through Express.js.
- **Frontend**: Dark-mode glassmorphic single-page chat UI with Web Speech STT/TTS and IndexedDB chat persistence.

### Architectural Health Matrix

| Subsystem | Status | Risk Level | Primary Concerns |
|---|---|---|---|
| **RAG Citations** | 🔴 Broken | **P0 (Critical)** | Frontend wipes citation data; `renderSourceChips()` returns empty string. |
| **Transport & SSE** | 🔴 Fragile | **P0 (Critical)** | Premature header dispatch, missing client disconnect abort, no client-side stop button. |
| **API Endpoints** | 🔴 Misconfigured | **P0 (Critical)** | Hardcoded Render production URL persists in localStorage; local server lacks static file routing. |
| **State & Reliability** | 🟠 Vulnerable | **P1 (High)** | Multi-turn history is truncated incorrectly; background streams bleed into new sessions. |
| **Security & Caching** | 🟠 Vulnerable | **P1 (High)** | Reverse proxy IP sharing causes global DoS via rate limiter; unbounded `node-cache` memory leak. |
| **Accessibility (a11y)** | 🔴 Non-Compliant | **P1 (High)** | Viewport zoom disabled (`user-scalable=no`), non-semantic interactive cards, contrast failures. |
| **Code Structure** | 🟡 Monolithic | **P2 (Medium)** | 2,159-line `index.html` file combining HTML, CSS, and 1,500+ lines of vanilla JS in global scope. |

---

## 2. Critical Bugs to Fix Immediately (P0 / P1)

---

### Bug 1: RAG Sources & Citation Rendering Suppressed in UI
- **Severity:** `P0 (Critical)`
- **Affected Files:** `index.html` (Lines 1665–1682, 1927, 1991–2006)
- **Problem Description:**  
  The core promise of RAG is providing grounded, verifiable institutional facts with citations. In `server.js` (Lines 416–438), verified Pinecone vector matches are built into `{ id, title, url, score }` source objects and transmitted via `writeSse(res, 'sources', { sources })`.  
  However, in `index.html`:
  1. Line 1666: `assistantShell.sourcesEl.innerHTML = '';` explicitly wipes incoming sources.
  2. Line 1681 & Line 1927: `assistantShell.sourcesEl.innerHTML = '';` wipes sources again upon stream completion and message re-rendering.
  3. Line 1991: `function renderSourceChips(sources) { return ''; }` is an empty stub.
  4. Line 1995–2006: `getSafeUrl()` is dead code.
- **Impact:** Students and faculty receive zero citations or reference links; answers cannot be verified against official college regulations.
- **Remediation:**  
  Implement the source chip renderer in `index.html`:
  ```javascript
  function renderSourceChips(sources) {
      if (!Array.isArray(sources) || sources.length === 0) return '';
      
      const chips = sources.map((src, index) => {
          const safeTitle = escapeHtml(src.title || `Document ${index + 1}`);
          const safeUrl = getSafeUrl(src.url);
          const scorePercent = typeof src.score === 'number' ? Math.round(src.score * 100) : null;
          
          if (safeUrl) {
              return `
                  <a href="${safeUrl}" target="_blank" rel="noopener noreferrer" 
                     class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-cyan-500/20 bg-cyan-500/5 hover:bg-cyan-500/15 text-cyan-300 text-xs transition-colors group">
                      <i data-lucide="external-link" class="w-3 h-3 text-cyan-400 group-hover:scale-110 transition-transform"></i>
                      <span class="truncate max-w-[160px]">${safeTitle}</span>
                      ${scorePercent ? `<span class="text-[10px] px-1.5 py-0.2 bg-cyan-500/20 rounded-md font-mono text-cyan-200">${scorePercent}%</span>` : ''}
                  </a>`;
          }
          return `
              <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-white/10 bg-white/5 text-zinc-300 text-xs">
                  <i data-lucide="file-text" class="w-3 h-3 text-zinc-400"></i>
                  <span class="truncate max-w-[160px]">${safeTitle}</span>
                  ${scorePercent ? `<span class="text-[10px] px-1.5 py-0.2 bg-white/10 rounded-md font-mono text-zinc-400">${scorePercent}%</span>` : ''}
              </span>`;
      }).join('');

      return `
          <div class="mt-3 pt-3 border-t border-white/5 flex flex-wrap items-center gap-2">
              <span class="text-[11px] uppercase tracking-wider text-zinc-500 font-semibold flex items-center gap-1">
                  <i data-lucide="check-check" class="w-3 h-3 text-cyan-400"></i> Sources:
              </span>
              ${chips}
          </div>`;
  }
  ```
  Then in `onSources` (line 1665) and `done` (line 1681), render `renderSourceChips(sources)` instead of setting `innerHTML = ''`.

---

### Bug 2: Hardcoded Production Remote Endpoint & LocalStorage Lock-in
- **Severity:** `P0 (Critical)`
- **Affected Files:** `index.html` (Lines 601, 778–788)
- **Problem Description:**  
  Line 601 defines:
  ```javascript
  const DEFAULT_API_ENDPOINT = 'https://poornima-oracle.onrender.com/api/chat';
  ```
  In `ensureApiEndpoint()`, if `localStorage.getItem('geminiApiEndpoint')` is empty, it permanently writes `https://poornima-oracle.onrender.com/api/chat` into `localStorage`.
- **Impact:**
  1. Developers running locally via `npm run dev` (`http://localhost:3001`) unknowingly send queries to the remote Render instance instead of their local backend.
  2. Render free-tier instances spin down after inactivity; initial requests encounter 60–90s cold start delays or 504 timeouts.
  3. Changing backend ports or domains fails to take effect in client browsers until `localStorage` is manually cleared.
- **Remediation:**  
  Dynamically determine the relative endpoint:
  ```javascript
  function getDefaultApiEndpoint() {
      if (typeof window !== 'undefined' && window.location.protocol.startsWith('http')) {
          return `${window.location.origin}/api/chat`;
      }
      return '/api/chat';
  }

  function ensureApiEndpoint() {
      const storedEndpoint = localStorage.getItem('geminiApiEndpoint');
      if (storedEndpoint && storedEndpoint.includes('poornima-oracle.onrender.com') && window.location.hostname === 'localhost') {
          localStorage.setItem('geminiApiEndpoint', `${window.location.origin}/api/chat`);
          return `${window.location.origin}/api/chat`;
      }
      return storedEndpoint?.trim() || getDefaultApiEndpoint();
  }
  ```

---

### Bug 3: Flawed Precedence in API Error Detection Disables Key Diagnostics
- **Severity:** `P1 (High)`
- **Affected File:** `server.js` (Lines 209–244)
- **Problem Description:**  
  In `detectApiKeyError`:
  ```javascript
  const errorMessage = error?.message || String(error).toLowerCase();
  ```
  The operator precedence causes `error.message` to be evaluated **without** `.toLowerCase()` whenever `error.message` exists.
  Subsequent checks (lines 216–232) test for lowercase substrings:
  ```javascript
  errorMessage.includes('api_key') ||
  errorMessage.includes('api key') ||
  errorMessage.includes('unauthorized') ||
  errorMessage.includes('invalid api key')
  ```
- **Impact:**  
  Standard exceptions from Google GenAI (`Error: "API key not valid. Please pass a valid API key."`) or Pinecone (`Error: "Unauthorized"`) fail all `.includes()` tests because `"API key".includes('api key')` is `false`. The entire diagnostic warning block is skipped, returning a generic 500 error instead of actionable credentials feedback.
- **Remediation:**
  ```javascript
  const errorMessage = (error?.message || String(error)).toLowerCase();
  ```

---

### Bug 4: Premature SSE Headers Nullify HTTP Status Codes & Error Handling
- **Severity:** `P1 (High)`
- **Affected File:** `server.js` (Lines 606, 653–675)
- **Problem Description:**  
  Line 606 calls `setSseHeaders(res)` (which executes `res.flushHeaders()`) **before** running vector embeddings (`createQueryEmbedding`), Pinecone vector search (`pineconeIndex.query`), or model generation (`startAnswerStream`).  
  Once headers are flushed:
  - Line 664: `return res.status(401).json(...)` fails with `ERR_HTTP_HEADERS_SENT`.
  - Line 674: `res.status(500).json(...)` fails with `ERR_HTTP_HEADERS_SENT`.
- **Impact:**  
  Any failure during embedding generation or Pinecone lookup causes HTTP 200 to be locked in. Observability monitoring (uptime checks, APM tools) records fatal failures as successful 200 OK responses.
- **Remediation:**  
  Defer `setSseHeaders(res)` until validation, embedding, and vector lookup have succeeded. If any pre-stream step fails, respond with genuine HTTP error codes:
  ```javascript
  // 1. Generate query embedding
  const queryVector = await createQueryEmbedding(message);
  if (!Array.isArray(queryVector) || queryVector.length === 0) {
      return res.status(502).json({ error: 'Failed to generate embedding for the query.' });
  }

  // 2. Query Pinecone
  const queryResponse = await pineconeIndex.query({
      topK: RAG_TOP_K,
      vector: queryVector,
      includeMetadata: true,
  });

  // 3. All pre-flight tasks succeeded — initiate SSE stream
  setSseHeaders(res);
  writeSse(res, 'sources', { sources });

  const stream = await startAnswerStream(message, historyContext, contextSnippets);
  for await (const chunk of stream) {
      // stream tokens...
  }
  ```

---

### Bug 5: Missing SSE Client Disconnect & Mid-Stream Timeout Handlers
- **Severity:** `P1 (High)`
- **Affected File:** `server.js` (Lines 531–555, 636–652)
- **Problem Description:**
  1. `server.js` does not listen to `req.on('close')`. If a user closes the browser tab, navigates away, or cancels mid-stream, the Node.js server continues to consume Gemini API tokens and iterate through the generator to completion.
  2. In `startAnswerStream`, the timeout `abortController` is cleared inside `finally` **before** the stream is actually consumed:
     ```javascript
     try {
       return await ai.models.generateContentStream(...);
     } finally {
       abortController.clear(); // Cleared immediately after starting!
     }
     ```
- **Impact:** Sockets remain open; background unread streams waste paid Gemini quota; aborted requests cause unhandled `ERR_STREAM_WRITE_AFTER_END` socket exceptions.
- **Remediation:**
  Attach an `AbortController` linked directly to `req.on('close')`:
  ```javascript
  const clientAbortController = new AbortController();
  req.on('close', () => {
      if (!res.writableEnded) {
          console.log('[SSE] Client disconnected mid-stream. Aborting model call.');
          clientAbortController.abort();
      }
  });
  ```

---

### Bug 6: Multi-Turn Conversation History Truncation Drops Previous Assistant Responses
- **Severity:** `P1 (High)`
- **Affected File:** `server.js` (Lines 352–376)
- **Problem Description:**  
  `getRecentHistoryEntries(history)` executes:
  ```javascript
  return history
    .slice(0, -1)
    .slice(-MAX_HISTORY_MESSAGES)
  ```
  The logic assumes that the client includes the *current* query in `history` and uses `.slice(0, -1)` to remove it.  
  However, on follow-up questions:
  - If a client provides history of prior turns (`[ { role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1' } ]`) and the new question in `message: 'Q2'`:
  - `history.slice(0, -1)` removes `{ role: 'assistant', content: 'A1' }`! The assistant only sees `Q1`, completely losing its own prior answer.
- **Impact:** Contextual queries (*"Can you elaborate on that?"*, *"How much was the fee mentioned above?"*) fail completely because the previous answer was stripped.
- **Remediation:**
  ```javascript
  function getRecentHistoryEntries(history, currentMessage) {
    if (!Array.isArray(history) || history.length === 0) {
      return [];
    }

    let cleanHistory = history.filter(item => item && typeof item === 'object' && item.content);
    
    // Only strip the last item if it is an exact duplicate of the incoming message
    if (cleanHistory.length > 0) {
      const last = cleanHistory[cleanHistory.length - 1];
      if (last.role === 'user' && last.content.trim() === currentMessage.trim()) {
        cleanHistory = cleanHistory.slice(0, -1);
      }
    }

    return cleanHistory.slice(-MAX_HISTORY_MESSAGES).map(msg => ({
      role: msg.role === 'user' ? 'user' : 'assistant',
      content: sanitizeText(msg.content),
    }));
  }
  ```

---

### Bug 7: Missing `AbortController` Causes Stream State Bleed on "New Chat"
- **Severity:** `P1 (High)`
- **Affected File:** `index.html` (Lines 1177–1229, 1604–1708)
- **Problem Description:**  
  When a user starts a "New Chat" while a response is streaming:
  `startNewChat()` resets `isLoading = false` and creates a fresh `activeConversation`. However, the asynchronous `callGeminiAPI()` reader loop continues running in the background. When it completes, line 1683:
  ```javascript
  conversationHistory.push({ id: assistantId, role: 'assistant', content: responseText, ... });
  ```
  pushes the previous conversation's assistant answer into the brand new, clean chat session.
- **Impact:** UI state corruption; answers from old chats suddenly appear inside new conversations.
- **Remediation:**
  Introduce a global `activeAbortController`:
  ```javascript
  let activeAbortController = null;

  function stopGenerating() {
      if (activeAbortController) {
          activeAbortController.abort();
          activeAbortController = null;
      }
      isLoading = false;
  }
  ```
  Pass `signal: activeAbortController.signal` into `fetch(apiEndpoint, { ... })` and call `stopGenerating()` inside `startNewChat()` and `handleSwitchConversation()`.

---

### Bug 8: Destructive Mid-Stream Error Handling Wipes Prior Streamed Output
- **Severity:** `P1 (High)`
- **Affected File:** `index.html` (Lines 1696–1700)
- **Problem Description:**  
  If the network drops mid-stream (e.g. at 90% of a 400-word response), the catch block executes:
  ```javascript
  } catch (err) {
      assistantShell.wrapper.remove(); // <-- Deletes the entire message bubble!
      const errHTML = `<div class="flex justify-center mb-6"><div class="bg-rose-500/10 border border-rose-500/20 text-rose-400 px-4 py-2 rounded-xl text-sm">Error: ${escapeHtml(err.message)}</div></div>`;
      chatContainer.insertAdjacentHTML('beforeend', errHTML);
  }
  ```
- **Impact:** All paragraphs streamed up to that point vanish instantly from the user's view, leaving an orphaned user question without a response.
- **Remediation:**
  Retain the partial response and render a non-destructive inline warning banner with a "Retry" button.

---

### Bug 9: Permanent Runaway Canvas Loop in `ClickSpark` Draining CPU & Battery
- **Severity:** `P1 (High)`
- **Affected File:** `index.html` (Lines 2090–2152)
- **Problem Description:**  
  The full-screen canvas particle animation `ClickSpark.animate()` recursively requests animation frames unconditionally:
  ```javascript
  animate(timestamp) {
      if (!timestamp) timestamp = performance.now();
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.sparks = this.sparks.filter(spark => { ... });
      // ...
      requestAnimationFrame((t) => this.animate(t)); // Runs 60-120fps forever!
  }
  ```
- **Impact:** Even when no sparks exist (`this.sparks = []`), the browser repaints the full-screen canvas 60–120 times every second. This causes laptop fans to spin, high CPU usage, and rapid mobile battery drain.
- **Remediation:**  
  Only run the `requestAnimationFrame` loop when `this.sparks.length > 0`. Stop the loop when empty, and restart it in `addSparks()`.

---

### Bug 10: Missing Static Asset Middleware in Express (`Cannot GET /`)
- **Severity:** `P1 (High)`
- **Affected File:** `server.js` (Lines 557–564)
- **Problem Description:**  
  `server.js` manually handles `/` and `/styles.css` using explicit `res.sendFile()` routes, but omits `express.static('.')`. Any future assets (favicon, images, client JS modules) return `404 Not Found`.
- **Remediation:**
  ```javascript
  app.use(express.static(path.join(__dirname)));
  ```

---

## 3. Security & Architectural Vulnerabilities (P1 / P2)

---

### Sec 1: Missing `trust proxy` Enables Global Rate Limiter Denial of Service
- **Severity:** `P1 (High)`
- **Affected File:** `server.js` (Lines 15, 152–158)
- **Vulnerability Details:**  
  The application is deployed on cloud infrastructure (Render, Heroku, AWS ALB) behind reverse proxies. However, `app.set('trust proxy', 1)` is not set.  
  As a result:
  - Express interprets `req.ip` as the load balancer's internal IP address.
  - All users across the globe are assigned the **same IP address** by `express-rate-limit`.
  - Once any single user consumes 20 queries within 15 minutes, **all campus users are blocked simultaneously** with `"Too many chat requests"`.
- **Remediation:**  
  Add immediately after `const app = express();`:
  ```javascript
  app.set('trust proxy', 1);
  ```

---

### Sec 2: Unbounded In-Memory Cache (`node-cache`) Leading to OOM Crash
- **Severity:** `P1 (High)`
- **Affected File:** `server.js` (Lines 77–84)
- **Vulnerability Details:**  
  `queryCache = new NodeCache({ stdTTL: 3600, checkperiod: 120, useClones: false })` has no `maxKeys` limit.  
  An attacker can generate thousands of distinct variations of queries to flood the cache with large text strings and source arrays, forcing a Node.js heap overflow crash (`JavaScript heap out of memory`).
- **Remediation:**
  ```javascript
  const queryCache = new NodeCache({
    stdTTL: queryCacheTtlSeconds || 3600,
    checkperiod: 120,
    maxKeys: 1000,      // Prevent unbounded memory expansion
    useClones: true,     // Prevent in-place mutation of cached records
  });
  ```

---

### Sec 3: Destructive Sanitization (`xss` with `whiteList: {}`) Corrupting Markdown and Math
- **Severity:** `P1 (High)`
- **Affected File:** `server.js` (Lines 197–207, 578, 649)
- **Vulnerability Details:**  
  `sanitizeText()` uses `xss(value, { whiteList: {} })`.
  - Strips valid mathematical operators (`attendance < 75%`, `CGPA > 8.5`).
  - Corrupts Gemini autolinks (`<https://poornima.edu.in>`).
  - Stripping on line 649 (`answer = sanitizeText(answer)`) creates a visible flash where tokens streamed raw via SSE suddenly have characters deleted when the final `done` event fires.
- **Remediation:**  
  On the backend, validate string type, normalize unicode, and enforce maximum length. Let client-side `DOMPurify.sanitize(marked.parse(...))` handle HTML element sanitization safely.

---

### Sec 4: Wildcard CORS Fallback & CSP Directive Mismatches
- **Severity:** `P2 (Medium)`
- **Affected File:** `server.js` (Lines 17–19, 160–192)
- **Vulnerability Details:**
  1. If `CORS_ORIGIN` is not defined in `.env`, CORS defaults to `*`, allowing arbitrary external origins to send POST requests.
  2. Helmet's CSP `connectSrc` includes Google Generative AI endpoints (`https://generativelanguage.googleapis.com`), which the client browser never contacts directly (the backend does). Meanwhile, external subdomains or CDNs used by the frontend risk being blocked if configured strictly.
- **Remediation:**  
  Restrict default CORS in production to the college's verified domains, and streamline `connectSrc` to `'self'` and the designated backend API host.

---

### Sec 5: Unbounded Feedback Endpoint Flooding & Ephemeral Storage
- **Severity:** `P2 (Medium)`
- **Affected File:** `server.js` (Lines 678–696)
- **Vulnerability Details:**  
  `/api/feedback` is not protected by rate limiting. Automated bots can POST arbitrary volume, polluting stdout. Furthermore, feedback is only printed to `console.log` and never saved to a database or file, meaning all user telemetry is lost on container restarts.
- **Remediation:**  
  Apply rate limiting to `/api/feedback` (e.g., max 10/min per IP) and buffer feedback to an append-only JSONL log file or persistent database.

---

### Sec 6: Missing Server Graceful Shutdown Handlers (`SIGTERM`/`SIGINT`)
- **Severity:** `P2 (Medium)`
- **Affected File:** `server.js` (Lines 698–717)
- **Vulnerability Details:**  
  `package.json` includes PM2 scripts (`npm run start:prod`). However, `server.js` registers no `SIGTERM` or `SIGINT` signals. Container redeployments or PM2 reloads sever client SSE connections and in-flight vector queries abruptly.
- **Remediation:**
  ```javascript
  const shutdown = (signal) => {
    console.log(`Received ${signal}. Gracefully closing server...`);
    server.close(() => {
      console.log('HTTP server closed. Exiting process.');
      process.exit(0);
    });
    setTimeout(() => {
      console.error('Force shutdown after timeout.');
      process.exit(1);
    }, 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  ```

---

### Sec 7: Missing Pinecone Namespace Support & Euclidean Metric Assumption
- **Severity:** `P2 (Medium)`
- **Affected File:** `server.js` (Lines 622–626)
- **Vulnerability Details:**
  1. `pineconeIndex.query` does not specify a `namespace`. If documents were ingested into a specific namespace (e.g. `handbook` or `admissions`), queries to the default namespace return zero matches.
  2. In `filterRelevantMatches`, `match.score >= RAG_MIN_SCORE` assumes cosine similarity (where 1.0 is identical). If the Pinecone index was created using Euclidean distance (`L2`), smaller scores indicate closer matches, causing the filter to discard the best matches.
- **Remediation:**  
  Support `PINECONE_NAMESPACE` in `.env`, and add an assertion or metric check for the index configuration.

---

## 4. UX, Performance & Accessibility (a11y) Improvements (P2 / P3)

---

### UX 1: Assistant Action Bar Hidden on Mobile Screens & Touch Laptops
- **Problem:** `index.html:1937` marks the action bar with `hidden md:flex opacity-0 group-hover:opacity-100`.  
  Mobile users on phones cannot access **Copy**, **Read Aloud**, or **Regenerate**. Touch screen laptops fail to trigger `group-hover`.
- **Fix:** Display the action bar with visible tap targets on mobile screens (`flex md:opacity-0 md:group-hover:opacity-100`).

---

### UX 2: Mobile Sidebar Overlay Z-Index Glitch Allowing Accidental Clicks
- **Problem:** `index.html:427` assigns `#sidebarOverlay` `z-[10]`.  
  The main header has `z-30` and the input bar has `z-20`. When the mobile drawer is open, users can tap right through the header or input box behind the drawer.
- **Fix:** Upgrade `#sidebarOverlay` to `z-[60]` (positioned directly underneath the drawer at `z-[70]`).

---

### UX 3: Desktop Collapse Inline Style Poisoning Mobile Drawer
- **Problem:** `index.html:1167` injects `sidebar.style.width = '80px'`.  
  If the browser window is resized to mobile viewport, the inline style overrides Tailwind's `w-[85%]`, squishing the mobile drawer to 80px.
- **Fix:** Clear `sidebar.style.width = ''` whenever the screen is below `768px` or during sidebar state changes.

---

### UX 4: Flawed "Regenerate" Appending Duplicate Questions
- **Problem:** `index.html:1593-1601` handles regenerate by calling `sendMessage({ message: question })`.  
  This appends a duplicate user prompt and duplicate assistant answer at the bottom of the conversation instead of updating the existing response in place.
- **Fix:** Replace the target assistant bubble and re-stream into the existing container.

---

### UX 5: Accidental Instant Conversation Deletion
- **Problem:** `index.html:937-942` immediately deletes conversations on trash icon click without confirmation. Accidental taps cause irreversible data loss.
- **Fix:** Add a non-blocking confirmation dialog or inline undo toast.

---

### UX 6: Unstable External Google Search Thumbnail for Oracle Avatar
- **Problem:** `index.html:570` uses an unauthenticated Google Image Search thumbnail URL (`https://encrypted-tbn0.gstatic.com/images?q=...`), which can expire or return 403.
- **Fix:** Replace with an inline SVG avatar or a locally hosted WebP asset in the project directory.

---

### UX 7: Synchronous Full Markdown Parsing During High-Speed Streaming
- **Problem:** `index.html:1954-1975` calls `marked.parse(latestText)` and `DOMPurify.sanitize(rawHtml)` inside `requestAnimationFrame` on every single incoming token chunk. For long answers, running full AST parsing and sanitization 60 times a second causes frame drops.
- **Fix:** Throttle markdown rendering to 150ms intervals during active streaming, and flush the final render when the stream completes.

---

### A11y 1: Viewport Zoom Disabled (`user-scalable=no` Violation)
- **Problem:** `index.html:6` sets `maximum-scale=1, user-scalable=no`, and line 1140 intercepts `dblclick`.  
  This violates **WCAG 1.4.4 (Resize Text)**, preventing visually impaired users from zooming.
- **Fix:** Change viewport to `width=device-width, initial-scale=1` and remove the `dblclick` preventDefault interceptor.

---

### A11y 2: Non-Semantic Interactive Divs Failing Keyboard Navigation
- **Problem:** Suggestion cards (`index.html:1845`) and sidebar items (`index.html:922`) are plain `<div>` elements with `onclick`. Keyboard users navigating via Tab cannot access them.
- **Fix:** Use `<button type="button">` or add `tabindex="0"`, `role="button"`, and Enter/Space `keydown` listeners.

---

### A11y 3: Low Contrast Text Violating WCAG 2.1 AA
- **Problem:** Elements with `text-zinc-600` (`#52525b`) on `bg-zinc-950` (`#09090b`) exhibit a contrast ratio of only **3.2:1**, failing the WCAG AA minimum threshold of **4.5:1**.
- **Fix:** Upgrade secondary labels to `text-zinc-400` (`#a1a1aa`, 6.8:1 contrast).

---

### A11y 4: Missing ARIA Live Region for Screen Readers
- **Problem:** Incoming streaming responses lack `aria-live="polite"` or `role="status"`. Screen reader users receive no notification when an answer has begun streaming or finished.
- **Fix:** Add `aria-live="polite"` to the assistant message content container.

---

## 5. Refactoring & Modularization Blueprint

To eliminate the 2,159-line single-file monolith (`index.html`), the frontend should be organized into modular ES modules:

```
Poornima-Oracle/
├── public/
│   ├── index.html              <-- Clean HTML skeleton (< 120 lines)
│   ├── favicon.ico
│   └── assets/
│       └── oracle-avatar.svg   <-- Self-hosted vector branding
├── src/
│   ├── css/
│   │   ├── input.css           <-- Tailwind directives
│   │   └── animations.css      <-- Orb blur, glow, particle styles
│   └── js/
│       ├── app.js              <-- Application lifecycle & bootstrapping
│       ├── config.js           <-- API endpoints, prompt presets, storage keys
│       ├── state.js            <-- Global store, conversation state
│       ├── storage/
│       │   └── conversationStore.js  <-- IndexedDB with safe fallback
│       ├── api/
│       │   ├── sseClient.js    <-- Robust SSE streaming with AbortController
│       │   └── feedback.js     <-- Feedback dispatcher
│       ├── audio/
│       │   ├── speechRecognition.js  <-- Speech-to-text handler
│       │   └── speechSynthesizer.js  <-- Mobile-compatible Text-to-speech
│       ├── components/
│       │   ├── messageBubble.js      <-- User & Assistant message shells
│       │   ├── sourceChips.js        <-- Verified RAG citations chips
│       │   ├── sidebar.js            <-- History drawer & modal controllers
│       │   └── sparkCanvas.js        <-- Battery-friendly spark canvas
│       └── utils/
│           ├── markdown.js           <-- Throttled marked + DOMPurify
│           └── dom.js                <-- HTML escape, focus traps, scroll helpers
├── styles.css                  <-- Minified Tailwind output
├── server.js                   <-- Clean Express backend API
├── package.json
└── README.md
```

---

## 6. Implementation Roadmap & Prioritized Task List

### Phase 1: Immediate Critical Fixes (Sprint 1) — ✅ COMPLETED
- [x] **Task 1.1**: Activate RAG citation rendering in `index.html` (implemented `renderSourceChips`, removed DOM wipe stubs).
- [x] **Task 1.2**: Remove hardcoded Render remote endpoint; make `/api/chat` dynamic and relative to `window.location.origin`.
- [x] **Task 1.3**: Fix operator precedence in `server.js:detectApiKeyError` (`(error?.message || String(error)).toLowerCase()`).
- [x] **Task 1.4**: Defer SSE headers in `server.js` until validation and Pinecone queries pass.
- [x] **Task 1.5**: Add `AbortController` linked to `req.on('close')` in `server.js` and client-side stop button in `index.html`.
- [x] **Task 1.6**: Correct history truncation logic in `server.js:getRecentHistoryEntries`.
- [x] **Task 1.7**: Fix runaway loop in `ClickSpark` to stop when sparks array is empty.
- [x] **Task 1.8**: Non-destructive mid-stream error handling in `index.html` (preserve partial answers).
- [x] **Task 1.9**: Enable Express static serving (`app.use(express.static('.'))`) and cloud reverse proxy trust (`app.set('trust proxy', 1)`).

### Phase 2: Security & Backend Hardening (Sprint 2) — ✅ COMPLETED
- [x] **Task 2.1**: Add `app.set('trust proxy', 1)` in `server.js` to fix global rate limiter blocking on Render.
- [x] **Task 2.2**: Configure `maxKeys: 1000` and `useClones: true` in `node-cache`.
- [x] **Task 2.3**: Stop destructive backend `xss` sanitization on LLM markdown output and Pinecone snippets.
- [x] **Task 2.4**: Restrict CORS origins in production and clean up redundant Google endpoints in CSP `connectSrc`.
- [x] **Task 2.5**: Add rate limiting to `/api/feedback` and implement graceful shutdown (`SIGTERM`/`SIGINT`).
- [x] **Task 2.6**: Add `PINECONE_NAMESPACE` support in `server.js`.

### Phase 3: UX, Accessibility & Mobile Optimization (Sprint 3) — ✅ COMPLETED
- [x] **Task 3.1**: Enable mobile view of assistant action bar (Copy, Read Aloud, Regenerate).
- [x] **Task 3.2**: Fix mobile sidebar overlay z-index (`z-[60]`) and reset desktop collapse inline styles.
- [x] **Task 3.3**: Enable viewport pinch-to-zoom (remove `user-scalable=no, maximum-scale=1` and `dblclick` preventer for WCAG 1.4.4 compliance).
- [x] **Task 3.4**: Make all interactive cards and conversation items keyboard accessible (`<button>` or `tabindex="0"` with Enter/Space listeners).
- [x] **Task 3.5**: Upgrade low-contrast text colors (`text-zinc-600` -> `text-zinc-400`).
- [x] **Task 3.6**: Add `aria-live="polite"` to message response containers.
- [x] **Task 3.7**: Replace external Google Search thumbnail avatar with local branded SVG asset.
- [x] **Task 3.8**: Added IME composition guard (`isComposing`) to input key handler.
- [x] **Task 3.9**: Added confirmation dialog on conversation deletion to prevent accidental loss.

### Phase 4: Performance & Tooling (Sprint 4) — ✅ COMPLETED
- [x] **Task 4.1**: Throttled Markdown AST parsing to 100ms intervals during active streaming to preserve 60fps frame rates.
- [x] **Task 4.2**: Pinned Lucide icons to specific release (`lucide@0.469.0`).
- [x] **Task 4.3**: Added `test:pinecone` and `check` npm scripts to `package.json`.
- [x] **Task 4.4**: Recompiled production CSS bundle with Tailwind CSS (`npm run build:css`).

---
*Improvements Plan document compiled and saved in the project root directory.*
