(function exposeConversationRequestOwner(root) {
  class ConversationRequestOwner {
    constructor() {
      this.generation = 0;
      this.currentRequest = null;
    }

    begin(conversationId) {
      if (typeof conversationId !== 'string' || !conversationId) {
        throw new TypeError('A conversation ID is required to start a request.');
      }

      this.cancel();
      const request = {
        generation: ++this.generation,
        conversationId,
        controller: new AbortController(),
      };
      this.currentRequest = request;
      return request;
    }

    cancel() {
      const request = this.currentRequest;
      this.currentRequest = null;
      this.generation += 1;
      if (request && !request.controller.signal.aborted) {
        request.controller.abort();
      }
      return request;
    }

    owns(request, selectedConversationId) {
      return this.currentRequest === request &&
        request?.generation === this.generation &&
        request?.conversationId === selectedConversationId;
    }

    finish(request) {
      if (!this.owns(request, request?.conversationId)) return false;
      this.currentRequest = null;
      this.generation += 1;
      return true;
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ConversationRequestOwner };
  }
  if (root) {
    root.PoornimaRequestOwner = ConversationRequestOwner;
  }
})(typeof window !== 'undefined' ? window : globalThis);
