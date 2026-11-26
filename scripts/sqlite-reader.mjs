import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * In-memory cache of parsed conversation databases keyed by absolute file path.
 * Avoids re-opening and re-parsing unchanged SQLite files on repeated UI refreshes.
 */
const dbParseCache = new Map();

const MODEL_ENUM_LABELS = {
  1298: 'Gemini 3.7 Flash',
  1318: 'Gemini 3.8 Flash',
  1322: 'Gemini 3.8 Flash Tiered',
  1401: 'Claude Opus',
  1418: 'Gemini 4 Argon',
  1532: 'Gemini 4 Neon',
};

const FAMILY_META = {
  gemini4: { key: 'gemini4', label: 'Gemini 4', poolLabel: 'Gemini 4 主力池', order: 0 },
  claude: { key: 'claude', label: 'Claude', poolLabel: 'Claude 池', order: 1 },
  flash: { key: 'flash', label: 'Flash / Subagent', poolLabel: 'Flash / 子代理池', order: 2 },
  other: { key: 'other', label: 'Other', poolLabel: '其他模型池', order: 3 },
};

const WINDOW_5H_MS = 5 * 3_600_000;
const ROLLOFF_BATCH_SPAN_MS = 15 * 60_000;

/**
 * Resolve the user's .gemini root directory.
 */
export function resolveGeminiDir() {
  if (process.env.ANTIGRAVITY_GEMINI_DIR) {
    return process.env.ANTIGRAVITY_GEMINI_DIR;
  }
  return path.join(os.homedir(), '.gemini');
}

/**
 * Open a SQLite database strictly in read-only mode.
 * Falls back to immutable URI mode if the DB is missing a WAL sidecar or momentarily locked.
 */
function openReadOnlyDb(filePath) {
  try {
    return new DatabaseSync(filePath, { readOnly: true });
  } catch {
    const normalized = filePath.replace(/\\/g, '/');
    const prefix = normalized.startsWith('/') ? 'file://' : 'file:///';
    const uri = `${prefix}${encodeURI(normalized)}?mode=ro&immutable=1`;
    return new DatabaseSync(uri, { readOnly: true });
  }
}

/**
 * Read an unsigned varint from a Uint8Array starting at `offset`.
 * Uses BigInt so 64-bit unsigned sentinel values never lose precision.
 */
function readVarint(buf, offset) {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: result, next: pos };
    }
    shift += 7n;
    if (shift > 70n) {
      throw new Error('Malformed varint');
    }
  }
  throw new Error('Truncated varint');
}

/**
 * Iterate top-level protobuf wire fields inside `buf[start..end]`.
 */
function visitProtobufFields(buf, start, end, onField) {
  let pos = start;
  while (pos < end) {
    const tagRes = readVarint(buf, pos);
    pos = tagRes.next;
    const tag = Number(tagRes.value);
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (fieldNo === 0) {
      break;
    }
    if (wireType === 0) {
      const valRes = readVarint(buf, pos);
      pos = valRes.next;
      onField(fieldNo, wireType, valRes.value, 0, 0);
    } else if (wireType === 1) {
      if (pos + 8 > end) break;
      pos += 8;
    } else if (wireType === 2) {
      const lenRes = readVarint(buf, pos);
      pos = lenRes.next;
      const len = Number(lenRes.value);
      if (len < 0 || pos + len > end) break;
      onField(fieldNo, wireType, 0n, pos, pos + len);
      pos += len;
    } else if (wireType === 5) {
      if (pos + 4 > end) break;
      pos += 4;
    } else {
      break;
    }
  }
}

function toSafeInt(bigVal) {
  if (bigVal <= 0n || bigVal > 1_000_000_000_000n) return 0;
  return Number(bigVal);
}

function decodeUtf8(buf, start, end) {
  return Buffer.from(buf.buffer, buf.byteOffset + start, end - start).toString('utf8');
}

/**
 * Decode a Protobuf Timestamp / Duration `{ 1: seconds, 2: nanos }`.
 */
function decodeDurationSec(buf, start, end) {
  let sec = 0;
  let nanos = 0;
  visitProtobufFields(buf, start, end, (fn, wt, val) => {
    if (wt !== 0) return;
    if (fn === 1) sec = toSafeInt(val);
    else if (fn === 2) nanos = toSafeInt(val);
  });
  return sec + nanos / 1e9;
}

/**
 * Decode verified fields from a `gen_metadata.data` protobuf blob.
 */
function parseGenMetadataBlob(blob) {
  const buf = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  let streamSec = 0;
  const out = {
    requestId: '',
    modelEnum: 0,
    modelSlug: '',
    modelName: '',
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    thinkingTokens: 0,
    textTokens: 0,
    contextUsed: 0,
    contextLimit: 0,
    streamSec: 0,
    latencySec: 0,
    ttftSec: 0,
    metaMap: {},
  };

  visitProtobufFields(buf, 0, buf.length, (fn, wt, _val, s, e) => {
    if (fn === 4 && wt === 2) {
      out.requestId = decodeUtf8(buf, s, e);
      return;
    }
    if (fn !== 1 || wt !== 2) return;

    visitProtobufFields(buf, s, e, (subFn, subWt, subVal, ss, se) => {
      if (subFn === 3 && subWt === 0) {
        out.modelEnum = toSafeInt(subVal);
      } else if (subFn === 4 && subWt === 2) {
        visitProtobufFields(buf, ss, se, (tFn, tWt, tVal) => {
          if (tWt !== 0) return;
          if (tFn === 2) out.inputTokens = toSafeInt(tVal);
          else if (tFn === 3) out.outputTokens = toSafeInt(tVal);
          else if (tFn === 4) out.cacheWriteTokens = toSafeInt(tVal);
          else if (tFn === 5) out.cacheReadTokens = toSafeInt(tVal);
          else if (tFn === 9) out.thinkingTokens = toSafeInt(tVal);
          else if (tFn === 10) out.textTokens = toSafeInt(tVal);
        });
      } else if (subFn === 9 && subWt === 2) {
        visitProtobufFields(buf, ss, se, (cFn, cWt, _cVal, cs, ce) => {
          if (cFn !== 10 || cWt !== 2) return;
          visitProtobufFields(buf, cs, ce, (iFn, iWt, iVal) => {
            if (iWt !== 0) return;
            if (iFn === 1) out.contextUsed = toSafeInt(iVal);
            else if (iFn === 4) out.contextLimit = toSafeInt(iVal);
          });
        });
      } else if (subFn === 11 && subWt === 2) {
        out.ttftSec = decodeDurationSec(buf, ss, se);
      } else if (subFn === 12 && subWt === 2) {
        streamSec = decodeDurationSec(buf, ss, se);
      } else if (subFn === 19 && subWt === 2) {
        out.modelSlug = decodeUtf8(buf, ss, se);
      } else if (subFn === 20 && subWt === 2) {
        let k = '';
        let v = '';
        visitProtobufFields(buf, ss, se, (mFn, mWt, _mVal, ms, me) => {
          if (mWt !== 2) return;
          if (mFn === 1) k = decodeUtf8(buf, ms, me);
          else if (mFn === 2) v = decodeUtf8(buf, ms, me);
        });
        if (k) out.metaMap[k] = v;
      } else if (subFn === 21 && subWt === 2) {
        out.modelName = decodeUtf8(buf, ss, se);
      }
    });
  });

  out.streamSec = streamSec;
  out.latencySec = out.ttftSec + streamSec;
  if (out.textTokens === 0 && out.outputTokens > 0) {
    out.textTokens = Math.max(0, out.outputTokens - out.thinkingTokens);
  }
  return out;
}

/**
 * Extract step creation unix timestamp (ms) and request ID from `steps.metadata`.
 */
function parseStepMetadataBlob(blob) {
  const buf = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  let timestampMs = 0;
  let requestId = '';
  visitProtobufFields(buf, 0, buf.length, (fn, wt, _val, s, e) => {
    if (fn === 1 && wt === 2) {
      let sec = 0;
      let nanos = 0;
      visitProtobufFields(buf, s, e, (tFn, tWt, tVal) => {
        if (tWt !== 0) return;
        if (tFn === 1) sec = Number(tVal);
        else if (tFn === 2) nanos = Number(tVal);
      });
      if (sec > 1_000_000_000) {
        timestampMs = sec * 1000 + Math.round(nanos / 1e6);
      }
    } else if (fn === 12 && wt === 2) {
      requestId = decodeUtf8(buf, s, e);
    }
  });
  return { timestampMs, requestId };
}

function formatSlugLabel(slug) {
  if (!slug) return '';
  return slug
    .split('-')
    .map((part) => (part.length ? part[0].toUpperCase() + part.slice(1) : ''))
    .join(' ');
}

function resolveModelLabel(gen) {
  if (gen.modelName) return gen.modelName;
  if (gen.modelSlug) return formatSlugLabel(gen.modelSlug);
  if (MODEL_ENUM_LABELS[gen.modelEnum]) return MODEL_ENUM_LABELS[gen.modelEnum];
  if (gen.metaMap?.model_enum) return gen.metaMap.model_enum;
  return gen.modelEnum ? `Model #${gen.modelEnum}` : 'Unknown Model';
}

function classifyModelFamily(modelLabel, modelSlug, modelEnum, metaMap) {
  const text = `${modelLabel} ${modelSlug}`.toLowerCase();
  if (text.includes('claude') || metaMap?.used_claude === 'true') {
    return 'claude';
  }
  if (text.includes('flash') || modelEnum === 1298 || modelEnum === 1318 || modelEnum === 1322) {
    return 'flash';
  }
  if (/gemini[- ]?4|neon|carbon|hydrogen|argon|orchestrator/i.test(text)) {
    return 'gemini4';
  }
  return 'other';
}

function computeTurnTps(outputTokens, streamSec, latencySec) {
  if (!outputTokens || outputTokens <= 0) return 0;
  const effectiveSec = streamSec > 0.05 ? streamSec : latencySec > 0.05 ? latencySec : 0;
  if (effectiveSec <= 0 || effectiveSec > 3600) return 0;
  return Math.round((outputTokens / effectiveSec) * 10) / 10;
}

function parseSqlTimestampMs(raw) {
  if (!raw || typeof raw !== 'string') return 0;
  const normalized = raw
    .trim()
    .replace(' ', 'T')
    .replace(/(\.\d{3})\d+/, '$1');
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : 0;
}

function extractProjectName(workspaceUrisRaw, projectId) {
  if (workspaceUrisRaw) {
    try {
      const parsed = JSON.parse(workspaceUrisRaw);
      const first = Array.isArray(parsed) ? parsed[0] : null;
      if (typeof first === 'string' && first.length > 0) {
        let decoded = first;
        try {
          decoded = decodeURIComponent(first);
        } catch {
          // Keep raw URI if percent-encoding is partial
        }
        const cleaned = decoded.replace(/^file:\/+/i, '').replace(/\/+$/, '');
        const base = path.basename(cleaned);
        if (base) return base;
        return cleaned;
      }
    } catch {
      // Fallback below
    }
  }
  if (projectId) return `Project ${projectId.slice(0, 8)}`;
  return 'Outside of Project';
}

/**
 * Load conversation summaries from `conversation_summaries.db` across primary and CLI roots.
 */
function loadSummariesMap(geminiDir) {
  const summaries = new Map();
  const candidates = [
    { path: path.join(geminiDir, 'conversation_summaries.db'), defaultSurface: 'desktop' },
    { path: path.join(geminiDir, 'antigravity-cli', 'conversation_summaries.db'), defaultSurface: 'cli' },
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate.path)) continue;
    let db;
    try {
      db = openReadOnlyDb(candidate.path);
      const cols = new Set(
        db
          .prepare("PRAGMA table_info('conversation_summaries')")
          .all()
          .map((c) => String(c.name))
      );

      const selectCols = [
        'conversation_id',
        'title',
        'last_modified_time',
        'workspace_uris',
        'status',
        'source',
        'project_id',
      ];
      if (cols.has('step_count')) selectCols.push('step_count');
      if (cols.has('parent_conversation_id')) selectCols.push('parent_conversation_id');
      if (cols.has('nesting_depth')) selectCols.push('nesting_depth');
      if (cols.has('agent_name')) selectCols.push('agent_name');

      const rows = db.prepare(`SELECT ${selectCols.join(', ')} FROM conversation_summaries`).all();
      for (const row of rows) {
        if (!row.conversation_id) continue;
        const src = String(row.source || '').toUpperCase();
        const surface =
          candidate.defaultSurface === 'cli' || src.includes('CLI') ? 'cli' : 'desktop';
        const prev = summaries.get(row.conversation_id);
        const modMs = parseSqlTimestampMs(row.last_modified_time);
        if (!prev || modMs >= prev.lastModifiedMs) {
          summaries.set(row.conversation_id, {
            id: row.conversation_id,
            title: row.title || prev?.title || '',
            stepCount: Number(row.step_count) || prev?.stepCount || 0,
            parentId: row.parent_conversation_id || prev?.parentId || '',
            nestingDepth: Number(row.nesting_depth) || prev?.nestingDepth || 0,
            agentName: row.agent_name || prev?.agentName || '',
            lastModifiedMs: modMs || prev?.lastModifiedMs || 0,
            project: extractProjectName(row.workspace_uris, row.project_id),
            workspaceRaw: row.workspace_uris || '',
            status: row.status || '',
            surface,
          });
        }
      }

      const hasParentsTable = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_parents'")
        .get();
      if (hasParentsTable) {
        const pRows = db
          .prepare('SELECT conversation_id, parent_id FROM conversation_parents')
          .all();
        for (const pRow of pRows) {
          if (!pRow.conversation_id || !pRow.parent_id) continue;
          const existing = summaries.get(pRow.conversation_id);
          if (existing && !existing.parentId) {
            existing.parentId = String(pRow.parent_id);
          }
        }
      }
    } catch {
      // Non-fatal: individual conversation DBs still parse cleanly
    } finally {
      if (db) {
        try {
          db.close();
        } catch {
          // ignore
        }
      }
    }
  }
  return summaries;
}

/**
 * Parse a single conversation `.db` file using the stat-keyed cache.
 */
function parseConversationDb(dbPath, forcedSurface, summary) {
  const stat = fs.statSync(dbPath);
  const convId = path.basename(dbPath, '.db');
  const cached = dbParseCache.get(dbPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return mergeSummaryIntoParsed(cached.parsed, summary, forcedSurface);
  }

  let db;
  try {
    db = openReadOnlyDb(dbPath);
    const hasGenMeta = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gen_metadata'")
      .get();
    if (!hasGenMeta) {
      return null;
    }

    const stepTimeByIdx = new Map();
    const stepTimeByReqId = new Map();
    let dbStepCount = 0;
    const hasSteps = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='steps'")
      .get();
    if (hasSteps) {
      const stepRows = db.prepare('SELECT idx, metadata FROM steps').all();
      dbStepCount = stepRows.length;
      for (const sRow of stepRows) {
        if (!sRow.metadata) continue;
        try {
          const parsedStep = parseStepMetadataBlob(sRow.metadata);
          if (parsedStep.timestampMs > 0) {
            stepTimeByIdx.set(Number(sRow.idx), parsedStep.timestampMs);
            if (parsedStep.requestId) {
              stepTimeByReqId.set(parsedStep.requestId, parsedStep.timestampMs);
            }
          }
        } catch {
          // Skip malformed individual step row
        }
      }
    }

    const genRows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all();
    const turns = [];
    for (const gRow of genRows) {
      if (!gRow.data || gRow.data.length === 0) continue;
      const g = parseGenMetadataBlob(gRow.data);
      const stepIdxRaw = g.metaMap?.last_step_index;
      const stepIdx = stepIdxRaw !== undefined ? Number(stepIdxRaw) : NaN;
      let ts = 0;
      if (Number.isFinite(stepIdx) && stepTimeByIdx.has(stepIdx)) {
        ts = stepTimeByIdx.get(stepIdx);
      } else if (g.requestId && stepTimeByReqId.has(g.requestId)) {
        ts = stepTimeByReqId.get(g.requestId);
      } else {
        ts = summary?.lastModifiedMs || stat.mtimeMs;
      }

      const modelLabel = resolveModelLabel(g);
      const family = classifyModelFamily(modelLabel, g.modelSlug, g.modelEnum, g.metaMap);
      const totalTokens =
        g.inputTokens + g.cacheReadTokens + g.cacheWriteTokens + g.outputTokens;
      const tps = computeTurnTps(g.outputTokens, g.streamSec, g.latencySec);

      turns.push({
        idx: Number(gRow.idx),
        timestampMs: ts,
        modelLabel,
        modelSlug: g.modelSlug,
        family,
        inputTokens: g.inputTokens,
        cacheReadTokens: g.cacheReadTokens,
        cacheWriteTokens: g.cacheWriteTokens,
        outputTokens: g.outputTokens,
        thinkingTokens: g.thinkingTokens,
        textTokens: g.textTokens,
        totalTokens,
        contextUsed: g.contextUsed,
        contextLimit: g.contextLimit,
        streamSec: g.streamSec,
        latencySec: g.latencySec,
        ttftSec: g.ttftSec,
        tps,
        requestId: g.requestId,
      });
    }

    const parsed = {
      id: convId,
      dbPath,
      mtimeMs: stat.mtimeMs,
      dbStepCount,
      turns,
    };
    dbParseCache.set(dbPath, { mtimeMs: stat.mtimeMs, size: stat.size, parsed });
    return mergeSummaryIntoParsed(parsed, summary, forcedSurface);
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  }
}

function mergeSummaryIntoParsed(parsed, summary, forcedSurface) {
  const lastTurnTs =
    parsed.turns.length > 0 ? parsed.turns[parsed.turns.length - 1].timestampMs : 0;
  const lastActiveMs = Math.max(
    lastTurnTs,
    summary?.lastModifiedMs || 0,
    parsed.mtimeMs || 0
  );
  const stepCount = Math.max(
    summary?.stepCount || 0,
    parsed.dbStepCount || 0,
    parsed.turns.length
  );
  return {
    ...parsed,
    surface: forcedSurface || summary?.surface || 'desktop',
    title: summary?.title || `Session ${parsed.id.slice(0, 8)}`,
    project: summary?.project || 'Outside of Project',
    status: summary?.status || 'CASCADE_RUN_STATUS_IDLE',
    stepCount,
    parentId: summary?.parentId || '',
    nestingDepth: summary?.nestingDepth || 0,
    agentName: summary?.agentName || '',
    lastActiveMs,
  };
}

/**
 * Scan all Antigravity conversation databases across Desktop and CLI roots.
 */
function scanAllConversations() {
  const startedAt = performance.now();
  const rootGeminiDir = resolveGeminiDir();
  const antigravityDir = path.join(rootGeminiDir, 'antigravity');
  const cliDir = path.join(rootGeminiDir, 'antigravity-cli');

  const summaries = loadSummariesMap(antigravityDir);
  const primaryConvsDir = path.join(antigravityDir, 'conversations');
  const cliConvsDir = path.join(cliDir, 'conversations');

  const dbSources = [];
  if (fs.existsSync(primaryConvsDir)) {
    for (const name of fs.readdirSync(primaryConvsDir)) {
      if (name.endsWith('.db')) {
        dbSources.push({
          id: name.slice(0, -3),
          filePath: path.join(primaryConvsDir, name),
          forcedSurface: null,
          root: 'primary',
        });
      }
    }
  }
  if (fs.existsSync(cliConvsDir)) {
    for (const name of fs.readdirSync(cliConvsDir)) {
      if (name.endsWith('.db')) {
        dbSources.push({
          id: name.slice(0, -3),
          filePath: path.join(cliConvsDir, name),
          forcedSurface: 'cli',
          root: 'cli',
        });
      }
    }
  }

  const byId = new Map();
  let primaryDbCount = 0;
  let cliDbCount = 0;
  for (const src of dbSources) {
    if (src.root === 'primary') primaryDbCount += 1;
    else cliDbCount += 1;
    if (!byId.has(src.id) || src.root === 'primary') {
      byId.set(src.id, src);
    }
  }

  const conversations = [];
  const errors = [];
  for (const src of byId.values()) {
    try {
      const parsed = parseConversationDb(src.filePath, src.forcedSurface, summaries.get(src.id));
      if (parsed) conversations.push(parsed);
    } catch (err) {
      errors.push({
        file: path.basename(src.filePath),
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  conversations.sort((a, b) => b.lastActiveMs - a.lastActiveMs);
  const scanMs = Math.round((performance.now() - startedAt) * 10) / 10;

  return {
    conversations,
    diagnostics: {
      nodeVersion: process.version,
      geminiDir: rootGeminiDir,
      primaryDbCount,
      cliDbCount,
      parsedCount: conversations.length,
      errorCount: errors.length,
      errors: errors.slice(0, 5),
      cacheEntries: dbParseCache.size,
      scanMs,
      activeEnvConversation: Boolean(process.env.ANTIGRAVITY_CONVERSATION_ID),
      envConversationId: process.env.ANTIGRAVITY_CONVERSATION_ID || null,
    },
  };
}

function matchesSurface(conv, surface) {
  if (!surface || surface === 'all') return true;
  return conv.surface === surface;
}

function computeCacheHitRate(inputTokens, cacheReadTokens) {
  const denom = inputTokens + cacheReadTokens;
  if (denom <= 0) return 0;
  return Math.round((cacheReadTokens / denom) * 1000) / 10;
}

/**
 * Determine the representative context window turn for a session.
 * Prefers the latest turn of the session's primary non-flash model if subagents ran interleaved.
 */
function resolveContextState(turns) {
  const withLimit = turns.filter((t) => t.contextLimit > 0);
  if (withLimit.length === 0) {
    return {
      contextUsed: 0,
      contextLimit: 0,
      contextPct: 0,
      alertLevel: 'ok',
      modelLabel: turns[turns.length - 1]?.modelLabel || 'No generations yet',
      family: turns[turns.length - 1]?.family || 'other',
      compactionEvents: [],
    };
  }

  const nonSubagent = withLimit.filter((t) => t.family !== 'flash');
  const targetPool =
    nonSubagent.length >= Math.max(1, Math.floor(withLimit.length * 0.25))
      ? nonSubagent
      : withLimit;
  const latest = targetPool[targetPool.length - 1];
  const pct =
    latest.contextLimit > 0
      ? Math.min(100, Math.round((latest.contextUsed / latest.contextLimit) * 1000) / 10)
      : 0;
  const alertLevel = pct >= 90 ? 'danger' : pct >= 75 ? 'warn' : 'ok';

  const compactionEvents = [];
  for (let i = 1; i < targetPool.length; i += 1) {
    const prev = targetPool[i - 1];
    const curr = targetPool[i];
    if (
      prev.contextUsed > 20_000 &&
      curr.contextUsed < prev.contextUsed * 0.65 &&
      prev.contextLimit === curr.contextLimit
    ) {
      compactionEvents.push({
        turnIdx: curr.idx,
        timestampMs: curr.timestampMs,
        beforeTokens: prev.contextUsed,
        afterTokens: curr.contextUsed,
        savedTokens: prev.contextUsed - curr.contextUsed,
      });
    }
  }

  return {
    contextUsed: latest.contextUsed,
    contextLimit: latest.contextLimit,
    contextPct: pct,
    alertLevel,
    modelLabel: latest.modelLabel,
    family: latest.family,
    compactionEvents,
  };
}

function localDayKey(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function buildDailyBuckets(turns, days, nowMs) {
  const buckets = [];
  const byDay = new Map();
  const todayMidnight = new Date(nowMs);
  todayMidnight.setHours(0, 0, 0, 0);

  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(todayMidnight.getTime() - i * 86_400_000);
    const key = localDayKey(d.getTime());
    const weekdayNames = ['日', '一', '二', '三', '四', '五', '六'];
    const shortLabel =
      i === 0
        ? '今'
        : days <= 7
          ? weekdayNames[d.getDay()]
          : `${d.getMonth() + 1}/${d.getDate()}`;
    const bucket = {
      dayKey: key,
      label: shortLabel,
      dateLabel: `${d.getMonth() + 1}月${d.getDate()}日`,
      totalTokens: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      turnsCount: 0,
      families: { gemini4: 0, flash: 0, claude: 0, other: 0 },
    };
    buckets.push(bucket);
    byDay.set(key, bucket);
  }

  for (const t of turns) {
    const key = localDayKey(t.timestampMs);
    const b = byDay.get(key);
    if (!b) continue;
    b.totalTokens += t.totalTokens;
    b.inputTokens += t.inputTokens;
    b.cacheReadTokens += t.cacheReadTokens;
    b.outputTokens += t.outputTokens;
    b.thinkingTokens += t.thinkingTokens;
    b.turnsCount += 1;
    b.families[t.family] = (b.families[t.family] || 0) + t.totalTokens;
  }

  for (const b of buckets) {
    b.cacheHitRate = computeCacheHitRate(b.inputTokens, b.cacheReadTokens);
  }

  return buckets;
}

/**
 * Compute 5h rolling window rolloff timing from sorted or unsorted window turns.
 */
function compute5hRolloff(windowTurns, nowMs) {
  if (!windowTurns || windowTurns.length === 0) {
    return {
      active: false,
      nextRolloffAtMs: 0,
      nextRolloffInSec: 0,
      nextRolloffTokens: 0,
      fullClearAtMs: 0,
      fullClearInSec: 0,
    };
  }

  const sorted = [...windowTurns].sort((a, b) => a.timestampMs - b.timestampMs);
  const firstTs = sorted[0].timestampMs;
  const lastTs = sorted[sorted.length - 1].timestampMs;
  const batchEndTs = firstTs + ROLLOFF_BATCH_SPAN_MS;

  let batchTokens = 0;
  for (const t of sorted) {
    if (t.timestampMs <= batchEndTs) {
      batchTokens += t.totalTokens;
    } else {
      break;
    }
  }

  const nextRolloffAtMs = firstTs + WINDOW_5H_MS;
  const fullClearAtMs = lastTs + WINDOW_5H_MS;

  return {
    active: true,
    nextRolloffAtMs,
    nextRolloffInSec: Math.max(1, Math.round((nextRolloffAtMs - nowMs) / 1000)),
    nextRolloffTokens: batchTokens,
    fullClearAtMs,
    fullClearInSec: Math.max(1, Math.round((fullClearAtMs - nowMs) / 1000)),
  };
}

/**
 * Collect descendant subagent conversations rooted at `rootId`.
 */
function collectDescendantStats(conversations, rootId) {
  if (!rootId) {
    return { count: 0, turnsCount: 0, totalTokens: 0 };
  }
  const byId = new Map(conversations.map((c) => [c.id, c]));
  const memo = new Map();

  function descendsFromRoot(convId) {
    if (memo.has(convId)) return memo.get(convId);
    memo.set(convId, false); // cycle guard
    const c = byId.get(convId);
    if (!c || !c.parentId) return false;
    if (c.parentId === rootId) {
      memo.set(convId, true);
      return true;
    }
    const res = descendsFromRoot(c.parentId);
    memo.set(convId, res);
    return res;
  }

  let count = 0;
  let turnsCount = 0;
  let totalTokens = 0;
  for (const c of conversations) {
    if (c.id === rootId) continue;
    if (descendsFromRoot(c.id)) {
      count += 1;
      turnsCount += c.turns.length;
      for (const t of c.turns) {
        totalTokens += t.totalTokens;
      }
    }
  }
  return { count, turnsCount, totalTokens };
}

/**
 * Get live telemetry snapshot for Live and Trends views.
 */
export function getSnapshot({ surface = 'all', conversationId = null } = {}) {
  const nowMs = Date.now();
  const { conversations } = scanAllConversations();
  const filtered = conversations.filter((c) => matchesSurface(c, surface));

  const envConvId = process.env.ANTIGRAVITY_CONVERSATION_ID || null;
  let activeConv = null;
  if (conversationId) {
    activeConv =
      filtered.find((c) => c.id === conversationId) ||
      conversations.find((c) => c.id === conversationId);
  }
  if (!activeConv && envConvId) {
    activeConv = filtered.find((c) => c.id === envConvId);
  }
  if (!activeConv) {
    activeConv =
      filtered.find((c) => c.status === 'CASCADE_RUN_STATUS_RUNNING' && c.turns.length > 0 && !c.parentId) ||
      filtered.find((c) => c.turns.length > 0 && !c.parentId) ||
      filtered.find((c) => c.turns.length > 0) ||
      filtered[0] ||
      null;
  }

  let activeSession = null;
  if (activeConv) {
    const ctxState = resolveContextState(activeConv.turns);
    let streamOutTokens = 0;
    let streamDurSec = 0;
    let ttftSum = 0;
    let ttftCount = 0;
    let lastTps = 0;

    const totals = activeConv.turns.reduce(
      (acc, t) => {
        acc.inputTokens += t.inputTokens;
        acc.cacheReadTokens += t.cacheReadTokens;
        acc.cacheWriteTokens += t.cacheWriteTokens;
        acc.outputTokens += t.outputTokens;
        acc.thinkingTokens += t.thinkingTokens;
        acc.textTokens += t.textTokens;
        acc.totalTokens += t.totalTokens;
        const effSec = t.streamSec > 0.05 ? t.streamSec : t.latencySec > 0.05 ? t.latencySec : 0;
        if (t.outputTokens > 0 && effSec > 0 && effSec <= 3600) {
          streamOutTokens += t.outputTokens;
          streamDurSec += effSec;
        }
        if (t.ttftSec > 0 && t.ttftSec < 120) {
          ttftSum += t.ttftSec;
          ttftCount += 1;
        }
        if (t.tps > 0) {
          lastTps = t.tps;
        }
        return acc;
      },
      {
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        textTokens: 0,
        totalTokens: 0,
      }
    );

    const avgTps = streamDurSec > 0.05 ? Math.round((streamOutTokens / streamDurSec) * 10) / 10 : 0;
    const avgTtftSec = ttftCount > 0 ? Math.round((ttftSum / ttftCount) * 100) / 100 : 0;
    const subagents = collectDescendantStats(conversations, activeConv.id);

    activeSession = {
      id: activeConv.id,
      title: activeConv.title,
      project: activeConv.project,
      surface: activeConv.surface,
      status: activeConv.status,
      isCurrentEnv: Boolean(envConvId && activeConv.id === envConvId),
      turnsCount: activeConv.turns.length,
      stepCount: activeConv.stepCount,
      lastTps,
      avgTps,
      avgTtftSec,
      subagents,
      lastActiveMs: activeConv.lastActiveMs,
      ...ctxState,
      ...totals,
      cacheHitRate: computeCacheHitRate(totals.inputTokens, totals.cacheReadTokens),
      recentTurns: activeConv.turns
        .slice(-8)
        .reverse()
        .map((t) => ({
          idx: t.idx,
          timestampMs: t.timestampMs,
          modelLabel: t.modelLabel,
          family: t.family,
          inputTokens: t.inputTokens,
          cacheReadTokens: t.cacheReadTokens,
          cacheWriteTokens: t.cacheWriteTokens,
          cacheHitRate: computeCacheHitRate(t.inputTokens, t.cacheReadTokens),
          thinkingTokens: t.thinkingTokens,
          textTokens: t.textTokens,
          outputTokens: t.outputTokens,
          totalTokens: t.totalTokens,
          contextUsed: t.contextUsed,
          contextLimit: t.contextLimit,
          tps: t.tps,
          latencySec: Math.round(t.latencySec * 100) / 100,
          ttftSec: Math.round(t.ttftSec * 100) / 100,
        })),
    };
  }

  // Time boundaries: Today 00:00, Rolling 5h, and Calendar Week (Monday 00:00 -> Next Monday 00:00)
  const todayStart = new Date(nowMs);
  todayStart.setHours(0, 0, 0, 0);
  const todayStartMs = todayStart.getTime();

  const dayOfWeek = todayStart.getDay(); // 0=Sun, 1=Mon...
  const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const weekStartMs = todayStartMs - diffToMonday * 86_400_000;
  const weekResetAtMs = weekStartMs + 7 * 86_400_000;

  const cutoff5h = nowMs - WINDOW_5H_MS;
  const rolling5hBuckets = Array.from({ length: 5 }, (_, idx) => {
    const startMs = cutoff5h + idx * 3_600_000;
    const d = new Date(startMs);
    return {
      label: `${String(d.getHours()).padStart(2, '0')}:00`,
      totalTokens: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheHitRate: 0,
      turnsCount: 0,
      families: { gemini4: 0, flash: 0, claude: 0, other: 0 },
    };
  });

  const allTurns = [];
  const window5hTurns = [];
  const pool5hTurns = { gemini4: [], claude: [], flash: [], other: [] };

  const todaySessionIds = new Set();
  let todayTokens = 0;
  let todayInput = 0;
  let todayCacheRead = 0;
  let todayTurns = 0;
  let todayTtftSum = 0;
  let todayTtftCount = 0;
  let todayLatencySum = 0;
  let todayLatencyCount = 0;
  const todayByFamily = { gemini4: 0, flash: 0, claude: 0, other: 0 };

  let rolling5hTotal = 0;
  let rolling5hInput = 0;
  let rolling5hCacheRead = 0;
  let rolling5hTurns = 0;
  const rolling5hByFamily = { gemini4: 0, flash: 0, claude: 0, other: 0 };
  const rolling5hInputByFamily = { gemini4: 0, flash: 0, claude: 0, other: 0 };
  const rolling5hCacheByFamily = { gemini4: 0, flash: 0, claude: 0, other: 0 };
  const rolling5hTurnsByFamily = { gemini4: 0, flash: 0, claude: 0, other: 0 };

  const weekSessionIds = new Set();
  let calWeekTotal = 0;
  let calWeekInput = 0;
  let calWeekCacheRead = 0;
  let calWeekTurns = 0;
  const calWeekByFamily = { gemini4: 0, flash: 0, claude: 0, other: 0 };
  const calWeekInputByFamily = { gemini4: 0, flash: 0, claude: 0, other: 0 };
  const calWeekCacheByFamily = { gemini4: 0, flash: 0, claude: 0, other: 0 };
  const calWeekTurnsByFamily = { gemini4: 0, flash: 0, claude: 0, other: 0 };

  for (const conv of filtered) {
    for (const t of conv.turns) {
      allTurns.push(t);
      const fam = FAMILY_META[t.family] ? t.family : 'other';

      if (t.timestampMs >= todayStartMs) {
        todaySessionIds.add(conv.id);
        todayTokens += t.totalTokens;
        todayInput += t.inputTokens;
        todayCacheRead += t.cacheReadTokens;
        todayTurns += 1;
        todayByFamily[fam] += t.totalTokens;
        if (t.ttftSec > 0 && t.ttftSec < 120) {
          todayTtftSum += t.ttftSec;
          todayTtftCount += 1;
        }
        if (t.latencySec > 0 && t.latencySec < 600) {
          todayLatencySum += t.latencySec;
          todayLatencyCount += 1;
        }
      }

      if (t.timestampMs >= weekStartMs && t.timestampMs <= weekResetAtMs) {
        weekSessionIds.add(conv.id);
        calWeekTotal += t.totalTokens;
        calWeekInput += t.inputTokens;
        calWeekCacheRead += t.cacheReadTokens;
        calWeekTurns += 1;
        calWeekByFamily[fam] += t.totalTokens;
        calWeekInputByFamily[fam] += t.inputTokens;
        calWeekCacheByFamily[fam] += t.cacheReadTokens;
        calWeekTurnsByFamily[fam] += 1;
      }

      if (t.timestampMs >= cutoff5h && t.timestampMs <= nowMs + 60_000) {
        rolling5hTotal += t.totalTokens;
        rolling5hInput += t.inputTokens;
        rolling5hCacheRead += t.cacheReadTokens;
        rolling5hTurns += 1;
        rolling5hByFamily[fam] += t.totalTokens;
        rolling5hInputByFamily[fam] += t.inputTokens;
        rolling5hCacheByFamily[fam] += t.cacheReadTokens;
        rolling5hTurnsByFamily[fam] += 1;
        window5hTurns.push(t);
        pool5hTurns[fam].push(t);
        const bucketIdx = Math.min(4, Math.max(0, Math.floor((t.timestampMs - cutoff5h) / 3_600_000)));
        rolling5hBuckets[bucketIdx].totalTokens += t.totalTokens;
        rolling5hBuckets[bucketIdx].inputTokens += t.inputTokens;
        rolling5hBuckets[bucketIdx].cacheReadTokens += t.cacheReadTokens;
        rolling5hBuckets[bucketIdx].turnsCount += 1;
        rolling5hBuckets[bucketIdx].families[fam] =
          (rolling5hBuckets[bucketIdx].families[fam] || 0) + t.totalTokens;
      }
    }
  }

  for (const b of rolling5hBuckets) {
    b.cacheHitRate = computeCacheHitRate(b.inputTokens, b.cacheReadTokens);
  }

  const mini7d = buildDailyBuckets(allTurns, 7, nowMs);
  const weekByFamily = { gemini4: 0, flash: 0, claude: 0, other: 0 };
  let weekTotalTokens = 0;
  for (const day of mini7d) {
    weekTotalTokens += day.totalTokens;
    for (const k of Object.keys(weekByFamily)) {
      weekByFamily[k] += day.families[k] || 0;
    }
  }

  const poolKeys = ['gemini4', 'claude', 'flash'];
  if (rolling5hByFamily.other > 0 || calWeekByFamily.other > 0 || todayByFamily.other > 0) {
    poolKeys.push('other');
  }
  const quotaPools = poolKeys.map((key) => {
    const meta = FAMILY_META[key];
    return {
      key,
      label: meta.label,
      poolLabel: meta.poolLabel,
      tokens5h: rolling5hByFamily[key] || 0,
      turns5h: rolling5hTurnsByFamily[key] || 0,
      cacheHit5h: computeCacheHitRate(rolling5hInputByFamily[key] || 0, rolling5hCacheByFamily[key] || 0),
      tokensPerHour5h: Math.round((rolling5hByFamily[key] || 0) / 5),
      rolloff5h: compute5hRolloff(pool5hTurns[key], nowMs),
      tokensWeek: calWeekByFamily[key] || 0,
      turnsWeek: calWeekTurnsByFamily[key] || 0,
      cacheHitWeek: computeCacheHitRate(calWeekInputByFamily[key] || 0, calWeekCacheByFamily[key] || 0),
      tokensToday: todayByFamily[key] || 0,
    };
  });

  const recentSessions = filtered
    .filter((c) => c.turns.length > 0 && !c.parentId)
    .slice(0, 20)
    .map((c) => {
      const ctx = resolveContextState(c.turns);
      const total = c.turns.reduce((sum, t) => sum + t.totalTokens, 0);
      return {
        id: c.id,
        title: c.title,
        project: c.project,
        surface: c.surface,
        status: c.status,
        isCurrentEnv: Boolean(envConvId && c.id === envConvId),
        modelLabel: ctx.modelLabel,
        contextPct: ctx.contextPct,
        totalTokens: total,
        turnsCount: c.turns.length,
        stepCount: c.stepCount,
        lastActiveMs: c.lastActiveMs,
      };
    });

  if (activeSession && !recentSessions.some((s) => s.id === activeSession.id)) {
    recentSessions.unshift({
      id: activeSession.id,
      title: activeSession.title,
      project: activeSession.project,
      surface: activeSession.surface,
      status: activeSession.status,
      isCurrentEnv: activeSession.isCurrentEnv,
      modelLabel: activeSession.modelLabel,
      contextPct: activeSession.contextPct,
      totalTokens: activeSession.totalTokens,
      turnsCount: activeSession.turnsCount,
      stepCount: activeSession.stepCount,
      lastActiveMs: activeSession.lastActiveMs,
    });
  }

  const surfaceCounts = {
    all: conversations.filter((c) => !c.parentId).length || conversations.length,
    desktop: conversations.filter((c) => c.surface === 'desktop' && !c.parentId).length,
    cli: conversations.filter((c) => c.surface === 'cli' && !c.parentId).length,
  };

  return {
    syncedAt: nowMs,
    surface,
    surfaceCounts,
    activeSession,
    recentSessions,
    today: {
      totalTokens: todayTokens,
      cacheReadTokens: todayCacheRead,
      inputTokens: todayInput,
      cacheHitRate: computeCacheHitRate(todayInput, todayCacheRead),
      sessionsCount: todaySessionIds.size,
      turnsCount: todayTurns,
      avgTtftSec: todayTtftCount > 0 ? Math.round((todayTtftSum / todayTtftCount) * 100) / 100 : 0,
      avgLatencySec:
        todayLatencyCount > 0 ? Math.round((todayLatencySum / todayLatencyCount) * 100) / 100 : 0,
    },
    rolling5h: {
      totalTokens: rolling5hTotal,
      inputTokens: rolling5hInput,
      cacheReadTokens: rolling5hCacheRead,
      cacheHitRate: computeCacheHitRate(rolling5hInput, rolling5hCacheRead),
      turnsCount: rolling5hTurns,
      tokensPerHour: Math.round(rolling5hTotal / 5),
      buckets: rolling5hBuckets,
      byFamily: rolling5hByFamily,
      rolloff: compute5hRolloff(window5hTurns, nowMs),
    },
    calendarWeek: {
      startMs: weekStartMs,
      resetAtMs: weekResetAtMs,
      resetInSec: Math.max(0, Math.round((weekResetAtMs - nowMs) / 1000)),
      totalTokens: calWeekTotal,
      inputTokens: calWeekInput,
      cacheReadTokens: calWeekCacheRead,
      cacheHitRate: computeCacheHitRate(calWeekInput, calWeekCacheRead),
      turnsCount: calWeekTurns,
      sessionsCount: weekSessionIds.size,
      byFamily: calWeekByFamily,
    },
    quotaPools,
    weekSummary: {
      totalTokens: weekTotalTokens,
      byFamily: weekByFamily,
    },
    mini7d,
    familyMeta: Object.values(FAMILY_META),
  };
}

/**
 * Compute multi-day analytics and model/project/session drill-downs.
 */
export function getAnalytics({ surface = 'all', days = 7, family = 'all' } = {}) {
  const safeDays = days === 30 ? 30 : days === 14 ? 14 : 7;
  const nowMs = Date.now();
  const { conversations } = scanAllConversations();
  const filteredConvs = conversations.filter((c) => matchesSurface(c, surface));

  const todayMidnight = new Date(nowMs);
  todayMidnight.setHours(0, 0, 0, 0);
  const cutoffMs = todayMidnight.getTime() - (safeDays - 1) * 86_400_000;

  const matchingTurns = [];
  const sessionIds = new Set();
  const byModelMap = new Map();
  const byProjectMap = new Map();
  const bySessionList = [];
  const byFamily = { gemini4: 0, flash: 0, claude: 0, other: 0 };

  let totalTokens = 0;
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let thinkingTokens = 0;
  let ttftSum = 0;
  let ttftCount = 0;

  for (const conv of filteredConvs) {
    let sessTokens = 0;
    let sessInput = 0;
    let sessCacheRead = 0;
    let sessTurns = 0;
    let sessModel = '';

    for (const t of conv.turns) {
      if (t.timestampMs < cutoffMs) continue;
      if (family && family !== 'all' && t.family !== family) continue;

      matchingTurns.push(t);
      sessionIds.add(conv.id);
      totalTokens += t.totalTokens;
      inputTokens += t.inputTokens;
      cacheReadTokens += t.cacheReadTokens;
      outputTokens += t.outputTokens;
      thinkingTokens += t.thinkingTokens;
      byFamily[t.family] = (byFamily[t.family] || 0) + t.totalTokens;
      if (t.ttftSec > 0 && t.ttftSec < 120) {
        ttftSum += t.ttftSec;
        ttftCount += 1;
      }

      // By Model
      const mEntry = byModelMap.get(t.modelLabel) || {
        name: t.modelLabel,
        family: t.family,
        totalTokens: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        streamOutTokens: 0,
        streamDurSec: 0,
        turnsCount: 0,
      };
      mEntry.totalTokens += t.totalTokens;
      mEntry.inputTokens += t.inputTokens;
      mEntry.cacheReadTokens += t.cacheReadTokens;
      mEntry.outputTokens += t.outputTokens;
      mEntry.thinkingTokens += t.thinkingTokens;
      const effSec = t.streamSec > 0.05 ? t.streamSec : t.latencySec > 0.05 ? t.latencySec : 0;
      if (t.outputTokens > 0 && effSec > 0 && effSec <= 3600) {
        mEntry.streamOutTokens += t.outputTokens;
        mEntry.streamDurSec += effSec;
      }
      mEntry.turnsCount += 1;
      byModelMap.set(t.modelLabel, mEntry);

      // By Project
      const pEntry = byProjectMap.get(conv.project) || {
        name: conv.project,
        totalTokens: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        turnsCount: 0,
        sessions: new Set(),
      };
      pEntry.totalTokens += t.totalTokens;
      pEntry.inputTokens += t.inputTokens;
      pEntry.cacheReadTokens += t.cacheReadTokens;
      pEntry.turnsCount += 1;
      pEntry.sessions.add(conv.id);
      byProjectMap.set(conv.project, pEntry);

      sessTokens += t.totalTokens;
      sessInput += t.inputTokens;
      sessCacheRead += t.cacheReadTokens;
      sessTurns += 1;
      sessModel = t.modelLabel;
    }

    if (sessTurns > 0) {
      bySessionList.push({
        id: conv.id,
        title: conv.title,
        project: conv.project,
        surface: conv.surface,
        modelLabel: sessModel,
        totalTokens: sessTokens,
        cacheReadTokens: sessCacheRead,
        turnsCount: sessTurns,
        stepCount: conv.stepCount,
        cacheHitRate: computeCacheHitRate(sessInput, sessCacheRead),
        lastActiveMs: conv.lastActiveMs,
      });
    }
  }

  const daily = buildDailyBuckets(matchingTurns, safeDays, nowMs);
  const byModel = Array.from(byModelMap.values())
    .map((m) => ({
      name: m.name,
      family: m.family,
      totalTokens: m.totalTokens,
      inputTokens: m.inputTokens,
      cacheReadTokens: m.cacheReadTokens,
      outputTokens: m.outputTokens,
      thinkingTokens: m.thinkingTokens,
      turnsCount: m.turnsCount,
      avgTps: m.streamDurSec > 0.05 ? Math.round((m.streamOutTokens / m.streamDurSec) * 10) / 10 : 0,
      cacheHitRate: computeCacheHitRate(m.inputTokens, m.cacheReadTokens),
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const byProject = Array.from(byProjectMap.values())
    .map((p) => ({
      name: p.name,
      totalTokens: p.totalTokens,
      cacheReadTokens: p.cacheReadTokens,
      turnsCount: p.turnsCount,
      sessionsCount: p.sessions.size,
      cacheHitRate: computeCacheHitRate(p.inputTokens, p.cacheReadTokens),
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  bySessionList.sort((a, b) => b.totalTokens - a.totalTokens);

  return {
    surface,
    days: safeDays,
    family,
    daily,
    totals: {
      totalTokens,
      inputTokens,
      cacheReadTokens,
      outputTokens,
      thinkingTokens,
      cacheHitRate: computeCacheHitRate(inputTokens, cacheReadTokens),
      turnsCount: matchingTurns.length,
      sessionsCount: sessionIds.size,
      avgTtftSec: ttftCount > 0 ? Math.round((ttftSum / ttftCount) * 100) / 100 : 0,
    },
    byFamily,
    byModel: byModel.slice(0, 25),
    byProject: byProject.slice(0, 25),
    bySession: bySessionList.slice(0, 30),
  };
}

/**
 * Return local SQLite discovery and parser health metrics.
 */
export function getDiagnostics() {
  const { diagnostics } = scanAllConversations();
  return diagnostics;
}
