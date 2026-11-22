# ADR-0001：纯本地只读 SQLite 采集与零依赖原生插件边界

- **状态**：已采纳（Accepted）
- **日期**：2026-11-23
- **关联代码**：[`scripts/sqlite-reader.mjs`](../../scripts/sqlite-reader.mjs), [`scripts/server.mjs`](../../scripts/server.mjs), [`build.mjs`](../../build.mjs)

## 1. 背景与问题（Context）

参考外部工具 `token-monitor` 时，原方案包含三类偏离 Antigravity 原生插件定位的复杂度：
1. 维护 50+ 第三方 AI 工具采集器与独立 Electron 桌面壳；
2. 通过 `Get-CimInstance` 扫描 `language_server*.exe` 命令行 `--csrf_token` 并探测本地端口调用未公开 RPC；
3. 按公开 API 单价拍脑袋估算“API 等价费用”，而 Antigravity 本身采用订阅配额且各模型窗口/缓存机制差异大。

## 2. 核心决策（Decision）

1. **只监控 Antigravity 原生生态**：筛选维度收拢为本机真实存在的 `全部 / Desktop / CLI`（本机旧版 `antigravity-ide` 已合并至 `antigravity` 主库）。
2. **纯本地只读采集替代进程抓取**：完全移除进程命令行抓取、端口探测与外部 OAuth；直接利用 Node.js 内置 `node:sqlite`（`readOnly: true` + `immutable=1` 回退）与零依赖 Protobuf 解析器读取 `gen_metadata`、`steps.metadata` 和 `conversation_summaries.db`。
3. **移除虚拟费用估算**：聚焦真实可验证指标——动态上下文上限（如 `512,000` / `256,000`）、Input / Cache Read / Thinking / Text 拆解、缓存命中率、TTFT 与总耗时、5 小时滚动消耗节奏及多日趋势。
4. **MCP 工具可见性分层与零依赖交付**：`open_telemetry_panel` 暴露 `aux_pane` 与 `global` 入口，重数据查询工具声明 `visibility: ["app"]` 避免撑爆模型上下文；部署包零 `node_modules`。

## 3. 后果与权衡（Consequences）

- **收益**：零网络请求、零额外模型 Token 消耗、零外部运行时依赖、不触碰系统进程安全边界。
- **代价与约束**：不在插件内硬推官方未落盘的远程 5h/Weekly 剩余百分比（以宿主原生界面为准），改用本地精确时间戳驱动的 5h 滚动消耗与速率视图；若上游 Protobuf 字段号变化需同步更新 `sqlite-reader.mjs`。
