import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

const DEPLOY_DIR = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'token-pulse');
const MAX_HTML_BYTES = 10 * 1024 * 1024;
const MAX_TOOL_RESULT_BYTES = 1024 * 1024;

function assertNoCostFields(obj, label) {
  const json = JSON.stringify(obj);
  assert.equal(
    /"(costUsd|totalCost|equivalentCost|apiCost|usd)"/i.test(json),
    false,
    `${label} must not include cost estimation fields`
  );
}

async function verifySqliteReader() {
  const readerUrl = pathToFileURL(path.join(DEPLOY_DIR, 'scripts/sqlite-reader.mjs')).href;
  const { getSnapshot, getAnalytics, getDiagnostics } = await import(readerUrl);

  const diag = getDiagnostics();
  assert.ok(diag.parsedCount > 0, `Expected parsedCount > 0, got ${diag.parsedCount}`);
  assert.equal(diag.errorCount, 0, `Expected 0 parse errors, got ${JSON.stringify(diag.errors)}`);

  const snapAll = getSnapshot({ surface: 'all' });
  assert.ok(snapAll.activeSession, 'Expected an activeSession in snapshot');
  assert.ok(snapAll.activeSession.contextLimit > 0, 'Expected contextLimit > 0');
  assert.ok(
    snapAll.today.cacheHitRate >= 0 && snapAll.today.cacheHitRate <= 100,
    `Invalid cacheHitRate: ${snapAll.today.cacheHitRate}`
  );
  if (snapAll.today.avgTtftSec > 0 && snapAll.today.avgLatencySec > 0) {
    assert.ok(
      snapAll.today.avgLatencySec >= snapAll.today.avgTtftSec,
      `avgLatencySec (${snapAll.today.avgLatencySec}) must be >= avgTtftSec (${snapAll.today.avgTtftSec})`
    );
  }
  assertNoCostFields(snapAll, 'snapshot');

  const snapDesktop = getSnapshot({ surface: 'desktop' });
  const snapCli = getSnapshot({ surface: 'cli' });
  assert.ok(snapDesktop.surfaceCounts.desktop >= 1, 'Expected desktop sessions');
  assert.ok(snapCli.surfaceCounts.cli >= 0, 'Expected valid cli count');

  const analytics7 = getAnalytics({ surface: 'all', days: 7 });
  const analytics30 = getAnalytics({ surface: 'all', days: 30 });
  assert.equal(analytics7.daily.length, 7);
  assert.equal(analytics30.daily.length, 30);
  assertNoCostFields(analytics7, 'analytics7');

  console.log(
    `[PASS] sqlite-reader: ${diag.parsedCount} DBs parsed in ${diag.scanMs}ms (0 errors), active=${snapAll.activeSession.modelLabel} ${snapAll.activeSession.contextUsed}/${snapAll.activeSession.contextLimit}`
  );
}

function verifyManifestAndHtml() {
  const allowedPluginKeys = new Set([
    'name',
    'displayName',
    'description',
    'version',
    'author',
    'homepage',
    'repository',
    'logo',
    'suggestedPrompts',
    'disabled',
  ]);
  const manifest = JSON.parse(fs.readFileSync(path.join(DEPLOY_DIR, 'plugin.json'), 'utf8'));
  for (const key of Object.keys(manifest)) {
    assert.ok(allowedPluginKeys.has(key), `Unexpected plugin.json top-level field: ${key}`);
  }
  assert.equal(manifest.name, 'token-pulse');
  assert.ok(fs.existsSync(path.join(DEPLOY_DIR, manifest.logo)), 'logo.svg must exist');
  assert.ok(fs.existsSync(path.join(DEPLOY_DIR, 'skills/telemetry/SKILL.md')), 'SKILL.md must exist');
  assert.ok(fs.existsSync(path.join(DEPLOY_DIR, 'mcp_config.json')), 'mcp_config.json must exist');

  const html = fs.readFileSync(path.join(DEPLOY_DIR, 'ui/dashboard.html'), 'utf8');
  const htmlBytes = Buffer.byteLength(html, 'utf8');
  assert.ok(htmlBytes > 1024 && htmlBytes < MAX_HTML_BYTES, `Invalid HTML byte size: ${htmlBytes}`);
  assert.ok(html.includes('<meta name="color-scheme" content="light dark"'), 'Missing color-scheme meta');

  const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/i);
  assert.ok(styleMatch, 'Missing inline <style> block');
  const css = styleMatch[1];
  assert.ok(css.includes('color-scheme: light dark'), 'Missing :root color-scheme');
  assert.equal(/color-mix\(\s*in\s+oklch\b/i.test(css), false, 'Must not use in oklch in color-mix');
  assert.equal(
    /background(?:-color)?\s*:\s*(?:#fff(?:fff)?\b|rgba?\(\s*255\s*,\s*255\s*,\s*255)/i.test(css),
    false,
    'Must not hardcode white background colors'
  );
  assert.equal(/transition[^;]*scrollbar-color/i.test(css), false, 'Must not transition scrollbar-color');
  assert.ok(css.includes('forced-colors: active'), 'Must support Windows High Contrast forced-colors');

  console.log(`[PASS] manifest & UI HTML verified (${(htmlBytes / 1024).toFixed(1)} KB, native theming clean)`);
}

async function verifyMcpServer() {
  const serverPath = path.join(DEPLOY_DIR, 'scripts/server.mjs');
  const child = spawn(process.execPath, [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderrOut = '';
  child.stderr.on('data', (chunk) => {
    stderrOut += chunk.toString('utf8');
  });

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const msg = JSON.parse(trimmed);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  });

  let nextId = 1;
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`RPC timeout for ${method}`));
      }, 8000);
      pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  const notify = (method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  };

  try {
    const initRes = await rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'verify-client', version: '1.0.0' },
    });
    assert.ok(initRes.result?.capabilities?.resources, 'Server must declare resources capability');
    assert.ok(initRes.result?.capabilities?.tools, 'Server must declare tools capability');
    notify('notifications/initialized', {});

    const resList = await rpc('resources/list', {});
    assert.equal(resList.result.resources.length, 1);
    assert.equal(resList.result.resources[0].uri, 'ui://token-pulse/dashboard');
    assert.equal(resList.result.resources[0].mimeType, 'text/html;profile=mcp-app');

    const resRead = await rpc('resources/read', { uri: 'ui://token-pulse/dashboard' });
    assert.equal(resRead.result.contents[0].mimeType, 'text/html;profile=mcp-app');
    assert.ok(resRead.result.contents[0].text.includes('Token Pulse'));

    const toolsList = await rpc('tools/list', {});
    const toolMap = new Map(toolsList.result.tools.map((t) => [t.name, t]));
    const openTool = toolMap.get('open_telemetry_panel');
    assert.ok(openTool, 'open_telemetry_panel missing');
    assert.equal(openTool._meta?.ui?.resourceUri, 'ui://token-pulse/dashboard');
    const entrypoints = openTool._meta?.['com.google.antigravity/ui']?.entrypoints || [];
    assert.deepEqual(
      entrypoints.map((e) => e.type),
      ['aux_pane', 'global']
    );

    for (const appOnlyName of ['telemetry_snapshot', 'telemetry_analytics', 'telemetry_diagnostics']) {
      const t = toolMap.get(appOnlyName);
      assert.ok(t, `${appOnlyName} missing`);
      assert.deepEqual(t._meta?.ui?.visibility, ['app'], `${appOnlyName} must be app-only`);
    }

    const toolCalls = [
      ['open_telemetry_panel', {}], // Empty {} entrypoint launch contract
      ['telemetry_snapshot', { surface: 'all' }],
      ['telemetry_analytics', { surface: 'all', days: 7, family: 'all' }],
      ['telemetry_diagnostics', {}],
    ];

    for (const [name, args] of toolCalls) {
      const callRes = await rpc('tools/call', { name, arguments: args });
      assert.ok(!callRes.error, `Tool ${name} returned RPC error: ${JSON.stringify(callRes.error)}`);
      assert.ok(!callRes.result?.isError, `Tool ${name} returned isError=true`);
      const bytes = Buffer.byteLength(JSON.stringify(callRes.result), 'utf8');
      assert.ok(bytes < MAX_TOOL_RESULT_BYTES, `${name} result exceeds 1 MiB: ${bytes}`);
      assertNoCostFields(callRes.result, `tool ${name}`);
    }

    assert.equal(stderrOut.trim(), '', `Unexpected stderr from MCP server: ${stderrOut}`);
    console.log('[PASS] stdio MCP server: handshake, resources, entrypoints, visibility, and 4 tools verified (<1 MiB)');
  } finally {
    rl.close();
    child.stdin.end();
    child.kill();
  }
}

async function main() {
  await verifySqliteReader();
  verifyManifestAndHtml();
  await verifyMcpServer();
  console.log('ALL VERIFICATION CHECKS PASSED');
}

main().catch((err) => {
  console.error('VERIFICATION FAILED:', err);
  process.exit(1);
});
