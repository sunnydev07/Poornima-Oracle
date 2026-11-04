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
