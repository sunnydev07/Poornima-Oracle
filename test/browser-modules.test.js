const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('shared chat contract exposes its bounded request builder to browser scripts', () => {
  const browserWindow = {};
  const browserContext = vm.createContext({ window: browserWindow });

  vm.runInContext(read('chat-contract.js'), browserContext, { filename: 'chat-contract.js' });

  assert.equal(typeof browserWindow.PoornimaChatContract?.buildChatRequestPayload, 'function');
  const payload = browserWindow.PoornimaChatContract.buildChatRequestPayload('fees < 20000', []);
  assert.equal(JSON.stringify(payload), '{"message":"fees < 20000","history":[]}');
});

test('the app shell exposes spatial glass and accessible controls', () => {
  const html = read('index.html');

  assert.match(html, /<header\s+id=["']mainHeader["'][^>]*class=["'][^"']*liquid-capsule/);
  assert.match(html, /id=["']mainChat["']/);
  assert.match(html, /id=["']chatStatus["'][^>]*role=["']status["']/);
  assert.match(html, /id=["']mobileMenuButton["'][^>]*aria-label=["']Open conversation history["']/);
  assert.match(html, /id=["']closeSidebarButton["'][^>]*aria-label=["']Close conversation history["']/);
  assert.match(html, /id=["']newChatButton["'][^>]*aria-label=["']Start a new chat["']/);
  assert.match(html, /id=["']sidebarCampusSwitcher["']/);
  assert.match(html, /class=["'][^"']*spatial-orbital-ring/);
  assert.match(html, /class=["'][^"']*spatial-halo-bloom/);
  assert.match(html, /id=["']apiModal["'][^>]*aria-modal=["']true["']/);
  assert.match(html, /id=["']messageInput["'][^>]*aria-label=["']Message["']/);
  assert.match(html, /id=["']composerDock["'][^>]*liquid-glass/);
});

test('citation URL validation accepts web links and rejects unsafe schemes', () => {
  const source = read('src/js/utils/dom.js');
  const start = source.indexOf('export function getSafeUrl(');
  const end = source.indexOf('\nexport function adjustTextareaHeight(', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const helperSource = source.slice(start, end).replace('export function', 'function');
  const getSafeUrl = new Function('URL', 'window', `${helperSource}\nreturn getSafeUrl;`)(URL, {
    location: { href: 'https://oracle.example/' },
  });

  assert.equal(getSafeUrl('https://poornima.example/notice'), 'https://poornima.example/notice');
  assert.equal(getSafeUrl('/handbook.pdf'), 'https://oracle.example/handbook.pdf');
  assert.equal(getSafeUrl('javascript:alert(1)'), '');
  assert.match(read('src/js/components/sourceChips.js'), /citation-chip citation-notice/);
  assert.match(read('src/js/components/sourceChips.js'), /citation-chip citation-web/);
});

test('regeneration removes its assistant response and immediately preceding user turn', () => {
  const source = read('src/js/components/messageBubble.js');
  const start = source.indexOf('export function buildRegenerationState(');
  const end = source.indexOf('\nexport async function regenerateAssistantMessage(', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const helperSource = source.slice(start, end).replace('export function', 'function');
  const buildRegenerationState = new Function(`${helperSource}\nreturn buildRegenerationState;`)();
  const messages = [
    { id: 'u1', role: 'user', content: 'First' },
    { id: 'a1', role: 'assistant', content: 'First answer' },
    { id: 'u2', role: 'user', content: 'Retry this' },
    { id: 'a2', role: 'assistant', content: 'Incomplete', question: 'Retry this' },
    { id: 'u3', role: 'user', content: 'Later turn' },
  ];

  const result = buildRegenerationState(messages, 'a2');
  assert.equal(result.question, 'Retry this');
  assert.deepEqual(result.removedIds, ['u2', 'a2']);
  assert.deepEqual(result.messages.map((message) => message.id), ['u1', 'a1', 'u3']);
  assert.deepEqual(messages.map((message) => message.id), ['u1', 'a1', 'u2', 'a2', 'u3']);
});

test('campus quick switch keeps profile and calendar campus in sync', () => {
  const profileStore = read('src/js/profile/profileStore.js');
  const app = read('src/js/app.js');

  assert.match(profileStore, /export function setQuickCampus\(campus\)/);
  assert.match(profileStore, /saveStudentProfile\(\{ college \}\)/);
  assert.match(profileStore, /data-campus-pill/);
  assert.match(app, /window\.setQuickCampus = setQuickCampus/);
});

test('PWA assets keep the current offline shell and Liquid Glass app icon', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const serviceWorker = read('sw.js');
  const installPrompt = read('src/js/pwa/installPrompt.js');

  assert.equal(manifest.name, 'Poornima Oracle');
  assert.ok(manifest.icons.some((icon) => icon.src === './poornima-oracle.svg'));
  assert.match(serviceWorker, /poornima-oracle-v4/);
  assert.match(serviceWorker, /\.\/chat-contract\.js/);
  assert.match(serviceWorker, /\.\/chat-request-owner\.js/);
  assert.match(serviceWorker, /\/api\//);
  assert.match(installPrompt, /\.register\('\.\/sw\.js'\)/);
});

test('server routes serve client assets without exposing the backend root', () => {
  const server = read('server.js');

  assert.match(server, /app\.use\('\/src', express\.static\(path\.join\(__dirname, 'src'\)/);
  assert.doesNotMatch(server, /express\.static\(path\.join\(__dirname\)\)/);
  for (const asset of ['index.html', 'styles.css', 'manifest.json', 'sw.js', 'poornima-oracle.svg']) {
    assert.match(server, new RegExp(`app\\.get\\(['\"]/${asset.replace('.', '\\.')}['\"]`));
  }
});
