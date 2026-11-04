const test = require('node:test');
const assert = require('node:assert/strict');
const { ConversationRequestOwner } = require('../chat-request-owner');

test('switching ownership aborts the old request and rejects late completions', () => {
  const owner = new ConversationRequestOwner();
  const oldRequest = owner.begin('conversation-a');

  assert.equal(owner.owns(oldRequest, 'conversation-a'), true);
  owner.cancel();
  assert.equal(oldRequest.controller.signal.aborted, true);

  const newRequest = owner.begin('conversation-b');
  assert.equal(owner.owns(oldRequest, 'conversation-b'), false);
  assert.equal(owner.owns(newRequest, 'conversation-b'), true);
  owner.finish(oldRequest);
  assert.equal(owner.owns(newRequest, 'conversation-b'), true);
});
