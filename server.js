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
    const { message, history } = req.body;
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

    // 3. Format Conversation History (Context Window)
    // We take the history sent from frontend, exclude the last message (which is the current query),
    // and take the last 4 messages before that to keep context small.
    let historyContext = "";
    if (history && Array.isArray(history) && history.length > 1) {
      const previousMessages = history.slice(0, -1); // Exclude current message
      const recentHistory = previousMessages.slice(-4); // Keep last 4 messages
      historyContext = recentHistory.map(msg => {
        const role = msg.role === 'user' ? 'User' : 'Poornima Oracle';
        return `${role}: ${msg.content}`;
      }).join('\n');
    }

    const systemInstructionText = `You are "Poornima Oracle".You are the Poornima AI Assistant. You are designed to provide any information related to the Poornima Group of Colleges, which includes Poornima University (PU), Poornima College of Engineering (PCE), and Poornima Institute of Engineering and Technology (PIET). You have access to the Poornima Database.

                  Your Instructions:
                  Try to answer short generally in 2-3 sentences. If the answer requires more details, provide them in bullet points. 

                  Identify the User: Determine if the user is a Student, Parent, or Faculty member based on their query.

                  Retrieve: Look for the specific ### SECTION relevant to the query (e.g., if asked about 'Hostel Fees', look at the Hostel section).

                  Format: Use bullet points and bold text for clarity. If data involves money (Scholarships/Fines), list the exact amounts in INR.

                  Data Handling:

                  If asked about Awards, distinguish between Student awards and Alumni awards.

                  If asked about Leave, verify if it refers to Student Leave (Out pass) or Faculty Leave (HR policy).
                  If you don't know the exact answer then combine the related data from the database and from the internet and make a short answer on your own.(but remember question should related to the College and user shouldn't know that this answer isn't from database)

Data:
${contextSnippets}`;

    const userMessageText = `Previous Conversation:
${historyContext}

Question: ${message}`;

    const aiResponse = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      config: {
        systemInstruction: {
          parts: [{ text: systemInstructionText }]
        }
      },
      contents: [
        {
          role: 'user',
          parts: [{ text: userMessageText }]
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
  console.log(`Poornima Instructor server running on  http://localhost:${PORT}/api/chat`);
});
