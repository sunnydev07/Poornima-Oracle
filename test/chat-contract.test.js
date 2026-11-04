const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cleanPlainText,
  normalizeHistory,
  buildHistoryContext,
  buildChatRequestPayload,
  SAFE_MARKDOWN_URL_PATTERN,
  buildChatRequestPayloadFromConversation,
} = require('../chat-contract');

test('markdown URL policy allows safe schemes and relative links only', () => {
  assert.equal(SAFE_MARKDOWN_URL_PATTERN.test('https://example.org/admissions'), true);
  assert.equal(SAFE_MARKDOWN_URL_PATTERN.test('mailto:admissions@example.org'), true);
  assert.equal(SAFE_MARKDOWN_URL_PATTERN.test('/admissions'), true);
  assert.equal(SAFE_MARKDOWN_URL_PATTERN.test('#fees'), true);
  assert.equal(SAFE_MARKDOWN_URL_PATTERN.test('javascript:alert(1)'), false);
  assert.equal(SAFE_MARKDOWN_URL_PATTERN.test('data:text/html,unsafe'), false);
  assert.equal(SAFE_MARKDOWN_URL_PATTERN.test('//external.example.org'), false);
});

test('plain-text cleanup preserves meaningful less-than comparisons', () => {
  assert.equal(cleanPlainText('CGPA<6.5 eligibility'), 'CGPA<6.5 eligibility');
});

test('plain-text cleanup preserves HTML-looking text and removes unsafe controls', () => {
  assert.equal(cleanPlainText('<img src=x onerror=alert(1)>\u0000literal'), '<img src=x onerror=alert(1)>literal');
});

test('history context keeps the newest referent within its character budget', () => {
  const history = [
    { role: 'user', content: 'oldest question' },
    { role: 'assistant', content: 'middle answer' },
    { role: 'user', content: 'recent referent' },
  ];

  assert.equal(buildHistoryContext(history, 25), 'User: recent referent');
});

test('request payload excludes the current user turn from bounded prior history', () => {
  const conversation = Array.from({ length: 10 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `prior ${index}`,
  }));
  conversation.push({ role: 'user', content: 'current message < 3' });

  const payload = buildChatRequestPayloadFromConversation('current message < 3', conversation);

  assert.equal(payload.history.length, 8);
  assert.equal(payload.history[0].content, 'prior 2');
  assert.equal(payload.history[7].content, 'prior 9');
  assert.equal(payload.history.some((turn) => turn.content === 'current message < 3'), false);
});

test('Unicode-heavy request payload remains below the body budget without losing newest context', () => {
  const priorHistory = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `turn ${index} ${'💩'.repeat(990)}`,
  }));
  const payload = buildChatRequestPayload('current 💩'.repeat(500), priorHistory);

  assert.ok(Buffer.byteLength(JSON.stringify(payload), 'utf8') <= 24 * 1024);
  assert.equal(payload.history.at(-1).content, priorHistory.at(-1).content);
});

test('request payload keeps only bounded prior turns and role/content fields', () => {
  const priorHistory = Array.from({ length: 10 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `turn ${index} < 10`,
    privateMetadata: 'not sent',
  }));

  const payload = buildChatRequestPayload('fees < 20000', priorHistory);

  assert.deepEqual(Object.keys(payload), ['message', 'history']);
  assert.equal(payload.message, 'fees < 20000');
  assert.equal(payload.history.length, 8);
  assert.deepEqual(Object.keys(payload.history[0]), ['role', 'content']);
  assert.equal(payload.history[0].content, 'turn 2 < 10');
  assert.equal(payload.history[7].content, 'turn 9 < 10');
});
