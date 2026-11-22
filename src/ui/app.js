import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';

const state = {
  activeTab: 'overview',
  surface: 'all',
  selectedSessionId: null,
  privacyMask: false,
  analyticsDays: 7,
  analyticsFamily: 'all',
  drillMode: 'model',
  selectedChartDayIdx: null,
  snapshot: null,
  analytics: null,
  diagnostics: null,
  canSendMessage: false,
  compactState: 'idle', // idle | sending | sent | error
  compactMessage: '',
  loadingSnapshot: false,
  loadingAnalytics: false,
  loadingDiagnostics: false,
  errorText: '',
};

const FAMILY_LABELS = {
  gemini4: 'Gemini 4',
  flash: 'Flash / Subagent',
  claude: 'Claude',
  other: 'Other',
};

const TAB_ORDER = ['overview', 'context', 'pace', 'trends'];

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

function fmtRelativeTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '未知';
  const diffSec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (diffSec < 60) return '刚刚';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m 前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h 前`;
  return `${Math.floor(diffSec / 86400)}d 前`;
}

function maskText(text, fallbackLabel = '已隐藏') {
  if (!state.privacyMask) return text;
  if (!text) return fallbackLabel;
  return `${text.slice(0, 2)}•••`;
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

function buildRingSvg(pct, alertLevel, sizeClass = '') {
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
  const r = 19;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - clamped / 100);
  const strokeCls = alertLevel === 'danger' ? 'ring-fill danger' : alertLevel === 'warn' ? 'ring-fill warn' : 'ring-fill';

  return `
    <div class="ring-wrap ${sizeClass}">
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <circle class="ring-track" cx="24" cy="24" r="${r}" stroke-width="4.5" />
        <circle class="${strokeCls}" cx="24" cy="24" r="${r}" stroke-width="4.5"
          stroke-dasharray="${circ.toFixed(2)}"
          stroke-dashoffset="${offset.toFixed(2)}" />
      </svg>
      <div class="ring-center num">${Math.round(clamped)}%</div>
    </div>
  `;
}

function buildStackedChart(buckets, { large = false, selectedIdx = null, familyFilter = 'all', clickable = false } = {}) {
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
      const value = familyFilter !== 'all' ? (b.families?.[familyFilter] || 0) : (b.totalTokens || 0);
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
      const titleTip = `${b.dateLabel || b.label}: ${fmtTokens(value)} tokens (${b.turnsCount || 0} 轮)`;

      return `
        <button type="button" class="bar-col ${isSelected ? 'selected' : ''}"
          data-day-idx="${idx}" title="${esc(titleTip)}" ${clickable ? '' : 'tabindex="-1"'}>
          <span class="bar-stack" style="height:${heightPct}%">${segs}</span>
          <span class="bar-label">${showLabel ? esc(b.label) : '&nbsp;'}</span>
        </button>
      `;
    })
    .join('');

  return `<div class="stacked-chart ${large ? 'lg' : ''}" style="grid-template-columns: repeat(${cols}, minmax(0, 1fr))">${itemsHtml}</div>`;
}

function renderHeaderAndFilters() {
  const snap = state.snapshot;
  const active = snap?.activeSession;
  const subEl = document.getElementById('header-sub');
  const badgeEl = document.getElementById('env-badge');
  const syncEl = document.getElementById('sync-label');
  const privacyBtn = document.getElementById('btn-privacy');
  const privacyLabel = document.getElementById('privacy-label');

  if (privacyBtn && privacyLabel) {
    privacyBtn.setAttribute('aria-pressed', String(state.privacyMask));
    privacyLabel.textContent = state.privacyMask ? '已脱敏' : '脱敏';
  }

  if (snap) {
    const counts = snap.surfaceCounts || {};
    document.getElementById('count-all').textContent = counts.all ?? '';
    document.getElementById('count-desktop').textContent = counts.desktop ?? '';
    document.getElementById('count-cli').textContent = counts.cli ?? '';
    syncEl.textContent = fmtRelativeTime(snap.syncedAt);
  }

  document.querySelectorAll('.pill-btn[data-surface]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.surface === state.surface));
  });

  if (active) {
    const proj = maskText(active.project, '已隐藏项目');
    const sess = maskText(active.title, '当前会话');
    subEl.textContent = `${proj} · ${sess}`;
    badgeEl.textContent = active.surface === 'cli' ? 'CLI' : active.isCurrentEnv ? '当前对话' : 'Desktop';
  } else if (state.errorText) {
    subEl.textContent = state.errorText;
    badgeEl.textContent = 'Offline';
  } else if (snap) {
    subEl.textContent = '当前过滤下暂无会话';
    badgeEl.textContent = state.surface.toUpperCase();
  }
}

function renderOverview() {
  const root = document.getElementById('body-overview');
  const snap = state.snapshot;
  if (!snap) {
    root.innerHTML = `<div class="card empty-state">${esc(state.errorText || '正在扫描本地 Antigravity 会话数据…')}</div>`;
    return;
  }

  const active = snap.activeSession;
  const today = snap.today;
  const r5 = snap.rolling5h;
  const max5h = Math.max(1, ...r5.buckets.map((b) => b.totalTokens));

  const ctxCardHtml = active
    ? `
      <section class="card">
        <div class="card-head">
          <span class="card-title">当前上下文</span>
          <span class="card-meta ${active.alertLevel}">${active.contextPct}%</span>
        </div>
        <div class="ring-row">
          ${buildRingSvg(active.contextPct, active.alertLevel)}
          <div style="min-width:0">
            <div class="metric-main num">${fmtTokens(active.contextUsed)} / ${fmtTokens(active.contextLimit)}</div>
            <div class="metric-sub" title="${esc(active.modelLabel)}">${esc(active.modelLabel)}</div>
          </div>
        </div>
        <button type="button" class="link-btn" data-goto-tab="context">查看明细 / 一键压缩 →</button>
      </section>
    `
    : `
      <section class="card">
        <div class="card-head"><span class="card-title">当前上下文</span></div>
        <div class="empty-state">当前过滤下暂无会话</div>
      </section>
    `;

  const mini5hBars = r5.buckets
    .map((b) => {
      const h = b.totalTokens > 0 ? Math.max(12, Math.round((b.totalTokens / max5h) * 100)) : 8;
      return `
        <div class="mini-col" title="${esc(b.label)}: ${fmtTokens(b.totalTokens)} tokens (${b.turnsCount} 轮)">
          <span class="mini-bar-fill ${b.totalTokens === 0 ? 'empty' : ''}" style="height:${h}%"></span>
        </div>
      `;
    })
    .join('');

  const paceCardHtml = `
    <section class="card">
      <div class="card-head">
        <span class="card-title">近 5h 滚动窗口</span>
        <span class="card-meta accent num">${r5.turnsCount} 轮</span>
      </div>
      <div class="metric-main num">${fmtTokens(r5.totalTokens)} tokens</div>
      <div class="metric-sub num">均速 ${fmtTokens(r5.tokensPerHour)} / h</div>
      <div class="mini-bars">${mini5hBars}</div>
      <button type="button" class="link-btn" data-goto-tab="pace">查看 5h 节奏 →</button>
    </section>
  `;

  const kpiRowHtml = `
    <div class="grid-3">
      <section class="card">
        <span class="card-title">今日处理量</span>
        <div class="metric-big num">${fmtTokens(today.totalTokens)}</div>
        <span class="metric-note num">${today.sessionsCount} 会话 · ${today.turnsCount} 轮</span>
      </section>
      <section class="card">
        <span class="card-title">缓存命中率</span>
        <div class="metric-big num">${today.cacheHitRate}%</div>
        <span class="metric-note num">命中 ${fmtTokens(today.cacheReadTokens)}</span>
      </section>
      <section class="card">
        <span class="card-title">平均 TTFT</span>
        <div class="metric-big num">${fmtSec(today.avgTtftSec)}</div>
        <span class="metric-sub num">总耗时 ${fmtSec(today.avgLatencySec)}</span>
      </section>
    </div>
  `;

  const chart7dHtml = `
    <section class="card">
      <div class="card-head">
        <div>
          <span class="card-title">近 7 天 Antigravity 消耗</span>
          <div class="metric-sub num">共 ${fmtTokens(snap.weekSummary.totalTokens)} tokens · 纯本地统计</div>
        </div>
        <button type="button" class="link-btn" data-goto-tab="trends">详细钻取 →</button>
      </div>
      <div class="chart-wrap">
        ${buildStackedChart(snap.mini7d)}
        <div class="legend-row">
          <span class="legend-item"><span class="swatch swatch-gemini4"></span>Gemini 4</span>
          <span class="legend-item"><span class="swatch swatch-claude"></span>Claude</span>
          <span class="legend-item"><span class="swatch swatch-flash"></span>Flash / Subagent</span>
        </div>
      </div>
    </section>
  `;

  root.innerHTML = `<div class="grid-2">${ctxCardHtml}${paceCardHtml}</div>${kpiRowHtml}${chart7dHtml}`;
}

function renderContext() {
  const root = document.getElementById('body-context');
  const snap = state.snapshot;
  const active = snap?.activeSession;
  if (!active) {
    root.innerHTML = '<div class="card empty-state">暂无可检查的 Antigravity 会话记录。</div>';
    return;
  }

  const sessionOptions = (snap.recentSessions || [])
    .map((s) => {
      const label = `${s.surface === 'cli' ? '[CLI] ' : ''}${maskText(s.title, '会话')} (${s.contextPct}%)`;
      const selected = s.id === active.id ? 'selected' : '';
      return `<option value="${esc(s.id)}" ${selected}>${esc(label)}</option>`;
    })
    .join('');

  const remaining = Math.max(0, active.contextLimit - active.contextUsed);
  const totalComposed = Math.max(
    1,
    active.inputTokens + active.cacheReadTokens + active.thinkingTokens + active.textTokens
  );
  const pctIn = (active.inputTokens / totalComposed) * 100;
  const pctCache = (active.cacheReadTokens / totalComposed) * 100;
  const pctThink = (active.thinkingTokens / totalComposed) * 100;
  const pctText = (active.textTokens / totalComposed) * 100;

  let alertBanner = '';
  if (active.alertLevel === 'danger') {
    alertBanner = `<span>上下文已达 <strong>${active.contextPct}%</strong>，建议立即发送 <code>/compact</code> 释放空间。</span>`;
  } else if (active.alertLevel === 'warn') {
    alertBanner = `<span>上下文已使用 <strong>${active.contextPct}%</strong>，接近高水位阈值。</span>`;
  } else {
    alertBanner = `<span>上下文余量充足（剩余 ${fmtTokens(remaining)} tokens）。</span>`;
  }

  const compactBtnHtml = state.canSendMessage
    ? `<button type="button" id="btn-compact" class="primary-btn" ${state.compactState === 'sending' ? 'disabled' : ''}>
         ${state.compactState === 'sending' ? '发送中…' : '一键 /compact'}
       </button>`
    : `<span class="metric-sub">侧边栏对话内可用 /compact</span>`;

  const compactFeedbackHtml = state.compactMessage
    ? `<div class="metric-sub" style="color: ${state.compactState === 'error' ? 'var(--danger)' : 'var(--ok)'}">${esc(state.compactMessage)}</div>`
    : '';

  const compactionsHtml =
    active.compactionEvents?.length > 0
      ? `
      <section class="card">
        <div class="card-head">
          <span class="card-title">观测到的上下文回落 / 压缩</span>
          <span class="card-meta num">${active.compactionEvents.length} 次</span>
        </div>
        <div class="list-stack">
          ${active.compactionEvents
            .slice(-3)
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
      </section>`
      : '';

  const turnsHtml = (active.recentTurns || [])
    .map(
      (t) => `
      <div class="list-item">
        <div class="list-item-top">
          <span class="list-item-title" title="${esc(t.modelLabel)}">#${t.idx} · ${esc(t.modelLabel)}</span>
          <span class="kv-val num">${fmtTokens(t.totalTokens)}</span>
        </div>
        <div class="list-item-sub num">
          <span>In ${fmtTokens(t.inputTokens)} · Cache ${fmtTokens(t.cacheReadTokens)} · Think ${fmtTokens(t.thinkingTokens)} · Text ${fmtTokens(t.textTokens)}</span>
          <span>TTFT ${fmtSec(t.ttftSec)} / ${fmtSec(t.latencySec)}</span>
        </div>
      </div>`
    )
    .join('');

  root.innerHTML = `
    <section class="card">
      <div class="card-head">
        <label class="card-title" for="session-select">目标会话</label>
        <span class="metric-sub">${esc(maskText(active.project, '已隐藏项目'))}</span>
      </div>
      <select id="session-select" class="select-control">${sessionOptions}</select>
    </section>

    <section class="card">
      <div class="card-head">
        <span class="card-title">Context Window 占用</span>
        <span class="card-meta ${active.alertLevel} num">${active.turnsCount} 轮 · 缓存 ${active.cacheHitRate}%</span>
      </div>
      <div class="ring-row">
        ${buildRingSvg(active.contextPct, active.alertLevel, 'lg')}
        <div style="min-width:0; flex:1">
          <div class="metric-big num">${fmtExact(active.contextUsed)}</div>
          <div class="metric-sub num">上限 ${fmtExact(active.contextLimit)} · 剩余 ${fmtExact(remaining)}</div>
          <div class="metric-sub" style="margin-top:2px">${esc(active.modelLabel)}</div>
        </div>
      </div>
      <div class="alert-banner ${active.alertLevel}">
        <div style="min-width:0">${alertBanner}</div>
        ${compactBtnHtml}
      </div>
      ${compactFeedbackHtml}
    </section>

    <section class="card">
      <div class="card-head">
        <span class="card-title">会话累计 Token 构成</span>
        <span class="card-meta num">${fmtTokens(active.totalTokens)}</span>
      </div>
      <div class="progress-track" aria-hidden="true">
        <span class="progress-seg" style="width:${pctCache.toFixed(1)}%; background: var(--ok)"></span>
        <span class="progress-seg" style="width:${pctIn.toFixed(1)}%; background: var(--accent)"></span>
        <span class="progress-seg" style="width:${pctThink.toFixed(1)}%; background: var(--warn)"></span>
        <span class="progress-seg" style="width:${pctText.toFixed(1)}%; background: var(--fg-muted)"></span>
      </div>
      <div class="kv-list">
        <div class="kv-row"><span class="kv-name"><span class="swatch" style="background:var(--ok)"></span>缓存命中 (Cache Read)</span><span class="kv-val num">${fmtExact(active.cacheReadTokens)}</span></div>
        <div class="kv-row"><span class="kv-name"><span class="swatch" style="background:var(--accent)"></span>未命中输入 (Input)</span><span class="kv-val num">${fmtExact(active.inputTokens)}</span></div>
        <div class="kv-row"><span class="kv-name"><span class="swatch" style="background:var(--warn)"></span>思考推理 (Thinking)</span><span class="kv-val num">${fmtExact(active.thinkingTokens)}</span></div>
        <div class="kv-row"><span class="kv-name"><span class="swatch" style="background:var(--fg-muted)"></span>可见输出 (Text)</span><span class="kv-val num">${fmtExact(active.textTokens)}</span></div>
      </div>
    </section>

    ${compactionsHtml}

    <section class="card">
      <div class="card-head">
        <span class="card-title">最近轮次明细</span>
        <span class="metric-sub">倒序最近 8 轮</span>
      </div>
      <div class="list-stack">${turnsHtml || '<div class="empty-state">暂无生成轮次</div>'}</div>
    </section>
  `;
}

function renderPace() {
  const root = document.getElementById('body-pace');
  const snap = state.snapshot;
  if (!snap) {
    root.innerHTML = '<div class="card empty-state">暂无 5h 滚动数据</div>';
    return;
  }

  const r5 = snap.rolling5h;
  const week = snap.weekSummary;
  const weekTotal = Math.max(1, week.totalTokens);

  const famRows = ['gemini4', 'claude', 'flash', 'other']
    .map((key) => {
      const v5 = r5.byFamily?.[key] || 0;
      const v7 = week.byFamily?.[key] || 0;
      const pct7 = Math.round((v7 / weekTotal) * 1000) / 10;
      return `
        <div class="list-item">
          <div class="list-item-top">
            <span class="kv-name"><span class="swatch swatch-${key}"></span>${esc(FAMILY_LABELS[key])}</span>
            <span class="kv-val num">${fmtTokens(v7)} <span class="metric-sub">(${pct7}%)</span></span>
          </div>
          <div class="rank-bar-bg"><div class="rank-bar-fill swatch-${key}" style="width:${pct7}%"></div></div>
          <div class="list-item-sub num">
            <span>近 5h: ${fmtTokens(v5)} tokens</span>
            <span>近 7d 占比 ${pct7}%</span>
          </div>
        </div>
      `;
    })
    .join('');

  let diagBody = '<div class="metric-sub">展开后读取本地 SQLite 扫描诊断…</div>';
  if (state.loadingDiagnostics) {
    diagBody = '<div class="metric-sub">正在检查本地库文件…</div>';
  } else if (state.diagnostics) {
    const d = state.diagnostics;
    diagBody = `
      <div class="kv-list">
        <div class="kv-row"><span class="kv-name">内置 Node.js 运行时</span><span class="kv-val mono">${esc(d.nodeVersion)}</span></div>
        <div class="kv-row"><span class="kv-name">Desktop / CLI 会话库</span><span class="kv-val num">${d.primaryDbCount} + ${d.cliDbCount} (成功 ${d.parsedCount})</span></div>
        <div class="kv-row"><span class="kv-name">解析耗时 / 错误数</span><span class="kv-val num">${d.scanMs} ms / ${d.errorCount} err</span></div>
        <div class="kv-row"><span class="kv-name">会话环境变量绑定</span><span class="kv-val">${d.activeEnvConversation ? '已绑定当前对话' : '未绑定（自动取最近活跃）'}</span></div>
      </div>
    `;
  }

  root.innerHTML = `
    <section class="card">
      <div class="card-head">
        <div>
          <span class="card-title">近 5 小时滚动窗口消耗</span>
          <div class="metric-big num">${fmtTokens(r5.totalTokens)} tokens</div>
        </div>
        <span class="card-meta accent num">${fmtTokens(r5.tokensPerHour)} / h</span>
      </div>
      ${buildStackedChart(r5.buckets, { large: false })}
      <div class="legend-row">
        <span>共 ${r5.turnsCount} 轮生成</span>
        <span>·</span>
        <span>不含外部接口探测（完全只读本地库）</span>
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <span class="card-title">7 天模型家族消耗分布</span>
        <span class="card-meta num">${fmtTokens(week.totalTokens)}</span>
      </div>
      <div class="list-stack">${famRows}</div>
    </section>

    <details id="diag-disclosure" class="diag-box" ${state.diagnostics ? 'open' : ''}>
      <summary>本地数据源与解析诊断</summary>
      <div id="diag-content">${diagBody}</div>
    </details>
  `;
}

function renderTrends() {
  const root = document.getElementById('body-trends');
  if (state.loadingAnalytics && !state.analytics) {
    root.innerHTML = '<div class="card empty-state">正在聚合多日消费明细…</div>';
    return;
  }

  const data = state.analytics;
  if (!data) {
    root.innerHTML = '<div class="card empty-state">切换至此标签页自动加载分析数据</div>';
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
      const label = f === 'all' ? '全部家族' : FAMILY_LABELS[f];
      const dot = f === 'all' ? '' : `<span class="swatch swatch-${f}"></span>`;
      return `<button type="button" class="legend-item interactive" data-family="${f}" aria-pressed="${state.analyticsFamily === f}">${dot}${esc(label)}</button>`;
    })
    .join('');

  const selectedDay =
    state.selectedChartDayIdx !== null && data.daily[state.selectedChartDayIdx]
      ? data.daily[state.selectedChartDayIdx]
      : data.daily[data.daily.length - 1];

  const selectedDayInfo = selectedDay
    ? `${selectedDay.dateLabel}：${fmtTokens(selectedDay.totalTokens)} tokens · ${selectedDay.turnsCount} 轮`
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
                ? `${item.turnsCount} 轮 · Think ${fmtTokens(item.thinkingTokens)}`
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
                  <span>缓存 ${item.cacheHitRate}%</span>
                </div>
              </div>
            `;
          })
          .join('')
      : '<div class="empty-state">当前筛选范围内无消费明细</div>';

  root.innerHTML = `
    <section class="card">
      <div class="card-head">
        <div>
          <span class="card-title">${data.days} 天消费趋势</span>
          <div class="metric-main num">${fmtTokens(data.totals.totalTokens)} tokens</div>
        </div>
        <div class="sub-pills" role="group" aria-label="统计天数">${dayButtons}</div>
      </div>

      ${buildStackedChart(data.daily, {
        large: true,
        selectedIdx: state.selectedChartDayIdx,
        familyFilter: state.analyticsFamily,
        clickable: true,
      })}

      <div class="legend-row">${legendFilters}</div>
      <div class="metric-sub num">${esc(selectedDayInfo)} · 缓存命中 ${data.totals.cacheHitRate}% · 平均 TTFT ${fmtSec(data.totals.avgTtftSec)}</div>
    </section>

    <section class="card">
      <div class="card-head">
        <span class="card-title">消费钻取</span>
        <div class="sub-pills" role="group" aria-label="钻取维度">${drillButtons}</div>
      </div>
      <div class="list-stack">${drillHtml}</div>
    </section>
  `;
}

function renderAll() {
  renderHeaderAndFilters();
  renderOverview();
  renderContext();
  renderPace();
  renderTrends();
}

function selectTab(tabName, { focusTab = false } = {}) {
  if (!TAB_ORDER.includes(tabName)) return;
  state.activeTab = tabName;

  document.querySelectorAll('.segmented-tabs [role="tab"]').forEach((tabEl) => {
    const isSel = tabEl.dataset.tab === tabName;
    tabEl.setAttribute('aria-selected', String(isSel));
    tabEl.setAttribute('tabindex', isSel ? '0' : '-1');
    if (isSel && focusTab) tabEl.focus();
  });

  TAB_ORDER.forEach((name) => {
    const panel = document.getElementById(`panel-${name}`);
    if (panel) panel.hidden = name !== tabName;
  });

  if (tabName === 'trends' && !state.analytics && !state.loadingAnalytics) {
    void loadAnalytics();
  }
}

const app = new App({ name: 'Token Pulse', version: '1.0.0' }, {});

async function loadSnapshot() {
  if (state.loadingSnapshot) return;
  state.loadingSnapshot = true;
  const refreshBtn = document.getElementById('btn-refresh');
  refreshBtn?.classList.add('spinning');
  try {
    const res = await app.callServerTool({
      name: 'telemetry_snapshot',
      arguments: {
        surface: state.surface,
        ...(state.selectedSessionId ? { conversationId: state.selectedSessionId } : {}),
      },
    });
    if (res?.isError) {
      state.errorText = res.content?.[0]?.text || '读取快照失败';
    } else if (res?.structuredContent) {
      state.errorText = '';
      state.snapshot = res.structuredContent;
    }
  } catch (err) {
    state.errorText = err instanceof Error ? err.message : String(err);
  } finally {
    state.loadingSnapshot = false;
    refreshBtn?.classList.remove('spinning');
    renderAll();
  }
}

async function loadAnalytics() {
  if (state.loadingAnalytics) return;
  state.loadingAnalytics = true;
  renderTrends();
  try {
    const res = await app.callServerTool({
      name: 'telemetry_analytics',
      arguments: {
        surface: state.surface,
        days: state.analyticsDays,
        family: state.analyticsFamily,
      },
    });
    if (!res?.isError && res?.structuredContent) {
      state.analytics = res.structuredContent;
    }
  } finally {
    state.loadingAnalytics = false;
    renderTrends();
  }
}

async function loadDiagnostics() {
  if (state.loadingDiagnostics) return;
  state.loadingDiagnostics = true;
  renderPace();
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
    renderPace();
  }
}

async function handleSendCompact() {
  if (!state.canSendMessage || state.compactState === 'sending') return;
  state.compactState = 'sending';
  state.compactMessage = '';
  renderContext();
  try {
    const res = await app.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: '/compact' }],
    });
    if (res?.isError) {
      state.compactState = 'error';
      state.compactMessage = '宿主拒绝了 /compact 消息发送';
    } else {
      state.compactState = 'sent';
      state.compactMessage = '已向当前对话发送 /compact';
    }
  } catch (err) {
    state.compactState = 'error';
    state.compactMessage = err instanceof Error ? err.message : '发送失败';
  } finally {
    renderContext();
  }
}

// Register MCP Apps handlers BEFORE calling app.connect()
app.ontoolinput = () => {
  if (!state.snapshot) {
    renderHeaderAndFilters();
  }
};

app.ontoolresult = (result) => {
  const sc = result?.structuredContent;
  if (!sc) return;
  if (sc.snapshot) {
    state.snapshot = sc.snapshot;
    state.errorText = '';
    if (sc.initialTab && TAB_ORDER.includes(sc.initialTab)) {
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

// Event delegation for UI controls
document.addEventListener('click', (event) => {
  const target = event.target.closest('button');
  if (!target) return;

  if (target.id === 'btn-refresh') {
    void loadSnapshot();
    if (state.activeTab === 'trends') void loadAnalytics();
    return;
  }

  if (target.id === 'btn-privacy') {
    state.privacyMask = !state.privacyMask;
    renderAll();
    return;
  }

  if (target.id === 'btn-compact') {
    void handleSendCompact();
    return;
  }

  if (target.dataset.surface) {
    const nextSurface = target.dataset.surface;
    if (nextSurface !== state.surface) {
      state.surface = nextSurface;
      state.selectedSessionId = null;
      state.analytics = null;
      void loadSnapshot();
      if (state.activeTab === 'trends') void loadAnalytics();
    }
    return;
  }

  if (target.dataset.tab) {
    selectTab(target.dataset.tab);
    return;
  }

  if (target.dataset.gotoTab) {
    selectTab(target.dataset.gotoTab);
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
    state.compactState = 'idle';
    state.compactMessage = '';
    void loadSnapshot();
  }
});

document.addEventListener('toggle', (event) => {
  if (event.target?.id === 'diag-disclosure' && event.target.open && !state.diagnostics) {
    void loadDiagnostics();
  }
}, true);

// Keyboard navigation for ARIA tablist
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
    const caps = app.getHostCapabilities();
    state.canSendMessage = Boolean(caps?.message);
    if (!state.snapshot) {
      await loadSnapshot();
    } else {
      renderAll();
    }
    setInterval(() => {
      if (document.visibilityState === 'visible') {
        void loadSnapshot();
      }
    }, 30_000);
  } catch (err) {
    state.errorText = err instanceof Error ? err.message : String(err);
    renderAll();
  }
}

void bootstrap();
