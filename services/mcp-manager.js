const fs = require('fs');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
const { toolDispatcher } = require('./tool-dispatcher');

const DEFAULT_TOOL_TIMEOUT_MS = 10000;
const DEFAULT_CONNECT_TIMEOUT_MS = 5000;

function resolveEnvVars(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, varName) => process.env[varName] || '');
}

function resolveEnvObject(envObj) {
  if (!envObj || typeof envObj !== 'object') return {};
  const resolved = {};
  for (const [k, v] of Object.entries(envObj)) {
    resolved[k] = resolveEnvVars(v);
  }
  return resolved;
}

function createTimeout(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`Operation timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  timer.unref?.();

  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

class McpManager {
  constructor(options = {}) {
    this.configPath =
      options.configPath ||
      process.env.MCP_CONFIG_PATH ||
      path.join(__dirname, '../mcp-servers.json');

    this.clients = new Map();
    this.toolMap = new Map();
    this.serverStatuses = new Map();
    this.isInitialized = false;
  }

  /**
   * Read and parse mcp-servers.json configuration
   */
  loadConfig() {
    try {
      if (!fs.existsSync(this.configPath)) {
        return { mcpServers: {} };
      }
      const raw = fs.readFileSync(this.configPath, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed.mcpServers === 'object' ? parsed : { mcpServers: {} };
    } catch (err) {
      console.warn(`[McpManager] Failed reading config at ${this.configPath}: ${err.message}`);
      return { mcpServers: {} };
    }
  }

  /**
   * Connect to all enabled MCP servers and discover tools dynamically
   */
  async initialize() {
    if (this.isInitialized) {
      return this.getStatus();
    }

    const config = this.loadConfig();
    const serverEntries = Object.entries(config.mcpServers || {});

    for (const [serverName, serverConfig] of serverEntries) {
      if (!serverConfig || serverConfig.enabled !== true) {
        this.serverStatuses.set(serverName, { status: 'disabled', toolsCount: 0 });
        continue;
      }

      try {
        console.log(`[McpManager] Connecting to MCP server: "${serverName}"...`);
        const client = new Client(
          {
            name: 'poornima-oracle-agent',
            version: '1.0.0',
          },
          { capabilities: {} }
        );

        let transport;
        if (serverConfig.url || serverConfig.transport === 'sse') {
          const targetUrl = resolveEnvVars(serverConfig.url);
          transport = new SSEClientTransport(new URL(targetUrl));
        } else if (serverConfig.command) {
          const command = resolveEnvVars(serverConfig.command);
          const args = Array.isArray(serverConfig.args)
            ? serverConfig.args.map(resolveEnvVars)
            : [];
          const customEnv = resolveEnvObject(serverConfig.env);

          transport = new StdioClientTransport({
            command,
            args,
            env: { ...process.env, ...customEnv },
            stderr: 'pipe',
          });
        } else {
          throw new Error('Neither "command" nor "url" specified in server config');
        }

        // Connect with timeout guardrail
        const timeout = createTimeout(DEFAULT_CONNECT_TIMEOUT_MS);
        try {
          await Promise.race([
            client.connect(transport),
            new Promise((_, reject) => {
              timeout.signal.addEventListener('abort', () => reject(timeout.signal.reason), {
                once: true,
              });
            }),
          ]);
        } finally {
          timeout.clear();
        }

        // Discover tools dynamically via listTools
        const { tools } = await client.listTools();
        const registeredForServer = [];

        if (Array.isArray(tools)) {
          for (const tool of tools) {
            const namespacedName = `mcp__${serverName}__${tool.name}`;
            const toolDef = {
              type: 'function',
              function: {
                name: namespacedName,
                description: `[MCP: ${serverName}] ${tool.description || ''}`.trim(),
                parameters: tool.inputSchema || { type: 'object', properties: {} },
              },
            };

            this.toolMap.set(namespacedName, {
              serverName,
              originalName: tool.name,
              toolDef,
            });

            // Register into central ToolDispatcher
            toolDispatcher.registerTool(namespacedName, toolDef, async (args, opts) => {
              return this.callTool(namespacedName, args, opts);
            });

            registeredForServer.push(namespacedName);
          }
        }

        this.clients.set(serverName, { client, transport, serverConfig });
        this.serverStatuses.set(serverName, {
          status: 'connected',
          toolsCount: registeredForServer.length,
          tools: registeredForServer,
        });

        console.log(
          `[McpManager] Connected to "${serverName}". Discovered ${registeredForServer.length} tool(s).`
        );
      } catch (err) {
        console.warn(`[McpManager] Connection failed for server "${serverName}": ${err.message}`);
        this.serverStatuses.set(serverName, {
          status: 'error',
          error: err.message,
          toolsCount: 0,
        });
      }
    }

    this.isInitialized = true;
    return this.getStatus();
  }

  /**
   * Execute an MCP tool by namespaced name
   */
  async callTool(namespacedName, rawArgs = {}, options = {}) {
    const mapping = this.toolMap.get(namespacedName);
    if (!mapping) {
      return {
        success: false,
        error: `MCP tool "${namespacedName}" is not registered.`,
      };
    }

    const clientEntry = this.clients.get(mapping.serverName);
    if (!clientEntry || !clientEntry.client) {
      return {
        success: false,
        error: `MCP server "${mapping.serverName}" is not connected.`,
      };
    }

    const timeout = createTimeout(DEFAULT_TOOL_TIMEOUT_MS);
    try {
      const toolCallPromise = clientEntry.client.callTool({
        name: mapping.originalName,
        arguments: rawArgs,
      });

      const result = await Promise.race([
        toolCallPromise,
        new Promise((_, reject) => {
          timeout.signal.addEventListener('abort', () => reject(timeout.signal.reason), {
            once: true,
          });
        }),
      ]);

      // Extract text content from MCP format
      let formattedText = '';
      if (Array.isArray(result?.content)) {
        formattedText = result.content
          .map((item) => (item.type === 'text' ? item.text : JSON.stringify(item)))
          .join('\n\n');
      } else if (result?.structuredContent) {
        formattedText = JSON.stringify(result.structuredContent);
      } else {
        formattedText = JSON.stringify(result || {});
      }

      // Extract any URLs found in text for source citations
      const urlRegex = /https?:\/\/[^\s"',;<>]+/gi;
      const discoveredUrls = (formattedText.match(urlRegex) || []).slice(0, 3);

      return {
        success: !result?.isError,
        data: formattedText,
        sources: discoveredUrls.map((url, i) => ({
          id: `mcp-${mapping.serverName}-${i + 1}`,
          title: `[MCP: ${mapping.serverName}] Resource`,
          url,
        })),
      };
    } catch (err) {
      console.error(`[McpManager] Tool call error for "${namespacedName}":`, err);
      return {
        success: false,
        error: `MCP tool call failed: ${err.message}`,
      };
    } finally {
      timeout.clear();
    }
  }

  /**
   * Return status summary of all configured and active MCP servers
   */
  getStatus() {
    const servers = {};
    for (const [name, info] of this.serverStatuses.entries()) {
      servers[name] = info;
    }

    return {
      initialized: this.isInitialized,
      activeServersCount: this.clients.size,
      totalToolsCount: this.toolMap.size,
      servers,
      tools: Array.from(this.toolMap.keys()),
    };
  }

  /**
   * Graceful shutdown of all MCP clients
   */
  async closeAll() {
    for (const [name, entry] of this.clients.entries()) {
      try {
        await entry.client.close();
      } catch (err) {
        console.warn(`[McpManager] Error closing client "${name}": ${err.message}`);
      }
    }
    this.clients.clear();
    this.toolMap.clear();
    this.isInitialized = false;
  }
}

const mcpManager = new McpManager();

module.exports = {
  McpManager,
  mcpManager,
};
