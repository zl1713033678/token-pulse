# Changelog · 版本演进与修复归档

本项目的重要功能里程碑与已完成的安全、逻辑、UI 修复均归档于此（遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 精神）。当前未修复问题请查阅 [`docs/BUGS.md`](./docs/BUGS.md)。

---

## [1.1.0] - 2026-11-26

### Added
- **零重叠双视图架构与首屏直出明细**（[`src/ui/`](./src/ui/app.js), [`docs/specs/SPEC-001-dual-view-and-quota-ledger.md`](./docs/specs/SPEC-001-dual-view-and-quota-ledger.md)）：将原 4 个交叉重复标签页收敛为 `实时` 与 `趋势` 双视图，前置顶栏会话选择器，首屏直出 DSH 风高密度状态条（轮/步、`tok/s`、累计 Token、缓存命中率、上下文占比）与完整上下文构成拆解（含 `Cache Write` 与关联子代理拆分），移除二级跳转菜单。
- **5h 滚动与自然周分模型池额度台账**（[`scripts/sqlite-reader.mjs`](./scripts/sqlite-reader.mjs), [`src/ui/app.js`](./src/ui/app.js)）：新增按 `Gemini 4`、`Claude`、`Flash / 子代理` 独立模型池聚合的近 5 小时与自然周（周一 00:00 起）真实消耗台账，以及基于请求精确时间戳的 5h 滑窗最早批次滑出回血倒计时（不含虚构百分比条或费用估算）。
- **容器查询响应式与端到端交互回归测试**（[`src/ui/styles.css`](./src/ui/styles.css), [`test/verify.mjs`](./test/verify.mjs)）：引入 CSS `@container` 容器查询自适应窄侧边栏单栏与宽屏双栏；在 `verify.mjs` 中新增基于 `node:vm` 与真实 Stdio MCP Server 的全按钮点击、折叠框开关与并发乱序响应回归校验。

### Fixed
- **修复 `BUG-001`：非激活标签面板层叠上下文遮挡全部点击事件**（[`src/ui/styles.css`](./src/ui/styles.css), [`src/ui/template.html`](./src/ui/template.html), [`src/ui/app.js`](./src/ui/app.js)）：移除 `.panels-root > [role='tabpanel']` 的 `grid-area: 1 / 1` 同格叠放与 `hidden="until-found"`（其在 Chromium 中仅设 `content-visibility: hidden` 并创建 `contain: paint` 层叠上下文覆盖在激活面板上方），改为标准布尔 `hidden` 搭配 `[hidden] { display: none !important }`，恢复「实时」页折叠明细/压缩按钮与「趋势」页 `7/14/30天`、钻取维度、模型筛选等全部交互。
- **修复 `BUG-002`：并发点击静默丢弃、后台轮询打断点击与诊断框无法收起**（[`src/ui/app.js`](./src/ui/app.js)）：为快照与趋势请求引入单调递增序号保护（丢弃过期乱序响应而非丢弃用户新点击），后台轮询引入数据指纹比对与 `pointerdown` 防打断，并移除 `#diag-disclosure` 上的 `|| state.diagnostics` 强行展开条件。
- **补齐 `Gemini 4 Carbon` 家族识别与流式吞吐计算**（[`scripts/sqlite-reader.mjs`](./scripts/sqlite-reader.mjs)）：修复 `Carbon` 模型未纳入 `gemini4` 家族正则的问题，暴露单轮与会话加权生成速率 `tps`（`tok/s`）及 `conversation_summaries.step_count`。
- **移除无法触发命令菜单的 `#btn-compact` 按钮并修复多宽度文本截断**（[`src/ui/app.js`](./src/ui/app.js), [`src/ui/styles.css`](./src/ui/styles.css), [`test/verify.mjs`](./test/verify.mjs)）：移除通过 `ui/message` 发送纯文本 `/compact` 的虚假一键按钮，改为随上下文水位渐进提示用户在聊天输入框输入 `/compact` 并从命令菜单执行的通知条；同时解除 `.metric-sub`、`.strip-primary`/`.strip-sub`、`.kpi-sub`、`.pool-cell-sub`、`.badge-pill` 与 `.list-item-title` 的单行省略号截断并调整 `@container` 列断点，确保窄/宽面板均完整换行展示。
- **修复 Windows 热部署目录句柄占用报错**（[`build.mjs`](./build.mjs)）：改为原位覆盖同步插件文件并按需清理多余子项，避免宿主 MCP 进程占用插件根目录 CWD 时 `fs.rmSync(DEPLOY_DIR)` 触发 `EPERM`。

---

## [1.0.0] - 2026-11-23

### Added
- **纯本地 SQLite/Protobuf 遥测读取器**（[`scripts/sqlite-reader.mjs`](./scripts/sqlite-reader.mjs)）：零依赖只读扫描 Antigravity Desktop 与 CLI 会话库，提取动态上下文上限、Input/Cache Read/Thinking/Text 拆解、观测到的上下文回落事件与 5h/多日趋势聚合（不含任何费用估算）。
- **零依赖 Stdio MCP Server**（[`scripts/server.mjs`](./scripts/server.mjs)）：提供 `open_telemetry_panel`（支持 `aux_pane` 侧边栏与 `global` 全页入口）及 3 个 `app` 私有刷新/分析/诊断工具。
- **原生主题单文件 MCP App UI**（[`src/ui/`](./src/ui/app.js)）：基于 `@modelcontextprotocol/ext-apps` 打包为自包含页面，实现无白底同色系分层、设置强调色跟随、无障碍标签页、隐私脱敏切换及侧边栏一键发送 `/compact`。
- **原生插件打包与自动化校验体系**（[`build.mjs`](./build.mjs), [`test/verify.mjs`](./test/verify.mjs), [`skills/telemetry/SKILL.md`](./skills/telemetry/SKILL.md)）：支持一键单文件打包、零 `node_modules` 热部署与端到端回归测试。

### Security & Fixed
- **校准 Protobuf 时延字段映射**（`scripts/sqlite-reader.mjs`）：经真实库交叉验证，修正 `genInfo.11` 为首字延迟（`ttftSec`）、`genInfo.12` 为流式生成耗时（`streamSec`），确保 `latencySec = ttftSec + streamSec` 物理关系准确。
