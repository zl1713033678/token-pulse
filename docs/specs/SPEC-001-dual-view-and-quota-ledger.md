# SPEC-001：零重叠双视图重构、上下文直出与分池额度台账

- **状态**：`COMPLETED`
- **提出日期**：`2026-11-26`
- **完成时间戳**：`2026-11-26 01:05:00+08:00`
- **关联代码**：`scripts/sqlite-reader.mjs`, `scripts/server.mjs`, `src/ui/template.html`, `src/ui/styles.css`, `src/ui/app.js`, `skills/telemetry/SKILL.md`

---

## 1. 背景与痛点

`v1.0.0` 采用四标签页（`总览 / 上下文 / 节奏 / 趋势`），在实际侧边栏使用中暴露三类问题：
1. **信息交叉重复与二级跳转割裂**：上下文占用圆环、5h 柱状图、7 天消耗在多个标签页重复绘制，而核心的 Token 构成拆解与 `/compact` 操作被藏在二级页。
2. **本地数据未充分透出**：`conversation_summaries.step_count`、子代理父子层级（`parent_conversation_id`）、流式生成速率 `tok/s`（`outputTokens / streamSec`）及 `Gemini 4 Carbon` 家族映射与 `cacheWriteTokens` 尚未在界面呈现。
3. **缺少直观的额度消耗与回血视图**：官方云端配额百分比未落盘至 SQLite，需基于本地精确时间戳构建诚实无虚构的「近 5h 滚动 + 自然周（周一 00:00 起）」分模型池消耗与 5h 滑窗回血倒计时台账。

## 2. 架构与接口变更

1. **数据层 (`scripts/sqlite-reader.mjs`)**
   - 补齐 `carbon` 模型家族分类，暴露单轮 `streamSec` / `tps` 及会话 `stepCount`、`lastTps`、`avgTps`、`avgTtftSec` 与子代理归集统计 `subagents`。
   - 新增 `rolling5h.rolloff`（最早批次滑出时间戳 `nextRolloffAtMs`、释放量 `nextRolloffTokens` 与全清空时间 `fullClearAtMs`）。
   - 新增 `calendarWeek`（本地时间周一 `00:00` 起至下周一 `00:00` 重置）与 `quotaPools`（按 `Gemini 4 / Claude / Flash` 分池统计近 5h、本周、今日消耗及各自 5h 滑出回血时间）。
2. **协议层 (`scripts/server.mjs`)**
   - `open_telemetry_panel` 的 `tab` 收敛为主视图 `live` 与 `trends`，同时兼容旧值 `overview / context / pace` 自动映射至 `live`。
3. **前端层 (`src/ui/*`)**
   - 精简顶栏并前置目标会话选择器；首屏 `实时 (live)` 直出 DSH 风高密度状态条、完整上下文构成 + `/compact`、以及 5h/本周分池额度卡片；`趋势 (trends)` 承载 7/14/30 天交互图表、多维钻取与折叠诊断。
   - 采用 CSS `@container` 容器查询自适应窄侧边栏单栏与宽屏双栏，轮询刷新保留 `<details>` 展开态。
