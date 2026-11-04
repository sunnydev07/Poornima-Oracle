const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { AsyncLocalStorage } = require('node:async_hooks');
const { once } = require('node:events');
const { createApp, createTimeoutFetch } = require('../server');

function parseSseEvents(body) {
  return body
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const event = block.match(/^event: (.+)$/m)?.[1];
      const data = block.match(/^data: (.+)$/m)?.[1];
      return event && data ? { event, data: JSON.parse(data) } : null;
    })
    .filter(Boolean);
}

async function startTestServer(app, t) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

function createAbortAwareProviders(onGenerationStart = () => {}, onProviderAbort = () => {}) {
  return {
    ai: {
      models: {
        async embedContent() {
          return { embeddings: [{ values: [1] }] };
        },
        async generateContentStream({ config }) {
          const signal = config.abortSignal;
          onGenerationStart(signal);
          return (async function* stream() {
            await new Promise((resolve) => {
              if (signal.aborted) {
                onProviderAbort();
                resolve();
                return;
              }
              signal.addEventListener('abort', () => {
                onProviderAbort();
                resolve();
              }, { once: true });
            });
          }());
        },
      },
    },
    pineconeIndex: { async query() { return { matches: [] }; } },
  };
}

test('chat preserves literal text and returns identical streamed, final, and cached answers', async (t) => {
  const embeddingQueries = [];
  const modelPrompts = [];
  const mockAi = {
    models: {
      async embedContent({ contents }) {
        embeddingQueries.push(contents);
        return { embeddings: [{ values: [0.1, 0.2] }] };
      },
      async generateContentStream(params) {
        const prompt = params.contents[0].parts[0].text;
        modelPrompts.push({ prompt, systemInstruction: params.config.systemInstruction });
        const answer = prompt.includes('fees < 50000')
          ? 'Fees < 50,000 and **eligible**.'
          : 'Fees < 20,000 and **eligible**.';
        return (async function* stream() {
          yield { text: answer.slice(0, 12) };
          yield { text: answer.slice(12) };
        }());
      },
    },
  };
  const mockPineconeIndex = {
    async query() {
      return {
        matches: [
          {
            id: 'policy-1',
            score: 0.95,
            metadata: {
              text: 'Eligibility requires CGPA<6.5 and the fee threshold.',
              url: 'javascript:alert(1)',
            },
          },
          {
            id: 'policy-2',
            score: 0.92,
            metadata: {
              documentName: 'Admissions policy',
              url: 'javascript:alert(1)',
              link: 'https://example.org/admissions',
            },
          },
        ],
      };
    },
  };
  const app = createApp({
    ai: mockAi,
    pineconeIndex: mockPineconeIndex,
    missingEnvVars: [],
    config: { answerTimeoutMs: 1000, answerIdleTimeoutMs: 500 },
  });
  const baseUrl = await startTestServer(app, t);
  const requestBody = {
    message: 'fees < 20000',
    history: [
      { role: 'user', content: 'Tell me the eligibility rule.' },
      { role: 'assistant', content: 'The CGPA requirement is CGPA<6.5.' },
      { role: 'user', content: 'Does the latest policy apply to fees < 20000?' },
    ],
  };

  const firstResponse = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });
  assert.equal(firstResponse.status, 200);
  const firstEvents = parseSseEvents(await firstResponse.text());
  const firstTokens = firstEvents.filter((event) => event.event === 'token');
  const firstDone = firstEvents.find((event) => event.event === 'done');
  assert.equal(embeddingQueries[0], 'fees < 20000');
  const sources = firstEvents.find((event) => event.event === 'sources').data.sources;
  assert.equal(sources[0].url, '');
  assert.equal(sources[1].url, 'https://example.org/admissions');
  assert.match(modelPrompts[0].systemInstruction, /CGPA<6\.5/);
  assert.match(modelPrompts[0].prompt, /User: Tell me the eligibility rule\./);
  assert.match(modelPrompts[0].prompt, /Poornima Oracle: The CGPA requirement is CGPA<6\.5\./);
  assert.match(modelPrompts[0].prompt, /User: Does the latest policy apply to fees < 20000\?/);
  assert.match(modelPrompts[0].prompt, /Question: fees < 20000/);
  assert.equal(firstTokens.map((event) => event.data.text).join(''), firstDone.data.answer);
  assert.equal(firstDone.data.answer, 'Fees < 20,000 and **eligible**.');

  const cachedResponse = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });
  const cachedEvents = parseSseEvents(await cachedResponse.text());
  const cachedTokens = cachedEvents.filter((event) => event.event === 'token');
  const cachedDone = cachedEvents.find((event) => event.event === 'done');
  assert.equal(cachedDone.data.cached, true);
  assert.equal(cachedTokens.map((event) => event.data.text).join(''), cachedDone.data.answer);
  assert.equal(cachedDone.data.answer, firstDone.data.answer);
  assert.equal(modelPrompts.length, 1);

  const differentQuestion = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'fees < 50000', history: requestBody.history }),
  });
  const differentEvents = parseSseEvents(await differentQuestion.text());
  assert.equal(differentEvents.find((event) => event.event === 'done').data.answer, 'Fees < 50,000 and **eligible**.');
  assert.equal(modelPrompts.length, 2);
});

test('API returns stable JSON for malformed and oversized requests and tolerates untrusted XFF', async (t) => {
  const app = createApp({
    ai: null,
    pineconeIndex: null,
    missingEnvVars: [],
    config: { chatRateLimitMax: 1, chatRateLimitWindowMs: 60000 },
  });
  const baseUrl = await startTestServer(app, t);

  const malformedResponse = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  });
  assert.equal(malformedResponse.status, 400);
  assert.match(malformedResponse.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await malformedResponse.json(), { error: 'Request body must contain valid JSON.' });

  const oversizedResponse = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'x'.repeat(40000) }),
  });
  assert.equal(oversizedResponse.status, 413);
  assert.deepEqual(await oversizedResponse.json(), { error: 'Request body is too large.' });

  const forwardedResponse = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': '203.0.113.42',
    },
    body: '{}',
  });
  assert.equal(forwardedResponse.status, 400);
  assert.deepEqual(await forwardedResponse.json(), { error: 'Message is required.' });

  const spoofedForwardResponse = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': '198.51.100.77',
    },
    body: '{}',
  });
  assert.equal(spoofedForwardResponse.status, 429);
  assert.deepEqual(await spoofedForwardResponse.json(), {
    error: 'Too many chat requests. Please wait and try again.',
  });
});

test('feedback validates bounded fields, rate limits submissions, and never logs student text', async (t) => {
  const app = createApp({
    ai: null,
    pineconeIndex: null,
    missingEnvVars: [],
    config: { feedbackRateLimitMax: 3, feedbackRateLimitWindowMs: 60000 },
  });
  const baseUrl = await startTestServer(app, t);
  const privateQuestion = 'student question < 5';
  const privateAnswer = 'private assistant answer';
  const originalInfo = console.info;
  const logs = [];
  console.info = (...args) => logs.push(JSON.stringify(args));

  let validResponse;
  try {
    validResponse = await fetch(`${baseUrl}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messageId: 'assistant-1',
        rating: 'up',
        question: privateQuestion,
        answer: privateAnswer,
        sources: [{ id: 'source-1', title: '<script>title</script>', url: 'javascript:alert(1)' }],
      }),
    });
  } finally {
    console.info = originalInfo;
  }

  assert.equal(validResponse.status, 200);
  assert.deepEqual(await validResponse.json(), { ok: true, messageId: 'assistant-1' });
  assert.equal(logs.join(' ').includes(privateQuestion), false);
  assert.equal(logs.join(' ').includes(privateAnswer), false);

  const longFeedbackResponse = await fetch(`${baseUrl}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rating: 'down', answer: 'x'.repeat(12001) }),
  });
  assert.equal(longFeedbackResponse.status, 400);

  const invalidSourceResponse = await fetch(`${baseUrl}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rating: 'up', sources: [{ title: 'x'.repeat(2049) }] }),
  });
  assert.equal(invalidSourceResponse.status, 400);

  const limitedResponse = await fetch(`${baseUrl}/api/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rating: 'up' }),
  });
  assert.equal(limitedResponse.status, 429);
});

test('cache evicts the oldest entry at its configured bound', async (t) => {
  let generationCount = 0;
  const app = createApp({
    ai: {
      models: {
        async embedContent() { return { embeddings: [{ values: [1] }] }; },
        async generateContentStream({ contents }) {
          generationCount += 1;
          const prompt = contents[0].parts[0].text;
          const answer = prompt.split('Question: ').pop();
          return (async function* stream() { yield { text: answer }; }());
        },
      },
    },
    pineconeIndex: { async query() { return { matches: [] }; } },
    missingEnvVars: [],
    config: { cacheMaxKeys: 1 },
  });
  const baseUrl = await startTestServer(app, t);

  async function ask(message) {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history: [] }),
    });
    return parseSseEvents(await response.text()).find((event) => event.event === 'done');
  }

  await ask('question one');
  await ask('question two');
  await ask('question one');
  assert.equal(generationCount, 3);
});

test('CORS only allows configured browser origins', async (t) => {
  const app = createApp({
    ai: null,
    pineconeIndex: null,
    missingEnvVars: [],
    config: { corsOrigins: ['https://portal.example.test'] },
  });
  const baseUrl = await startTestServer(app, t);

  const blockedResponse = await fetch(`${baseUrl}/api/chat`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://untrusted.example.test',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  assert.equal(blockedResponse.headers.get('access-control-allow-origin'), null);

  const allowedResponse = await fetch(`${baseUrl}/api/chat`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://portal.example.test',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  assert.equal(allowedResponse.headers.get('access-control-allow-origin'), 'https://portal.example.test');
});

test('static app assets are served explicitly without exposing backend files', async (t) => {
  const app = createApp({ ai: null, pineconeIndex: null, missingEnvVars: [] });
  const baseUrl = await startTestServer(app, t);

  for (const assetPath of ['/index.html', '/manifest.json', '/sw.js', '/poornima-oracle.svg']) {
    const response = await fetch(`${baseUrl}${assetPath}`);
    assert.equal(response.status, 200, `${assetPath} should be available to the PWA`);
  }

  for (const privatePath of ['/server.js', '/.env', '/package.json']) {
    const response = await fetch(`${baseUrl}${privatePath}`);
    assert.equal(response.status, 404, `${privatePath} must remain private`);
  }
});

test('answer deadline remains active through slow stream consumption', async (t) => {
  let providerAborted = false;
  let markProviderAbort;
  const abortObserved = new Promise((resolve) => { markProviderAbort = resolve; });
  const providers = createAbortAwareProviders(
    () => {},
    () => {
      providerAborted = true;
      markProviderAbort();
    }
  );
  const app = createApp({
    ...providers,
    missingEnvVars: [],
    config: { answerTimeoutMs: 80, answerIdleTimeoutMs: 1000 },
  });
  const baseUrl = await startTestServer(app, t);
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'slow response', history: [] }),
  });
  const events = parseSseEvents(await response.text());

  assert.equal(providerAborted, true);
  await abortObserved;
  assert.equal(events.find((event) => event.event === 'error')?.data.error, 'The response took too long. Please try again.');
  assert.equal(events.some((event) => event.event === 'done'), false);
});

test('provider throttling and API-key errors are classified separately from generic upstream errors', async (t) => {
  let generateCalls = 0;
  const mockAi = {
    models: {
      async embedContent() { return { embeddings: [{ values: [1] }] }; },
      async generateContentStream({ contents }) {
        generateCalls += 1;
        const prompt = contents[0].parts[0].text;
        const error = new Error(prompt.includes('quota case') ? 'quota exceeded' :
          prompt.includes('key case') ? 'invalid credential' : 'bad request');
        error.status = prompt.includes('quota case') ? 429 : prompt.includes('key case') ? 403 : 400;
        throw error;
      },
    },
  };
  const app = createApp({
    ai: mockAi,
    pineconeIndex: { async query() { return { matches: [] }; } },
    missingEnvVars: [],
    config: { ragRequestRetries: 2 },
  });
  const baseUrl = await startTestServer(app, t);

  const quotaResponse = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'quota case', history: [] }),
  });
  assert.equal(quotaResponse.status, 429);
  assert.equal(quotaResponse.headers.get('retry-after'), '30');
  const quotaBody = await quotaResponse.json();
  assert.deepEqual(quotaBody, { error: 'The assistant is busy. Please try again shortly.' });

  const genericResponse = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'generic provider failure', history: [] }),
  });
  assert.equal(genericResponse.status, 502);
  assert.deepEqual(await genericResponse.json(), {
    error: 'The assistant service could not process this request.',
  });

  const keyResponse = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'key case', history: [] }),
  });
  assert.equal(keyResponse.status, 502);
  assert.deepEqual(await keyResponse.json(), {
    error: 'The assistant service could not authorize this request.',
  });
  assert.equal(generateCalls, 3);
});

test('upstream abort is classified as timeout and is not retried', async (t) => {
  let embeddingCalls = 0;
  const mockAi = {
    models: {
      async embedContent() {
        embeddingCalls += 1;
        const error = new Error('The operation was aborted.');
        error.name = 'AbortError';
        throw error;
      },
    },
  };
  const app = createApp({
    ai: mockAi,
    pineconeIndex: { async query() { throw new Error('Pinecone should not be reached.'); } },
    missingEnvVars: [],
    config: { ragRequestRetries: 2 },
  });
  const baseUrl = await startTestServer(app, t);
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'cancelled upstream', history: [] }),
  });

  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), {
    error: 'The response took too long. Please try again.',
  });
  assert.equal(embeddingCalls, 1);
});

test('concurrency cap rejects excess provider generations', async (t) => {
  let markGenerationStarted;
  let markProviderAbort;
  const generationStarted = new Promise((resolve) => { markGenerationStarted = resolve; });
  const abortObserved = new Promise((resolve) => { markProviderAbort = resolve; });
  const providers = createAbortAwareProviders(
    () => markGenerationStarted(),
    () => markProviderAbort()
  );
  const app = createApp({
    ...providers,
    missingEnvVars: [],
    config: {
      maxConcurrentGenerations: 1,
      answerTimeoutMs: 2000,
      answerIdleTimeoutMs: 2000,
    },
  });
  const baseUrl = await startTestServer(app, t);
  const controller = new AbortController();
  const firstResponse = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'first generation', history: [] }),
    signal: controller.signal,
  });
  await generationStarted;

  const secondResponse = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'second generation', history: [] }),
  });
  assert.equal(secondResponse.status, 429);
  assert.equal(secondResponse.headers.get('retry-after'), '5');
  assert.deepEqual(await secondResponse.json(), {
    error: 'Chat service is busy. Please try again shortly.',
  });

  const firstBody = firstResponse.text();
  controller.abort();
  await assert.rejects(firstBody);
  await abortObserved;
});

test('request-scoped abort reaches Pinecone-style fetches through response bodies', async (t) => {
  let markRequestStarted;
  let markResponseClosed;
  const requestStarted = new Promise((resolve) => { markRequestStarted = resolve; });
  const responseClosed = new Promise((resolve) => { markResponseClosed = resolve; });
  const requestSignalStorage = new AsyncLocalStorage();
  const fetchWithTimeout = createTimeoutFetch(2000, requestSignalStorage);
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.on('close', () => markResponseClosed());
    res.write('{"partial":');
    markRequestStarted();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  }));

  const controller = new AbortController();
  const fetchPromise = requestSignalStorage.run(
    controller.signal,
    () => fetchWithTimeout(`http://127.0.0.1:${server.address().port}/slow-json`)
  );
  const response = await fetchPromise;
  await requestStarted;
  const bodyPromise = response.text();
  controller.abort();

  await assert.rejects(bodyPromise);
  await responseClosed;
});

test('disconnect during retrieval aborts the request-scoped vector query', async (t) => {
  const requestSignalStorage = new AsyncLocalStorage();
  let markQueryStarted;
  let markQueryAborted;
  let generateCalls = 0;
  const queryStarted = new Promise((resolve) => { markQueryStarted = resolve; });
  const queryAborted = new Promise((resolve) => { markQueryAborted = resolve; });
  const app = createApp({
    ai: {
      models: {
        async embedContent() { return { embeddings: [{ values: [1] }] }; },
        async generateContentStream() {
          generateCalls += 1;
          return (async function* stream() { yield { text: 'should not run' }; }());
        },
      },
    },
    pineconeRequestSignalStorage: requestSignalStorage,
    pineconeIndex: {
      async query() {
        const signal = requestSignalStorage.getStore();
        assert.ok(signal instanceof AbortSignal);
        markQueryStarted();
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            markQueryAborted();
            reject(signal.reason || new Error('Vector query aborted.'));
          }, { once: true });
        });
      },
    },
    missingEnvVars: [],
    config: { ragRequestRetries: 0 },
  });
  const baseUrl = await startTestServer(app, t);
  const controller = new AbortController();
  const fetchPromise = fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'cancel during retrieval', history: [] }),
    signal: controller.signal,
  });

  await queryStarted;
  controller.abort();
  await assert.rejects(fetchPromise);
  await queryAborted;
  assert.equal(generateCalls, 0);
});

test('client disconnect aborts the provider stream', async (t) => {
  let markGenerationStarted;
  let markProviderAbort;
  const generationStarted = new Promise((resolve) => { markGenerationStarted = resolve; });
  const abortObserved = new Promise((resolve) => { markProviderAbort = resolve; });
  const providers = createAbortAwareProviders(
    () => markGenerationStarted(),
    () => markProviderAbort()
  );
  const app = createApp({
    ...providers,
    missingEnvVars: [],
    config: { answerTimeoutMs: 2000, answerIdleTimeoutMs: 2000 },
  });
  const baseUrl = await startTestServer(app, t);
  const controller = new AbortController();
  const responsePromise = fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'cancel this response', history: [] }),
    signal: controller.signal,
  });
  const response = await responsePromise;
  await generationStarted;
  const bodyPromise = response.text();
  controller.abort();

  await assert.rejects(bodyPromise);
  await abortObserved;
});
