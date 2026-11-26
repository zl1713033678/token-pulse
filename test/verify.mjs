import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

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
    snapAll.activeSession.stepCount >= snapAll.activeSession.turnsCount,
    `Expected stepCount (${snapAll.activeSession.stepCount}) >= turnsCount (${snapAll.activeSession.turnsCount})`
  );
  assert.equal(typeof snapAll.activeSession.lastTps, 'number', 'Expected numeric lastTps');
  assert.equal(typeof snapAll.activeSession.avgTps, 'number', 'Expected numeric avgTps');

  assert.ok(snapAll.calendarWeek, 'Expected calendarWeek summary');
  assert.ok(
    snapAll.calendarWeek.startMs <= snapAll.syncedAt &&
      snapAll.calendarWeek.resetAtMs > snapAll.syncedAt,
    'Expected valid Monday-to-Monday calendarWeek window bounds'
  );
  assert.ok(Array.isArray(snapAll.quotaPools) && snapAll.quotaPools.length >= 3, 'Expected quotaPools array');
  assert.ok(snapAll.rolling5h.rolloff, 'Expected rolling5h.rolloff object');

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
    `[PASS] sqlite-reader: ${diag.parsedCount} DBs parsed in ${diag.scanMs}ms (0 errors), active=${snapAll.activeSession.modelLabel} ${snapAll.activeSession.turnsCount}t/${snapAll.activeSession.stepCount}s @ ${snapAll.activeSession.lastTps} tok/s`
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
  assert.equal(manifest.version, '1.1.0');
  assert.ok(fs.existsSync(path.join(DEPLOY_DIR, manifest.logo)), 'logo.svg must exist');
  assert.ok(fs.existsSync(path.join(DEPLOY_DIR, 'skills/telemetry/SKILL.md')), 'SKILL.md must exist');
  assert.ok(fs.existsSync(path.join(DEPLOY_DIR, 'mcp_config.json')), 'mcp_config.json must exist');

  const html = fs.readFileSync(path.join(DEPLOY_DIR, 'ui/dashboard.html'), 'utf8');
  const htmlBytes = Buffer.byteLength(html, 'utf8');
  assert.ok(htmlBytes > 1024 && htmlBytes < MAX_HTML_BYTES, `Invalid HTML byte size: ${htmlBytes}`);
  assert.ok(html.includes('<meta name="color-scheme" content="light dark"'), 'Missing color-scheme meta');

  // BUG-001 Regression Guard: Never use hidden="until-found" or grid-area: 1 / 1 panel stacking
  // because content-visibility: hidden creates a stacking context that intercepts clicks over the active panel!
  assert.equal(
    html.includes('until-found'),
    false,
    'Tab panels must NOT use hidden="until-found" (creates click-intercepting stacking context)'
  );

  const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/i);
  assert.ok(styleMatch, 'Missing inline <style> block');
  const css = styleMatch[1];
  assert.ok(css.includes('color-scheme: light dark'), 'Missing :root color-scheme');
  assert.ok(css.includes('container-type: inline-size'), 'Missing CSS container query container-type');
  assert.ok(css.includes('@container pulse'), 'Missing @container pulse responsive rules');
  assert.equal(
    /\.panels-root\s*>\s*\[role=['"]tabpanel['"]\][^{]*\{[^}]*grid-area\s*:\s*1\s*\/\s*1/i.test(css),
    false,
    'Tab panels must NOT overlap in grid-area: 1 / 1'
  );
  assert.ok(
    /\[hidden\]\s*\{\s*display\s*:\s*none\s*!important/i.test(css),
    'CSS must enforce [hidden] { display: none !important } so hidden panels never intercept pointer events'
  );
  assert.equal(/color-mix\(\s*in\s+oklch\b/i.test(css), false, 'Must not use in oklch in color-mix');
  assert.equal(
    /background(?:-color)?\s*:\s*(?:#fff(?:fff)?\b|rgba?\(\s*255\s*,\s*255\s*,\s*255)/i.test(css),
    false,
    'Must not hardcode white background colors'
  );
  assert.equal(/transition[^;]*scrollbar-color/i.test(css), false, 'Must not transition scrollbar-color');
  assert.ok(css.includes('forced-colors: active'), 'Must support Windows High Contrast forced-colors');

  // Guard against single-line ellipsis truncation on numeric/telemetry summaries
  for (const selector of ['\\.metric-sub', '\\.strip-sub', '\\.kpi-sub', '\\.pool-cell-sub']) {
    const ruleRe = new RegExp(`${selector}\\s*\\{([^}]*)\\}`, 'g');
    let match;
    let foundRule = false;
    while ((match = ruleRe.exec(css)) !== null) {
      foundRule = true;
      const body = match[1];
      assert.equal(
        /text-overflow\s*:\s*ellipsis/i.test(body),
        false,
        `${selector} must not truncate telemetry text with ellipsis`
      );
      assert.equal(
        /white-space\s*:\s*nowrap/i.test(body),
        false,
        `${selector} must allow line wrapping instead of nowrap`
      );
    }
    assert.ok(foundRule, `Expected CSS rule for ${selector}`);
  }

  console.log(`[PASS] manifest & UI CSS/hit-test invariants verified (${(htmlBytes / 1024).toFixed(1)} KB)`);
}

/**
 * Minimal deterministic DOM implementation for executing bundled dashboard.html
 * and verifying every interactive button, dropdown, disclosure, and race condition.
 */
function createMiniDom(bodyHtml) {
  const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

  function toCamel(kebab) {
    return kebab.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
  }

  function decodeEntities(str) {
    return String(str)
      .replace(/&nbsp;/g, ' ')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }

  class MiniEvent {
    constructor(type, { bubbles = true, target = null, key = '' } = {}) {
      this.type = type;
      this.bubbles = bubbles;
      this.target = target;
      this.currentTarget = null;
      this.key = key;
      this.defaultPrevented = false;
    }
    preventDefault() {
      this.defaultPrevented = true;
    }
  }

  class MiniElement {
    constructor(tagName, ownerDocument) {
      this.tagName = String(tagName || 'DIV').toUpperCase();
      this.ownerDocument = ownerDocument;
      this.parentElement = null;
      this.children = [];
      this.attributes = new Map();
      this._listeners = [];
      this._text = '';
      this._value = undefined;
      this.disabled = false;
      const self = this;
      this.style = {
        colorScheme: '',
        height: '',
        setProperty(k, v) {
          this[k] = v;
        },
      };
      this.classList = {
        add(...tokens) {
          const set = new Set(self.className.split(/\s+/).filter(Boolean));
          tokens.forEach((t) => set.add(t));
          self.className = [...set].join(' ');
        },
        remove(...tokens) {
          const set = new Set(self.className.split(/\s+/).filter(Boolean));
          tokens.forEach((t) => set.delete(t));
          self.className = [...set].join(' ');
        },
        contains(token) {
          return self.className.split(/\s+/).filter(Boolean).includes(token);
        },
        toggle(token, force) {
          const has = this.contains(token);
          const shouldHave = force !== undefined ? Boolean(force) : !has;
          if (shouldHave) this.add(token);
          else this.remove(token);
          return shouldHave;
        },
      };
      this.dataset = new Proxy(
        {},
        {
          get(_, prop) {
            if (typeof prop !== 'string') return undefined;
            const attrName = `data-${prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
            return self.attributes.has(attrName) ? self.attributes.get(attrName) : undefined;
          },
          set(_, prop, val) {
            const attrName = `data-${String(prop).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
            self.setAttribute(attrName, String(val));
            return true;
          },
        }
      );
    }

    get id() {
      return this.attributes.get('id') || '';
    }
    set id(v) {
      this.setAttribute('id', String(v));
    }

    get className() {
      return this.attributes.get('class') || '';
    }
    set className(v) {
      this.setAttribute('class', String(v));
    }

    get hidden() {
      return this.attributes.has('hidden');
    }
    set hidden(v) {
      if (v) this.attributes.set('hidden', v === 'until-found' ? 'until-found' : '');
      else this.attributes.delete('hidden');
    }

    get title() {
      return this.attributes.get('title') || '';
    }
    set title(v) {
      this.setAttribute('title', String(v));
    }

    get value() {
      if (this._value !== undefined) return this._value;
      if (this.tagName === 'SELECT') {
        const selOpt = this.children.find((c) => c.tagName === 'OPTION' && c.attributes.has('selected')) || this.children.find((c) => c.tagName === 'OPTION');
        return selOpt ? selOpt.attributes.get('value') ?? '' : '';
      }
      return this.attributes.get('value') ?? '';
    }
    set value(v) {
      this._value = String(v);
    }

    setAttribute(name, val) {
      this.attributes.set(String(name).toLowerCase(), String(val));
    }
    getAttribute(name) {
      const k = String(name).toLowerCase();
      return this.attributes.has(k) ? this.attributes.get(k) : null;
    }
    hasAttribute(name) {
      return this.attributes.has(String(name).toLowerCase());
    }
    removeAttribute(name) {
      this.attributes.delete(String(name).toLowerCase());
    }

    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      return child;
    }

    get textContent() {
      if (this.children.length === 0) return this._text;
      return this._text + this.children.map((c) => c.textContent).join('');
    }
    set textContent(v) {
      this.children = [];
      this._text = String(v ?? '');
    }

    get innerHTML() {
      return this.textContent;
    }
    set innerHTML(htmlStr) {
      this.children = [];
      this._text = '';
      parseFragmentInto(this, String(htmlStr ?? ''), this.ownerDocument);
    }

    scrollIntoView() {}
    focus() {
      this.ownerDocument.activeElement = this;
    }
    getBoundingClientRect() {
      return { width: 520, height: 640, top: 0, left: 0, right: 520, bottom: 640 };
    }

    matches(selector) {
      return selector
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .some((sel) => matchesCompound(this, sel));
    }

    closest(selector) {
      let cur = this;
      while (cur && cur instanceof MiniElement) {
        if (cur.matches(selector)) return cur;
        cur = cur.parentElement;
      }
      return null;
    }

    querySelectorAll(selector) {
      const out = [];
      const visit = (node) => {
        for (const ch of node.children) {
          if (ch.matches(selector)) out.push(ch);
          visit(ch);
        }
      };
      visit(this);
      return out;
    }

    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }

    addEventListener(type, fn, options) {
      const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
      this._listeners.push({ type, fn, capture });
    }
    removeEventListener(type, fn) {
      this._listeners = this._listeners.filter((l) => !(l.type === type && l.fn === fn));
    }

    dispatchEvent(evt) {
      evt.target = this;
      const chain = [];
      let p = this.parentElement;
      while (p) {
        chain.push(p);
        p = p.parentElement;
      }
      chain.push(this.ownerDocument);
      const captureChain = [...chain].reverse();

      for (const ancestor of captureChain) {
        evt.currentTarget = ancestor;
        for (const l of ancestor._listeners) {
          if (l.type === evt.type && l.capture) l.fn(evt);
        }
      }
      evt.currentTarget = this;
      for (const l of this._listeners) {
        if (l.type === evt.type) l.fn(evt);
      }
      if (evt.bubbles) {
        for (const ancestor of chain) {
          evt.currentTarget = ancestor;
          for (const l of ancestor._listeners) {
            if (l.type === evt.type && !l.capture) l.fn(evt);
          }
        }
      }
      return !evt.defaultPrevented;
    }

    /**
     * Simulate a real user pointer click: verifies no ancestor tabpanel is hidden
     * AND no sibling tabpanel is using non-display:none `until-found` overlay!
     */
    click() {
      // Hit-test check: ensure target is inside a visible panel (or outside panels-root)
      const panel = this.closest('[role="tabpanel"]');
      if (panel) {
        assert.equal(panel.hidden, false, `Cannot click element inside hidden panel #${panel.id}`);
        const root = panel.parentElement;
        if (root) {
          for (const sib of root.children) {
            if (sib !== panel && sib.getAttribute('role') === 'tabpanel') {
              assert.equal(sib.hidden, true, `Sibling panel #${sib.id} is also visible`);
              assert.notEqual(
                sib.getAttribute('hidden'),
                'until-found',
                `Sibling panel #${sib.id} uses hidden="until-found" which intercepts clicks!`
              );
            }
          }
        }
      }

      if (this.tagName === 'SUMMARY' && this.parentElement instanceof MiniDetailsElement) {
        const det = this.parentElement;
        det.open = !det.open;
        det.dispatchEvent(new MiniEvent('toggle', { bubbles: false, target: det }));
        return;
      }

      this.dispatchEvent(new MiniEvent('click', { bubbles: true, target: this }));
    }
  }

  class MiniDetailsElement extends MiniElement {
    get open() {
      return this.attributes.has('open');
    }
    set open(v) {
      if (v) this.attributes.set('open', '');
      else this.attributes.delete('open');
    }
  }

  function matchesSimple(el, simple) {
    let rem = simple.trim();
    if (!rem) return false;
    const tagMatch = rem.match(/^[a-zA-Z0-9-]+/);
    if (tagMatch) {
      if (el.tagName !== tagMatch[0].toUpperCase()) return false;
      rem = rem.slice(tagMatch[0].length);
    }
    const tokenRe = /#([a-zA-Z0-9_-]+)|\.([a-zA-Z0-9_-]+)|\[([a-zA-Z0-9_-]+)(?:=['"]?([^'"\]]*)['"]?)?\]/g;
    let m;
    let consumed = 0;
    while ((m = tokenRe.exec(rem)) !== null) {
      consumed += m[0].length;
      if (m[1]) {
        if (el.id !== m[1]) return false;
      } else if (m[2]) {
        if (!el.classList.contains(m[2])) return false;
      } else if (m[3]) {
        const attr = m[3].toLowerCase();
        if (!el.hasAttribute(attr)) return false;
        if (m[4] !== undefined && el.getAttribute(attr) !== m[4]) return false;
      }
    }
    return consumed === rem.length;
  }

  function matchesCompound(el, sel) {
    const parts = sel.replace(/\s*>\s*/g, ' > ').trim().split(/\s+/);
    let cur = el;
    let idx = parts.length - 1;
    if (!matchesSimple(cur, parts[idx])) return false;
    idx -= 1;
    while (idx >= 0) {
      if (parts[idx] === '>') {
        idx -= 1;
        cur = cur.parentElement;
        if (!cur || !(cur instanceof MiniElement) || !matchesSimple(cur, parts[idx])) return false;
        idx -= 1;
      } else {
        const targetPart = parts[idx];
        cur = cur.parentElement;
        while (cur && cur instanceof MiniElement && !matchesSimple(cur, targetPart)) {
          cur = cur.parentElement;
        }
        if (!cur || !(cur instanceof MiniElement)) return false;
        idx -= 1;
      }
    }
    return true;
  }

  function parseAttrs(el, rawAttrs) {
    const attrRe = /([a-zA-Z0-9_:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let m;
    while ((m = attrRe.exec(rawAttrs)) !== null) {
      const name = m[1].toLowerCase();
      const val = m[2] ?? m[3] ?? m[4] ?? '';
      el.setAttribute(name, decodeEntities(val));
    }
  }

  function parseFragmentInto(rootEl, htmlStr, doc) {
    const stack = [rootEl];
    const tagRe = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9-]+)\s*>|<([a-zA-Z0-9-]+)([^>]*?)(\/?)>/g;
    let lastIdx = 0;
    let m;
    while ((m = tagRe.exec(htmlStr)) !== null) {
      if (m.index > lastIdx) {
        const txt = decodeEntities(htmlStr.slice(lastIdx, m.index));
        if (txt) stack[stack.length - 1]._text += txt;
      }
      lastIdx = tagRe.lastIndex;
      if (m[0].startsWith('<!--')) continue;
      if (m[1]) {
        const closeTag = m[1].toUpperCase();
        for (let i = stack.length - 1; i >= 1; i -= 1) {
          if (stack[i].tagName === closeTag) {
            stack.length = i;
            break;
          }
        }
      } else if (m[2]) {
        const tag = m[2].toUpperCase();
        const el = tag === 'DETAILS' ? new MiniDetailsElement(tag, doc) : new MiniElement(tag, doc);
        parseAttrs(el, m[3] || '');
        stack[stack.length - 1].appendChild(el);
        const selfClose = Boolean(m[4]) || VOID_TAGS.has(tag.toLowerCase());
        if (!selfClose) stack.push(el);
      }
    }
    if (lastIdx < htmlStr.length) {
      const rem = decodeEntities(htmlStr.slice(lastIdx));
      if (rem) stack[stack.length - 1]._text += rem;
    }
  }

  const doc = {
    visibilityState: 'visible',
    activeElement: null,
    _listeners: [],
    documentElement: null,
    head: null,
    body: null,
    createElement(tag) {
      const up = String(tag).toUpperCase();
      return up === 'DETAILS' ? new MiniDetailsElement(up, doc) : new MiniElement(up, doc);
    },
    getElementById(id) {
      return doc.body.querySelector(`#${id}`);
    },
    querySelector(sel) {
      return doc.body.querySelector(sel);
    },
    querySelectorAll(sel) {
      return doc.body.querySelectorAll(sel);
    },
    addEventListener(type, fn, options) {
      const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
      this._listeners.push({ type, fn, capture });
    },
    removeEventListener(type, fn) {
      this._listeners = this._listeners.filter((l) => !(l.type === type && l.fn === fn));
    },
  };

  doc.documentElement = new MiniElement('HTML', doc);
  doc.head = new MiniElement('HEAD', doc);
  doc.body = new MiniElement('BODY', doc);
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);
  doc.body.innerHTML = bodyHtml;

  return { doc, MiniElement, MiniDetailsElement, MiniEvent, toCamel };
}

async function verifyMcpServerAndUiInteractions() {
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

  const intervals = [];

  try {
    const initRes = await rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'verify-client', version: '1.1.0' },
    });
    assert.ok(initRes.result?.capabilities?.resources, 'Server must declare resources capability');
    assert.ok(initRes.result?.capabilities?.tools, 'Server must declare tools capability');
    notify('notifications/initialized', {});

    const resList = await rpc('resources/list', {});
    assert.equal(resList.result.resources.length, 1);
    assert.equal(resList.result.resources[0].uri, 'ui://token-pulse/dashboard');
    assert.equal(resList.result.resources[0].mimeType, 'text/html;profile=mcp-app');

    const resRead = await rpc('resources/read', { uri: 'ui://token-pulse/dashboard' });
    const fullHtml = resRead.result.contents[0].text;
    assert.ok(fullHtml.includes('Token Pulse'));

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
      ['open_telemetry_panel', {}],
      ['open_telemetry_panel', { tab: 'context' }],
      ['open_telemetry_panel', { tab: 'trends' }],
      ['telemetry_snapshot', { surface: 'all' }],
      ['telemetry_analytics', { surface: 'all', days: 7, family: 'all' }],
      ['telemetry_diagnostics', {}],
    ];

    for (const [name, args] of toolCalls) {
      const callRes = await rpc('tools/call', { name, arguments: args });
      assert.ok(!callRes.error, `Tool ${name} returned RPC error: ${JSON.stringify(callRes.error)}`);
      assert.ok(!callRes.result?.isError, `Tool ${name} returned isError=true`);
      if (name === 'open_telemetry_panel' && args.tab === 'context') {
        assert.equal(callRes.result.structuredContent?.initialTab, 'live');
      }
      if (name === 'open_telemetry_panel' && args.tab === 'trends') {
        assert.equal(callRes.result.structuredContent?.initialTab, 'trends');
      }
      const bytes = Buffer.byteLength(JSON.stringify(callRes.result), 'utf8');
      assert.ok(bytes < MAX_TOOL_RESULT_BYTES, `${name} result exceeds 1 MiB: ${bytes}`);
      assertNoCostFields(callRes.result, `tool ${name}`);
    }

    console.log('[PASS] stdio MCP server: handshake, resources, entrypoints, visibility, and 4 tools verified (<1 MiB)');

    // --- Interactive Runtime Verification of Bundled UI ---
    const bodyMatch = fullHtml.match(/<body>([\s\S]*?)<script>/i);
    const scriptMatch = fullHtml.match(/<script>([\s\S]*?)<\/script>/i);
    assert.ok(bodyMatch && scriptMatch, 'Expected <body> and <script> in dashboard.html');

    const { doc, MiniElement, MiniDetailsElement, MiniEvent } = createMiniDom(bodyMatch[1]);
    const windowListeners = [];
    const sentMessages = [];
    const toolCallLog = [];

    const win = {
      innerWidth: 520,
      innerHeight: 740,
      document: doc,
      Element: MiniElement,
      HTMLElement: MiniElement,
      HTMLDetailsElement: MiniDetailsElement,
      ResizeObserver: class {
        observe() {}
        disconnect() {}
      },
      requestAnimationFrame: (cb) => setTimeout(cb, 0),
      setTimeout,
      clearTimeout,
      setInterval: (fn, ms) => {
        const t = setInterval(fn, ms);
        intervals.push(t);
        return t;
      },
      clearInterval,
      navigator: { userAgent: 'AntigravityTest/1.1' },
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      crypto: globalThis.crypto,
      performance: globalThis.performance,
      AbortController,
      AbortSignal,
      structuredClone,
      atob: (s) => Buffer.from(s, 'base64').toString('binary'),
      btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
      console,
      addEventListener(type, fn) {
        windowListeners.push({ type, fn });
      },
      removeEventListener(type, fn) {
        const idx = windowListeners.findIndex((l) => l.type === type && l.fn === fn);
        if (idx >= 0) windowListeners.splice(idx, 1);
      },
      parent: {
        postMessage(payload) {
          setImmediate(async () => {
            if (!payload || typeof payload !== 'object') return;
            const replyToApp = (msg) => {
              for (const l of [...windowListeners]) {
                if (l.type === 'message') {
                  l.fn({ data: msg, source: win.parent });
                }
              }
            };

            if (payload.method === 'ui/initialize') {
              replyToApp({
                jsonrpc: '2.0',
                id: payload.id,
                result: {
                  protocolVersion: payload.params?.protocolVersion || '2025-11-21',
                  hostInfo: { name: 'Antigravity', version: '2.34.0' },
                  hostCapabilities: { serverTools: {}, message: { text: {} } },
                  hostContext: { theme: 'dark', styles: { variables: {} } },
                },
              });
              return;
            }

            if (payload.method === 'tools/call') {
              toolCallLog.push({ name: payload.params?.name, arguments: { ...payload.params?.arguments } });
              // Slight delay on 14d call to test concurrent 14d -> 30d click race!
              if (payload.params?.name === 'telemetry_analytics' && payload.params?.arguments?.days === 14 && toolCallLog.filter((c) => c.arguments?.days === 14).length === 1) {
                await new Promise((r) => setTimeout(r, 40));
              }
              const srvRes = await rpc('tools/call', payload.params);
              replyToApp({
                jsonrpc: '2.0',
                id: payload.id,
                result: srvRes.result,
              });
              return;
            }

            if (payload.method === 'ui/message') {
              sentMessages.push(payload.params);
              replyToApp({
                jsonrpc: '2.0',
                id: payload.id,
                result: { isError: false },
              });
            }
          });
        },
      },
    };
    win.window = win;
    win.globalThis = win;

    const flushUi = (ms = 60) => new Promise((r) => setTimeout(r, ms));
    vm.runInNewContext(scriptMatch[1], win);
    await flushUi(120);

    // 1. Live view initial state & hit-testing
    const panelLive = doc.getElementById('panel-live');
    const panelTrends = doc.getElementById('panel-trends');
    assert.equal(panelLive.hidden, false, '#panel-live should be visible initially');
    assert.equal(panelTrends.hidden, true, '#panel-trends should be hidden initially');
    assert.ok(doc.getElementById('body-live').textContent.includes('当前上下文'), 'Live context card must render inline');
    assert.ok(doc.getElementById('body-live').textContent.includes('额度与窗口消耗'), 'Quota ledger card must render inline');

    // 2. Live view <details> (`最近生成轮次明细`) toggle & persistence across refresh
    const turnsSummary = doc.querySelector('details[data-fold-id="turns"] > summary');
    assert.ok(turnsSummary, 'Expected 最近生成轮次明细 summary');
    turnsSummary.click();
    assert.equal(doc.querySelector('details[data-fold-id="turns"]').open, true, 'Clicking turns summary must open details');

    doc.getElementById('btn-refresh').click();
    await flushUi(80);
    assert.equal(
      doc.querySelector('details[data-fold-id="turns"]').open,
      true,
      'Turns <details> must remain open after refresh'
    );

    // Close turns <details> and verify it stays closed after refresh
    doc.querySelector('details[data-fold-id="turns"] > summary').click();
    doc.getElementById('btn-refresh').click();
    await flushUi(80);
    assert.equal(
      doc.querySelector('details[data-fold-id="turns"]').open,
      false,
      'Turns <details> must stay closed after user closes it'
    );

    // 3. Non-interactive /compact command reminder (no fake ui/message button)
    assert.equal(doc.getElementById('btn-compact'), null, '#btn-compact must be removed');
    const compactNotice = doc.querySelector('.compact-notice');
    assert.ok(
      compactNotice && compactNotice.textContent.includes('/compact'),
      'Live view must render a non-interactive /compact command reminder'
    );
    assert.equal(sentMessages.length, 0, 'UI must not dispatch fake /compact messages via ui/message');

    // 4. Privacy toggle button
    doc.getElementById('btn-privacy').click();
    assert.equal(doc.getElementById('btn-privacy').getAttribute('aria-pressed'), 'true');
    doc.getElementById('btn-privacy').click();
    assert.equal(doc.getElementById('btn-privacy').getAttribute('aria-pressed'), 'false');

    // 5. Switch to Trends tab & test ALL circled buttons (`7/14/30天` + `按模型/按项目/按会话` + concurrent clicks!)
    doc.getElementById('tab-trends').click();
    await flushUi(100);
    assert.equal(panelTrends.hidden, false, '#panel-trends must be visible');
    assert.equal(panelLive.hidden, true, '#panel-live must be hidden without until-found overlay');
    assert.ok(doc.getElementById('body-trends').textContent.includes('近 7 天消耗趋势'), '7d trends must render');

    // Rapid back-to-back click race test: click 14天 then immediately click 30天 before 14天 finishes!
    const btn14 = doc.querySelector('button[data-days="14"]');
    const btn30 = doc.querySelector('button[data-days="30"]');
    assert.ok(btn14 && btn30, 'Expected 14天 and 30天 buttons');
    btn14.click();
    doc.querySelector('button[data-days="30"]').click();
    await flushUi(140);
    assert.equal(
      doc.querySelector('button[data-days="30"]').getAttribute('aria-pressed'),
      'true',
      '30天 button must stay active after concurrent 14d -> 30d click'
    );
    assert.ok(
      doc.getElementById('body-trends').textContent.includes('近 30 天消耗趋势'),
      `Expected 近 30 天消耗趋势 after concurrent click, got: ${doc.getElementById('body-trends').textContent.slice(0, 80)}`
    );

    // Click 14天 normally
    doc.querySelector('button[data-days="14"]').click();
    await flushUi(100);
    assert.ok(doc.getElementById('body-trends').textContent.includes('近 14 天消耗趋势'), '14天 button click must render 14d chart');

    // Family filter button click & toggle back
    doc.querySelector('button[data-family="gemini4"]').click();
    await flushUi(100);
    assert.equal(doc.querySelector('button[data-family="gemini4"]').getAttribute('aria-pressed'), 'true');
    doc.querySelector('button[data-family="gemini4"]').click();
    await flushUi(100);
    assert.equal(doc.querySelector('button[data-family="all"]').getAttribute('aria-pressed'), 'true');

    // Drill-down buttons (`按模型 / 按项目 / 按会话`)
    doc.querySelector('button[data-drill="project"]').click();
    assert.equal(doc.querySelector('button[data-drill="project"]').getAttribute('aria-pressed'), 'true');
    doc.querySelector('button[data-drill="session"]').click();
    assert.equal(doc.querySelector('button[data-drill="session"]').getAttribute('aria-pressed'), 'true');

    // Chart day bar selection & cache percentage display assertion
    const firstBar = doc.querySelector('#body-trends button[data-day-idx="0"]');
    assert.ok(firstBar, 'Expected clickable chart day bar');
    firstBar.click();
    assert.ok(doc.querySelector('#body-trends button[data-day-idx="0"]').classList.contains('selected'));
    assert.match(
      doc.getElementById('body-trends').textContent,
      /缓存\s+[0-9.]+[kMB]?\s*\(命中[0-9.]+%\)/,
      'Trends daily summary & drill-down must show both cache token count and hit rate percentage'
    );
    assert.match(
      doc.getElementById('body-live').textContent,
      /缓存\s+[0-9.]+[kMB]?\s*\(命中[0-9.]+%\)/,
      'Live turn rows must show both cache token count and hit rate percentage'
    );

    // Diagnostics <details> open -> load -> close -> stay closed on re-render (BUG-002)
    doc.querySelector('#diag-disclosure > summary').click();
    await flushUi(80);
    assert.equal(doc.getElementById('diag-disclosure').open, true, 'Diagnostics must open and load');
    assert.ok(doc.getElementById('diag-content').textContent.includes('Node.js'), 'Diagnostics payload must render');

    doc.querySelector('#diag-disclosure > summary').click();
    assert.equal(doc.getElementById('diag-disclosure').open, false, 'Diagnostics must close on second click');
    // Trigger re-render via drill switch and confirm diagnostics stays closed!
    doc.querySelector('button[data-drill="model"]').click();
    assert.equal(
      doc.getElementById('diag-disclosure').open,
      false,
      'Diagnostics <details> must NOT reopen on re-render after user closed it'
    );

    // Surface filter + session selector
    doc.querySelector('button[data-surface="desktop"]').click();
    await flushUi(100);
    assert.equal(doc.querySelector('button[data-surface="desktop"]').getAttribute('aria-pressed'), 'true');

    doc.getElementById('tab-live').click();
    assert.equal(panelLive.hidden, false);
    assert.equal(panelTrends.hidden, true);

    assert.equal(stderrOut.trim(), '', `Unexpected stderr from MCP server: ${stderrOut}`);
    console.log('[PASS] interactive UI runtime: all buttons (7/14/30d, model/project/session drill, family, bars, /compact notice, disclosures, concurrent races) verified end-to-end');
  } finally {
    intervals.forEach((t) => clearInterval(t));
    rl.close();
    child.stdin.end();
    child.kill();
  }
}

async function main() {
  await verifySqliteReader();
  verifyManifestAndHtml();
  await verifyMcpServerAndUiInteractions();
  console.log('ALL VERIFICATION CHECKS PASSED');
}

main().catch((err) => {
  console.error('VERIFICATION FAILED:', err);
  process.exit(1);
});
