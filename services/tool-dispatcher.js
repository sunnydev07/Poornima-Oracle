const { executeWebSearch } = require('./tools/web-search');
const { executeWebScraper } = require('./tools/web-scraper');
const { executePortalInspector } = require('./tools/portal-inspector');
const { executeDatetimeCalculator } = require('./tools/datetime-calculator');

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the live Internet for current updates, RTU Kota examination notices, Poornima circulars, syllabus, or general information.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Specific search query, e.g. "RTU Kota BTech exam timetable 2025" or "Poornima University admission last date"',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_webpage',
      description:
        'Fetch and read the text of a specific web article or circular URL to extract full details.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The full HTTP or HTTPS URL to read.',
          },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'poornima_portal_inspector',
      description:
        'Inspect official Poornima University & Group websites (poornima.edu.in, poornima.org) for active circulars, notices, and announcements.',
      parameters: {
        type: 'object',
        properties: {
          section: {
            type: 'string',
            enum: ['all', 'admissions', 'pce', 'piet'],
            description: 'Portal section to check (default: "all").',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'datetime_calculator',
      description:
        'Get the current Indian Standard Time (IST) date, day of the week, or calculate days between dates for academic deadlines.',
      parameters: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['current_date', 'days_between', 'add_days'],
            description: 'Date calculation operation.',
          },
          startDate: {
            type: 'string',
            description: 'Start date in YYYY-MM-DD format (for days_between or add_days).',
          },
          endDate: {
            type: 'string',
            description: 'End date in YYYY-MM-DD format (for days_between).',
          },
          daysToAdd: {
            type: 'number',
            description: 'Number of days to add to startDate.',
          },
        },
      },
    },
  },
];

class ToolDispatcher {
  constructor() {
    this.customTools = new Map();
  }

  /**
   * Return all tool definitions (built-in + any dynamically registered)
   */
  getToolDefinitions() {
    const definitions = [...TOOL_DEFINITIONS];
    for (const customTool of this.customTools.values()) {
      if (customTool.definition) {
        definitions.push(customTool.definition);
      }
    }
    return definitions;
  }

  /**
   * Register dynamic external tool (e.g. for MCP integration)
   */
  registerTool(name, definition, handler) {
    this.customTools.set(name, { definition, handler });
  }

  /**
   * Safely parse tool arguments which may be an object or a JSON string
   */
  parseArguments(rawArgs) {
    if (!rawArgs) return {};
    if (typeof rawArgs === 'object') return rawArgs;
    if (typeof rawArgs === 'string') {
      try {
        return JSON.parse(rawArgs);
      } catch {
        return { query: rawArgs };
      }
    }
    return {};
  }

  /**
   * Execute a tool by name with arguments and cancellation signal
   */
  async execute(name, rawArgs = {}, options = {}) {
    const args = this.parseArguments(rawArgs);

    try {
      let result;
      switch (name) {
        case 'web_search':
          result = await executeWebSearch(args, options);
          break;
        case 'fetch_webpage':
          result = await executeWebScraper(args, options);
          break;
        case 'poornima_portal_inspector':
          result = await executePortalInspector(args, options);
          break;
        case 'datetime_calculator':
          result = executeDatetimeCalculator(args);
          break;
        default: {
          const custom = this.customTools.get(name);
          if (custom && typeof custom.handler === 'function') {
            result = await custom.handler(args, options);
          } else {
            return {
              success: false,
              error: `Tool "${name}" is not recognized or supported.`,
              sources: [],
            };
          }
        }
      }

      return {
        success: result?.success !== false,
        data: result,
        sources: Array.isArray(result?.sources) ? result.sources : [],
      };
    } catch (error) {
      console.error(`[ToolDispatcher] Error executing tool "${name}":`, error);
      return {
        success: false,
        error: `Tool execution error: ${error.message}`,
        sources: [],
      };
    }
  }
}

const toolDispatcher = new ToolDispatcher();

module.exports = {
  ToolDispatcher,
  toolDispatcher,
  TOOL_DEFINITIONS,
};
