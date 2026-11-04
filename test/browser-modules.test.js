const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('shared chat contract exposes its payload builder to browser scripts', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'chat-contract.js'), 'utf8');
  const browserWindow = {};
  const browserContext = vm.createContext({ window: browserWindow });

  vm.runInContext(source, browserContext, { filename: 'chat-contract.js' });

  assert.equal(typeof browserWindow.PoornimaChatContract?.buildChatRequestPayload, 'function');
  const payload = browserWindow.PoornimaChatContract.buildChatRequestPayload('fees < 20000', []);
  assert.equal(JSON.stringify(payload), '{"message":"fees < 20000","history":[]}');
});

test('the document provides the spatial glass shell and its accessible controls', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

  assert.match(html, /<script\s+src=["']\.\/chat-contract\.js["']><\/script>/);
  assert.match(html, /<script\s+src=["']\.\/chat-request-owner\.js["']><\/script>/);
  assert.match(html, /<header\s+id=["']mainHeader["']/);
  assert.match(html, /id=["']mobileMenuButton["']/);
  assert.match(html, /id=["']closeSidebarButton["']/);
  assert.match(html, /id=["']profilePillButton["']/);
  assert.match(html, /id=["']sidebarCampusSwitcher["']/);
  assert.match(html, /data-campus-pill/);
  assert.match(html, /class=["'][^"']*spatial-orbital-ring/);
  assert.match(html, /class=["'][^"']*spatial-halo-bloom/);
  assert.match(html, /id=["']apiModal["'][^>]*aria-label=["']Setup API["']/);
  assert.match(html, /id=["']messageInput["'][^>]*aria-label=["']Message["']/);
  assert.match(html, /id=["']composerDock["'][^>]*liquid-glass/);
});

test('citation chips render safe, meaningful source links', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const extractFunction = (name, nextMarker) => {
    const start = html.indexOf(`function ${name}(`);
    const end = html.indexOf(nextMarker, start);
    assert.notEqual(start, -1, `Expected ${name} to exist.`);
    assert.notEqual(end, -1, `Expected a code boundary after ${name}.`);
    return html.slice(start, end);
  };
  const source = [
    extractFunction('renderSourceChips', '\n        function getSafeUrl('),
    extractFunction('getSafeUrl', '\n        function renderFeedbackControls('),
    extractFunction('escapeHtml', '\n        class ClickSpark'),
    'return renderSourceChips;',
  ].join('\n');
  const renderSourceChips = new Function('URL', 'window', source)(URL, {
    location: { href: 'https://oracle.example/' },
  });

  const rendered = renderSourceChips([
    { title: 'Handbook', url: 'https://poornima.example/handbook.pdf', type: 'handbook' },
    { title: 'Unsafe', url: 'javascript:alert(1)', type: 'web' },
  ]);

  assert.match(rendered, /citation-chip citation-handbook/);
  assert.match(rendered, /https:\/\/poornima\.example\/handbook\.pdf/);
  assert.doesNotMatch(rendered, /javascript:/i);
});

test('regeneration removes only its assistant response and originating user turn', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const start = html.indexOf('function buildRegenerationState(');
  const end = html.indexOf('\n        async function regenerateAssistantMessage(', start);
  assert.notEqual(start, -1, 'Expected regeneration state helper to exist.');
  assert.notEqual(end, -1, 'Expected regeneration state helper boundary.');
  const buildRegenerationState = new Function(`${html.slice(start, end)}\nreturn buildRegenerationState;`)();

  const messages = [
    { id: 'user-first', role: 'user', content: 'First' },
    { id: 'assistant-first', role: 'assistant', content: 'First answer' },
    { id: 'user-question', role: 'user', content: 'Question to retry' },
    { id: 'assistant-failed', role: 'assistant', content: 'Incomplete', question: 'Question to retry' },
    { id: 'user-later', role: 'user', content: 'Later question' },
  ];
  const result = buildRegenerationState(messages, 'assistant-failed');

  assert.equal(result.question, 'Question to retry');
  assert.deepEqual(result.removedIds, ['user-question', 'assistant-failed']);
  assert.deepEqual(result.messages.map((message) => message.id), [
    'user-first',
    'assistant-first',
    'user-later',
  ]);
  assert.deepEqual(messages.map((message) => message.id), [
    'user-first',
    'assistant-first',
    'user-question',
    'assistant-failed',
    'user-later',
  ]);
});

test('conversation export preserves turns and excludes unsafe source links', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const start = html.indexOf('function buildConversationExport(');
  const end = html.indexOf('\n        function exportChatMarkdown(', start);
  assert.notEqual(start, -1, 'Expected conversation export formatter to exist.');
  assert.notEqual(end, -1, 'Expected conversation export formatter boundary.');
  const buildConversationExport = new Function('URL', `${html.slice(start, end)}\nreturn buildConversationExport;`)(URL);

  const markdown = buildConversationExport({
    title: 'Campus questions',
    messages: [
      { role: 'user', content: 'Where is the library?' },
      {
        role: 'assistant',
        content: 'The library is in the main academic block.',
        sources: [
          { title: 'Handbook', url: 'https://poornima.example/handbook.pdf' },
          { title: 'Unsafe', url: 'javascript:alert(1)' },
        ],
      },
    ],
  });

  assert.match(markdown, /# Campus questions/);
  assert.match(markdown, /## You\n\nWhere is the library\?/);
  assert.match(markdown, /## Poornima Oracle\n\nThe library is in the main academic block\./);
  assert.match(markdown, /\[Handbook\]\(https:\/\/poornima\.example\/handbook\.pdf\)/);
  assert.doesNotMatch(markdown, /javascript:/i);
});

test('PWA assets support installation and cache the current app shell', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const serviceWorker = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');

  assert.match(html, /rel=["']manifest["'][^>]*href=["']\.\/manifest\.json["']/);
  assert.match(html, /id=["']installAppButton["']/);
  assert.match(html, /serviceWorker\.register\(["']\.\/sw\.js["']/);
  assert.equal(manifest.name, 'Poornima Oracle');
  assert.ok(manifest.icons.some((icon) => icon.src === './poornima-oracle.svg'));
  assert.match(serviceWorker, /poornima-oracle-v4/);
  assert.match(serviceWorker, /\.\/chat-contract\.js/);
  assert.match(serviceWorker, /\.\/chat-request-owner\.js/);
  assert.match(serviceWorker, /\/api\//);
});
