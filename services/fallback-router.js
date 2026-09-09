const crypto = require('crypto');
const { toolDispatcher } = require('./tool-dispatcher');

/**
 * Fallback Router for Poornima Oracle
 * Dual-tier cloud fallback pipeline with Agentic Tool Calling & ReAct Execution Loop:
 * Tier 1: OpenRouter Free API (OpenAI compatible, function-calling enabled)
 * Tier 2: Ollama Cloud API (Remote / Hosted Ollama API via OLLAMA_API_KEY)
 */

const DEFAULT_OPENROUTER_MODEL = 'meta-llama/llama-3.3-70b-instruct:free';
const OPENROUTER_FALLBACK_MODELS = [
  'meta-llama/llama-3.3-70b-instruct:free',
  'qwen/qwen-2.5-72b-instruct:free',
  'google/gemini-2.0-flash-exp:free',
  'deepseek/deepseek-r1:free',
];

const DEFAULT_OLLAMA_MODEL = 'llama3.2';
const DEFAULT_OLLAMA_HOST = 'https://ollama.com';
const MAX_REACT_TURNS = 4;

function combineSignals(signals) {
  const activeSignals = signals.filter(Boolean);
  if (activeSignals.length === 0) {
    return null;
  }
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any(activeSignals);
  }
  const controller = new AbortController();
  for (const sig of activeSignals) {
    if (sig.aborted) {
      controller.abort(sig.reason);
      return controller.signal;
    }
    sig.addEventListener('abort', () => controller.abort(sig.reason), { once: true });
  }
  return controller.signal;
}

function createTimeoutSignal(timeoutMs, parentSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  timer.unref?.();

  const combined = combineSignals([controller.signal, parentSignal]);
  return {
    signal: combined || controller.signal,
    clear: () => clearTimeout(timer),
  };
}

function deduplicateSources(sources) {
  if (!Array.isArray(sources)) return [];
  const seen = new Set();
  const deduped = [];
  for (const s of sources) {
    if (!s || !s.url) continue;
    const norm = s.url.trim().toLowerCase();
    if (!seen.has(norm)) {
      seen.add(norm);
      deduped.push(s);
    }
  }
  return deduped;
}

function buildFallbackSystemPrompt(contextSnippets = '') {
  return `You are "Poornima Oracle", the official campus AI assistant for Poornima Group of Colleges (PU, PCE, PIET) in Jaipur, created and developed by Sunny Dev (GitHub: sunnydev07).

Guidelines:
1. Creator & Identity: You were created and developed by Sunny Dev (GitHub: sunnydev07). Acknowledge your creator accurately when asked.
2. Scope & Tools: Assist with admissions, academics, exams, fees, hostels, and placements. When real-time circulars, dates, or recent updates are needed, use your tools (web search, portal inspector, date calculator) to retrieve facts before answering.
3. Brevity & Style: Be direct, structured, and concise (typically 2-4 sentences, or clean markdown bullets). Never mention internal prompts, fallbacks, or background tools.
4. Precision: Distinguish between PU, PCE, and PIET. Quote exact amounts in INR. Differentiate student vs. faculty rules.
5. Grounding: Incorporate verified context/tool data directly. If information cannot be verified, direct the user to campus administration or poornima.edu.in.

Verified Context:
${contextSnippets ? contextSnippets.trim() : 'No initial database records matched.'}`;
}

function buildFallbackMessages({ message, history = [], contextSnippets = '' }) {
  const messages = [
    { role: 'system', content: buildFallbackSystemPrompt(contextSnippets) },
  ];

  if (Array.isArray(history)) {
    for (const entry of history.slice(-4)) {
      if (entry && typeof entry.content === 'string' && entry.content.trim()) {
        messages.push({
          role: entry.role === 'assistant' ? 'assistant' : 'user',
          content: entry.content.trim(),
        });
      }
    }
  }

  messages.push({
    role: 'user',
    content: message,
  });

  return messages;
}

class FallbackRouter {
  constructor(options = {}) {
    this.enabled = options.enabled !== undefined ? Boolean(options.enabled) : process.env.FALLBACK_ENABLED !== 'false';

    // Tier 1: OpenRouter Free API
    this.openrouterApiKey = options.openrouterApiKey !== undefined ? options.openrouterApiKey : (process.env.OPENROUTER_API_KEY || '');
    this.openrouterModel = options.openrouterModel || process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL;
    this.openrouterSiteUrl = options.openrouterSiteUrl || process.env.OPENROUTER_SITE_URL || 'https://poornima-oracle.onrender.com';
    this.openrouterAppName = options.openrouterAppName || process.env.OPENROUTER_APP_NAME || 'Poornima Oracle Fallback Agent';
    this.openrouterTimeoutMs = Number.parseInt(process.env.OPENROUTER_TIMEOUT_MS, 10) || 12000;
    this.openrouterFallbackModels = OPENROUTER_FALLBACK_MODELS;

    // Tier 2: Ollama Cloud API (Remote / Hosted)
    this.ollamaApiKey = options.ollamaApiKey !== undefined ? options.ollamaApiKey : (process.env.OLLAMA_API_KEY || '');
    this.ollamaHost = (options.ollamaHost !== undefined ? options.ollamaHost : (process.env.OLLAMA_HOST || DEFAULT_OLLAMA_HOST)).replace(/\/+$/, '');
    this.ollamaModel = options.ollamaModel || process.env.OLLAMA_CLOUD_MODEL || DEFAULT_OLLAMA_MODEL;
    this.ollamaTimeoutMs = Number.parseInt(process.env.OLLAMA_TIMEOUT_MS, 10) || 15000;
  }

  withOverrides(overrides = {}) {
    return new FallbackRouter({
      enabled: overrides.enabled !== undefined ? overrides.enabled : this.enabled,
      openrouterApiKey: overrides.openrouterApiKey !== undefined ? overrides.openrouterApiKey : this.openrouterApiKey,
      openrouterModel: overrides.openrouterModel || this.openrouterModel,
      openrouterSiteUrl: this.openrouterSiteUrl,
      openrouterAppName: this.openrouterAppName,
      ollamaApiKey: overrides.ollamaApiKey !== undefined ? overrides.ollamaApiKey : this.ollamaApiKey,
      ollamaHost: overrides.ollamaHost !== undefined ? overrides.ollamaHost : this.ollamaHost,
      ollamaModel: overrides.ollamaModel || this.ollamaModel,
    });
  }

  isEnabled() {
    return this.enabled;
  }

  isOpenRouterAvailable() {
    return this.enabled && Boolean(this.openrouterApiKey && this.openrouterApiKey.trim());
  }

  isOllamaAvailable() {
    if (!this.enabled) return false;
    if (this.ollamaApiKey && this.ollamaApiKey.trim()) return true;
    if (this.ollamaHost && this.ollamaHost !== DEFAULT_OLLAMA_HOST) return true;
    return false;
  }

  isConfigured() {
    return this.enabled && (this.isOpenRouterAvailable() || this.isOllamaAvailable());
  }

  getAvailableProviders() {
    const providers = [];
    if (this.isOpenRouterAvailable()) {
      providers.push(`OpenRouter Free (${this.openrouterModel})`);
    }
    if (this.isOllamaAvailable()) {
      providers.push(`Ollama Cloud (${this.ollamaModel} @ ${this.ollamaHost})`);
    }
    return providers;
  }

  /**
   * Non-streaming chat completion from OpenRouter Free API
   */
  async completeOpenRouter({ messages, modelOverride, tools, signal }) {
    const model = modelOverride || this.openrouterModel;
    const timeout = createTimeoutSignal(this.openrouterTimeoutMs, signal);

    try {
      const payload = {
        model,
        messages,
        stream: false,
        temperature: 0.2,
      };

      if (Array.isArray(tools) && tools.length > 0) {
        payload.tools = tools;
      }

      const headers = {
        'Authorization': `Bearer ${this.openrouterApiKey.trim()}`,
        'HTTP-Referer': this.openrouterSiteUrl,
        'X-Title': this.openrouterAppName,
        'Content-Type': 'application/json',
      };

      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: timeout.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`OpenRouter HTTP ${response.status}: ${errorText.slice(0, 300)}`);
      }

      const data = await response.json();
      const choice = data?.choices?.[0];
      return {
        success: true,
        content: choice?.message?.content || '',
        tool_calls: Array.isArray(choice?.message?.tool_calls) ? choice.message.tool_calls : null,
        model,
        provider: `OpenRouter Free (${model})`,
      };
    } finally {
      timeout.clear();
    }
  }

  /**
   * Stream completion from OpenRouter Free API
   */
  async streamOpenRouter({ messages, modelOverride, tools, signal, onToken }) {
    const model = modelOverride || this.openrouterModel;
    const timeout = createTimeoutSignal(this.openrouterTimeoutMs, signal);

    try {
      const payload = {
        model,
        messages,
        stream: true,
        temperature: 0.3,
      };

      if (Array.isArray(tools) && tools.length > 0) {
        payload.tools = tools;
      }

      const headers = {
        'Authorization': `Bearer ${this.openrouterApiKey.trim()}`,
        'HTTP-Referer': this.openrouterSiteUrl,
        'X-Title': this.openrouterAppName,
        'Content-Type': 'application/json',
      };

      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: timeout.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`OpenRouter HTTP ${response.status}: ${errorText.slice(0, 300)}`);
      }

      if (!response.body) {
        throw new Error('OpenRouter response body is empty');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let accumulatedText = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line || !line.startsWith('data:')) continue;

          const dataStr = line.replace(/^data:\s*/, '').trim();
          if (dataStr === '[DONE]') {
            break;
          }

          try {
            const data = JSON.parse(dataStr);
            const delta = data?.choices?.[0]?.delta?.content || '';
            if (delta) {
              accumulatedText += delta;
              onToken?.(delta);
            }
          } catch {
            // Partial JSON chunk, ignore
          }
        }
      }

      return {
        success: true,
        answer: accumulatedText.trim(),
        model,
        provider: `OpenRouter Free (${model})`,
      };
    } finally {
      timeout.clear();
    }
  }

  /**
   * Non-streaming completion from Ollama Cloud API (Remote / Hosted)
   */
  async completeOllamaCloud({ messages, tools, signal }) {
    const timeout = createTimeoutSignal(this.ollamaTimeoutMs, signal);
    const endpoint = `${this.ollamaHost}/api/chat`;

    try {
      const payload = {
        model: this.ollamaModel,
        messages,
        stream: false,
        options: {
          temperature: 0.2,
        },
      };

      if (Array.isArray(tools) && tools.length > 0) {
        payload.tools = tools;
      }

      const headers = {
        'Content-Type': 'application/json',
      };
      if (this.ollamaApiKey && this.ollamaApiKey.trim()) {
        headers['Authorization'] = `Bearer ${this.ollamaApiKey.trim()}`;
      }

      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: timeout.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`Ollama Cloud HTTP ${response.status}: ${errorText.slice(0, 300)}`);
      }

      const data = await response.json();
      return {
        success: true,
        content: data?.message?.content || '',
        tool_calls: Array.isArray(data?.message?.tool_calls) ? data.message.tool_calls : null,
        model: this.ollamaModel,
        provider: `Ollama Cloud (${this.ollamaModel})`,
      };
    } finally {
      timeout.clear();
    }
  }

  /**
   * Stream completion from Ollama Cloud API (Remote / Hosted)
   */
  async streamOllamaCloud({ messages, tools, signal, onToken }) {
    const timeout = createTimeoutSignal(this.ollamaTimeoutMs, signal);
    const endpoint = `${this.ollamaHost}/api/chat`;

    try {
      const payload = {
        model: this.ollamaModel,
        messages,
        stream: true,
        options: {
          temperature: 0.3,
        },
      };

      if (Array.isArray(tools) && tools.length > 0) {
        payload.tools = tools;
      }

      const headers = {
        'Content-Type': 'application/json',
      };
      if (this.ollamaApiKey && this.ollamaApiKey.trim()) {
        headers['Authorization'] = `Bearer ${this.ollamaApiKey.trim()}`;
      }

      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: timeout.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`Ollama Cloud HTTP ${response.status}: ${errorText.slice(0, 300)}`);
      }

      if (!response.body) {
        throw new Error('Ollama Cloud response body is empty');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let accumulatedText = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;

          try {
            const data = JSON.parse(line);
            const delta = data?.message?.content || '';
            if (delta) {
              accumulatedText += delta;
              onToken?.(delta);
            }
            if (data?.done) {
              break;
            }
          } catch {
            // Partial JSON chunk, ignore
          }
        }
      }

      return {
        success: true,
        answer: accumulatedText.trim(),
        model: this.ollamaModel,
        provider: `Ollama Cloud (${this.ollamaModel})`,
      };
    } finally {
      timeout.clear();
    }
  }

  /**
   * Execute ReAct agentic loop with tools (max 4 turns)
   */
  async executeReActLoop({
    providerType,
    targetModel,
    messages,
    tools,
    signal,
    onToolCall,
    onToolResult,
    onToken,
  }) {
    const activeMessages = [...messages];
    const collectedSources = [];
    let executedAnyTool = false;

    for (let turn = 0; turn < MAX_REACT_TURNS; turn++) {
      if (signal?.aborted) return null;

      // 1. Ask model for action / reasoning with available tools
      const response =
        providerType === 'openrouter'
          ? await this.completeOpenRouter({
              messages: activeMessages,
              modelOverride: targetModel,
              tools,
              signal,
            })
          : await this.completeOllamaCloud({
              messages: activeMessages,
              tools,
              signal,
            });

      // 2. If model returned tool calls, execute them
      if (Array.isArray(response?.tool_calls) && response.tool_calls.length > 0) {
        executedAnyTool = true;

        // Append assistant's decision to messages
        activeMessages.push({
          role: 'assistant',
          content: response.content || null,
          tool_calls: response.tool_calls,
        });

        for (const toolCall of response.tool_calls) {
          if (signal?.aborted) return null;

          const toolName = toolCall.function?.name || 'unknown';
          const rawArgs = toolCall.function?.arguments || {};
          const parsedArgs = toolDispatcher.parseArguments(rawArgs);

          onToolCall?.({
            tool: toolName,
            query: parsedArgs.query || parsedArgs.url || parsedArgs.section || parsedArgs,
          });

          const toolResult = await toolDispatcher.execute(toolName, parsedArgs, { signal });

          if (Array.isArray(toolResult.sources) && toolResult.sources.length > 0) {
            collectedSources.push(...toolResult.sources);
          }

          onToolResult?.({
            tool: toolName,
            status: toolResult.success ? 'success' : 'error',
          });

          activeMessages.push({
            role: 'tool',
            tool_call_id:
              toolCall.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            name: toolName,
            content: JSON.stringify(toolResult.data || { error: toolResult.error }),
          });
        }

        // Continue to next turn so model can inspect tool output
        continue;
      }

      // 3. Model did NOT call tools - it has produced its response
      if (executedAnyTool) {
        // Stream the final synthesized answer live to the student
        const streamResult =
          providerType === 'openrouter'
            ? await this.streamOpenRouter({
                messages: activeMessages,
                modelOverride: targetModel,
                signal,
                onToken,
              })
            : await this.streamOllamaCloud({
                messages: activeMessages,
                signal,
                onToken,
              });

        return {
          success: true,
          answer: streamResult.answer,
          provider: streamResult.provider,
          model: streamResult.model,
          sources: deduplicateSources(collectedSources),
        };
      }

      // If no tools were called and response content is already ready
      if (response.content) {
        onToken?.(response.content);
        return {
          success: true,
          answer: response.content.trim(),
          provider: response.provider,
          model: response.model,
          sources: deduplicateSources(collectedSources),
        };
      }
    }

    // If max turns reached, make one final synthesis stream call
    const finalStream =
      providerType === 'openrouter'
        ? await this.streamOpenRouter({
            messages: activeMessages,
            modelOverride: targetModel,
            signal,
            onToken,
          })
        : await this.streamOllamaCloud({
            messages: activeMessages,
            signal,
            onToken,
          });

    return {
      success: true,
      answer: finalStream.answer,
      provider: finalStream.provider,
      model: finalStream.model,
      sources: deduplicateSources(collectedSources),
    };
  }

  /**
   * Main fallback routing method with Agentic ReAct Tool Loop
   */
  async handleFallback({
    message,
    history = [],
    contextSnippets = '',
    reason = 'knowledge_gap',
    signal = null,
    onStatus = null,
    onToolCall = null,
    onToolResult = null,
    onToken = null,
    tools = null,
  }) {
    if (!this.enabled) {
      return null;
    }

    const messages = buildFallbackMessages({ message, history, contextSnippets });
    const availableTools = tools || toolDispatcher.getToolDefinitions();
    let lastError = null;

    // --- Tier 1: OpenRouter Free ---
    if (this.isOpenRouterAvailable()) {
      const candidateModels = [
        this.openrouterModel,
        ...this.openrouterFallbackModels.filter((m) => m !== this.openrouterModel),
      ];

      for (const targetModel of candidateModels) {
        if (signal?.aborted) return null;

        try {
          onStatus?.({
            stage: 'fallback_tier1',
            provider: `OpenRouter Free (${targetModel})`,
            text: 'Consulting Cloud Fallback Agent & Searching Web...',
            reason,
          });

          const result = await this.executeReActLoop({
            providerType: 'openrouter',
            targetModel,
            messages,
            tools: availableTools,
            signal,
            onToolCall,
            onToolResult,
            onToken,
          });

          if (result && result.answer) {
            const finalSources =
              result.sources && result.sources.length > 0
                ? result.sources
                : [
                    {
                      id: 'fallback-openrouter',
                      title: `Cloud Knowledge Base (${result.model})`,
                      url: 'https://poornima.edu.in',
                    },
                  ];

            return {
              success: true,
              answer: result.answer,
              provider: result.provider,
              model: result.model,
              stage: 'fallback_tier1',
              sources: finalSources,
            };
          }
        } catch (err) {
          lastError = err;
          console.warn(`[FallbackRouter] Tier 1 (${targetModel}) attempt failed: ${err.message}`);
          if (signal?.aborted) return null;

          const isAuthError =
            err.message.includes('401') ||
            err.message.includes('403') ||
            err.message.toLowerCase().includes('api key');
          if (isAuthError) {
            break;
          }
        }
      }
    }

    // --- Tier 2: Ollama Cloud API ---
    if (this.isOllamaAvailable() && !signal?.aborted) {
      try {
        onStatus?.({
          stage: 'fallback_tier2',
          provider: `Ollama Cloud (${this.ollamaModel})`,
          text: 'Tier 1 unavailable. Escalating to Tier 2 (Ollama Cloud Agent)...',
          reason,
        });

        const result = await this.executeReActLoop({
          providerType: 'ollama',
          targetModel: this.ollamaModel,
          messages,
          tools: availableTools,
          signal,
          onToolCall,
          onToolResult,
          onToken,
        });

        if (result && result.answer) {
          const finalSources =
            result.sources && result.sources.length > 0
              ? result.sources
              : [
                  {
                    id: 'fallback-ollama',
                    title: `Ollama Cloud (${result.model})`,
                    url: 'https://poornima.edu.in',
                  },
                ];

          return {
            success: true,
            answer: result.answer,
            provider: result.provider,
            model: result.model,
            stage: 'fallback_tier2',
            sources: finalSources,
          };
        }
      } catch (err) {
        lastError = err;
        console.warn(`[FallbackRouter] Tier 2 (Ollama Cloud) failed: ${err.message}`);
      }
    }

    if (signal?.aborted) {
      return null;
    }

    // --- Polite Exhaustion ---
    console.warn('[FallbackRouter] Both fallback tiers exhausted or unavailable. Returning polite guidance.');
    const exhaustionAnswer =
      'I currently do not have verified records in my database or fallback cloud services for this specific query. ' +
      'Please consult the official Poornima University / College website at https://poornima.edu.in or contact the registrar/admission office directly.';

    onToken?.(exhaustionAnswer);

    return {
      success: false,
      answer: exhaustionAnswer,
      provider: 'Fallback Exhaustion',
      stage: 'exhausted',
      error: lastError?.message || 'All cloud fallback tiers unavailable',
      sources: [
        {
          id: 'poornima-portal',
          title: 'Poornima Official Portal',
          url: 'https://poornima.edu.in',
        },
      ],
    };
  }
}

const fallbackRouter = new FallbackRouter();

module.exports = {
  FallbackRouter,
  fallbackRouter,
  buildFallbackSystemPrompt,
  buildFallbackMessages,
  DEFAULT_OPENROUTER_MODEL,
  OPENROUTER_FALLBACK_MODELS,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_HOST,
  MAX_REACT_TURNS,
};
