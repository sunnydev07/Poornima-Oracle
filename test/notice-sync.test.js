const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Keep the pipeline fully offline: these notices have no PDF URLs, and this
// also avoids any PDF fetch attempts if a test adds one later.
process.env.ENABLE_PDF_EXTRACTION = 'false';

const {
  syncNotices,
  crawlAllSources,
  buildChunkId,
  noticeContentHash,
  resetProcessedHashes,
  NOTICES_NAMESPACE,
} = require('../services/crawler/notice-sync');

const EMBEDDING = new Array(768).fill(0.01);

function makeNotice(overrides = {}) {
  return {
    title: 'Mid-Term Examination Schedule',
    url: 'https://www.poornima.org/notices/exam-schedule',
    text: 'Mid-term examination schedule for all B.Tech students.',
    college: 'PCE',
    category: 'examination',
    publishedAt: '2026-01-10',
    ...overrides,
  };
}

/**
 * Minimal Gemini stub. Records every text sent for embedding so tests can
 * prove a retry actually re-processed a notice.
 */
function createAi() {
  const calls = [];
  return {
    calls,
    models: {
      async embedContent({ contents }) {
        calls.push(contents);
        return { embeddings: [{ values: EMBEDDING }] };
      },
    },
  };
}

/**
 * Minimal Pinecone stub. `fail` receives the zero-based batch number and can
 * throw to simulate a namespace upsert failure.
 */
function createIndex({ fail = () => false } = {}) {
  const attempts = [];
  const successfulUpserts = [];
  let batchIndex = 0;

  return {
    attempts,
    successfulUpserts,
    namespace(name) {
      assert.equal(name, NOTICES_NAMESPACE);
      return {
        async upsert(batch) {
          const currentBatch = batchIndex;
          batchIndex += 1;
          attempts.push({
            batchIndex: currentBatch,
            ids: batch.map((vector) => vector.id),
            vectors: batch,
          });

          if (fail(currentBatch)) {
            throw new Error(`simulated Pinecone failure for batch ${currentBatch}`);
          }
          successfulUpserts.push(batch);
        },
      };
    },
  };
}

beforeEach(() => {
  resetProcessedHashes();
});

test('content and PDF-text edits change the content hash and re-ingest', async () => {
  const original = makeNotice();
  const edited = makeNotice({
    text: `${original.text} Updated venue: Block C.`,
  });

  assert.notEqual(noticeContentHash(original), noticeContentHash(edited));
  assert.notEqual(
    noticeContentHash({ ...original, pdfText: 'Circular section A' }),
    noticeContentHash({ ...original, pdfText: 'Circular section B' })
  );

  const ai = createAi();
  const index = createIndex();

  const first = await syncNotices({ ai, pineconeIndex: index, crawl: [original] });
  assert.equal(first.success, true);

  const second = await syncNotices({ ai, pineconeIndex: index, crawl: [edited] });
  assert.equal(second.success, true);
  assert.equal(ai.calls.length, 2, 'edited HTML notice must be embedded again');
  assert.equal(index.attempts.length, 2);
  assert.equal(
    index.attempts[0].ids[0],
    index.attempts[1].ids[0],
    'same URL must overwrite idempotently'
  );
  assert.match(index.attempts[1].vectors[0].metadata.text, /Updated venue: Block C/);
});

test('same-title notices with different URLs get distinct chunk IDs', async () => {
  const firstNotice = makeNotice({
    url: 'https://www.poornima.org/notices/exam-schedule-a',
  });
  const secondNotice = makeNotice({
    url: 'https://www.poornima.org/notices/exam-schedule-b',
  });

  const index = createIndex();
  const result = await syncNotices({
    ai: createAi(),
    pineconeIndex: index,
    crawl: [firstNotice, secondNotice],
  });

  assert.equal(result.success, true);
  assert.equal(result.vectorsUpserted, 2);
  assert.equal(index.attempts.length, 1);
  assert.equal(index.attempts[0].ids.length, 2);

  const [firstId, secondId] = index.attempts[0].ids;
  assert.notEqual(firstId, secondId);
  assert.equal(new Set(index.attempts[0].ids).size, 2);
  assert.match(firstId, /^notice-pce-mid-term-examination-schedule-[a-f0-9]{12}-c0$/);
  assert.match(secondId, /^notice-pce-mid-term-examination-schedule-[a-f0-9]{12}-c0$/);
});

test('re-running a notice reuses deterministic chunk IDs', async () => {
  const notice = makeNotice();
  const ai = createAi();
  const index = createIndex();

  await syncNotices({ ai, pineconeIndex: index, crawl: [notice] });

  // A fresh process would have an empty module-level dedupe set, but the
  // Pinecone IDs must still match so the retry overwrites rather than duplicates.
  resetProcessedHashes();
  await syncNotices({ ai, pineconeIndex: index, crawl: [notice] });

  assert.equal(index.attempts.length, 2);
  assert.deepEqual(index.attempts[0].ids, index.attempts[1].ids);

  const canonicalVariant = makeNotice({
    url: 'https://WWW.POORNIMA.ORG/notices/exam-schedule#latest',
  });
  assert.equal(buildChunkId(canonicalVariant, 0), buildChunkId(notice, 0));
});

test('failed upsert returns success:false and does not poison dedupe', async () => {
  const notice = makeNotice();
  const ai = createAi();
  // Fail only the very first batch attempted by this index stub.
  const index = createIndex({ fail: (batchIndex) => batchIndex === 0 });

  const first = await syncNotices({ ai, pineconeIndex: index, crawl: [notice] });
  assert.equal(first.success, false);
  assert.equal(first.vectorsUpserted, 0);
  assert.equal(first.failedBatches, 1);
  assert.ok(first.errors.some((error) => /Upsert batch 1 failed/.test(error)));

  // Because the hash was never marked as processed, the next run retries.
  const second = await syncNotices({ ai, pineconeIndex: index, crawl: [notice] });
  assert.equal(second.success, true);
  assert.equal(second.vectorsUpserted, 1);
  assert.equal(ai.calls.length, 2, 'retry must embed the notice again');
  assert.equal(index.attempts.length, 2);
  assert.deepEqual(index.attempts[0].ids, index.attempts[1].ids);
});

test('dry runs never mutate dedupe state', async () => {
  const notice = makeNotice();
  const ai = createAi();
  const index = createIndex();

  const dry = await syncNotices({
    ai,
    pineconeIndex: index,
    crawl: [notice],
    dryRun: true,
  });
  assert.equal(dry.success, true);
  assert.equal(dry.vectorsUpserted, 0);
  assert.equal(index.attempts.length, 0);

  const real = await syncNotices({ ai, pineconeIndex: index, crawl: [notice] });
  assert.equal(real.success, true);
  assert.equal(real.vectorsUpserted, 1);
  assert.equal(index.attempts.length, 1, 'the post-dry-run real sync must not be deduped away');
});

test('total crawl failure returns success:false', async () => {
  const index = createIndex();
  const result = await syncNotices({
    ai: createAi(),
    pineconeIndex: index,
    crawl: {
      notices: [],
      attempted: 2,
      failed: 2,
      errors: ['PU Firestore timed out', 'PCE page returned HTTP 503'],
    },
  });

  assert.equal(result.success, false);
  assert.equal(result.noticesFound, 0);
  assert.equal(index.attempts.length, 0);
  assert.ok(result.errors.includes('PU Firestore timed out'));
  assert.ok(result.errors.some((error) => /All 2 notice sources failed/.test(error)));
});

test('partial crawl failure continues and records errors', async () => {
  const index = createIndex();
  const result = await syncNotices({
    ai: createAi(),
    pineconeIndex: index,
    crawl: {
      notices: [makeNotice()],
      attempted: 2,
      failed: 1,
      errors: ['PU Firestore timed out'],
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.vectorsUpserted, 1);
  assert.ok(result.errors.includes('PU Firestore timed out'));
});

test('crawlAllSources reports detailed results when every fetch fails', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('network unavailable');
  };

  try {
    const result = await crawlAllSources();
    assert.deepEqual(result.notices, []);
    assert.equal(result.attempted, 5, '3 PU collections + 2 PCE/PIET pages');
    assert.equal(result.failed, 5);
    assert.equal(result.errors.length, 5);
  } finally {
    global.fetch = originalFetch;
  }
});
