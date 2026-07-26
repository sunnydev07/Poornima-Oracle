# 🔮 Poornima Oracle — Campus RAG Assistant

[![Node.js](https://img.shields.io/badge/Node.js-18+-green?style=flat-square&logo=node.js)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-4.0-black?style=flat-square&logo=express)](https://expressjs.com/)
[![Pinecone](https://img.shields.io/badge/Pinecone-VectorDB-blue?style=flat-square)](https://www.pinecone.io/)
[![Google Gemini](https://img.shields.io/badge/Gemini-2.5--Flash-orange?style=flat-square&logo=google)](https://ai.google.dev/)

**Poornima Oracle** is an intelligent, RAG-powered campus assistant designed for Poornima Group of Colleges (PU, PCE, PIET). It retrieves verified institutional information from Pinecone vector databases and streams grounded answers using Google Gemini.

---

## ✨ Features

- 🧠 **Retrieval-Augmented Generation (RAG)**: Answers grounded in official Poornima academic, campus, and administrative documents.
- ⚡ **Server-Sent Events (SSE) Streaming**: Real-time token streaming for zero-perceived-latency responses.
- 🎙️ **Voice & Audio Features**: Built-in speech-to-text input and text-to-speech response playback.
- 🛡️ **Production Security**: Rate limiting, query caching, input sanitization, dynamic CORS, and Helmet headers.
- 📊 **Feedback & Health System**: `/api/health` configuration checks and user feedback logging.

---

## 🛠️ Architecture

```
[ User Browser ] ---> SSE Request ---> [ Express API Server ]
                                             |
                                 +-----------+-----------+
                                 |                       |
                      [ Pinecone Vector DB ]     [ Google Gemini ]
                      (768-dim Embeddings)      (gemini-2.5-flash)
```

---

## 🚀 Quick Start

### 1. Installation

```bash
git clone https://github.com/sunnydev07/Poornima-Oracle.git
cd Poornima-Oracle
npm install
```

### 2. Environment Setup

Create a `.env` file in the project root:

```env
GEMINI_API_KEY=your_gemini_api_key
PINECONE_API_KEY=your_pinecone_api_key
PINECONE_INDEX_NAME=poornima
PORT=3001
```

### 3. Run Locally

```bash
npm run dev
```

Open [http://localhost:3001](http://localhost:3001) in your browser.

---

## 🔌 API Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/health` | GET | Check server configuration & health status |
| `/api/chat` | POST | Stream RAG-grounded responses via SSE |
| `/api/feedback` | POST | Log user upvote/downvote feedback |

---

## 📄 License

Distributed under the MIT License. Created by [Sunny Kumar Dev](https://github.com/sunnydev07).
