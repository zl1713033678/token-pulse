import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { getAnalytics, getDiagnostics, getSnapshot } from './sqlite-reader.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_URI = 'ui://token-pulse/dashboard';
const RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';
const SERVER_INFO = {
  name: 'token-pulse-telemetry',
  version: '1.1.0',
};
const DEFAULT_PROTOCOL_VERSION = '2025-03-26';

/**
 * Resolve the single-file dashboard HTML path, allowing hot reload via TOKEN_PULSE_UI_HTML.
 */
function resolveDashboardPath() {
  if (process.env.TOKEN_PULSE_UI_HTML) {
    return process.env.TOKEN_PULSE_UI_HTML;
  }
  return path.resolve(__dirname, '../ui/dashboard.html');
}

function formatCompactTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function normalizeInitialTab(rawTab) {
  if (rawTab === 'trends') return 'trends';
  return 'live';
}

function sendMessage(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function sendResult(id, result) {
  sendMessage({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  sendMessage({ jsonrpc: '2.0', id, error: err });
}

const TOOLS = [
  {
    name: 'open_telemetry_panel',
    title: 'Token Pulse',
    description:
      'Open the native Token Pulse telemetry dashboard in the side pane or global view to inspect live Antigravity context breakdown, generation speed (tok/s), cache hit rate, 5h/weekly model-pool consumption & rolloff countdown, and multi-day trends.',
    inputSchema: {
      type: 'object',
      properties: {
        tab: {
          type: 'string',
          enum: ['live', 'trends', 'overview', 'context', 'pace'],
          description: 'Initial view to focus (`live` for real-time context & 5h/weekly quota pools, `trends` for 7d/14d/30d history).',
        },
        surface: {
          type: 'string',
          enum: ['all', 'desktop', 'cli'],
          description: 'Filter metrics by Antigravity surface.',
        },
        conversationId: {
          type: 'string',
          description: 'Optional conversation ID to inspect.',
        },
      },
    },
    _meta: {
      ui: {
        resourceUri: APP_URI,
      },
      'com.google.antigravity/ui': {
        entrypoints: [
          { type: 'aux_pane', title: 'Token Pulse' },
          { type: 'global', title: 'Token Pulse' },
        ],
      },
    },
  },
  {
    name: 'telemetry_snapshot',
    title: 'Fetch live telemetry snapshot',
    description: 'App-only tool returning current context breakdown, generation speed, 5h/weekly model-pool usage, and rolloff timers.',
    inputSchema: {
      type: 'object',
      properties: {
        surface: { type: 'string', enum: ['all', 'desktop', 'cli'] },
        conversationId: { type: 'string' },
      },
    },
    _meta: {
      ui: {
        visibility: ['app'],
      },
    },
  },
  {
    name: 'telemetry_analytics',
    title: 'Fetch multi-day analytics',
    description: 'App-only tool returning multi-day stacked usage and model/project/session drill-downs.',
    inputSchema: {
      type: 'object',
      properties: {
        surface: { type: 'string', enum: ['all', 'desktop', 'cli'] },
        days: { type: 'number', enum: [7, 14, 30] },
        family: { type: 'string', enum: ['all', 'gemini4', 'flash', 'claude', 'other'] },
      },
    },
    _meta: {
      ui: {
        visibility: ['app'],
      },
    },
  },
  {
    name: 'telemetry_diagnostics',
    title: 'Fetch local SQLite diagnostics',
    description: 'App-only tool returning local database discovery and parser health details.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    _meta: {
      ui: {
        visibility: ['app'],
      },
    },
  },
];

function handleInitialize(id, params) {
  const requestedVersion =
    typeof params?.protocolVersion === 'string' && params.protocolVersion
      ? params.protocolVersion
      : DEFAULT_PROTOCOL_VERSION;

  sendResult(id, {
    protocolVersion: requestedVersion,
    capabilities: {
      tools: { listChanged: false },
      resources: { subscribe: false, listChanged: false },
    },
    serverInfo: SERVER_INFO,
  });
}

function handleResourcesList(id) {
  sendResult(id, {
    resources: [
      {
        uri: APP_URI,
        name: 'Token Pulse Dashboard',
        description: 'Native Antigravity telemetry side-pane and full-page UI.',
        mimeType: RESOURCE_MIME_TYPE,
        _meta: {
          ui: {
            prefersBorder: false,
          },
        },
      },
    ],
  });
}

function handleResourcesRead(id, params) {
  const uri = params?.uri;
  if (uri !== APP_URI) {
    sendError(id, -32602, `Unknown resource URI: ${String(uri)}`);
    return;
  }

  const htmlPath = resolveDashboardPath();
  if (!fs.existsSync(htmlPath)) {
    sendError(id, -32603, `Dashboard HTML not found at ${htmlPath}`);
    return;
  }

  const html = fs.readFileSync(htmlPath, 'utf8');
  sendResult(id, {
    contents: [
      {
        uri: APP_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: html,
        _meta: {
          ui: {
            prefersBorder: false,
          },
        },
      },
    ],
  });
}

function handleToolsCall(id, params) {
  const name = params?.name;
  const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};

  try {
    if (name === 'open_telemetry_panel') {
      const surface = ['all', 'desktop', 'cli'].includes(args.surface) ? args.surface : 'all';
      const initialTab = normalizeInitialTab(args.tab);
      const conversationId = typeof args.conversationId === 'string' ? args.conversationId : null;
      const snapshot = getSnapshot({ surface, conversationId });
      const active = snapshot.activeSession;
      const summaryLine = active
        ? `Token Pulse ready: ${active.modelLabel} context ${formatCompactTokens(active.contextUsed)}/${formatCompactTokens(active.contextLimit)} (${active.contextPct}%), ${active.turnsCount} turns / ${active.stepCount} steps, cache hit ${active.cacheHitRate}%, 5h ${formatCompactTokens(snapshot.rolling5h.totalTokens)}.`
        : `Token Pulse ready: today ${formatCompactTokens(snapshot.today.totalTokens)} tokens across ${snapshot.today.sessionsCount} sessions.`;

      sendResult(id, {
        content: [{ type: 'text', text: summaryLine }],
        structuredContent: {
          initialTab,
          snapshot,
        },
      });
      return;
    }

    if (name === 'telemetry_snapshot') {
      const surface = ['all', 'desktop', 'cli'].includes(args.surface) ? args.surface : 'all';
      const conversationId = typeof args.conversationId === 'string' ? args.conversationId : null;
      const snapshot = getSnapshot({ surface, conversationId });
      sendResult(id, {
        content: [{ type: 'text', text: 'Snapshot updated.' }],
        structuredContent: snapshot,
      });
      return;
    }

    if (name === 'telemetry_analytics') {
      const surface = ['all', 'desktop', 'cli'].includes(args.surface) ? args.surface : 'all';
      const days = [7, 14, 30].includes(Number(args.days)) ? Number(args.days) : 7;
      const family = ['all', 'gemini4', 'flash', 'claude', 'other'].includes(args.family)
        ? args.family
        : 'all';
      const analytics = getAnalytics({ surface, days, family });
      sendResult(id, {
        content: [{ type: 'text', text: `${days}d analytics loaded.` }],
        structuredContent: analytics,
      });
      return;
    }

    if (name === 'telemetry_diagnostics') {
      const diagnostics = getDiagnostics();
      sendResult(id, {
        content: [{ type: 'text', text: 'Diagnostics loaded.' }],
        structuredContent: diagnostics,
      });
      return;
    }

    sendError(id, -32601, `Unknown tool: ${String(name)}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendResult(id, {
      isError: true,
      content: [{ type: 'text', text: `Telemetry error: ${message}` }],
    });
  }
}

function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  const { id, method, params } = msg;
  const hasId = id !== undefined && id !== null;

  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    return;
  }

  if (!hasId) {
    return;
  }

  switch (method) {
    case 'initialize':
      handleInitialize(id, params);
      break;
    case 'ping':
      sendResult(id, {});
      break;
    case 'resources/list':
      handleResourcesList(id);
      break;
    case 'resources/read':
      handleResourcesRead(id, params);
      break;
    case 'tools/list':
      sendResult(id, { tools: TOOLS });
      break;
    case 'tools/call':
      handleToolsCall(id, params);
      break;
    default:
      sendError(id, -32601, `Method not found: ${String(method)}`);
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const parsed = JSON.parse(trimmed);
    handleMessage(parsed);
  } catch (err) {
    console.error('[token-pulse] Invalid JSON-RPC line:', err instanceof Error ? err.message : err);
  }
});

rl.on('close', () => {
  process.exit(0);
});
