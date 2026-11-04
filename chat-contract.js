const MAX_MESSAGE_CHARS = 2000;
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 2000;
const MAX_CONTEXT_CHARS = 4000;
const MAX_ANSWER_CHARS = 12000;
const MAX_CHAT_REQUEST_BYTES = 24 * 1024;

const UNSAFE_CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const SAFE_MARKDOWN_URL_PATTERN = /^(?:(?:https?:\/\/|mailto:|\/(?!\/)|#|\?))/i;

function cleanPlainText(value, maxChars = MAX_MESSAGE_CHARS) {
  if (typeof value !== 'string') {
    return '';
  }

  const safeLimit = Number.isInteger(maxChars) && maxChars >= 0
    ? maxChars
    : MAX_MESSAGE_CHARS;

  return value.replace(UNSAFE_CONTROL_CHARACTERS, '').slice(0, safeLimit).trim();
}

function cleanStreamText(value, maxChars = MAX_ANSWER_CHARS) {
  if (typeof value !== 'string') {
    return '';
  }

  const safeLimit = Number.isInteger(maxChars) && maxChars >= 0
    ? maxChars
    : MAX_ANSWER_CHARS;

  return value.replace(UNSAFE_CONTROL_CHARACTERS, '').slice(0, safeLimit);
}

function normalizeHistory(history = []) {
  if (!Array.isArray(history)) {
    throw new TypeError('History must be an array of prior user and assistant turns.');
  }

  return history
    .slice(-MAX_HISTORY_MESSAGES)
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new TypeError('Each history turn must include a role and content.');
      }
      if (entry.role !== 'user' && entry.role !== 'assistant') {
        throw new TypeError('History roles must be "user" or "assistant".');
      }
      if (typeof entry.content !== 'string') {
        throw new TypeError('History content must be text.');
      }
      if (entry.content.length > MAX_HISTORY_MESSAGE_CHARS) {
        throw new RangeError(`History content must be ${MAX_HISTORY_MESSAGE_CHARS} characters or less.`);
      }

      const content = cleanPlainText(entry.content, MAX_HISTORY_MESSAGE_CHARS);
      return content ? { role: entry.role, content } : null;
    })
    .filter(Boolean);
}

function buildHistoryContext(history, maxChars = MAX_CONTEXT_CHARS) {
  const safeLimit = Number.isInteger(maxChars) && maxChars >= 0
    ? maxChars
    : MAX_CONTEXT_CHARS;
  const entries = normalizeHistory(history);
  const recentFirst = [];
  let usedChars = 0;

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const speaker = entry.role === 'user' ? 'User' : 'Poornima Oracle';
    const formatted = `${speaker}: ${entry.content}`;
    const separatorChars = recentFirst.length > 0 ? 1 : 0;

    if (usedChars + separatorChars + formatted.length > safeLimit) {
      break;
    }

    recentFirst.push(formatted);
    usedChars += separatorChars + formatted.length;
  }

  return recentFirst.reverse().join('\n');
}

function getUtf8ByteLength(value) {
  let byteLength = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      byteLength += 1;
    } else if (codeUnit <= 0x7ff) {
      byteLength += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff &&
      value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      byteLength += 4;
      index += 1;
    } else {
      byteLength += 3;
    }
  }
  return byteLength;
}

function buildChatRequestPayload(message, priorHistory) {
  const payload = {
    message: cleanPlainText(message, MAX_MESSAGE_CHARS),
    history: normalizeHistory(priorHistory),
  };

  while (payload.history.length > 0 &&
    getUtf8ByteLength(JSON.stringify(payload)) > MAX_CHAT_REQUEST_BYTES) {
    payload.history.shift();
  }

  return payload;
}

function buildChatRequestPayloadFromConversation(message, conversationWithCurrentTurn) {
  const priorHistory = Array.isArray(conversationWithCurrentTurn)
    ? conversationWithCurrentTurn.slice(0, -1)
    : [];
  return buildChatRequestPayload(message, priorHistory);
}

const chatContract = {
  MAX_MESSAGE_CHARS,
  MAX_HISTORY_MESSAGES,
  MAX_HISTORY_MESSAGE_CHARS,
  MAX_CONTEXT_CHARS,
  MAX_ANSWER_CHARS,
  MAX_CHAT_REQUEST_BYTES,
  SAFE_MARKDOWN_URL_PATTERN,
  cleanPlainText,
  cleanStreamText,
  normalizeHistory,
  buildHistoryContext,
  buildChatRequestPayload,
  buildChatRequestPayloadFromConversation,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = chatContract;
}
if (typeof window !== 'undefined') {
  window.PoornimaChatContract = chatContract;
}
