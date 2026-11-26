import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';

const state = {
  activeTab: 'live',
  surface: 'all',
  selectedSessionId: null,
  privacyMask: false,
  analyticsDays: 7,
  analyticsFamily: 'all',
  drillMode: 'model',
  selectedChartDayIdx: null,
  openFolds: new Set(),
  snapshot: null,
  analytics: null,
  diagnostics: null,
  loadingSnapshot: false,
  loadingAnalytics: false,
  loadingDiagnostics: false,
  errorText: '',
};

const FAMILY_LABELS = {
  gemini4: 'Gemini 4',
  claude: 'Claude',
  flash: 'Flash / Subagent',
  other: 'Other',
};

const TAB_ORDER = ['live', 'trends'];

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function fmtExact(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  return Math.round(n).toLocaleString('en-US');
}

function fmtSec(s) {
  if (!Number.isFinite(s) || s <= 0) return '—';
  return s >= 10 ? `${s.toFixed(1)}s` : `${s.toFixed(2)}s`;
}

function fmtTps(tps) {
  if (!Number.isFinite(tps) || tps <= 0) return '—';
  return `${tps >= 100 ? Math.round(tps) : tps.toFixed(1)} tok/s`;
}

function calcCacheHitPct(inputTokens, cacheReadTokens, precomputed) {
  if (Number.isFinite(precomputed)) return precomputed;
  const denom = (Number(inputTokens) || 0) + (Number(cacheReadTokens) || 0);
  if (denom <= 0) return 0;
  return Math.round(((Number(cacheReadTokens) || 0) / denom) * 1000) / 10;
}

function fmtRelativeTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '未知';
  const diffSec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (diffSec < 45) return '刚刚';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m 前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h 前`;
  return `${Math.floor(diffSec / 86400)}d 前`;
}

function fmtCountdownMs(deltaMs) {
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return '即将更新';
  const totalSec = Math.max(1, Math.round(deltaMs / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours < 24) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

function maskText(text, fallbackLabel = '已隐藏') {
  if (!state.privacyMask) return text;
  if (!text) return fallbackLabel;
  return `${text.slice(0, 2)}•••`;
}

function normalizeTabName(raw) {
  return raw === 'trends' ? 'trends' : 'live';
}

function applyHostThemeContext(ctx) {
  if (!ctx) return;
  if (ctx.theme) {
    applyDocumentTheme(ctx.theme);
    document.documentElement.style.colorScheme = ctx.theme;
  }
  if (ctx.styles?.variables) {
    applyHostStyleVariables(ctx.styles.variables);
  }
  if (ctx.styles?.css?.fonts) {
    applyHostFonts(ctx.styles.css.fonts);
  }
}

function buildMiniRingSvg(pct, alertLevel) {
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
  const r = 14;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - clamped / 100);
  const strokeCls =
    alertLevel === 'danger' ? 'ring-fill danger' : alertLevel === 'warn' ? 'ring-fill warn' : 'ring-fill';

  return `
    <div class="ring-mini" aria-hidden="true">
      <svg viewBox="0 0 36 36">
        <circle class="ring-track" cx="18" cy="18" r="${r}" stroke-width="3.6" />
        <circle class="${strokeCls}" cx="18" cy="18" r="${r}" stroke-width="3.6"
          stroke-dasharray="${circ.toFixed(2)}"
          stroke-dashoffset="${offset.toFixed(2)}" />
      </svg>
      <div class="ring-mini-center num">${Math.round(clamped)}%</div>
    </div>
  `;
}

function buildStackedChart(buckets, { selectedIdx = null, familyFilter = 'all', clickable = false } = {}) {
  if (!buckets || buckets.length === 0) {
    return '<div class="empty-state">暂无统计周期内的消耗记录</div>';
  }

  const maxTotal = Math.max(
    1,
    ...buckets.map((b) => {
      if (familyFilter !== 'all') return b.families?.[familyFilter] || 0;
      return b.totalTokens || 0;
    })
  );

  const cols = buckets.length;
  const familyOrder = ['gemini4', 'claude', 'flash', 'other'];

  const itemsHtml = buckets
    .map((b, idx) => {
      const value = familyFilter !== 'all' ? b.families?.[familyFilter] || 0 : b.totalTokens || 0;
      const heightPct = value > 0 ? Math.max(4, Math.round((value / maxTotal) * 100)) : 0;
      const segs = familyOrder
        .filter((f) => familyFilter === 'all' || familyFilter === f)
        .map((f) => {
          const fv = b.families?.[f] || 0;
          if (fv <= 0 || value <= 0) return '';
          const segPct = Math.max(2, (fv / value) * 100);
          return `<span class="bar-seg swatch-${f}" style="height:${segPct.toFixed(1)}%"></span>`;
        })
        .join('');

      const showLabel = cols <= 7 || idx === 0 || idx === cols - 1 || idx % Math.ceil(cols / 6) === 0;
      const isSelected = clickable && selectedIdx === idx;
      const dayHitPct = calcCacheHitPct(b.inputTokens, b.cacheReadTokens, b.cacheHitRate);
      const titleTip = `${b.dateLabel || b.label}: ${fmtTokens(value)} tokens (${b.turnsCount || 0} 轮 · 缓存 ${fmtTokens(b.cacheReadTokens)} (命中${dayHitPct}%))`;

      return `
        <button type="button" class="bar-col ${isSelected ? 'selected' : ''}"
          data-day-idx="${idx}" title="${esc(titleTip)}" ${clickable ? '' : 'tabindex="-1"'}>
          <span class="bar-stack" style="height:${heightPct}%">${segs}</span>
          <span class="bar-label">${showLabel ? esc(b.label) : '&nbsp;'}</span>
        </button>
      `;
    })
    .join('');

  return `<div class="stacked-chart" style="grid-template-columns: repeat(${cols}, minmax(0, 1fr))">${itemsHtml}</div>`;
}

function renderTopToolbar() {
  const snap = state.snapshot;
  const active = snap?.activeSession;
  const syncEl = document.getElementById('sync-label');
  const dotEl = document.getElementById('status-dot');
  const selectEl = document.getElementById('session-select');
  const privacyBtn = document.getElementById('btn-privacy');

  if (privacyBtn) {
    privacyBtn.setAttribute('aria-pressed', String(state.privacyMask));
    privacyBtn.title = state.privacyMask ? '已开启隐私脱敏（点击恢复显示）' : '切换项目与会话名称隐私脱敏';
  }

  document.querySelectorAll('.pill-btn[data-surface]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.surface === state.surface));
  });

  if (snap) {
    const counts = snap.surfaceCounts || {};
    document.getElementById('count-all').textContent = counts.all ?? '';
    document.getElementById('count-desktop').textContent = counts.desktop ?? '';
    document.getElementById('count-cli').textContent = counts.cli ?? '';
    syncEl.textContent = fmtRelativeTime(snap.syncedAt);
  } else if (state.errorText) {
    syncEl.textContent = '离线';
  }

  if (dotEl) {
    dotEl.className = 'sync-dot';
    if (state.errorText) dotEl.classList.add('offline');
    else if (active?.status === 'CASCADE_RUN_STATUS_RUNNING') dotEl.classList.add('running');
  }

  // Avoid clobbering <select> while user is actively interacting with it
  if (selectEl && document.activeElement !== selectEl) {
    const sessions = snap?.recentSessions || [];
    if (sessions.length > 0 && active) {
      selectEl.disabled = false;
      selectEl.innerHTML = sessions
        .map((s) => {
          const prefix = s.isCurrentEnv ? '[当前] ' : s.surface === 'cli' ? '[CLI] ' : '';
          const proj = maskText(s.project, '项目');
          const title = maskText(s.title, '会话');
          const label = `${prefix}${proj} · ${title} (${s.contextPct}%)`;
          const selected = s.id === active.id ? 'selected' : '';
          return `<option value="${esc(s.id)}" ${selected}>${esc(label)}</option>`;
        })
        .join('');
    } else {
      selectEl.disabled = true;
      selectEl.innerHTML = `<option value="">${esc(state.errorText || '当前过滤下暂无会话记录')}</option>`;
    }
  }
}

function renderLive() {
  const root = document.getElementById('body-live');
  const snap = state.snapshot;
  if (!snap) {
    root.innerHTML = `<div class="card empty-state">${esc(state.errorText || '正在只读扫描本地 Antigravity 会话库…')}</div>`;
    return;
  }

  const nowMs = Date.now();
  const active = snap.activeSession;
  const today = snap.today;
  const r5 = snap.rolling5h;
  const calWeek = snap.calendarWeek || {
    resetAtMs: nowMs + 86_400_000,
    totalTokens: snap.weekSummary?.totalTokens || 0,
    turnsCount: 0,
    sessionsCount: 0,
  };
  const pools = snap.quotaPools || [];

  // 1. Top DSH-style Live Strip (when an active session exists)
  let stripHtml = '';
  let ctxCardHtml = '';

  if (active) {
    const stepCount = active.stepCount || active.turnsCount;
    const primaryTps = active.lastTps > 0 ? fmtTps(active.lastTps) : fmtTps(active.avgTps);
    const subSpeed =
      active.avgTps > 0
        ? `均值 ${fmtTps(active.avgTps)} · TTFT ${fmtSec(active.avgTtftSec)}`
        : `平均首字 TTFT ${fmtSec(active.avgTtftSec)}`;
    const ctxToneCls =
      active.alertLevel === 'danger'
        ? 'strip-danger'
        : active.alertLevel === 'warn'
          ? 'strip-warn'
          : 'strip-accent';

    stripHtml = `
      <section class="live-strip" aria-label="当前会话核心指标">
        <div class="strip-cell">
          <div class="strip-copy">
            <div class="strip-primary num">
              <span>${active.turnsCount} 轮 ${stepCount} 步</span>
              <span>·</span>
              <span class="strip-accent">${esc(primaryTps)}</span>
            </div>
            <div class="strip-sub num">${esc(subSpeed)}</div>
          </div>
        </div>

        <div class="strip-cell">
          <div class="strip-copy">
            <div class="strip-primary num">
              <span>${fmtTokens(active.totalTokens)} tok</span>
              <span>·</span>
              <span class="strip-ok">缓存 ${active.cacheHitRate}%</span>
            </div>
            <div class="strip-sub num">未命中 ${fmtTokens(active.inputTokens)} · 读取 ${fmtTokens(active.cacheReadTokens)}</div>
          </div>
        </div>

        <div class="strip-cell">
          <div class="strip-copy">
            <div class="strip-primary num">
              <span>上下文</span>
              <span class="${ctxToneCls}">${active.contextPct}%</span>
            </div>
            <div class="strip-sub num">${fmtTokens(active.contextUsed)} / ${fmtTokens(active.contextLimit)}</div>
          </div>
          ${buildMiniRingSvg(active.contextPct, active.alertLevel)}
        </div>
      </section>
    `;

    // Context Window + Inline Breakdown Card
    const remaining = Math.max(0, active.contextLimit - active.contextUsed);
    const clampedPct = Math.max(0, Math.min(100, Number(active.contextPct) || 0));
    const meterFillCls =
      active.alertLevel === 'danger'
        ? 'ctx-meter-fill danger'
        : active.alertLevel === 'warn'
          ? 'ctx-meter-fill warn'
          : 'ctx-meter-fill';

    const statusBadgeCls =
      active.alertLevel === 'danger'
        ? 'badge-pill danger'
        : active.alertLevel === 'warn'
          ? 'badge-pill warn'
          : 'badge-pill accent';
    const statusBadgeText =
      active.alertLevel === 'danger'
        ? '建议立即压缩'
        : active.alertLevel === 'warn'
          ? '接近高水位'
          : `余量 ${fmtTokens(remaining)}`;

    const compactNoticeCls =
      active.alertLevel === 'danger'
        ? 'compact-notice danger'
        : active.alertLevel === 'warn'
          ? 'compact-notice warn'
          : 'compact-notice';
    const compactNoticeHtml =
      active.alertLevel === 'danger'
        ? `<div class="${compactNoticeCls}" role="note">上下文已达高水位（${active.contextPct}%）：请在聊天输入框输入 <code class="cmd-chip">/compact</code> 并从命令菜单选择，以压缩历史释放空间。</div>`
        : active.alertLevel === 'warn'
          ? `<div class="${compactNoticeCls}" role="note">上下文已超过预警线（${active.contextPct}%）：可在聊天输入框输入 <code class="cmd-chip">/compact</code> 并从命令菜单选择以提前释放空间。</div>`
          : `<div class="${compactNoticeCls}" role="note">需要释放上下文时，请在聊天输入框输入 <code class="cmd-chip">/compact</code> 并从命令菜单选择执行。</div>`;

    const composedTotal = Math.max(
      1,
      active.cacheReadTokens +
        active.inputTokens +
        (active.cacheWriteTokens || 0) +
        active.thinkingTokens +
        active.textTokens
    );

    const breakdownItems = [
      { label: '缓存读取', val: active.cacheReadTokens, color: 'var(--ok)' },
      { label: '未命中输入', val: active.inputTokens, color: 'var(--accent)' },
      ...(active.cacheWriteTokens > 0
        ? [{ label: '缓存写入', val: active.cacheWriteTokens, color: 'var(--write-tone)' }]
        : []),
      { label: '思考推理', val: active.thinkingTokens, color: 'var(--warn)' },
      { label: '可见输出', val: active.textTokens, color: 'var(--fg-muted)' },
    ];

    const segsHtml = breakdownItems
      .map((item) => {
        if (item.val <= 0) return '';
        const pct = Math.max(1, (item.val / composedTotal) * 100);
        return `<span class="progress-seg" style="width:${pct.toFixed(1)}%; background:${item.color}"></span>`;
      })
      .join('');

    const compGridHtml = breakdownItems
      .map((item) => {
        const pct = Math.round((item.val / composedTotal) * 1000) / 10;
        return `
          <div class="comp-item">
            <span class="kv-name"><span class="swatch" style="background:${item.color}"></span>${esc(item.label)}</span>
            <span class="kv-val num">${fmtExact(item.val)}<span class="kv-pct">${pct}%</span></span>
          </div>
        `;
      })
      .join('');

    const subagentHtml =
      active.subagents && active.subagents.count > 0
        ? `
          <div class="subagent-strip num">
            <span>关联子代理 (${active.subagents.count} 会话 · ${active.subagents.turnsCount} 轮)</span>
            <span class="kv-val">额外 ${fmtTokens(active.subagents.totalTokens)} tok</span>
          </div>
        `
        : '';

    const turnsOpenAttr = state.openFolds.has('turns') ? 'open' : '';
    const turnsRowsHtml = (active.recentTurns || [])
      .map((t) => {
        const speedPart = t.tps > 0 ? `${fmtTps(t.tps)} · ` : '';
        const turnHitPct = calcCacheHitPct(t.inputTokens, t.cacheReadTokens, t.cacheHitRate);
        return `
          <div class="list-item">
            <div class="list-item-top">
              <span class="list-item-title" title="${esc(t.modelLabel)}">#${t.idx} · ${esc(t.modelLabel)}</span>
              <span class="kv-val num">${fmtTokens(t.totalTokens)}</span>
            </div>
            <div class="list-item-sub num">
              <span>未命中 ${fmtTokens(t.inputTokens)} · 缓存 ${fmtTokens(t.cacheReadTokens)} (命中${turnHitPct}%) · 输出 ${fmtTokens(t.outputTokens)}</span>
              <span>${esc(speedPart)}TTFT ${fmtSec(t.ttftSec)} / ${fmtSec(t.latencySec)}</span>
            </div>
          </div>
        `;
      })
      .join('');

    const compactionsOpenAttr = state.openFolds.has('compactions') ? 'open' : '';
    const compactionsFoldHtml =
      active.compactionEvents?.length > 0
        ? `
          <details class="inline-fold" data-fold-id="compactions" ${compactionsOpenAttr}>
            <summary>上下文压缩 / 回落记录（${active.compactionEvents.length} 次）</summary>
            <div class="list-stack">
              ${active.compactionEvents
                .slice(-4)
                .reverse()
                .map(
                  (ev) => `
                  <div class="list-item">
                    <div class="list-item-top">
                      <span class="list-item-title">Turn #${ev.turnIdx} 窗口收缩</span>
                      <span class="metric-note num">-${fmtTokens(ev.savedTokens)}</span>
                    </div>
                    <div class="list-item-sub num">
                      <span>${fmtTokens(ev.beforeTokens)} → ${fmtTokens(ev.afterTokens)}</span>
                      <span>${fmtRelativeTime(ev.timestampMs)}</span>
                    </div>
                  </div>`
                )
                .join('')}
            </div>
          </details>
        `
        : '';

    ctxCardHtml = `
      <section class="card">
        <div class="card-head">
          <div class="card-title-group">
            <span class="card-title">当前上下文</span>
            <span class="badge-pill" title="${esc(active.modelLabel)}">${esc(active.modelLabel)}</span>
          </div>
          <span class="${statusBadgeCls} num">${esc(statusBadgeText)}</span>
        </div>

        <div class="ctx-summary-row">
          <div class="ctx-numbers">
            <div class="metric-big num">${fmtExact(active.contextUsed)} <span class="metric-sub">/ ${fmtExact(active.contextLimit)} tok (${active.contextPct}% · 剩余 ${fmtTokens(remaining)})</span></div>
          </div>
        </div>

        <div class="ctx-meter-track" role="progressbar" aria-valuenow="${Math.round(clampedPct)}" aria-valuemin="0" aria-valuemax="100" aria-label="上下文窗口占用百分比">
          <div class="${meterFillCls}" style="width:${clampedPct.toFixed(1)}%"></div>
          <span class="ctx-tick" style="left:75%" title="75% 预警线"></span>
          <span class="ctx-tick" style="left:90%" title="90% 压缩线"></span>
        </div>
        ${compactNoticeHtml}

        <div class="section-divider"></div>

        <div class="comp-head">
          <span>会话累计 Token 构成 · <strong class="strip-ok num">缓存命中 ${active.cacheHitRate}%</strong></span>
          <span class="kv-val num">${fmtExact(active.totalTokens)} tok</span>
        </div>
        <div class="progress-track" aria-hidden="true">${segsHtml}</div>
        <div class="comp-grid">${compGridHtml}</div>
        ${subagentHtml}

        <details class="inline-fold" data-fold-id="turns" ${turnsOpenAttr}>
          <summary>最近生成轮次明细（${active.recentTurns?.length || 0} 轮）</summary>
          <div class="list-stack">${turnsRowsHtml || '<div class="empty-state">暂无生成轮次</div>'}</div>
        </details>
        ${compactionsFoldHtml}
      </section>
    `;
  } else {
    ctxCardHtml = `
      <section class="card">
        <div class="card-head"><span class="card-title">当前上下文</span></div>
        <div class="empty-state">当前过滤条件下暂无会话记录</div>
      </section>
    `;
  }

  // 2. Quota & Window Consumption Card (5h Rolling + Calendar Week + Per-Pool Ledger)
  const max5hBar = Math.max(1, ...(r5.buckets || []).map((b) => b.totalTokens || 0));
  const bars5hHtml = (r5.buckets || [])
    .map((b) => {
      const hPct = b.totalTokens > 0 ? Math.max(12, Math.round((b.totalTokens / max5hBar) * 100)) : 4;
      const bHitPct = calcCacheHitPct(b.inputTokens, b.cacheReadTokens, b.cacheHitRate);
      return `
        <div class="mini-col" title="${esc(b.label)}：${fmtTokens(b.totalTokens)} tok (${b.turnsCount} 轮 · 缓存 ${bHitPct}%)">
          <div class="mini-bar-track">
            <span class="mini-bar-fill ${b.totalTokens === 0 ? 'empty' : ''}" style="height:${hPct}%"></span>
          </div>
          <span class="mini-bar-lbl num">${esc(b.label)}</span>
        </div>
      `;
    })
    .join('');

  const rolloff = r5.rolloff;
  const rolloffTextHtml =
    rolloff && rolloff.active && rolloff.nextRolloffAtMs > nowMs
      ? `
        <div class="rolloff-row num">
          <span>5h 窗口回血：<strong class="rolloff-tag">${fmtCountdownMs(rolloff.nextRolloffAtMs - nowMs)}</strong> 后滑出最早一批 <strong>${fmtTokens(rolloff.nextRolloffTokens)}</strong></span>
          <span class="metric-sub">全清需 ${fmtCountdownMs(rolloff.fullClearAtMs - nowMs)}</span>
        </div>
      `
      : `
        <div class="rolloff-row">
          <span class="metric-note">近 5 小时窗口无消耗（全池空闲）</span>
          <span class="metric-sub">仅统计本地真实账本</span>
        </div>
      `;

  const poolRowsHtml = pools
    .map((p) => {
      const pRoll = p.rolloff5h;
      const sub5h =
        p.tokens5h > 0 && pRoll?.active && pRoll.nextRolloffAtMs > nowMs
          ? `${fmtCountdownMs(pRoll.nextRolloffAtMs - nowMs)} 后退 ${fmtTokens(pRoll.nextRolloffTokens)}`
          : p.turns5h > 0
            ? `${p.turns5h} 轮`
            : '5h 空闲';
      const subWeek =
        p.turnsWeek > 0
          ? `${p.turnsWeek} 轮 · 缓存 ${p.cacheHitWeek ?? 0}%`
          : '本周无消耗';

      return `
        <div class="pool-row">
          <span class="pool-name" title="${esc(p.poolLabel)}">
            <span class="swatch swatch-${esc(p.key)}"></span>
            <span>${esc(p.label)}</span>
          </span>
          <div class="num">
            <div class="pool-cell-main">${fmtTokens(p.tokens5h)}</div>
            <div class="pool-cell-sub">${esc(sub5h)}</div>
          </div>
          <div class="num">
            <div class="pool-cell-main">${fmtTokens(p.tokensWeek)}</div>
            <div class="pool-cell-sub">${esc(subWeek)}</div>
          </div>
        </div>
      `;
    })
    .join('');

  const weekResetText = `周一重置 · 剩 ${fmtCountdownMs(calWeek.resetAtMs - nowMs)}`;

  const quotaCardHtml = `
    <section class="card">
      <div class="card-head">
        <div class="card-title-group">
          <span class="card-title">额度与窗口消耗</span>
        </div>
        <span class="badge-pill num" title="自然周统计自本地时间周一 00:00 起">${esc(weekResetText)}</span>
      </div>

      <div class="window-kpis">
        <div class="kpi-tile">
          <span class="kpi-label">近 5h 已用</span>
          <span class="kpi-val num">${fmtTokens(r5.totalTokens)}</span>
          <span class="kpi-sub num">缓存 ${r5.cacheHitRate ?? 0}% · ${fmtTokens(r5.tokensPerHour)}/h</span>
        </div>
        <div class="kpi-tile">
          <span class="kpi-label">本周已用</span>
          <span class="kpi-val num">${fmtTokens(calWeek.totalTokens)}</span>
          <span class="kpi-sub num">缓存 ${calWeek.cacheHitRate ?? 0}% · ${calWeek.turnsCount} 轮</span>
        </div>
        <div class="kpi-tile">
          <span class="kpi-label">今日已用</span>
          <span class="kpi-val num">${fmtTokens(today.totalTokens)}</span>
          <span class="kpi-sub num">缓存 ${today.cacheHitRate}% · ${fmtSec(today.avgTtftSec)}</span>
        </div>
      </div>

      <div class="rolloff-box">
        ${rolloffTextHtml}
        <div class="mini-5h-bars">${bars5hHtml}</div>
      </div>

      <div class="pool-ledger">
        <div class="pool-head">
          <span>独立模型池</span>
          <span>近 5h 已用 / 回血</span>
          <span>本周累计</span>
        </div>
        ${poolRowsHtml}
      </div>
    </section>
  `;

  root.innerHTML = `${stripHtml}<div class="live-grid">${ctxCardHtml}${quotaCardHtml}</div>`;
}

function renderTrends() {
  const root = document.getElementById('body-trends');
  if (state.loadingAnalytics && !state.analytics) {
    root.innerHTML = '<div class="card empty-state">正在聚合多日消耗明细…</div>';
    return;
  }

  const data = state.analytics;
  if (!data) {
    root.innerHTML = '<div class="card empty-state">切换至此视图自动加载多日趋势分析</div>';
    return;
  }

  const dayButtons = [7, 14, 30]
    .map(
      (d) =>
        `<button type="button" class="sub-pill" data-days="${d}" aria-pressed="${state.analyticsDays === d}">${d}天</button>`
    )
    .join('');

  const legendFilters = ['all', 'gemini4', 'claude', 'flash']
    .map((f) => {
      const label = f === 'all' ? '全部模型' : FAMILY_LABELS[f];
      const dot = f === 'all' ? '' : `<span class="swatch swatch-${f}"></span>`;
      return `<button type="button" class="legend-item" data-family="${f}" aria-pressed="${state.analyticsFamily === f}">${dot}${esc(label)}</button>`;
    })
    .join('');

  const selectedDay =
    state.selectedChartDayIdx !== null && data.daily[state.selectedChartDayIdx]
      ? data.daily[state.selectedChartDayIdx]
      : data.daily[data.daily.length - 1];

  const selectedDayHitPct = selectedDay
    ? calcCacheHitPct(selectedDay.inputTokens, selectedDay.cacheReadTokens, selectedDay.cacheHitRate)
    : 0;
  const selectedDayInfo = selectedDay
    ? `${selectedDay.dateLabel}：${fmtTokens(selectedDay.totalTokens)} tok（未命中 ${fmtTokens(selectedDay.inputTokens)} · 缓存 ${fmtTokens(selectedDay.cacheReadTokens)} (命中${selectedDayHitPct}%) · 输出 ${fmtTokens(selectedDay.outputTokens)} · ${selectedDay.turnsCount} 轮）`
    : '';

  const drillButtons = [
    ['model', '按模型'],
    ['project', '按项目'],
    ['session', '按会话'],
  ]
    .map(
      ([key, label]) =>
        `<button type="button" class="sub-pill" data-drill="${key}" aria-pressed="${state.drillMode === key}">${label}</button>`
    )
    .join('');

  const list =
    state.drillMode === 'project'
      ? data.byProject
      : state.drillMode === 'session'
        ? data.bySession
        : data.byModel;

  const maxRow = Math.max(1, ...(list || []).map((r) => r.totalTokens || 0));
  const drillHtml =
    list && list.length > 0
      ? list
          .map((item) => {
            const pct = Math.max(2, Math.round((item.totalTokens / maxRow) * 100));
            let title = item.name || item.title;
            if (state.drillMode === 'project') title = maskText(title, '已隐藏项目');
            if (state.drillMode === 'session') title = maskText(title, '已隐藏会话');

            const leftSub =
              state.drillMode === 'model'
                ? `${item.turnsCount} 轮${item.avgTps > 0 ? ` · ${fmtTps(item.avgTps)}` : ''} · 思考 ${fmtTokens(item.thinkingTokens)}`
                : state.drillMode === 'project'
                  ? `${item.sessionsCount} 会话 · ${item.turnsCount} 轮`
                  : `${maskText(item.project, '项目')} · ${item.modelLabel}`;

            return `
              <div class="list-item">
                <div class="list-item-top">
                  <span class="list-item-title" title="${esc(title)}">${esc(title)}</span>
                  <span class="kv-val num">${fmtTokens(item.totalTokens)}</span>
                </div>
                <div class="rank-bar-bg"><div class="rank-bar-fill" style="width:${pct}%"></div></div>
                <div class="list-item-sub num">
                  <span>${esc(leftSub)}</span>
                  <span>缓存 ${fmtTokens(item.cacheReadTokens || 0)} (命中${item.cacheHitRate}%)</span>
                </div>
              </div>
            `;
          })
          .join('')
      : '<div class="empty-state">当前筛选范围内无消耗记录</div>';

  let diagBody = '<div class="metric-sub">展开后读取本地 SQLite 扫描诊断…</div>';
  if (state.loadingDiagnostics) {
    diagBody = '<div class="metric-sub">正在检查本地库文件…</div>';
  } else if (state.diagnostics) {
    const d = state.diagnostics;
    diagBody = `
      <div class="kv-list">
        <div class="kv-row"><span class="kv-name">内置 Node.js 运行时</span><span class="kv-val mono">${esc(d.nodeVersion)}</span></div>
        <div class="kv-row"><span class="kv-name">Desktop / CLI 会话库</span><span class="kv-val num">${d.primaryDbCount} + ${d.cliDbCount} (已解析 ${d.parsedCount})</span></div>
        <div class="kv-row"><span class="kv-name">扫描耗时 / 异常数</span><span class="kv-val num">${d.scanMs} ms / ${d.errorCount} err</span></div>
        <div class="kv-row"><span class="kv-name">当前对话环境变量</span><span class="kv-val">${d.activeEnvConversation ? '已自动锁定当前对话' : '未注入（自动选最近活跃会话）'}</span></div>
      </div>
    `;
  }

  const diagOpenAttr = state.openFolds.has('diag') ? 'open' : '';

  root.innerHTML = `
    <div class="trends-grid">
      <section class="card">
        <div class="card-head">
          <div>
            <span class="card-title">近 ${data.days} 天消耗趋势${state.loadingAnalytics ? ' · 更新中…' : ''}</span>
            <div class="metric-main num">${fmtTokens(data.totals.totalTokens)} tok <span class="metric-sub">· 缓存 ${data.totals.cacheHitRate}% · TTFT ${fmtSec(data.totals.avgTtftSec)}</span></div>
          </div>
          <div class="sub-pills" role="group" aria-label="统计天数">${dayButtons}</div>
        </div>

        <div class="chart-wrap">
          ${buildStackedChart(data.daily, {
            selectedIdx: state.selectedChartDayIdx,
            familyFilter: state.analyticsFamily,
            clickable: true,
          })}
          <div class="legend-row">${legendFilters}</div>
          <div class="metric-sub num">${esc(selectedDayInfo)}</div>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <span class="card-title">消耗排行</span>
          <div class="sub-pills" role="group" aria-label="排行维度">${drillButtons}</div>
        </div>
        <div class="list-stack">${drillHtml}</div>
      </section>
    </div>

    <details id="diag-disclosure" class="diag-box" data-fold-id="diag" ${diagOpenAttr}>
      <summary>本地数据源与解析诊断（纯本地只读 SQLite · 零额外模型 Token）</summary>
      <div id="diag-content">${diagBody}</div>
    </details>
  `;
}

function computeSnapshotFingerprint(snap) {
  if (!snap) return '';
  const a = snap.activeSession;
  return [
    snap.surface,
    a?.id || '',
    a?.turnsCount || 0,
    a?.stepCount || 0,
    a?.totalTokens || 0,
    a?.contextUsed || 0,
    snap.today?.totalTokens || 0,
    snap.rolling5h?.totalTokens || 0,
    snap.calendarWeek?.totalTokens || 0,
  ].join('|');
}

let lastRenderedFingerprint = '';
let snapshotReqSeq = 0;
let analyticsReqSeq = 0;
let isPointerDown = false;

function renderAll() {
  renderTopToolbar();
  renderLive();
  renderTrends();
  lastRenderedFingerprint = computeSnapshotFingerprint(state.snapshot);
}

function selectTab(rawTabName, { focusTab = false } = {}) {
  const tabName = normalizeTabName(rawTabName);
  if (!TAB_ORDER.includes(tabName)) return;
  state.activeTab = tabName;

  document.querySelectorAll('.segmented-tabs [role="tab"]').forEach((tabEl) => {
    const isSel = tabEl.dataset.tab === tabName;
    tabEl.setAttribute('aria-selected', String(isSel));
    tabEl.setAttribute('tabindex', isSel ? '0' : '-1');
    if (isSel) {
      tabEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      if (focusTab) tabEl.focus();
    }
  });

  TAB_ORDER.forEach((name) => {
    const panel = document.getElementById(`panel-${name}`);
    if (panel) panel.hidden = name !== tabName;
  });

  if (tabName === 'trends' && !state.analytics && !state.loadingAnalytics) {
    void loadAnalytics();
  }
}

const app = new App({ name: 'Token Pulse', version: '1.1.0' }, {});

async function loadSnapshot({ background = false } = {}) {
  if (background && (state.loadingSnapshot || isPointerDown)) return;
  const reqId = ++snapshotReqSeq;
  state.loadingSnapshot = true;
  const refreshBtn = document.getElementById('btn-refresh');
  if (!background) refreshBtn?.classList.add('spinning');

  const reqSurface = state.surface;
  const reqSessionId = state.selectedSessionId;

  try {
    const res = await app.callServerTool({
      name: 'telemetry_snapshot',
      arguments: {
        surface: reqSurface,
        ...(reqSessionId ? { conversationId: reqSessionId } : {}),
      },
    });
    if (reqId !== snapshotReqSeq) return;
    if (res?.isError) {
      state.errorText = res.content?.[0]?.text || '读取快照失败';
      renderAll();
    } else if (res?.structuredContent) {
      state.errorText = '';
      const nextFp = computeSnapshotFingerprint(res.structuredContent);
      state.snapshot = res.structuredContent;
      if (background && nextFp === lastRenderedFingerprint) {
        renderTopToolbar();
      } else {
        renderAll();
      }
    }
  } catch (err) {
    if (reqId !== snapshotReqSeq) return;
    state.errorText = err instanceof Error ? err.message : String(err);
    renderAll();
  } finally {
    if (reqId === snapshotReqSeq) {
      state.loadingSnapshot = false;
      refreshBtn?.classList.remove('spinning');
    }
  }
}

async function loadAnalytics() {
  const reqId = ++analyticsReqSeq;
  const reqSurface = state.surface;
  const reqDays = state.analyticsDays;
  const reqFamily = state.analyticsFamily;

  state.loadingAnalytics = true;
  renderTrends();
  try {
    const res = await app.callServerTool({
      name: 'telemetry_analytics',
      arguments: {
        surface: reqSurface,
        days: reqDays,
        family: reqFamily,
      },
    });
    if (reqId !== analyticsReqSeq) return;
    if (!res?.isError && res?.structuredContent) {
      state.analytics = res.structuredContent;
    }
  } finally {
    if (reqId === analyticsReqSeq) {
      state.loadingAnalytics = false;
      renderTrends();
    }
  }
}

async function loadDiagnostics() {
  if (state.loadingDiagnostics) return;
  state.loadingDiagnostics = true;
  renderTrends();
  try {
    const res = await app.callServerTool({
      name: 'telemetry_diagnostics',
      arguments: {},
    });
    if (!res?.isError && res?.structuredContent) {
      state.diagnostics = res.structuredContent;
    }
  } finally {
    state.loadingDiagnostics = false;
    renderTrends();
  }
}

// Register MCP Apps handlers BEFORE calling app.connect()
app.ontoolinput = () => {
  if (!state.snapshot) {
    renderTopToolbar();
  }
};

app.ontoolresult = (result) => {
  const sc = result?.structuredContent;
  if (!sc) return;
  if (sc.snapshot) {
    state.snapshot = sc.snapshot;
    state.errorText = '';
    if (sc.initialTab) {
      selectTab(sc.initialTab);
    }
  } else if (sc.today) {
    state.snapshot = sc;
    state.errorText = '';
  }
  renderAll();
};

app.onhostcontextchanged = (ctx) => {
  applyHostThemeContext(ctx);
};

document.addEventListener('pointerdown', () => {
  isPointerDown = true;
});
document.addEventListener('pointerup', () => {
  isPointerDown = false;
});
document.addEventListener('pointercancel', () => {
  isPointerDown = false;
});

// Event delegation for UI controls
document.addEventListener('click', (event) => {
  const origin = event.target instanceof Element ? event.target : event.target?.parentElement;
  const target = origin?.closest('button');
  if (!target) return;

  if (target.id === 'btn-refresh') {
    void loadSnapshot({ background: false });
    if (state.activeTab === 'trends') void loadAnalytics();
    return;
  }

  if (target.id === 'btn-privacy') {
    state.privacyMask = !state.privacyMask;
    renderAll();
    return;
  }

  if (target.dataset.surface) {
    const nextSurface = target.dataset.surface;
    if (nextSurface !== state.surface) {
      state.surface = nextSurface;
      state.selectedSessionId = null;
      state.analytics = null;
      void loadSnapshot({ background: false });
      if (state.activeTab === 'trends') void loadAnalytics();
    }
    return;
  }

  if (target.dataset.tab) {
    selectTab(target.dataset.tab);
    return;
  }

  if (target.dataset.days) {
    const nextDays = Number(target.dataset.days);
    if (nextDays !== state.analyticsDays) {
      state.analyticsDays = nextDays;
      state.selectedChartDayIdx = null;
      void loadAnalytics();
    }
    return;
  }

  if (target.dataset.family) {
    const nextFamily = target.dataset.family;
    state.analyticsFamily = state.analyticsFamily === nextFamily ? 'all' : nextFamily;
    void loadAnalytics();
    return;
  }

  if (target.dataset.drill) {
    state.drillMode = target.dataset.drill;
    renderTrends();
    return;
  }

  if (target.dataset.dayIdx !== undefined && target.closest('#body-trends')) {
    state.selectedChartDayIdx = Number(target.dataset.dayIdx);
    renderTrends();
  }
});

document.addEventListener('change', (event) => {
  if (event.target?.id === 'session-select') {
    state.selectedSessionId = event.target.value || null;
    void loadSnapshot({ background: false });
  }
});

// Preserve <details> open states across periodic refreshes & lazy-load diagnostics
document.addEventListener(
  'toggle',
  (event) => {
    const el = event.target;
    if (!(el instanceof HTMLDetailsElement)) return;
    const foldId = el.dataset.foldId;
    if (foldId) {
      if (el.open) state.openFolds.add(foldId);
      else state.openFolds.delete(foldId);
    }
    if (el.id === 'diag-disclosure' && el.open && !state.diagnostics) {
      void loadDiagnostics();
    }
  },
  true
);

// Keyboard navigation for ARIA tablist (selection follows focus)
const tablist = document.querySelector('.segmented-tabs');
tablist?.addEventListener('keydown', (event) => {
  const currentIdx = TAB_ORDER.indexOf(state.activeTab);
  if (currentIdx === -1) return;
  let nextIdx = null;
  if (event.key === 'ArrowRight') nextIdx = (currentIdx + 1) % TAB_ORDER.length;
  else if (event.key === 'ArrowLeft') nextIdx = (currentIdx - 1 + TAB_ORDER.length) % TAB_ORDER.length;
  else if (event.key === 'Home') nextIdx = 0;
  else if (event.key === 'End') nextIdx = TAB_ORDER.length - 1;
  if (nextIdx !== null) {
    event.preventDefault();
    selectTab(TAB_ORDER[nextIdx], { focusTab: true });
  }
});

async function bootstrap() {
  try {
    await app.connect();
    applyHostThemeContext(app.getHostContext());
    if (!state.snapshot) {
      await loadSnapshot({ background: false });
    } else {
      renderAll();
    }
    setInterval(() => {
      if (document.visibilityState === 'visible') {
        void loadSnapshot({ background: true });
      }
    }, 20_000);
  } catch (err) {
    state.errorText = err instanceof Error ? err.message : String(err);
    renderAll();
  }
}

void bootstrap();
