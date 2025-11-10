// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenAI } = require('@google/genai');
// const { PineconeClient } = require('@pinecone-database/pinecone');
const { Pinecone } = require('@pinecone-database/pinecone');
const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });


const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Google Gemini (GenAI) client
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Initialize Pinecone client
// const pinecone = new PineconeClient();
// pinecone.init({
//   apiKey: process.env.PINECONE_API_KEY,
//   environment: process.env.PINECONE_ENV,
// });

// Helper to detect abusive input
const isAbusive = (text) => {
  const badWords = ['fuck', 'shit', 'stupid', 'bakwaas'];
  return badWords.some(word => text.toLowerCase().includes(word));
};

// Chat endpoint
app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;
    console.log('User query:', message);

    // If input is abusive, reply in humorous Hinglish
    if (isAbusive(message)) {
      const hinglishReply = "Arre yaar, itni bakwaas mat kar! Thoda dimag laga ke baat kar.";
      return res.json({ answer: hinglishReply });
    }

    // 1. Create embedding for the user query
    const embedResponse = await ai.models.embedContent({
      model: 'text-embedding-004',
      contents: [
        {
          role: 'user',
          parts: [{ text: message }]
        }
      ],
      outputDimensionality: 768
    });
    const queryVector = (embedResponse.embeddings && embedResponse.embeddings[0] && embedResponse.embeddings[0].values) || [];

    // 2. Query Pinecone for relevant RuleBook passages
    const index = pinecone.Index(process.env.PINECONE_INDEX_NAME);
    const queryResponse = await index.query({
      topK: 3,
      vector: queryVector,
      includeMetadata: true
    });
    const matches = queryResponse.matches || [];
    const contextSnippets = matches
      .map(match => match.metadata.text)
      .join("\n");

    // 3. Generate answer with Google Gemini (GenAI) using the retrieved context
    const prompt = `Answer the question using the following RuleBook excerpts (include [bracketed] citations and use bulletpoints for long answers):\n\n${contextSnippets}\n\nQuestion: ${message}`;
    const aiResponse = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }]
        }
      ],
    });
    const answer = (aiResponse.text || '').trim();

    // Send the AI-generated answer back to the client
    res.json({ answer });
  } catch (error) {
    console.error('Error in /api/chat:', error);
    res.status(500).json({ error: 'Failed to process the query.' });
  }
});

// Start the Express server
app.listen(PORT, () => {
  console.log(`Poornima Instructor server running on port ${PORT}`);
});
